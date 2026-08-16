#!/usr/bin/env node
// Build public/data/stations.json (keyed by GTFS stop_id) from two MTA
// open-data feeds, and stamp public/data/sites.json with each site's
// nearest ADA station.
//
// Contract extension (2026-08-16): each station record now also carries
// name, routes (array), line, and borough so the UI can render
// "Prospect Park (B, Q, S)" instead of "D28". The GTFS id remains the
// key and is shown only in monospace provenance suffixes. Adding
// display-only fields is compatible with the original frozen shape:
// ada, adaDirectionNotes, elevators[] are unchanged.
//
// Sources:
//   Stations w/ ADA + coords: data.ny.gov 39hk-dx4f
//   Elevator asset inventory: data.ny.gov 94fv-bak7 (updated ~daily;
//                             service_status_code = IFIS/IFOS/INOS/RNOS)
//
// Only elevators (not escalators) are emitted, per the frozen
// stations.json contract in CLAUDE.md.
//
// Usage:
//   node scripts/build-stations.mjs           # fetch, write, print
//   node scripts/build-stations.mjs --dry-run # fetch, print, no writes

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SITES_PATH = resolve(HERE, "..", "public", "data", "sites.json");
const STATIONS_PATH = resolve(HERE, "..", "public", "data", "stations.json");

const STATIONS_URL = "https://data.ny.gov/resource/39hk-dx4f.json";
const EQUIPMENT_URL = "https://data.ny.gov/resource/94fv-bak7.json";

const DIST_ALERT_MILES = 0.75;

async function fetchJson(url, params) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params ?? {})) u.searchParams.set(k, v);
  u.searchParams.set("$limit", "10000");
  const res = await fetch(u);
  if (!res.ok) throw new Error(`HTTP ${res.status} ${u}`);
  return res.json();
}

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.7613; // earth radius in miles
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// MTA borough single-letter code -> full name for the human-facing label.
const BOROUGH_NAME = { M: "Manhattan", Bk: "Brooklyn", Q: "Queens", Bx: "Bronx", SI: "Staten Island" };

// daytime_routes ships as a whitespace-separated list, e.g. "N W" or
// "B Q S". Split and trim.
function parseRoutes(raw) {
  if (!raw || typeof raw !== "string") return [];
  return raw.trim().split(/\s+/).filter(Boolean);
}

// Build the adaDirectionNotes string for a partially-accessible (ada=2)
// station, using the north/south direction labels supplied by the
// stations feed.
function buildDirectionNotes(s) {
  if (s.ada !== "2") return null;
  const parts = [];
  if (s.ada_northbound === "1" && s.north_direction_label) {
    parts.push(`Accessible ${s.north_direction_label} (northbound)`);
  }
  if (s.ada_southbound === "1" && s.south_direction_label) {
    parts.push(`Accessible ${s.south_direction_label} (southbound)`);
  }
  if (parts.length === 0) return "Partial ADA access; direction details unavailable";
  return parts.join("; ");
}

function normalizeElevator(e) {
  return {
    id: e.equipment_code,
    servingDescription: e.notes || e.station_description || null,
    onAdaPath: e.ada_compliant === "YES",
    inService: e.service_status_code === "IFIS",
  };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("Fetching MTA subway stations (ADA=1 or 2)...");
  const stationsRaw = await fetchJson(STATIONS_URL, { $where: "ada in ('1','2')" });
  console.log(`  ${stationsRaw.length} accessible stations`);

  console.log("Fetching MTA elevator/escalator asset inventory (elevators only)...");
  const equipRaw = await fetchJson(EQUIPMENT_URL, { elevator_or_escalator: "Elevator" });
  console.log(`  ${equipRaw.length} elevator records`);

  const stationsByComplex = new Map(); // complex_mrn -> [station rows]
  for (const s of stationsRaw) {
    const key = s.complex_id ?? s.station_id;
    if (!stationsByComplex.has(key)) stationsByComplex.set(key, []);
    stationsByComplex.get(key).push(s);
  }

  const elevatorsByComplex = new Map(); // complex_mrn -> [elevator rows]
  for (const e of equipRaw) {
    const key = e.station_complex_mrn ?? e.station_mrn;
    if (!elevatorsByComplex.has(key)) elevatorsByComplex.set(key, []);
    elevatorsByComplex.get(key).push(e);
  }

  const stations = {};
  const stationPoints = []; // [{ id, lat, lng, name }]
  for (const s of stationsRaw) {
    const complexKey = s.complex_id ?? s.station_id;
    const elevators = (elevatorsByComplex.get(complexKey) ?? []).map(normalizeElevator);
    stations[s.gtfs_stop_id] = {
      name: s.stop_name ?? null,
      routes: parseRoutes(s.daytime_routes),
      line: s.line ?? null,
      borough: s.borough ? (BOROUGH_NAME[s.borough] ?? s.borough) : null,
      ada: Number(s.ada),
      adaDirectionNotes: buildDirectionNotes(s),
      elevators,
    };
    stationPoints.push({
      id: s.gtfs_stop_id,
      name: s.stop_name,
      lat: Number(s.gtfs_latitude),
      lng: Number(s.gtfs_longitude),
    });
  }

  const outOfService = Object.values(stations).reduce(
    (n, st) => n + st.elevators.filter((e) => !e.inService).length,
    0,
  );
  const totalElevators = Object.values(stations).reduce((n, st) => n + st.elevators.length, 0);
  console.log(`  stations.json: ${Object.keys(stations).length} keys, ${totalElevators} elevators (${outOfService} not in service)`);

  console.log("\nLoading sites.json and computing nearest station...");
  const sites = JSON.parse(await readFile(SITES_PATH, "utf8"));

  const results = sites.map((site) => {
    let best = null;
    for (const p of stationPoints) {
      const d = haversineMiles(site.lat, site.lng, p.lat, p.lng);
      if (!best || d < best.d) best = { d, id: p.id, name: p.name };
    }
    return { site, nearest: best };
  });

  const updatedSites = results.map(({ site, nearest }) => ({
    ...site,
    nearestStationId: nearest?.id ?? null,
  }));

  const farSites = results
    .filter((r) => r.nearest && r.nearest.d > DIST_ALERT_MILES)
    .sort((a, b) => b.nearest.d - a.nearest.d);

  console.log(`  ${results.length} sites matched to a nearest ADA station.`);
  console.log(`\nSites whose nearest ADA station is over ${DIST_ALERT_MILES} miles away: ${farSites.length}`);
  for (const { site, nearest } of farSites) {
    console.log(
      `  ${nearest.d.toFixed(2)} mi  ${site.name}  ->  ${nearest.name} (${nearest.id})`,
    );
  }

  if (dryRun) {
    console.log("\n--dry-run set; not writing files.");
    return;
  }

  await mkdir(dirname(STATIONS_PATH), { recursive: true });
  await writeFile(STATIONS_PATH, JSON.stringify(stations, null, 2) + "\n", "utf8");
  await writeFile(SITES_PATH, JSON.stringify(updatedSites, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${STATIONS_PATH}`);
  console.log(`Wrote ${SITES_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
