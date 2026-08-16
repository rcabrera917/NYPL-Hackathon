#!/usr/bin/env node
// Build public/data/overlays.json — the "Along the way" contextual layer.
// Keyed by site id. Additive to sites.json / stations.json — everything
// here is context, not a verdict input. If this file fails to load, the
// rest of the map must still work.
//
// Layer build order (do one at a time, verify render, then extend):
//   [x] 1. Libraries (NYPL + BPL + QPL, via Facilities Database)
//   [x] 2. 311 elevator/sidewalk/curb-cut/scaffolding complaints (90d)
//   [ ] 3. Cooling centers
//   [ ] 4. Film permits (date-scoped)
//   [x] 5. Census tract context (ACS 5-year 2023 + USDA LRAM 2019)
//   [x] 6. Street Tree Census — living trees in the 300m corridor
//   [x] 7. CityBench (DOT) — public bench locations, nearest bench distance
//   [x] 8. Motor Vehicle Collisions — pedestrian-injury crashes (24 mo)
//   [ ] 9. Sidewalk sheds (DOB permits) — SKIPPED. No NYC Open Data
//          dataset for active sidewalk sheds carries coordinates. DOB
//          Permit Issuance (ipu4-2q9a) and DOB NOW filings (w9ak-ipjd)
//          key by BIN/BBL; joining to a building-footprints dataset for
//          coords is possible but too heavy for a corridor layer here.
//          Documented in FUTURE.md.
//   [x] 10. Public Restrooms — Operational restrooms in the corridor
//
// Usage:
//   node scripts/build-overlays.mjs                # all layers, fetch/print/write
//   node scripts/build-overlays.mjs --dry-run      # no write
//   node scripts/build-overlays.mjs --only=5       # run one layer, merge into
//                                                    existing overlays.json
//   node scripts/build-overlays.mjs --only=5,6,7   # or several

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITES_PATH = resolve(HERE, "..", "public", "data", "sites.json");
const OUT_PATH = resolve(HERE, "..", "public", "data", "overlays.json");
const LRAM_PATH = resolve(HERE, "..", "public", "data", "usda-lram-2019.json");

const FACILITIES_URL = "https://data.cityofnewyork.us/resource/ji82-xba5.json";
const MTA_STATIONS_URL = "https://data.ny.gov/resource/39hk-dx4f.json";
const NYC311_URL = "https://data.cityofnewyork.us/resource/erm2-nwe9.json";
const FCC_BLOCK_URL = "https://geo.fcc.gov/api/census/block/find";
const TREES_URL = "https://data.cityofnewyork.us/resource/uvpi-gqnh.json";
const BENCHES_URL = "https://data.cityofnewyork.us/resource/kuxa-tauh.json";
const COLLISIONS_URL = "https://data.cityofnewyork.us/resource/h9gi-nx95.json";
const COLLISIONS_LOOKBACK_MONTHS = 24;
const RESTROOMS_URL = "https://data.cityofnewyork.us/resource/i7jb-7jku.json";
const CENSUS_ACS_DETAIL_URL = "https://api.census.gov/data/2023/acs/acs5";
const CENSUS_ACS_SUBJECT_URL = "https://api.census.gov/data/2023/acs/acs5/subject";
const ACS_VINTAGE_LABEL = "ACS 5-year, 2023";
const LRAM_VINTAGE_LABEL = "USDA LRAM, 2019 data";
const NYC_COUNTIES = ["005", "047", "061", "081", "085"]; // Bronx, Kings, NY, Queens, Richmond
const ADA_DIST_ALERT_MILES = 0.75;
const RADIUS_METERS = 300;
const MEAL_SITE_MATCH_METERS = 60;
const NYC311_LOOKBACK_DAYS = 90;
// Complaint types worth surfacing on a site's corridor. Values must match
// the 311 dataset's complaint_type strings (case-insensitive compare).
const NYC311_TARGET_TYPES = [
  "Elevator",                       // NYCHA / HPD elevator issues
  "Sidewalk Condition",             // DOT sidewalk cracks / trips
  "Root/Sewer/Sidewalk Condition",  // Parks-driven sidewalk damage
  "Curb Condition",                 // DOT curb / curb-cut issues
  "Scaffold Safety",                // DOB scaffolding hazards
  "DEP Sidewalk Condition",         // DEP-driven sidewalk work
];

async function fetchAll(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v);
  if (!u.searchParams.has("$limit")) u.searchParams.set("$limit", "50000");
  // One retry on 5xx — Socrata occasionally 500s under load and a
  // second attempt usually succeeds.
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(u);
    if (res.ok) return res.json();
    if (res.status < 500 || attempt === 1) throw new Error(`HTTP ${res.status} ${u}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

function haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function systemLabelFor(opname) {
  const n = String(opname ?? "").toLowerCase();
  if (n.includes("brooklyn")) return "BPL";
  if (n.includes("queens")) return "QPL";
  if (n.includes("new york public")) return "NYPL";
  return opname ?? "Unknown";
}

function withinAny(point, origins, radiusMeters) {
  for (const o of origins) {
    if (o == null) continue;
    if (haversineMeters(point.lat, point.lng, o.lat, o.lng) <= radiusMeters) return true;
  }
  return false;
}

function nearestOriginMeters(point, origins) {
  let best = Infinity;
  for (const o of origins) {
    if (o == null) continue;
    const d = haversineMeters(point.lat, point.lng, o.lat, o.lng);
    if (d < best) best = d;
  }
  return Number.isFinite(best) ? best : null;
}

// ---- Layer 5 helpers: FCC block lookup + ACS pull + LRAM join --------
async function fetchTractGeoidForPoint(lat, lng) {
  const u = new URL(FCC_BLOCK_URL);
  u.searchParams.set("latitude", String(lat));
  u.searchParams.set("longitude", String(lng));
  u.searchParams.set("censusYear", "2020");
  u.searchParams.set("format", "json");
  const res = await fetch(u);
  if (!res.ok) throw new Error(`FCC ${res.status} ${u}`);
  const body = await res.json();
  const fips = body?.Block?.FIPS;
  if (typeof fips !== "string" || fips.length < 11) return null;
  return fips.slice(0, 11); // state(2)+county(3)+tract(6)
}

// Variables we ask ACS for. Names + human labels kept together so the
// provenance block can render each one back with its source var. Each
// entry declares which endpoint it lives on — the detailed B/C tables
// and the S subject tables are served from separate URLs.
const ACS_VARS = [
  // Detailed tables (B/C prefix).
  { code: "B01001_001E", key: "totalPop",           label: "Total population",                                           endpoint: "detail"  },
  { code: "B17001_002E", key: "belowPovertyCount",  label: "Population below poverty (12mo)",                            endpoint: "detail"  },
  { code: "B17001_001E", key: "povertyUniverse",    label: "Poverty universe (for whom status determined)",              endpoint: "detail"  },
  { code: "B08201_002E", key: "hhNoVehicleCount",   label: "Households with no vehicle",                                 endpoint: "detail"  },
  { code: "B08201_001E", key: "hhTotal",            label: "Total households",                                           endpoint: "detail"  },
  { code: "B01002_001E", key: "medianAge",          label: "Median age",                                                 endpoint: "detail"  },
  { code: "C16002_004E", key: "hhLepSpanishCount",  label: "Spanish-speaking limited-English households",                endpoint: "detail"  },
  { code: "C16002_001E", key: "hhLepUniverse",      label: "Households (language universe)",                             endpoint: "detail"  },
  // Subject tables (S prefix). S1810 is the disability subject table;
  // _C03_ columns are percent-of-civilian-noninstitutionalized-population.
  { code: "S1810_C03_001E", key: "disabilityPct",              label: "Percent of civilian noninstitutionalized population with any disability", endpoint: "subject" },
  { code: "S1810_C03_001M", key: "disabilityPctMoe",           label: "MOE for percent-with-any-disability (90% confidence)",                    endpoint: "subject" },
  { code: "S1810_C03_047E", key: "ambulatoryDifficultyPct",    label: "Percent of civilian noninstitutionalized population with an ambulatory difficulty", endpoint: "subject" },
  { code: "S1810_C03_047M", key: "ambulatoryDifficultyPctMoe", label: "MOE for percent-with-an-ambulatory-difficulty (90% confidence)",          endpoint: "subject" },
];

async function fetchAcsEndpoint(baseUrl, vars, county, key) {
  const codes = vars.map((v) => v.code).join(",");
  const u = new URL(baseUrl);
  u.searchParams.set("get", `NAME,${codes}`);
  u.searchParams.set("for", "tract:*");
  u.searchParams.set("in", `state:36 county:${county}`);
  if (key) u.searchParams.set("key", key);
  const res = await fetch(u);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`ACS ${res.status} ${baseUrl} county=${county} — ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function fetchAcsForCounty(county, key) {
  const detailVars = ACS_VARS.filter((v) => v.endpoint === "detail");
  const subjectVars = ACS_VARS.filter((v) => v.endpoint === "subject");

  const [detailRows, subjectRows] = await Promise.all([
    fetchAcsEndpoint(CENSUS_ACS_DETAIL_URL, detailVars, county, key),
    fetchAcsEndpoint(CENSUS_ACS_SUBJECT_URL, subjectVars, county, key),
  ]);

  const out = new Map();

  function ingest(rows, vars) {
    const header = rows[0];
    const stateIdx = header.indexOf("state");
    const countyIdx = header.indexOf("county");
    const tractIdx = header.indexOf("tract");
    for (const row of rows.slice(1)) {
      const geoid = `${row[stateIdx]}${row[countyIdx]}${row[tractIdx]}`;
      const rec = out.get(geoid) ?? { geoid };
      for (const v of vars) {
        const raw = row[header.indexOf(v.code)];
        const num = raw == null ? null : Number(raw);
        rec[v.key] = Number.isFinite(num) ? num : null;
      }
      out.set(geoid, rec);
    }
  }
  ingest(detailRows, detailVars);
  ingest(subjectRows, subjectVars);

  // Derived rates (nullable — ACS uses negatives for suppressed/error).
  for (const rec of out.values()) {
    rec.povertyRate =
      rec.povertyUniverse > 0 && rec.belowPovertyCount != null && rec.belowPovertyCount >= 0
        ? rec.belowPovertyCount / rec.povertyUniverse
        : null;
    rec.noVehicleRate =
      rec.hhTotal > 0 && rec.hhNoVehicleCount != null && rec.hhNoVehicleCount >= 0
        ? rec.hhNoVehicleCount / rec.hhTotal
        : null;
    rec.spanishLepRate =
      rec.hhLepUniverse > 0 && rec.hhLepSpanishCount != null && rec.hhLepSpanishCount >= 0
        ? rec.hhLepSpanishCount / rec.hhLepUniverse
        : null;
    // Subject-table C03 columns already come as percentages (0–100).
    // Normalize into 0–1 to match the derived rates above, and drop the
    // ACS suppression sentinels (< 0). MOE gets the same /100 scaling.
    rec.disabilityRate =
      rec.disabilityPct != null && rec.disabilityPct >= 0 ? rec.disabilityPct / 100 : null;
    rec.disabilityRateMoe =
      rec.disabilityPctMoe != null && rec.disabilityPctMoe >= 0 ? rec.disabilityPctMoe / 100 : null;
    rec.ambulatoryDifficultyRate =
      rec.ambulatoryDifficultyPct != null && rec.ambulatoryDifficultyPct >= 0
        ? rec.ambulatoryDifficultyPct / 100
        : null;
    rec.ambulatoryDifficultyRateMoe =
      rec.ambulatoryDifficultyPctMoe != null && rec.ambulatoryDifficultyPctMoe >= 0
        ? rec.ambulatoryDifficultyPctMoe / 100
        : null;

    // Reliability heuristic: suppress the tract line in the UI when
    // the MOE is large relative to the estimate (MOE/estimate >= 0.5
    // — Census guidance treats CV>=40% as unreliable and this is a
    // slightly looser proxy at 90% confidence) OR when the estimate
    // itself blows past 30%, which in practice means a small tract
    // whose civilian-noninstitutionalized denominator is skewed by
    // group-quarters-adjacent population.
    const relFor = (est, moe) => {
      if (est == null || moe == null || est <= 0) return { ok: null, ratio: null, over30: false };
      const ratio = moe / est;
      const over30 = est > 0.3;
      return { ok: ratio < 0.5 && !over30, ratio, over30 };
    };
    const rd = relFor(rec.disabilityRate, rec.disabilityRateMoe);
    const ra = relFor(rec.ambulatoryDifficultyRate, rec.ambulatoryDifficultyRateMoe);
    rec.disabilityReliable = rd.ok;
    rec.ambulatoryReliable = ra.ok;
    rec.disabilityMoeRatio = rd.ratio;
    rec.ambulatoryMoeRatio = ra.ratio;
    rec.tractReliable = (rd.ok !== false) && (ra.ok !== false);
    rec.tractUnreliableReason =
      rd.over30 || ra.over30
        ? "estimate exceeds 30% — small-tract / group-quarters artifact suspected"
        : (rd.ok === false || ra.ok === false)
          ? "MOE ≥ 50% of estimate"
          : null;
  }

  return out;
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function median(nums) {
  const sorted = nums.filter((n) => Number.isFinite(n)).slice().sort((a, b) => a - b);
  if (!sorted.length) return null;
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}

// Origins used by every corridor layer: the site itself and its
// nearest ADA station. Missing coords are silently dropped — every
// downstream layer must be robust to zero origins.
function originsFor(site, stationById) {
  const origins = [];
  if (site.lat != null && site.lng != null) origins.push({ lat: site.lat, lng: site.lng });
  const s = site.nearestStationId ? stationById.get(site.nearestStationId) : null;
  if (s && Number.isFinite(s.lat)) origins.push(s);
  return origins;
}

// Bounding box that comfortably covers a haversine circle of `radiusMeters`
// around every origin. Used for datasets where `within_circle` isn't
// available (e.g. tree census — lat/lng are numeric but there is no
// Point column). Latitude buffer is straight; longitude buffer scales
// by cos(lat). We pad by 5% and take the union of all origin bboxes.
function unionBboxMeters(origins, radiusMeters) {
  if (!origins.length) return null;
  const dLat = (radiusMeters / 111_320) * 1.05;
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const o of origins) {
    const dLng = (radiusMeters / (111_320 * Math.cos((o.lat * Math.PI) / 180))) * 1.05;
    minLat = Math.min(minLat, o.lat - dLat);
    maxLat = Math.max(maxLat, o.lat + dLat);
    minLng = Math.min(minLng, o.lng - dLng);
    maxLng = Math.max(maxLng, o.lng + dLng);
  }
  return { minLat, maxLat, minLng, maxLng };
}

// True corridor test: is the point within radiusMeters of any origin.
function pointInCorridor(pointLat, pointLng, origins, radiusMeters) {
  for (const o of origins) {
    if (haversineMeters(pointLat, pointLng, o.lat, o.lng) <= radiusMeters) return true;
  }
  return false;
}

async function runCensusLayer(sites, perSite, pulledAt, opts = {}) {
  console.log(`\n[Layer 5: Census tract context — ${ACS_VINTAGE_LABEL} + ${LRAM_VINTAGE_LABEL}]`);
  const key = process.env.CENSUS_API_KEY || "";
  if (!key) console.warn("  warn: CENSUS_API_KEY not set — Census API may throttle or error");

  // Load LRAM (Rafy-owned preprocess output).
  const lramRaw = JSON.parse(await readFile(LRAM_PATH, "utf8"));
  const lram = lramRaw.tracts || {};
  console.log(`  LRAM tracts loaded: ${Object.keys(lram).length}`);

  // Station coords for site → nearest-ADA-station distance. Reuse if
  // Layer 1 already fetched them; otherwise fetch now (--only=5 path).
  let stationById = opts.stationById ?? null;
  if (!stationById) {
    const stations = await fetchAll(MTA_STATIONS_URL, {
      $select: "gtfs_stop_id,gtfs_latitude,gtfs_longitude",
    });
    stationById = new Map();
    for (const s of stations) {
      stationById.set(s.gtfs_stop_id, { lat: Number(s.gtfs_latitude), lng: Number(s.gtfs_longitude) });
    }
    console.log(`  MTA station coords fetched: ${stationById.size}`);
  }

  // Pull ACS for all 5 NYC counties up front (10 requests: 5 counties × 2 endpoints).
  const acsByGeoid = new Map();
  for (const c of NYC_COUNTIES) {
    const rows = await fetchAcsForCounty(c, key);
    for (const [g, r] of rows) acsByGeoid.set(g, r);
    console.log(`  ACS county ${c}: ${rows.size} tracts`);
  }

  // Citywide median ambulatory-difficulty rate across ALL NYC tracts
  // pulled — computed before the per-site loop so we can label sites
  // relative to it.
  const allAmbulatoryRates = [...acsByGeoid.values()]
    .map((r) => r.ambulatoryDifficultyRate)
    .filter((n) => Number.isFinite(n));
  const citywideAmbulatoryMedian = median(allAmbulatoryRates);
  const citywideDisabilityMedian = median(
    [...acsByGeoid.values()].map((r) => r.disabilityRate).filter((n) => Number.isFinite(n)),
  );
  console.log(
    `  citywide tract-level ambulatory-difficulty median: ${
      citywideAmbulatoryMedian != null ? (citywideAmbulatoryMedian * 100).toFixed(2) + "%" : "n/a"
    } (n=${allAmbulatoryRates.length})`,
  );

  // Reverse-geocode each site to a tract via the FCC block API.
  let sitesWithTract = 0;
  let sitesLilaVehicle = 0;
  const perSiteAmbulatory = []; // { id, name, rate, milesToAda }

  for (const site of sites) {
    if (site.lat == null || site.lng == null) {
      const entry = perSite.get(site.id) ?? {};
      entry.census = { geoid: null, error: "no coords" };
      perSite.set(site.id, entry);
      continue;
    }
    let geoid = null;
    try {
      geoid = await fetchTractGeoidForPoint(site.lat, site.lng);
    } catch (err) {
      console.warn(`  ${site.id}: FCC lookup failed — ${err.message}`);
    }
    const entry = perSite.get(site.id) ?? {};
    if (!geoid) {
      entry.census = { geoid: null, error: "no tract" };
      perSite.set(site.id, entry);
      continue;
    }
    const acs = acsByGeoid.get(geoid) ?? null;
    const lramRec = lram[geoid] ?? null;

    // Distance from site to its nearest ADA station (sites.json's
    // nearestStationId is already the nearest ADA one — build-stations.mjs
    // filters to ADA).
    let milesToAda = null;
    if (site.nearestStationId) {
      const s = stationById.get(site.nearestStationId);
      if (s && Number.isFinite(s.lat)) {
        milesToAda = haversineMiles(site.lat, site.lng, s.lat, s.lng);
      }
    }

    entry.census = {
      geoid,
      milesToAdaStation: milesToAda != null ? Number(milesToAda.toFixed(3)) : null,
      acs: acs
        ? {
            vintage: ACS_VINTAGE_LABEL,
            totalPop: acs.totalPop,
            povertyRate: acs.povertyRate,
            noVehicleRate: acs.noVehicleRate,
            medianAge: acs.medianAge,
            spanishLepRate: acs.spanishLepRate,
            disabilityRate: acs.disabilityRate,
            disabilityRateMoe: acs.disabilityRateMoe,
            ambulatoryDifficultyRate: acs.ambulatoryDifficultyRate,
            ambulatoryDifficultyRateMoe: acs.ambulatoryDifficultyRateMoe,
            tractReliable: acs.tractReliable,
            tractUnreliableReason: acs.tractUnreliableReason,
          }
        : null,
      lram: lramRec
        ? {
            vintage: LRAM_VINTAGE_LABEL,
            lilaVehicle: lramRec.lilaVehicle === 1,
            hunvFlag: lramRec.hunvFlag === 1,
            lowIncome: lramRec.lowIncome === 1,
            povertyRate: lramRec.povertyRate,
            urban: lramRec.urban === 1,
          }
        : null,
    };
    perSite.set(site.id, entry);
    sitesWithTract++;
    if (lramRec?.lilaVehicle === 1) sitesLilaVehicle++;
    perSiteAmbulatory.push({
      id: site.id,
      name: site.name,
      rate: acs?.ambulatoryDifficultyRate ?? null,
      disabilityRate: acs?.disabilityRate ?? null,
      milesToAda,
    });
  }

  // Aggregate: sites in tracts ABOVE the citywide median, and the
  // subset of those that are >0.75 mi from their nearest ADA station.
  const aboveMedian = perSiteAmbulatory
    .filter((s) => s.rate != null && citywideAmbulatoryMedian != null && s.rate > citywideAmbulatoryMedian)
    .sort((a, b) => b.rate - a.rate);
  const aboveMedianAndFar = aboveMedian.filter(
    (s) => s.milesToAda != null && s.milesToAda > ADA_DIST_ALERT_MILES,
  );

  // Small-tract / high-estimate audit. Prints raw pop, estimate, MOE, and
  // MOE/estimate ratio for any site whose ambulatory rate is > 30% and
  // always for Barretto Point Park (the user asked for that one by name).
  const auditIds = new Set(["cycle-05-ny-sfsp-0031"]); // Barretto Point Park
  const highRateAudits = perSiteAmbulatory
    .filter((s) => s.rate != null && s.rate > 0.3)
    .map((s) => s.id);
  for (const id of highRateAudits) auditIds.add(id);

  console.log("\n  Small-tract / high-estimate audit:");
  for (const id of auditIds) {
    const entry = perSite.get(id);
    const acs = entry?.census?.acs;
    const site = sites.find((s) => s.id === id);
    if (!site || !acs) {
      console.log(`    ${id} (${site?.name ?? "unknown"}): no ACS record`);
      continue;
    }
    const pct = (r) => (r == null ? "n/a" : (r * 100).toFixed(2) + "%");
    const moeR = acs.ambulatoryDifficultyRateMoe;
    const est = acs.ambulatoryDifficultyRate;
    const ratio = est != null && est > 0 && moeR != null ? (moeR / est).toFixed(2) : "n/a";
    console.log(`    ${site.name} (${id})`);
    console.log(`      tract:                    ${entry.census.geoid}`);
    console.log(`      total pop (B01001_001E):  ${acs.totalPop ?? "n/a"}`);
    console.log(`      disability     est/MOE:   ${pct(acs.disabilityRate)} / ±${pct(acs.disabilityRateMoe)}`);
    console.log(`      ambulatory     est/MOE:   ${pct(est)} / ±${pct(moeR)}   (MOE÷est=${ratio})`);
    console.log(`      tract reliable:           ${acs.tractReliable}${acs.tractUnreliableReason ? " — " + acs.tractUnreliableReason : ""}`);
  }

  console.log(`\n  sites resolved to a 2020 tract:                 ${sitesWithTract} / ${sites.length}`);
  console.log(`  sites in a LILA-vehicle tract (USDA LRAM 2019): ${sitesLilaVehicle}`);
  console.log(
    `\n  Above-citywide-median tract ambulatory-difficulty (${
      citywideAmbulatoryMedian != null ? (citywideAmbulatoryMedian * 100).toFixed(2) + "%" : "n/a"
    }): ${aboveMedian.length} of ${sites.length} sites`,
  );
  for (const s of aboveMedian) {
    console.log(
      `    ${(s.rate * 100).toFixed(1).padStart(5)}%  ${s.milesToAda != null ? s.milesToAda.toFixed(2).padStart(5) + " mi" : "  n/a"}   ${s.name}`,
    );
  }
  console.log(
    `\n  ...of which >${ADA_DIST_ALERT_MILES} mi from nearest ADA station: ${aboveMedianAndFar.length}`,
  );
  for (const s of aboveMedianAndFar) {
    console.log(
      `    ${(s.rate * 100).toFixed(1).padStart(5)}%  ${s.milesToAda.toFixed(2).padStart(5)} mi   ${s.name}`,
    );
  }

  return {
    dataset_labels: {
      acs: ACS_VINTAGE_LABEL,
      lram: LRAM_VINTAGE_LABEL,
    },
    acs_vars: ACS_VARS,
    counties: NYC_COUNTIES,
    pulled_at: pulledAt,
    citywide_ambulatory_median: citywideAmbulatoryMedian,
    citywide_disability_median: citywideDisabilityMedian,
    citywide_tract_count: allAmbulatoryRates.length,
    ada_distance_alert_miles: ADA_DIST_ALERT_MILES,
    fcc_note: "Site → tract via FCC geo.fcc.gov/api/census/block/find (2020 vintage). Tract = first 11 digits of the 15-digit block FIPS.",
    lram_note: "LILA-vehicle = Low-Income & Low-Access using the vehicle-availability threshold. Relevant for a population that does not drive.",
  };
}

// ---- Layer 6 helper: Street Tree Census -------------------------------
// The tree dataset (uvpi-gqnh) has numeric latitude/longitude columns
// but no Point column, so within_circle is unavailable. We bbox the
// query at Socrata and haversine-filter the result client-side.
async function fetchLivingTreesInBbox(bbox) {
  const params = {
    $where:
      `status = 'Alive' ` +
      `AND latitude between ${bbox.minLat} and ${bbox.maxLat} ` +
      `AND longitude between ${bbox.minLng} and ${bbox.maxLng}`,
    $select: "tree_id,latitude,longitude,tree_dbh,spc_common,health,status",
    $limit: "10000",
  };
  const rows = await fetchAll(TREES_URL, params);
  return rows.map((r) => ({
    id: r.tree_id,
    lat: Number(r.latitude),
    lng: Number(r.longitude),
    dbhInches: r.tree_dbh != null ? Number(r.tree_dbh) : null,
    species: r.spc_common ?? null,
    health: r.health ?? null,
  }));
}

async function runTreeLayer(sites, perSite, pulledAt, opts) {
  console.log(`\n[Layer 6: Street Tree Census — living trees in ${RADIUS_METERS}m corridor]`);
  console.log(`  dataset: uvpi-gqnh (2015 Street Tree Census, NYC Parks) — note the 2015 vintage`);
  const stationById = opts.stationById;
  let totalTrees = 0;
  let totalLargeTrees = 0;
  let sitesWithTrees = 0;
  let sitesWithNoOrigins = 0;

  for (const site of sites) {
    const origins = originsFor(site, stationById);
    const entry = perSite.get(site.id) ?? {};
    if (!origins.length) {
      entry.trees = { count: 0, error: "no coords" };
      perSite.set(site.id, entry);
      sitesWithNoOrigins++;
      continue;
    }
    const bbox = unionBboxMeters(origins, RADIUS_METERS);
    let count = 0;
    let largeCount = 0; // dbh >= 12 inches — a rough mature-canopy proxy
    let bySpeciesTop = [];
    try {
      const trees = await fetchLivingTreesInBbox(bbox);
      const inCorridor = trees.filter((t) => pointInCorridor(t.lat, t.lng, origins, RADIUS_METERS));
      count = inCorridor.length;
      for (const t of inCorridor) {
        if (t.dbhInches != null && t.dbhInches >= 12) largeCount++;
      }
      const bySpecies = new Map();
      for (const t of inCorridor) {
        if (!t.species) continue;
        bySpecies.set(t.species, (bySpecies.get(t.species) ?? 0) + 1);
      }
      bySpeciesTop = [...bySpecies.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([species, n]) => ({ species, count: n }));
      entry.trees = { count, largeCount, topSpecies: bySpeciesTop };
    } catch (err) {
      console.warn(`  ${site.id}: trees fetch failed — ${err.message}`);
      entry.trees = { count: 0, error: err.message };
    }
    perSite.set(site.id, entry);
    totalTrees += count;
    totalLargeTrees += largeCount;
    if (count > 0) sitesWithTrees++;
  }

  console.log(`  ${totalTrees} living trees across all corridors (${totalLargeTrees} with dbh ≥ 12")`);
  console.log(`  ${sitesWithTrees} of ${sites.length} sites have >=1 living tree in the ${RADIUS_METERS}m corridor`);
  if (sitesWithNoOrigins > 0) console.log(`  ${sitesWithNoOrigins} sites had no origins (no coord)`);
  return {
    dataset: "NYC 2015 Street Tree Census (uvpi-gqnh)",
    publisher: "NYC Department of Parks & Recreation",
    url: "https://data.cityofnewyork.us/Environment/2015-Street-Tree-Census-Tree-Data/uvpi-gqnh",
    vintage_label: "NYC Street Tree Census, 2015",
    pulled_at: pulledAt,
    note: "Counts living street trees within 300m of the site or its nearest ADA station. dbh ≥ 12\" flagged as a rough mature-canopy proxy. This is a shade / walkability signal — no temperature claim is made from it.",
  };
}

// ---- Layer 7 helper: CityBench ----------------------------------------
// Bench dataset (kuxa-tauh) exposes a `the_geom` Point column, so we
// can use Socrata's within_circle. Query per origin and merge.
async function fetchBenchesNearOrigin(origin, radiusMeters) {
  const params = {
    $where: `within_circle(the_geom, ${origin.lat}, ${origin.lng}, ${radiusMeters})`,
    $select: "benchid,latitude,longitude,benchtype,category,installati,street,address",
    $limit: "2000",
  };
  return fetchAll(BENCHES_URL, params);
}

async function runBenchLayer(sites, perSite, pulledAt, opts) {
  console.log(`\n[Layer 7: CityBench — public benches in ${RADIUS_METERS}m corridor]`);
  console.log(`  dataset: kuxa-tauh (CityBench Locations — Historical, NYC DOT)`);
  console.log(`  note: dataset labeled 'Historical' by DOT; includes bench installations that may since have been removed.`);
  const stationById = opts.stationById;
  let totalBenches = 0;
  let sitesWithAnyBench = 0;
  let sitesWithBenchAtStation = 0; // nearest bench <= 50m of station

  for (const site of sites) {
    const origins = originsFor(site, stationById);
    const entry = perSite.get(site.id) ?? {};
    if (!origins.length) {
      entry.benches = { count: 0, error: "no coords" };
      perSite.set(site.id, entry);
      continue;
    }
    const seen = new Map();
    try {
      for (const o of origins) {
        const rows = await fetchBenchesNearOrigin(o, RADIUS_METERS);
        for (const r of rows) {
          const lat = Number(r.latitude);
          const lng = Number(r.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
          if (seen.has(r.benchid)) continue;
          seen.set(r.benchid, {
            id: r.benchid,
            lat, lng,
            type: r.benchtype ?? null,
            category: r.category ?? null,
            installedAt: r.installati ?? null,
            street: r.street ?? null,
            address: r.address ?? null,
          });
        }
      }
    } catch (err) {
      console.warn(`  ${site.id}: benches fetch failed — ${err.message}`);
      entry.benches = { count: 0, error: err.message };
      perSite.set(site.id, entry);
      continue;
    }
    const benches = [...seen.values()];
    // Nearest-bench-to-station distance: this is the "range" number for
    // a rider stepping off at the ADA station.
    let nearestToStationMeters = null;
    const station = site.nearestStationId ? stationById.get(site.nearestStationId) : null;
    if (station && benches.length) {
      for (const b of benches) {
        const d = haversineMeters(b.lat, b.lng, station.lat, station.lng);
        if (nearestToStationMeters == null || d < nearestToStationMeters) nearestToStationMeters = d;
      }
    }
    // Nearest-bench-to-site (for a resting stop closer to the destination).
    let nearestToSiteMeters = null;
    if (site.lat != null && site.lng != null && benches.length) {
      for (const b of benches) {
        const d = haversineMeters(b.lat, b.lng, site.lat, site.lng);
        if (nearestToSiteMeters == null || d < nearestToSiteMeters) nearestToSiteMeters = d;
      }
    }
    entry.benches = {
      count: benches.length,
      nearestToStationMeters: nearestToStationMeters != null ? Math.round(nearestToStationMeters) : null,
      nearestToSiteMeters: nearestToSiteMeters != null ? Math.round(nearestToSiteMeters) : null,
    };
    perSite.set(site.id, entry);
    totalBenches += benches.length;
    if (benches.length > 0) sitesWithAnyBench++;
    if (nearestToStationMeters != null && nearestToStationMeters <= 50) sitesWithBenchAtStation++;
  }
  console.log(`  ${totalBenches} bench records across corridors (deduped per site)`);
  console.log(`  ${sitesWithAnyBench} of ${sites.length} sites have >=1 bench in corridor; ${sitesWithBenchAtStation} have a bench within 50m of the station`);
  return {
    dataset: "CityBench Locations — Historical (kuxa-tauh)",
    publisher: "NYC Department of Transportation",
    url: "https://data.cityofnewyork.us/Transportation/City-Bench-Locations-Historical-/kuxa-tauh",
    vintage_label: "NYC CityBench (Historical)",
    pulled_at: pulledAt,
    note: "Dataset labeled 'Historical' by DOT. Some benches may have been removed since installation; use as a range-of-rest indicator, not a guarantee.",
  };
}

// ---- Layer 8 helper: Motor Vehicle Collisions -------------------------
// h9gi-nx95 exposes a `location` (location type) column that supports
// within_circle. We filter to pedestrian-injury crashes in the last
// 24 months. Framed as crossing risk, not crime.
async function fetchPedInjuryCrashesNearOrigin(origin, radiusMeters, cutoffIso) {
  const params = {
    $where:
      `within_circle(location, ${origin.lat}, ${origin.lng}, ${radiusMeters}) ` +
      `AND crash_date >= '${cutoffIso}' ` +
      `AND number_of_pedestrians_injured > 0`,
    $select:
      "collision_id,crash_date,crash_time,latitude,longitude," +
      "number_of_pedestrians_injured,number_of_pedestrians_killed," +
      "on_street_name,cross_street_name,contributing_factor_vehicle_1",
    $limit: "5000",
  };
  return fetchAll(COLLISIONS_URL, params);
}

async function runCollisionLayer(sites, perSite, pulledAt, opts) {
  const cutoff = new Date(Date.now() - COLLISIONS_LOOKBACK_MONTHS * 30 * 86400000);
  const cutoffIso = cutoff.toISOString().slice(0, 19);
  console.log(`\n[Layer 8: Motor Vehicle Collisions — pedestrian-injury crashes, last ${COLLISIONS_LOOKBACK_MONTHS} months]`);
  console.log(`  dataset: h9gi-nx95 (NYPD Motor Vehicle Collisions - Crashes)`);
  console.log(`  cutoff: ${cutoffIso}`);
  const stationById = opts.stationById;
  let totalCrashes = 0;
  let totalPedInjured = 0;
  let totalPedKilled = 0;
  let sitesWithCrashes = 0;

  for (const site of sites) {
    const origins = originsFor(site, stationById);
    const entry = perSite.get(site.id) ?? {};
    if (!origins.length) {
      entry.pedCollisions = { count: 0, error: "no coords" };
      perSite.set(site.id, entry);
      continue;
    }
    const seen = new Map();
    try {
      for (const o of origins) {
        const rows = await fetchPedInjuryCrashesNearOrigin(o, RADIUS_METERS, cutoffIso);
        for (const r of rows) {
          if (seen.has(r.collision_id)) continue;
          const injured = Number(r.number_of_pedestrians_injured) || 0;
          const killed = Number(r.number_of_pedestrians_killed) || 0;
          seen.set(r.collision_id, {
            id: r.collision_id,
            crashDate: r.crash_date ?? null,
            pedInjured: injured,
            pedKilled: killed,
            onStreet: r.on_street_name?.trim() || null,
            crossStreet: r.cross_street_name?.trim() || null,
          });
        }
      }
    } catch (err) {
      console.warn(`  ${site.id}: collisions fetch failed — ${err.message}`);
      entry.pedCollisions = { count: 0, error: err.message };
      perSite.set(site.id, entry);
      continue;
    }
    const crashes = [...seen.values()];
    const pedInjured = crashes.reduce((n, c) => n + c.pedInjured, 0);
    const pedKilled = crashes.reduce((n, c) => n + c.pedKilled, 0);
    entry.pedCollisions = {
      count: crashes.length,
      pedInjured,
      pedKilled,
      lookbackMonths: COLLISIONS_LOOKBACK_MONTHS,
    };
    perSite.set(site.id, entry);
    totalCrashes += crashes.length;
    totalPedInjured += pedInjured;
    totalPedKilled += pedKilled;
    if (crashes.length > 0) sitesWithCrashes++;
  }
  console.log(`  ${totalCrashes} pedestrian-injury crashes across corridors — ${totalPedInjured} pedestrians injured, ${totalPedKilled} killed`);
  console.log(`  ${sitesWithCrashes} of ${sites.length} sites have >=1 pedestrian-injury crash in the ${RADIUS_METERS}m corridor`);
  return {
    dataset: "Motor Vehicle Collisions - Crashes (h9gi-nx95)",
    publisher: "NYC Police Department (NYPD)",
    url: "https://data.cityofnewyork.us/Public-Safety/Motor-Vehicle-Collisions-Crashes/h9gi-nx95",
    vintage_label: `NYPD Collisions, last ${COLLISIONS_LOOKBACK_MONTHS} months`,
    lookback_months: COLLISIONS_LOOKBACK_MONTHS,
    pulled_at: pulledAt,
    note: "Filter: number_of_pedestrians_injured > 0. This is a crossing-risk indicator based on reported crashes — not a comment on people or crime.",
  };
}

// ---- Layer 10 helper: Public Restrooms --------------------------------
// i7jb-7jku exposes a `location_1` Point column, supports within_circle.
async function fetchRestroomsNearOrigin(origin, radiusMeters) {
  const params = {
    $where: `within_circle(location_1, ${origin.lat}, ${origin.lng}, ${radiusMeters}) AND status = 'Operational'`,
    $select: "facility_name,location_type,operator,status,changing_stations,latitude,longitude",
    $limit: "1000",
  };
  return fetchAll(RESTROOMS_URL, params);
}

async function runRestroomLayer(sites, perSite, pulledAt, opts) {
  console.log(`\n[Layer 10: Public Restrooms — operational restrooms in ${RADIUS_METERS}m corridor]`);
  console.log(`  dataset: i7jb-7jku (Public Restrooms) filtered to status='Operational'`);
  const stationById = opts.stationById;
  let totalRestrooms = 0;
  let sitesWithRestroom = 0;
  let sitesWithChangingStation = 0;

  for (const site of sites) {
    const origins = originsFor(site, stationById);
    const entry = perSite.get(site.id) ?? {};
    if (!origins.length) {
      entry.restrooms = { count: 0, error: "no coords" };
      perSite.set(site.id, entry);
      continue;
    }
    const seen = new Map();
    try {
      for (const o of origins) {
        const rows = await fetchRestroomsNearOrigin(o, RADIUS_METERS);
        for (const r of rows) {
          const key = `${r.facility_name}|${r.latitude}|${r.longitude}`;
          if (seen.has(key)) continue;
          seen.set(key, {
            name: r.facility_name ?? null,
            locationType: r.location_type ?? null,
            operator: r.operator ?? null,
            changingStations: r.changing_stations === "Yes",
            lat: Number(r.latitude),
            lng: Number(r.longitude),
          });
        }
      }
    } catch (err) {
      console.warn(`  ${site.id}: restrooms fetch failed — ${err.message}`);
      entry.restrooms = { count: 0, error: err.message };
      perSite.set(site.id, entry);
      continue;
    }
    const restrooms = [...seen.values()];
    let nearestMeters = null;
    if (restrooms.length && site.lat != null && site.lng != null) {
      for (const r of restrooms) {
        if (!Number.isFinite(r.lat)) continue;
        const d = haversineMeters(r.lat, r.lng, site.lat, site.lng);
        if (nearestMeters == null || d < nearestMeters) nearestMeters = d;
      }
    }
    const hasChanging = restrooms.some((r) => r.changingStations);
    entry.restrooms = {
      count: restrooms.length,
      nearestToSiteMeters: nearestMeters != null ? Math.round(nearestMeters) : null,
      hasChangingStation: hasChanging,
    };
    perSite.set(site.id, entry);
    totalRestrooms += restrooms.length;
    if (restrooms.length > 0) sitesWithRestroom++;
    if (hasChanging) sitesWithChangingStation++;
  }
  console.log(`  ${totalRestrooms} operational restrooms across corridors (deduped per site)`);
  console.log(`  ${sitesWithRestroom} of ${sites.length} sites have >=1 operational restroom in corridor; ${sitesWithChangingStation} include a changing station`);
  return {
    dataset: "Public Restrooms (i7jb-7jku)",
    publisher: "NYC Department of Parks & Recreation (feed) + Department of Information Technology & Telecommunications",
    url: "https://data.cityofnewyork.us/Health/Public-Restrooms/i7jb-7jku",
    vintage_label: "NYC Public Restrooms — filtered to status='Operational'",
    pulled_at: pulledAt,
    note: "Operational status is what the dataset reports; it does not confirm the restroom is open at the moment of the trip.",
  };
}

function parseOnlyFlag(argv) {
  const arg = argv.find((a) => a.startsWith("--only="));
  if (!arg) return null;
  const list = arg.slice("--only=".length).split(",").map((s) => s.trim()).filter(Boolean);
  return new Set(list);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const only = parseOnlyFlag(process.argv);
  const runLayer = (id) => !only || only.has(String(id));
  const pulledAt = new Date().toISOString();

  console.log("Loading sites.json...");
  const sites = JSON.parse(await readFile(SITES_PATH, "utf8"));
  console.log(`  ${sites.length} sites`);

  // --only=<list> short-circuit: skip network-heavy Layers 1-2, run the
  // requested subset, merge into whatever overlays.json already contains.
  // Layers 5+ all need station coords, so we fetch them here once.
  if (only) {
    console.log(`\n--only=${[...only].join(",")} — merging into existing overlays.json`);
    let existing = { _meta: { sources: {} } };
    try {
      existing = JSON.parse(await readFile(OUT_PATH, "utf8"));
      existing._meta = existing._meta || {};
      existing._meta.sources = existing._meta.sources || {};
    } catch (err) {
      console.warn(`  no existing overlays.json (${err.code ?? err.message}) — will write from scratch`);
    }
    const perSite = new Map();
    for (const site of sites) {
      const prior = existing[site.id];
      perSite.set(site.id, prior ? { ...prior } : {});
    }

    // Station coords used by every Layer 5+.
    console.log("Fetching MTA station coords (for corridor origins)...");
    const stationsRaw = await fetchAll(MTA_STATIONS_URL, {
      $select: "gtfs_stop_id,gtfs_latitude,gtfs_longitude",
    });
    const stationById = new Map();
    for (const s of stationsRaw) {
      stationById.set(s.gtfs_stop_id, { lat: Number(s.gtfs_latitude), lng: Number(s.gtfs_longitude) });
    }
    console.log(`  ${stationById.size} station coords`);

    if (runLayer(5)) {
      const censusMeta = await runCensusLayer(sites, perSite, pulledAt, { stationById });
      existing._meta.sources.census_acs = {
        dataset: "American Community Survey 5-year estimates (2023)",
        publisher: "U.S. Census Bureau",
        vintage_label: ACS_VINTAGE_LABEL,
        url: "https://www.census.gov/data/developers/data-sets/acs-5year.html",
        endpoints: [CENSUS_ACS_DETAIL_URL, CENSUS_ACS_SUBJECT_URL],
        variables: ACS_VARS,
        citywide_ambulatory_median: censusMeta.citywide_ambulatory_median,
        citywide_disability_median: censusMeta.citywide_disability_median,
        citywide_tract_count: censusMeta.citywide_tract_count,
        pulled_at: pulledAt,
        note: "Never presented as current. Tract-level estimates lag by roughly two years. Detailed (B/C) and subject (S) tables are served from different endpoints.",
      };
      existing._meta.sources.usda_lram = {
        dataset: "USDA Food Access Research Atlas, 2019 data (LRAM)",
        publisher: "USDA Economic Research Service",
        vintage_label: LRAM_VINTAGE_LABEL,
        source_file: "public/data/usda-lram-2019.json (preprocess of FoodAccessResearchAtlasData2019.xlsx)",
        note: "Vehicle-flag variant retained — the successor SRAM drops it.",
        pulled_at: pulledAt,
      };
      existing._meta.sources.tract_lookup = {
        dataset: "FCC Block Find API (Census 2020 vintage)",
        url: "https://geo.fcc.gov/api/census/block/find",
        note: censusMeta.fcc_note,
        pulled_at: pulledAt,
      };
    }

    if (runLayer(6)) {
      const meta = await runTreeLayer(sites, perSite, pulledAt, { stationById });
      existing._meta.sources.trees = meta;
    }
    if (runLayer(7)) {
      const meta = await runBenchLayer(sites, perSite, pulledAt, { stationById });
      existing._meta.sources.benches = meta;
    }
    if (runLayer(8)) {
      const meta = await runCollisionLayer(sites, perSite, pulledAt, { stationById });
      existing._meta.sources.pedCollisions = meta;
    }
    if (runLayer(10)) {
      const meta = await runRestroomLayer(sites, perSite, pulledAt, { stationById });
      existing._meta.sources.restrooms = meta;
    }

    const out = { ...existing };
    for (const site of sites) out[site.id] = perSite.get(site.id) ?? {};
    if (dryRun) {
      console.log("\n--dry-run set; not writing file.");
      return;
    }
    await mkdir(dirname(OUT_PATH), { recursive: true });
    await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
    console.log(`\nWrote ${OUT_PATH}`);
    return;
  }

  console.log("Fetching MTA subway stations for coord lookup...");
  const stations = await fetchAll(MTA_STATIONS_URL, { $select: "gtfs_stop_id,gtfs_latitude,gtfs_longitude" });
  const stationById = new Map();
  for (const s of stations) {
    stationById.set(s.gtfs_stop_id, { lat: Number(s.gtfs_latitude), lng: Number(s.gtfs_longitude) });
  }
  console.log(`  ${stationById.size} stations indexed`);

  // ---- Layer 1: Libraries ------------------------------------------------
  console.log("\n[Layer 1: Libraries — Facilities DB, facsubgrp='PUBLIC LIBRARIES']");
  const librariesRaw = await fetchAll(FACILITIES_URL, {
    $where: "facsubgrp = 'PUBLIC LIBRARIES'",
    $select: "uid,facname,address,city,boro,zipcode,latitude,longitude,opname,factype",
  });
  console.log(`  fetched ${librariesRaw.length} library rows`);

  const librariesNormalized = librariesRaw
    .map((r) => ({
      id: r.uid,
      name: r.facname,
      system: systemLabelFor(r.opname),
      operator: r.opname ?? null,
      address: [r.address, r.city, r.zipcode].filter(Boolean).join(", "),
      borough: r.boro ?? null,
      lat: Number(r.latitude),
      lng: Number(r.longitude),
    }))
    .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng));

  // Cross-check: is any library also a meal site? (coord-based within ~60m)
  const mealSitePoints = sites
    .filter((s) => s.lat != null && s.lng != null)
    .map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng }));
  let overlapCount = 0;
  for (const lib of librariesNormalized) {
    let matched = null;
    for (const site of mealSitePoints) {
      if (haversineMeters(lib.lat, lib.lng, site.lat, site.lng) <= MEAL_SITE_MATCH_METERS) {
        matched = site;
        break;
      }
    }
    if (matched) {
      lib.isMealSite = true;
      lib.mealSiteId = matched.id;
      overlapCount++;
    }
  }
  console.log(`  ${overlapCount} libraries overlap with a meal site (within ${MEAL_SITE_MATCH_METERS}m)`);

  // Per-site library corridor: 300m around site AND its nearest ADA station.
  const perSite = new Map();
  let totalCorridorHits = 0;
  for (const site of sites) {
    const origins = [];
    if (site.lat != null && site.lng != null) origins.push({ lat: site.lat, lng: site.lng });
    const stationCoord = site.nearestStationId ? stationById.get(site.nearestStationId) : null;
    if (stationCoord && Number.isFinite(stationCoord.lat)) origins.push(stationCoord);

    const nearby = [];
    for (const lib of librariesNormalized) {
      if (withinAny(lib, origins, RADIUS_METERS)) {
        const distMeters = nearestOriginMeters(lib, origins);
        nearby.push({
          id: lib.id,
          name: lib.name,
          system: lib.system,
          operator: lib.operator,
          address: lib.address,
          lat: lib.lat,
          lng: lib.lng,
          borough: lib.borough,
          distanceMeters: distMeters != null ? Math.round(distMeters) : null,
          isMealSite: lib.isMealSite === true,
          mealSiteId: lib.mealSiteId ?? null,
        });
      }
    }
    nearby.sort((a, b) => (a.distanceMeters ?? 0) - (b.distanceMeters ?? 0));
    perSite.set(site.id, { libraries: nearby });
    totalCorridorHits += nearby.length;
  }
  console.log(`  ${totalCorridorHits} total library-in-corridor hits across all sites`);
  const withHits = [...perSite.values()].filter((v) => v.libraries.length > 0).length;
  console.log(`  ${withHits} of ${sites.length} sites have >=1 library within the ${RADIUS_METERS}m corridor`);

  // ---- Layer 2: 311 complaints (elevator / sidewalk / curb / scaffold) --
  console.log(`\n[Layer 2: 311 — last ${NYC311_LOOKBACK_DAYS} days, target complaint types]`);
  console.log(`  types included: ${NYC311_TARGET_TYPES.map((t) => JSON.stringify(t)).join(", ")}`);
  const cutoff = new Date(Date.now() - NYC311_LOOKBACK_DAYS * 86400000);
  const cutoffIso = cutoff.toISOString().slice(0, 19); // Socrata literal
  const typeList = NYC311_TARGET_TYPES.map((t) => `'${t.toLowerCase()}'`).join(",");

  let complaint311Total = 0;
  let sitesWith311 = 0;

  for (const site of sites) {
    if (site.lat == null || site.lng == null) {
      const entry = perSite.get(site.id) ?? { libraries: [] };
      entry.complaints311 = { total: 0, byType: {}, byAgency: {}, byTypeDetail: {}, samples: [] };
      perSite.set(site.id, entry);
      continue;
    }
    const origins = [];
    origins.push({ lat: site.lat, lng: site.lng });
    const stationCoord = site.nearestStationId ? stationById.get(site.nearestStationId) : null;
    if (stationCoord && Number.isFinite(stationCoord.lat)) origins.push(stationCoord);

    // Single request per site: OR across up to two within_circle predicates.
    const circles = origins
      .map((o) => `within_circle(location, ${o.lat}, ${o.lng}, ${RADIUS_METERS})`)
      .join(" OR ");
    const where = `created_date > '${cutoffIso}' AND lower(complaint_type) in (${typeList}) AND (${circles})`;
    const url = new URL(NYC311_URL);
    // agency + descriptor now captured for the per-type breakdown.
    url.searchParams.set("$select", "unique_key,complaint_type,descriptor,status,created_date,agency,agency_name,incident_address");
    url.searchParams.set("$where", where);
    url.searchParams.set("$order", "created_date DESC");
    url.searchParams.set("$limit", "500");

    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  ${site.id}: 311 fetch failed HTTP ${res.status}`);
      const entry = perSite.get(site.id) ?? { libraries: [] };
      entry.complaints311 = { total: 0, byType: {}, byAgency: {}, byTypeDetail: {}, samples: [], error: `HTTP ${res.status}` };
      perSite.set(site.id, entry);
      continue;
    }
    const rows = await res.json();

    // Aggregate — total by type, agency across all types, and a per-type
    // breakdown carrying its own agency + descriptor tallies.
    const byType = {};
    const byAgency = {};
    const byTypeDetail = {};
    for (const r of rows) {
      // Normalize type casing so "Elevator" and "ELEVATOR" merge cleanly.
      const key = String(r.complaint_type ?? "").replace(/\s+/g, " ").trim().toLowerCase();
      const canonical =
        NYC311_TARGET_TYPES.find((t) => t.toLowerCase() === key) ?? r.complaint_type ?? "Unknown";
      const agency = r.agency ?? "?";
      const descriptor = r.descriptor ?? "(no descriptor)";

      byType[canonical] = (byType[canonical] ?? 0) + 1;
      byAgency[agency] = (byAgency[agency] ?? 0) + 1;

      if (!byTypeDetail[canonical]) byTypeDetail[canonical] = { count: 0, byAgency: {}, byDescriptor: {} };
      const detail = byTypeDetail[canonical];
      detail.count++;
      detail.byAgency[agency] = (detail.byAgency[agency] ?? 0) + 1;
      detail.byDescriptor[descriptor] = (detail.byDescriptor[descriptor] ?? 0) + 1;
    }
    const samples = rows.slice(0, 5).map((r) => ({
      key: r.unique_key,
      type: r.complaint_type,
      descriptor: r.descriptor ?? null,
      status: r.status ?? null,
      createdAt: r.created_date,
      address: r.incident_address ?? null,
      agency: r.agency ?? null,
    }));

    const entry = perSite.get(site.id) ?? { libraries: [] };
    entry.complaints311 = { total: rows.length, byType, byAgency, byTypeDetail, samples };
    perSite.set(site.id, entry);

    complaint311Total += rows.length;
    if (rows.length > 0) sitesWith311++;
  }

  console.log(`  ${complaint311Total} complaints across all corridors`);
  console.log(`  ${sitesWith311} of ${sites.length} sites have >=1 complaint in the ${RADIUS_METERS}m corridor`);

  // ---- Layer 5: Census tract context (ACS 2023 + LRAM 2019) -------------
  const censusMeta = await runCensusLayer(sites, perSite, pulledAt, { stationById });

  // ---- Layer 6: Street Tree Census (uvpi-gqnh) --------------------------
  const treesMeta = await runTreeLayer(sites, perSite, pulledAt, { stationById });

  // ---- Layer 7: CityBench (kuxa-tauh) -----------------------------------
  const benchesMeta = await runBenchLayer(sites, perSite, pulledAt, { stationById });

  // ---- Layer 8: Motor Vehicle Collisions (h9gi-nx95) --------------------
  const pedCollisionsMeta = await runCollisionLayer(sites, perSite, pulledAt, { stationById });

  // ---- Layer 9: (skipped — see header note) -----------------------------

  // ---- Layer 10: Public Restrooms (i7jb-7jku) ---------------------------
  const restroomsMeta = await runRestroomLayer(sites, perSite, pulledAt, { stationById });

  // ---- Assemble overlays.json -------------------------------------------
  const out = {
    _meta: {
      generated_at: pulledAt,
      radius_meters: RADIUS_METERS,
      sources: {
        libraries: {
          dataset: "NYC Facilities Database (ji82-xba5)",
          publisher: "NYC Department of City Planning",
          filter: "facsubgrp = 'PUBLIC LIBRARIES'",
          url: "https://data.cityofnewyork.us/City-Government/Facilities-Database/ji82-xba5",
          pulled_at: pulledAt,
          note: "Fetched full set (~227 rows) and filtered per-site with haversine. The geometry column is text (WKT), not a Socrata Point, so within_circle is unsupported on this dataset — the fallback is equivalent.",
          systems_included: ["NYPL (Manhattan / Bronx / Staten Island)", "BPL (Brooklyn)", "QPL (Queens)"],
        },
        stations_lookup: {
          dataset: "MTA Subway Stations (39hk-dx4f)",
          publisher: "MTA, via NY State Open Data",
          url: "https://data.ny.gov/Transportation/MTA-Subway-Stations/39hk-dx4f",
          pulled_at: pulledAt,
          note: "Used only for gtfs_stop_id → (lat, lng) lookup so the corridor search can query around the site's nearest ADA station too.",
        },
        complaints311: {
          dataset: "NYC 311 Service Requests (erm2-nwe9)",
          publisher: "NYC Department of Information Technology & Telecommunications (DoITT)",
          url: "https://data.cityofnewyork.us/Social-Services/311-Service-Requests-from-2010-to-Present/erm2-nwe9",
          pulled_at: pulledAt,
          lookback_days: NYC311_LOOKBACK_DAYS,
          filter: `complaint_type in (${NYC311_TARGET_TYPES.map((t) => JSON.stringify(t)).join(", ")}) AND within_circle(location, siteOrStation, ${RADIUS_METERS}m)`,
          note: "Per-site query uses Socrata within_circle() OR'd across the site coord and its nearest ADA station coord. Complaint types are matched case-insensitively so 'Elevator' and 'ELEVATOR' merge. Elevator complaints in this feed are DOB/HPD building elevators — NOT transit elevators. MTA elevator status is a separate feed.",
        },
        census_acs: {
          dataset: "American Community Survey 5-year estimates (2023)",
          publisher: "U.S. Census Bureau",
          vintage_label: ACS_VINTAGE_LABEL,
          url: "https://www.census.gov/data/developers/data-sets/acs-5year.html",
          endpoints: [CENSUS_ACS_DETAIL_URL, CENSUS_ACS_SUBJECT_URL],
          variables: ACS_VARS,
          citywide_ambulatory_median: censusMeta.citywide_ambulatory_median,
          citywide_disability_median: censusMeta.citywide_disability_median,
          citywide_tract_count: censusMeta.citywide_tract_count,
          pulled_at: pulledAt,
          note: "Never presented as current. Tract-level estimates lag by roughly two years. Detailed (B/C) and subject (S) tables are served from different endpoints.",
        },
        usda_lram: {
          dataset: "USDA Food Access Research Atlas, 2019 data (LRAM)",
          publisher: "USDA Economic Research Service",
          vintage_label: LRAM_VINTAGE_LABEL,
          source_file: "public/data/usda-lram-2019.json (preprocess of FoodAccessResearchAtlasData2019.xlsx)",
          note: "Vehicle-flag variant retained — the successor SRAM drops it.",
          pulled_at: pulledAt,
        },
        tract_lookup: {
          dataset: "FCC Block Find API (Census 2020 vintage)",
          url: "https://geo.fcc.gov/api/census/block/find",
          note: "Site → tract via first 11 digits of the returned 15-digit block FIPS.",
          pulled_at: pulledAt,
        },
        trees: treesMeta,
        benches: benchesMeta,
        pedCollisions: pedCollisionsMeta,
        restrooms: restroomsMeta,
      },
    },
  };
  for (const site of sites) {
    out[site.id] = perSite.get(site.id) ?? { libraries: [] };
  }

  if (dryRun) {
    console.log("\n--dry-run set; not writing file.");
    return;
  }
  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
