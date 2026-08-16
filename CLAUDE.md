# Build rules

Two developers are working in this repo simultaneously.

## File ownership - STRICT
Rafy owns: scripts/, public/data/, src/lib/verdict.js
Chris owns: src/ (except src/lib/verdict.js), index.html, config files

You may ONLY edit files owned by your operator. Never edit, reformat,
refactor, or "clean up" a file outside your ownership. If a change seems
needed in the other person's files, stop and say so instead of editing.

Never edit package.json. Ask the operator to request it verbally.

## Data contract - FROZEN
public/data/sites.json is an array of:
{ id, name, address, lat, lng, phone, siteType, ageMin, ageMax,
  daysOpen, hoursText, nearestStationId, entranceStepFree,
  verifiedBy, verifiedAt, seasonStartAt, seasonEndAt }

seasonStartAt and seasonEndAt are ISO 8601 strings sourced from the
FNS record's Start_date / End_date. verdict.js returns red outside
that window.

public/data/stations.json is keyed by GTFS stop id:
{ name, routes, line, borough, lat, lng,
  ada, adaDirectionNotes, elevators: [{ id, servingDescription,
  onAdaPath, inService }] }

name is stop_name from 39hk-dx4f. routes is daytime_routes split on
whitespace into an array (e.g. ["B", "Q", "S"]). line is the MTA
line label. borough is the full name expanded from the single-letter
code. lat/lng are the GTFS station coords, used to draw the
straight-line site→station link when a result card is expanded.
These six display fields exist so the UI can render
"Prospect Park (B, Q, S)" instead of "D28"; the GTFS id remains
the key.

Do not change these shapes. Do not add fields.

## Scope
No auth. No backend. No database. Static JSON + client fetch only.
Every accessibility claim renders with its provenance visible.
Never assert a site is accessible without verifiedBy and verifiedAt.

## Ownership update
Rafy also owns: nlq.html, api/, scripts/, src/lib/filter.js
Chris still owns: nypl.html, src/ (except src/lib/), config files
nlq.html is a parallel prototype. Do not edit nypl.html.

## Scope update
One serverless function permitted: api/parse.js, for LLM query parsing only.
Never put an API key in client code.

## UI language
Machine identifiers never appear in a sentence a user reads. GTFS stop ids,
elevator equipment codes, tract GEOIDs, site ids, and raw dataset field values
stay in the JSON and may appear only in small monospace provenance suffixes.
If a string would confuse someone who has never seen the underlying dataset,
render a human equivalent and keep the raw value in a title attribute.
