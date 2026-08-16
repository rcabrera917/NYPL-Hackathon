# Future context layers

Datasets that were verified in NYC Open Data during this build but not
wired into `scripts/build-overlays.mjs`. Each entry explains what the
layer would add and why it wasn't built now.

## Sidewalk sheds — DOB permits (SKIPPED because no coord-carrying dataset)

**Would add:** flag any site whose walk from the ADA station passes a
scaffold shed that has stood more than 12 months — the difference
between active construction (usually resolves within weeks) and a
long-term obstruction of the sidewalk.

**Why not built:** the two candidate DOB datasets do not carry
coordinates.

- `ipu4-2q9a` — DOB Permit Issuance. Fields: address, `bin`, `block`,
  `lot`, `permit_type`, `issuance_date`. No `latitude`/`longitude`,
  no `location` Point column.
- `w9ak-ipjd` — DOB NOW: Build – Job Application Filings. Has a
  boolean `shed` field but same coord problem (BIN/BBL only).
- Searches for "Active Sidewalk Sheds", "DOB Safety Sheds", "shed
  permit", and "safety+sidewalk" returned no dedicated coord-carrying
  dataset.

**How to add it:** join by BIN to NYC Building Footprints (`nqwf-w8eh`
or the newer `5zhs-2jue`) to get building centroids, then apply the
existing 300m corridor test. Filter by `issuance_date <=
now − 12 months` for the "long-term shed" flag. Non-trivial join; out
of scope for this pass.

## Cooling Centers (planned Layer 3, still open)

**Would add:** during a heat advisory, list city-designated cooling
centers within the corridor. Directly complementary to Layer 6 (trees)
for a `heatSensitive` query.

**Why not built:** the NYC OEM cooling-center feed is seasonal and
activated only during heat events. Wiring it now would ship a layer
that reads empty for 10 months a year without a "not currently
activated" note. Not a blocker — but needs a fetch strategy that
handles the empty state gracefully.

## Film permits (planned Layer 4, still open)

**Would add:** date-scoped notice that a corridor will be closed for
filming on the selected trip date. Sites are often trip-of-the-day
decisions; a same-day film shoot can silently block a sidewalk.

**Dataset:** `tg4x-b46p` (Film Permits). Has coordinates via
`entireroad`/`enteredon_street_1` polylines. Doable with a
`within_circle` on a polyline representative point, but the schema is
polyline geometry, not a simple Point — needs a small geom
representative step.

## MTA elevator real-time outages (idea — no ID confirmed yet)

**Would add:** distinguish a station whose elevator was flagged
"in service" at the last MTA sync from one whose elevator is
currently reporting an unplanned outage. This is what our verdict
already tries to say, but with a live feed instead of a periodically
refreshed asset inventory.

**Why not built here:** the MTA publishes elevator/escalator outages
on a separate feed cadence (`ozg7-cvh8` for planned outages, plus a
live JSON on the MTA developer portal that requires periodic polling).
The candidate IDs need direct verification before wiring — several
have been renamed or deprecated in the last 18 months.

## LinkNYC kiosks (idea)

**Would add:** free wifi + phone-charging along the corridor for
someone whose phone died mid-trip. Useful adjacent to `crossingCaution`
(need to call a family member from the station) and to `urgency=high`.

**Dataset candidate:** `s4kf-3yrf` (LinkNYC Kiosk Locations). Not
yet verified against the catalog.

## Farmers markets accepting SNAP/HFNY

**Would add:** for `need=food` queries, adjacent SNAP-accepting
farmers markets during their open season — an alternative to the
prepared-meal sites when a family prefers to cook.

**Dataset candidate:** NYS Ag & Markets Farmers Market Locations.
The state feed is more reliable than any of the NYC-only equivalents.
Not yet wired.

---

None of these are verdict inputs, in the same way none of Layers 1-11
are. They're all "along the way" context. The bar for adding one is
the same: (1) a real dataset ID that resolves in the NYC / NY / USDA
catalog, (2) coordinates or a coord join that is not heavier than the
layer's value, (3) a sober framing that doesn't overclaim what the
data supports.
