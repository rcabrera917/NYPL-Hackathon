// Pure verdict for a single site + its nearest station's live status.
// See CLAUDE.md for the frozen sites/stations contracts. No imports,
// no fetch — inputs in, verdict out.
//
// stationStatus is expected to be stations[site.nearestStationId] —
// i.e. { ada, adaDirectionNotes, elevators: [{id, servingDescription,
// onAdaPath, inService}] } — or null/undefined if unknown.
//
// date is a Date or anything Date can parse. Day-of-week is read in
// the local timezone of the caller.

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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

  const source = verificationSource(site);
  if (source) {
    provenance.push(`entranceStepFree=${site.entranceStepFree} verified by ${source}`);
  } else {
    provenance.push(`entranceStepFree=${site.entranceStepFree ?? "unknown"} (unverified)`);
  }

  if (site.nearestStationId) {
    provenance.push(`nearest ADA station: ${site.nearestStationId}`);
  } else {
    provenance.push("no nearest ADA station on record");
  }

  const pathElevators = adaPathElevators(stationStatus);
  if (stationStatus) {
    if (pathElevators.length === 0) {
      provenance.push(`no ADA-path elevators on record for ${site.nearestStationId}`);
    } else {
      for (const e of pathElevators) {
        provenance.push(`elevator ${e.id}: ${e.inService ? "in service" : "OUT OF SERVICE"}`);
      }
    }
  } else if (site.nearestStationId) {
    provenance.push(`station ${site.nearestStationId} status unavailable`);
  }

  // Red: entrance explicitly not step-free, or any ADA-path elevator out.
  if (site.entranceStepFree === false) {
    reasons.push("entrance is not step-free");
    return { state: "red", reasons, provenance };
  }
  const outElevators = pathElevators.filter((e) => e.inService !== true);
  if (outElevators.length > 0) {
    reasons.push(
      `required elevator(s) out of service: ${outElevators.map((e) => e.id).join(", ")}`,
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
        ? `station ${site.nearestStationId} status unavailable`
        : "no nearest ADA station on record",
    );
  } else if (pathElevators.length === 0) {
    reasons.push("no ADA-path elevators listed for nearest station");
  }

  return { state: "amber", reasons, provenance };
}
