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
  verifiedBy, verifiedAt }

public/data/stations.json is keyed by GTFS stop id:
{ ada, adaDirectionNotes, elevators: [{ id, servingDescription,
  onAdaPath, inService }] }

Do not change these shapes. Do not add fields.

## Scope
No auth. No backend. No database. Static JSON + client fetch only.
Every accessibility claim renders with its provenance visible.
Never assert a site is accessible without verifiedBy and verifiedAt.
