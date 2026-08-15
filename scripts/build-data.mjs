#!/usr/bin/env node
// Fetch the NYC Free Summer Meals site list from the USDA FNS
// Meals-for-Kids Site Finder (2026) and normalize it to the sites.json
// contract defined in CLAUDE.md.
//
// Filters to public-access sites (Site_Type OPEN or OPEN RESTRICTED),
// then caps output at 40: keeps all Saturday sites first and fills
// the remainder round-robin across the five boroughs.
//
// Usage:
//   node scripts/build-data.mjs           # fetch, print diagnostics, write file
//   node scripts/build-data.mjs --dry-run # fetch, print diagnostics, no write

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_PATH = resolve(HERE, "..", "public", "data", "sites.json");

const SERVICE = "Summer_Meals_Site_Finder_2026_(Testing)/FeatureServer/0";
const BASE = `https://services1.arcgis.com/RLQu0rK7h4kbsBq5/arcgis/rest/services/${encodeURI(SERVICE)}/query`;

const COUNTY_TO_BOROUGH = {
  "New York County": "Manhattan",
  "Kings County": "Brooklyn",
  "Queens County": "Queens",
  "Bronx County": "Bronx",
  "Richmond County": "Staten Island",
};
const BOROUGHS = ["Bronx", "Brooklyn", "Manhattan", "Queens", "Staten Island"];

const WHERE = `UPPER(state)='NY' AND County IN (${Object.keys(COUNTY_TO_BOROUGH).map((c) => `'${c}'`).join(",")})`;
const ALLOWED_SITE_TYPES = new Set(["OPEN", "OPEN RESTRICTED"]);
const OUTPUT_CAP = 40;
const PAGE = 2000;

// Source uses week-starts-Sunday convention: S=Sun, SA=Sat.
// SU accepted as a fallback for Sun.
const DAY_TOKENS = { SU: "Sun", TH: "Thu", SA: "Sat", S: "Sun", M: "Mon", T: "Tue", W: "Wed", F: "Fri" };
const DAY_ORDER = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
// Longest first so greedy matcher takes TH before T, SA before S, etc.
const DAY_KEYS_BY_LEN = Object.keys(DAY_TOKENS).sort((a, b) => b.length - a.length);

async function fetchAll() {
  const all = [];
  let offset = 0;
  while (true) {
    const url = new URL(BASE);
    url.searchParams.set("where", WHERE);
    url.searchParams.set("outFields", "*");
    url.searchParams.set("returnGeometry", "false");
    url.searchParams.set("resultRecordCount", String(PAGE));
    url.searchParams.set("resultOffset", String(offset));
    url.searchParams.set("orderByFields", "FID");
    url.searchParams.set("f", "json");

    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} from ArcGIS`);
    const body = await res.json();
    if (body.error) throw new Error(`ArcGIS error: ${JSON.stringify(body.error)}`);

    const feats = body.features ?? [];
    all.push(...feats);
    if (!body.exceededTransferLimit || feats.length === 0) break;
    offset += feats.length;
  }
  return all;
}

// Greedy longest-match parse for a single (possibly malformed) token like
// "TWTHF" or "FSA". Unrecognized characters are dropped.
function parseDayToken(token) {
  const days = [];
  let i = 0;
  while (i < token.length) {
    let matched = null;
    for (const key of DAY_KEYS_BY_LEN) {
      if (token.startsWith(key, i)) { matched = key; break; }
    }
    if (matched) {
      days.push(DAY_TOKENS[matched]);
      i += matched.length;
    } else {
      i += 1; // drop unrecognized char
    }
  }
  return days;
}

function parseDays(csv) {
  if (!csv) return [];
  const days = new Set();
  for (const raw of csv.split(",")) {
    const t = raw.trim().toUpperCase();
    if (!t) continue;
    for (const d of parseDayToken(t)) days.add(d);
  }
  return [...days].sort((a, b) => DAY_ORDER[a] - DAY_ORDER[b]);
}

function buildHours(a) {
  const parts = [];
  if (a.Breakfast_Time2) parts.push(`Breakfast ${a.Breakfast_Time2}`);
  if (a.Lunch_Time2) parts.push(`Lunch ${a.Lunch_Time2}`);
  if (a.Snack_Time_AM2) parts.push(`Snack (AM) ${a.Snack_Time_AM2}`);
  if (a.Snack_Time_PM2) parts.push(`Snack (PM) ${a.Snack_Time_PM2}`);
  if (a.Dinner_Supper_Time2) parts.push(`Dinner ${a.Dinner_Supper_Time2}`);
  return parts.join(", ") || null;
}

function buildAddress(a) {
  const line1 = [a.Site_Address1, a.Site_Address2].filter(Boolean).join(" ");
  const cityState = [a.Site_City, a.Site_State].filter(Boolean).join(", ");
  return [line1, cityState, a.Site_Zip].filter(Boolean).join(", ");
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalize(feature) {
  const a = feature.attributes;
  const rawId = a.MasterID ?? String(a.FID);
  return {
    id: slugify(rawId),
    name: a.Site_Name ?? null,
    address: buildAddress(a),
    lat: typeof a.Y === "number" ? a.Y : null,
    lng: typeof a.X === "number" ? a.X : null,
    phone: a.Site_Phone ?? a.Contact_Phone ?? null,
    siteType: a.Site_Type ?? null,
    ageMin: 1,
    ageMax: 18,
    daysOpen: parseDays(a.Days_of_operation),
    hoursText: buildHours(a),
    nearestStationId: null,
    entranceStepFree: null,
    verifiedBy: null,
    verifiedAt: null,
  };
}

// Selection: (1) include every site whose daysOpen contains "Sat", then
// (2) fill remaining slots round-robin across the five boroughs from the
// non-Saturday pool. Deterministic ordering within each borough by id.
function selectRows(rows, borough, cap) {
  const withSat = rows.filter((r) => r.daysOpen.includes("Sat"));
  const withoutSat = rows.filter((r) => !r.daysOpen.includes("Sat"));

  const selected = [];
  const seen = new Set();
  const take = (r) => { if (!seen.has(r.id)) { seen.add(r.id); selected.push(r); } };

  for (const r of withSat) {
    if (selected.length >= cap) break;
    take(r);
  }

  const pools = new Map(BOROUGHS.map((b) => [b, []]));
  for (const r of withoutSat) {
    const b = borough.get(r.id);
    if (pools.has(b)) pools.get(b).push(r);
  }
  for (const b of BOROUGHS) pools.get(b).sort((a, b2) => a.id.localeCompare(b2.id));

  let progressed = true;
  while (selected.length < cap && progressed) {
    progressed = false;
    for (const b of BOROUGHS) {
      if (selected.length >= cap) break;
      const pool = pools.get(b);
      if (pool.length > 0) {
        take(pool.shift());
        progressed = true;
      }
    }
  }
  return selected;
}

function countByBorough(rows, borough) {
  const counts = Object.fromEntries(BOROUGHS.map((b) => [b, 0]));
  counts["(unknown)"] = 0;
  for (const r of rows) {
    const b = borough.get(r.id) ?? "(unknown)";
    counts[b] = (counts[b] ?? 0) + 1;
  }
  return counts;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  const sourceUrl = `${BASE}?where=${encodeURIComponent(WHERE)}&outFields=*&f=json`;
  console.log("Source URL:");
  console.log(" ", sourceUrl);
  console.log();

  const features = await fetchAll();
  if (features.length === 0) {
    console.error("No features returned. Aborting.");
    process.exit(1);
  }

  console.log("Raw shape of first record (source attributes):");
  console.log(JSON.stringify(features[0].attributes, null, 2));
  console.log();

  // Filter first, then normalize. Keep borough lookup keyed on the
  // normalized (slugified) id so selection helpers stay simple.
  const filtered = features.filter((f) => ALLOWED_SITE_TYPES.has(f.attributes.Site_Type));
  console.log(`After siteType filter (OPEN, OPEN RESTRICTED): ${filtered.length}`);

  const borough = new Map();
  const normalized = filtered.map((f) => {
    const row = normalize(f);
    borough.set(row.id, COUNTY_TO_BOROUGH[f.attributes.County] ?? "(unknown)");
    return row;
  });

  const satCount = normalized.filter((r) => r.daysOpen.includes("Sat")).length;
  console.log(`Sites with Saturday hours: ${satCount}`);
  console.log();

  const selected = selectRows(normalized, borough, OUTPUT_CAP);
  const breakdown = countByBorough(selected, borough);

  console.log(`Selected rows: ${selected.length}`);
  console.log("Borough breakdown:");
  for (const b of BOROUGHS) console.log(`  ${b.padEnd(14)} ${breakdown[b]}`);
  if (breakdown["(unknown)"]) console.log(`  ${"(unknown)".padEnd(14)} ${breakdown["(unknown)"]}`);
  console.log();

  if (dryRun) {
    console.log("--dry-run set; not writing file.");
    return;
  }

  await mkdir(dirname(OUT_PATH), { recursive: true });
  await writeFile(OUT_PATH, JSON.stringify(selected, null, 2) + "\n", "utf8");
  console.log(`Wrote ${selected.length} rows to ${OUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
