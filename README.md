# Can I Actually Get There?

An accessibility-aware map of NYC free summer meal sites.

**Live:** https://nypl-hackathon.vercel.app/public/nlq.html
**Built at:** "Built for NYC" AI Hackathon — New York Public Library + Major League Hacking, Stavros Niarchos Foundation Library, August 15–16, 2026

---

## The problem

Every civic directory in New York tells you *where* a resource is. None of them tell you whether you can actually reach it.

A food pantry, a summer meal site, a housing counselor — the address is public data. Whether the elevator at the station serving it is working today, whether the entrance has steps, whether the building's own elevator is out and the family can't even leave home: none of that is in any dataset, anywhere.

This app joins the transit half (which is knowable) to the destination half (which mostly isn't) and is explicit about which is which.

---

## What it does

**Verdict per site.** Every meal site renders green, amber, or red, based on:

- whether the site's season is currently open (per-site dates from the USDA feed)
- whether the site operates on the selected date
- whether the nearest ADA-accessible station's step-free path elevators are in service
- whether the entrance has been verified step-free by a human

**Provenance on every claim.** Tap any site and you see not just the verdict but every reason behind it and the source and date of every input. No claim appears without its origin.

**Nothing is green.** Green requires human verification, and no site in this dataset has been verified by a human. That is not a bug — it is the finding. The verification layer this product needs does not exist anywhere in New York City.

**Multilingual natural-language search.** Ask in any language. The query is parsed for need, age groups, dietary flags, accessibility needs, and urgency. UI strings switch to the detected language (en, es, zh, bn, ru).

The model *parses the question only*. It never generates, invents, or returns site data. A hallucinated pantry address for a hungry family is the worst thing this app could do, so the architecture makes it impossible.

**Works offline.** If the parse endpoint is unavailable, a local keyword matcher takes over and the app remains fully usable. The i18n dictionaries are static files, not model output.

**Ranking, never exclusion.** Filters sort matching sites up and label the rest "unknown — call ahead." No site is ever hidden from someone who needs food.

**"Along the way."** Contextual overlays for the corridor between the nearest accessible station and the site — nearby libraries, and 311 street- and building-condition complaints.

---

## Privacy

The user's address never leaves the browser. Geocoding runs client-side against NYC Planning Labs GeoSearch; only the free-text intent is sent to the parse endpoint. Household composition, ages, and any stated accessibility or dietary needs are held in memory and never transmitted or stored. No accounts, no analytics on those fields.

---

## Two data-quality findings

Offered back to the commons, since both would silently corrupt anyone else's build:

**1. USDA FNS Summer Meals sites are duplicated across cycles.** The 2026 NYC pull returns 507 records, but each physical site appears in both Cycle 05 and Cycle 09. After collapsing records sharing a name within 50m, roughly 254 unique sites remain — 87 collapses in our 300-record working set. Anyone summing that feed without deduplication will roughly double-count meal sites citywide.

**2. NYC 311 "Elevator" complaints are not transit elevators.** Across the five highest-volume corridors in our sample, 313 of 332 elevator complaints (94%) were routed to DOB and 19 to HPD. Zero went to any transit agency. 311's taxonomy has no channel for subway elevator complaints; those go through the MTA's own reporting. We initially built a "resident reports contradict MTA status" flag on this join and removed it — the two datasets describe different elevators entirely.

What the 311 elevator data *does* show is worth keeping: the dominant descriptor across these corridors is "single device on property / no alternate service" — a building with one elevator and no backup. In the corridor around Jackie Robinson Park, 57 such complaints were filed in 90 days. For those households, the trip this app maps never starts.

---

## Coverage

40 sites, weighted toward the 35 with Saturday hours, then filled across all five boroughs.

| Borough | Sites |
|---|---|
| Manhattan | 13 |
| Bronx | 10 |
| Brooklyn | 6 |
| Staten Island | 6 |
| Queens | 5 |

**14 of 40 sites sit more than three-quarters of a mile from any ADA-accessible subway station** — concentrated in Staten Island, with outliers in the Bronx and Queens. Saturday food access clusters heavily in Manhattan and the Bronx, largely because weekend-operating sites are mostly NYC Parks pools.

---

## Data sources

| Dataset | Publisher | Used for |
|---|---|---|
| Summer Meals Site Finder 2026 (ArcGIS FeatureServer) | USDA Food and Nutrition Service | Meal site locations, hours, days, season dates |
| MTA Subway Stations (`39hk-dx4f`) | Metropolitan Transportation Authority | ADA station status, direction notes, coordinates |
| MTA Subway Elevator & Escalator Asset Inventory (`94fv-bak7`) | Metropolitan Transportation Authority | Equipment inventory, ADA-path flags, service status |
| Facilities Database (`ji82-xba5`) | NYC Department of City Planning | Public library branches, all three systems |
| 311 Service Requests (`erm2-nwe9`) | NYC Office of Technology and Innovation | Sidewalk, curb, scaffold, and building elevator complaints |
| GeoSearch | NYC Planning Labs | Client-side address geocoding |
| Leaflet · OpenStreetMap · CARTO | — | Mapping and basemap tiles |

Every claim rendered in the UI carries its source dataset and the date it was pulled.

---

## Limitations

Read this before trusting anything on the map.

- **Accessibility is never asserted as fact.** Claims are agency-reported or human-verified, and both decay. A ramp that existed in March may be blocked today.
- **Elevator status is a periodically-updated inventory, not a live sensor.** "In service" means the last update said so.
- **Hours change without notice.** Sites close for holidays, run out of food, and adjust schedules faster than any feed updates.
- **We cannot verify ingredients or allergens.** The app will never tell you a site is safe for an allergy. It gives you the phone number and the question to ask.
- **A verdict is a best estimate at the time shown, not a guarantee.** Call ahead.
- **Straight-line distance is not walking distance.** Nearest-station distances are haversine, not routed.
- **The USDA endpoint is marked "(Testing)."** Site data is committed as a static file rather than fetched live, so the app does not break if that endpoint changes.

---

## Running it

```
git clone https://github.com/rcabrera917/NYPL-Hackathon.git
cd NYPL-Hackathon
python3 -m http.server 8000
```

Open `http://localhost:8000/public/nlq.html`. The natural-language parser requires a serverless deploy; without it the local keyword fallback runs automatically.

Rebuild the data files:

```
node scripts/build-data.mjs        # meal sites from USDA FNS
node scripts/build-stations.mjs    # MTA stations, elevators, nearest-station join
node scripts/build-overlays.mjs    # libraries and 311 corridor context
```

The parse endpoint needs `ANTHROPIC_API_KEY` set as an environment variable in the deployment. Never in client code.

---

## Built by

<!-- REPLACE WITH AUTHOR-SUPPLIED TEXT -->

**Rafy Cabrera** —

**Chris Franqui** —

---

## AI disclosure

Per MLH's requirement that teams disclose AI tools used: this project was built with Claude Code. All architecture, data-source decisions, verification logic, and the honesty constraints above were directed by the authors. Two false data joins proposed during the build were caught and removed before shipping; both are documented in the findings section above.

## Thanks

To the New York Public Library and Major League Hacking for hosting, and to Google.org for supporting the event.

To NYC Open Data and the New York State open data program — this project is entirely built on public data that someone decided to publish. To the NYC Department of City Planning, whose Facilities Database aggregates roughly 50 agency sources into one queryable schema and saved us most of a day. And to NYC Planning Labs, whose GeoSearch is free, keyless, and built for exactly this.

## License

MIT
