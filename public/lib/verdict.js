// Pure verdict for a single site + its nearest station's live status.
// See CLAUDE.md for the frozen sites/stations contracts. No imports,
// no fetch — inputs in, verdict out.
//
// stationStatus is expected to be stations[site.nearestStationId] —
// i.e. { name?, routes?, line?, borough?, ada, adaDirectionNotes,
// elevators: [{id, servingDescription, onAdaPath, inService}] } —
// or null/undefined if unknown.
//
// date is a Date or anything Date can parse. Day-of-week is read in
// the local timezone of the caller.
//
// Human-readable strings only. Machine identifiers (GTFS stop id,
// elevator equipment code) never appear in a sentence — the caller
// can render them separately in monospace from the raw JSON.

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Haversine in miles. Local to this module so verdict.js stays
// import-free (see file header). Same formula as the UI's
// haversineMiles — a provenance line derived from a different
// computation would be a lie.
function haversineMilesLocal(lat1, lng1, lat2, lng2) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Provenance line for the site→station straight-line distance. Same
// 20-blocks-per-mile convention and < 0.025 mi threshold that the UI
// uses in distancePhrase() — one derivation, two renderers.
function distanceProvenance(site, stationStatus) {
  if (
    !stationStatus ||
    site.lat == null || site.lng == null ||
    !Number.isFinite(stationStatus.lat) || !Number.isFinite(stationStatus.lng)
  ) return null;
  const miles = haversineMilesLocal(site.lat, site.lng, stationStatus.lat, stationStatus.lng);
  const mileStr = `${miles.toFixed(2)} mi`;
  const blockPart =
    miles < 0.025
      ? "less than a block"
      : `~${Math.max(1, Math.round(miles * 20))} blocks`;
  return `distance: ${mileStr} straight-line, estimated at 20 blocks per mile = ${blockPart}`;
}

// Render a human station label: "Prospect Park (B, Q, S)". Falls back
// to whatever we do have (name, then borough, then a generic "nearest
// ADA station" — never leaks the raw GTFS id into a sentence).
function stationLabel(stationStatus, stationId) {
  if (!stationStatus) return stationId ? "nearest ADA station" : null;
  const name = stationStatus.name || null;
  const routes = Array.isArray(stationStatus.routes) ? stationStatus.routes : [];
  if (name && routes.length) return `${name} (${routes.join(", ")})`;
  if (name) return name;
  if (stationStatus.borough) return `nearest ADA station in ${stationStatus.borough}`;
  return "nearest ADA station";
}

// Render a human elevator label using the equipment feed's serving
// description. Fall back to "elevator (ID X)" — the raw code only
// appears when we have nothing better.
function elevatorLabel(e) {
  const desc = e && e.servingDescription ? String(e.servingDescription).trim() : "";
  if (desc) return `elevator ${desc}`;
  return e && e.id ? `elevator (ID ${e.id})` : "elevator";
}

function dayLabel(date) {
  const d = date instanceof Date ? date : new Date(date);
  const idx = d.getDay();
  return Number.isNaN(idx) ? null : DAY_NAMES[idx];
}

function isOpenOn(site, date) {
  const label = dayLabel(date);
  if (!label) return false;
  return Array.isArray(site.daysOpen) && site.daysOpen.includes(label);
}

function adaPathElevators(stationStatus) {
  if (!stationStatus || !Array.isArray(stationStatus.elevators)) return [];
  return stationStatus.elevators.filter((e) => e && e.onAdaPath === true);
}

function verificationSource(site) {
  if (!site.verifiedBy) return null;
  return site.verifiedAt ? `${site.verifiedBy} (${site.verifiedAt})` : site.verifiedBy;
}

export function getVerdict(site, stationStatus, date) {
  const reasons = [];
  const provenance = [];

  const stationHuman = stationLabel(stationStatus, site.nearestStationId);

  const source = verificationSource(site);
  if (source) {
    const verb = site.entranceStepFree === true ? "verified step-free" :
                 site.entranceStepFree === false ? "verified NOT step-free" :
                 "verification recorded (result unclear)";
    provenance.push(`entrance ${verb} by ${source}`);
  } else if (site.entranceStepFree === true) {
    provenance.push("entrance reported step-free — unverified");
  } else if (site.entranceStepFree === false) {
    provenance.push("entrance reported NOT step-free — unverified");
  } else {
    provenance.push("entrance step-free status unknown, unverified");
  }

  if (site.nearestStationId) {
    provenance.push(`nearest ADA station: ${stationHuman}`);
    const distLine = distanceProvenance(site, stationStatus);
    if (distLine) provenance.push(distLine);
  } else {
    provenance.push("no nearest ADA station on record");
  }

  const pathElevators = adaPathElevators(stationStatus);
  if (stationStatus) {
    if (pathElevators.length === 0) {
      provenance.push(`no ADA-path elevators on record for ${stationHuman}`);
    } else {
      for (const e of pathElevators) {
        provenance.push(`${elevatorLabel(e)} — ${e.inService ? "in service" : "OUT OF SERVICE"}`);
      }
    }
  } else if (site.nearestStationId) {
    provenance.push(`${stationHuman} status unavailable`);
  }

  // Season bounds provenance (extension to the original frozen contract).
  if (site.seasonStartAt || site.seasonEndAt) {
    provenance.push(
      `season: ${site.seasonStartAt?.slice(0, 10) ?? "?"} → ${site.seasonEndAt?.slice(0, 10) ?? "?"}`,
    );
  }

  // Red: season not yet open or already ended, entrance explicitly not
  // step-free, or any ADA-path elevator out.
  const checkDate = date instanceof Date ? date : new Date(date);
  const seasonStart = site.seasonStartAt ? new Date(site.seasonStartAt) : null;
  const seasonEnd = site.seasonEndAt ? new Date(site.seasonEndAt) : null;
  const dateOk = !Number.isNaN(checkDate.getTime());
  if (
    seasonStart &&
    !Number.isNaN(seasonStart.getTime()) &&
    dateOk &&
    checkDate < seasonStart
  ) {
    reasons.push(`season starts ${site.seasonStartAt.slice(0, 10)}`);
    return { state: "red", reasons, provenance };
  }
  if (
    seasonEnd &&
    !Number.isNaN(seasonEnd.getTime()) &&
    dateOk &&
    checkDate > seasonEnd
  ) {
    reasons.push(`season ended ${site.seasonEndAt.slice(0, 10)}`);
    return { state: "red", reasons, provenance };
  }
  if (site.entranceStepFree === false) {
    reasons.push("entrance is not step-free");
    return { state: "red", reasons, provenance };
  }
  const outElevators = pathElevators.filter((e) => e.inService !== true);
  if (outElevators.length > 0) {
    reasons.push(
      `required elevator(s) out of service: ${outElevators.map(elevatorLabel).join("; ")}`,
    );
    return { state: "red", reasons, provenance };
  }

  // Green: every green condition must hold. verifiedBy is load-bearing —
  // no verification means no green, ever.
  const hasVerification = Boolean(site.verifiedBy);
  const stepFreeConfirmed = site.entranceStepFree === true;
  const openToday = isOpenOn(site, date);
  const stationConfirmed =
    Boolean(stationStatus) &&
    pathElevators.length > 0 &&
    pathElevators.every((e) => e.inService === true);

  if (hasVerification && stepFreeConfirmed && openToday && stationConfirmed) {
    reasons.push("verified step-free, open today, all ADA-path elevators in service");
    return { state: "green", reasons, provenance };
  }

  // Amber: everything else, including all unknowns.
  if (site.entranceStepFree == null) {
    reasons.push("entrance step-free status unknown");
  } else if (!hasVerification) {
    reasons.push("entrance step-free claim is unverified");
  }
  if (!openToday) {
    const label = dayLabel(date);
    reasons.push(label ? `closed on ${label}` : "invalid date");
  }
  if (!stationStatus) {
    reasons.push(
      site.nearestStationId
        ? `${stationHuman} status unavailable`
        : "no nearest ADA station on record",
    );
  } else if (pathElevators.length === 0) {
    reasons.push(`no ADA-path elevators listed for ${stationHuman}`);
  }

  return { state: "amber", reasons, provenance };
}
