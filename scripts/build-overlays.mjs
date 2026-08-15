#!/usr/bin/env node
// Build public/data/overlays.json — the "Along the way" contextual layer.
// Keyed by site id. Additive to sites.json / stations.json — everything
// here is context, not a verdict input. If this file fails to load, the
// rest of the map must still work.
//
// Layer build order (do one at a time, verify render, then extend):
//   [x] 1. Libraries (NYPL + BPL + QPL, via Facilities Database)
//   [ ] 2. 311 elevator/sidewalk/curb-cut/scaffolding complaints (90d)
//   [ ] 3. Cooling centers
//   [ ] 4. Film permits (date-scoped)
//
// Usage:
//   node scripts/build-overlays.mjs           # fetch, print, write
//   node scripts/build-overlays.mjs --dry-run # fetch, print, no write

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITES_PATH = resolve(HERE, "..", "public", "data", "sites.json");
const OUT_PATH = resolve(HERE, "..", "public", "data", "overlays.json");

const FACILITIES_URL = "https://data.cityofnewyork.us/resource/ji82-xba5.json";
const MTA_STATIONS_URL = "https://data.ny.gov/resource/39hk-dx4f.json";
const NYC311_URL = "https://data.cityofnewyork.us/resource/erm2-nwe9.json";
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
  u.searchParams.set("$limit", "50000");
  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${u}`);
  return res.json();
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

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const pulledAt = new Date().toISOString();

  console.log("Loading sites.json...");
  const sites = JSON.parse(await readFile(SITES_PATH, "utf8"));
  console.log(`  ${sites.length} sites`);

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
