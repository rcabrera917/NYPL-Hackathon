// Client-side helpers for the search flow. Exports:
//   keywordParse(query)              — pure fallback when /api/parse fails.
//                                      Produces the same shape as the API.
//   rankSites(sites, parsed, origin) — sort by distance from origin (haversine),
//                                      then decorate each site with matchChips[].
//                                      Filters are ranking only — every site
//                                      stays visible.
//
// No fetch, no imports. Runs in the browser.

const NEED_KEYWORDS = {
  food: [
    "food", "meal", "meals", "lunch", "breakfast", "dinner", "eat", "hungry",
    "feed", "vegetables", "groceries", "produce",
    "comida", "almuerzo", "desayuno", "cena", "hambre", "verduras", "alimentos",
    "免费", "午餐", "早餐", "晚餐", "食物", "吃",
    "খাবার", "খাদ্য",
    "еда", "питание", "обед", "завтрак", "ужин",
  ],
  transit: ["subway", "train", "bus", "transit", "mta"],
  housing: ["housing", "shelter", "apartment", "rent"],
  health: ["clinic", "doctor", "medical", "hospital", "urgent care", "medicina"],
};

const URGENCY_HIGH = ["urgent", "today", "now", "immediately", "asap", "hoy", "ahora", "紧急", "срочно"];
const URGENCY_MEDIUM = ["tomorrow", "this week", "soon", "mañana", "pronto"];

const DIETARY_KEYWORDS = {
  halal: ["halal"],
  kosher: ["kosher"],
  vegetarian: ["vegetarian", "vegan", "vegetariano", "vegano"],
  allergy: ["allergy", "allergic", "peanut", "nut", "shellfish", "alergia", "alérgico"],
  medical: ["diabetic", "diabetes", "low-sodium", "gluten-free", "celiac"],
};

const ACCESSIBILITY_KEYWORDS = {
  wheelchair: ["wheelchair", "silla de ruedas"],
  walker: ["walker", "andador"],
  stroller: ["stroller", "cochecito"],
  vision: ["blind", "vision impaired", "low vision", "ciego"],
  hearing: ["deaf", "hearing impaired", "sordo"],
};

const AGE_BUCKETS = [
  { key: "infant", min: 0, max: 2, words: ["infant", "baby", "bebé"] },
  { key: "child", min: 3, max: 12, words: ["child", "children", "kid", "kids", "niño", "hijo"] },
  { key: "teen", min: 13, max: 17, words: ["teen", "teenager", "adolescente"] },
  { key: "adult", min: 18, max: 64, words: ["adult", "adulto"] },
  { key: "senior", min: 65, max: 120, words: ["senior", "elderly", "abuelo", "anciano"] },
];

// Short-range mobility signals. Any hit → mobilityRange = "short".
// Broad on purpose — the ranking is additive, so a false positive costs
// at most a small nudge upward for benches / short distance.
const MOBILITY_SHORT_WORDS = [
  "walker", "cane", "wheelchair", "silla de ruedas", "andador", "bastón",
  "tire", "tired", "get tired", "cansada", "cansado", "cansar",
  "rest", "need to rest", "sit down", "sentar", "descansar",
  "can't go far", "cannot go far", "can't walk far", "short walk",
  "elderly", "abuelo", "abuela", "anciano", "anciana",
  "small child", "little one", "toddler", "on foot with",
  "老人", "легко устаю",
];
const HEAT_SENSITIVE_WORDS = [
  "shade", "shaded", "shady", "sombra", "sombreado",
  "heat", "hot day", "hot out", "sun", "sunny",
  "calor", "caluroso",
];
const RESTROOM_WORDS = [
  "restroom", "bathroom", "toilet", "washroom",
  "baño", "aseo",
  "changing station", "diaper", "pañales",
];
const CROSSING_CAUTION_WORDS = [
  "traffic", "afraid of traffic", "busy street", "cross the street",
  "slow walking", "slow walker", "slow to cross",
  "blind", "vision impaired", "low vision", "ciego",
  "child", "children", "kid", "kids", "niño", "niños", "hijo", "hija",
];

function detectLanguageIso(text) {
  if (/[一-鿿]/.test(text)) return "zh";
  if (/[ঀ-৿]/.test(text)) return "bn";
  if (/[Ѐ-ӿ]/.test(text)) return "ru";
  if (/[áéíóúñ¿¡]/i.test(text) || /\b(necesito|comida|niño|hijo|cerca|hoy|mañana)\b/i.test(text)) return "es";
  return "en";
}

function detectNeed(lower) {
  for (const [need, kws] of Object.entries(NEED_KEYWORDS)) {
    if (kws.some((kw) => lower.includes(kw.toLowerCase()))) return need;
  }
  return "unknown";
}

function detectAgeGroups(lower) {
  const groups = new Set();
  for (const b of AGE_BUCKETS) {
    if (b.words.some((w) => lower.includes(w))) groups.add(b.key);
  }
  const ageMatch = lower.match(/\b(\d{1,3})\s*(?:year|yr|año|años|岁|বছর|лет|года|год)/);
  if (ageMatch) {
    const n = parseInt(ageMatch[1], 10);
    const bucket = AGE_BUCKETS.find((b) => n >= b.min && n <= b.max);
    if (bucket) groups.add(bucket.key);
  }
  return [...groups];
}

function detectMulti(lower, table) {
  const out = [];
  for (const [key, kws] of Object.entries(table)) {
    if (kws.some((kw) => lower.includes(kw))) out.push(key);
  }
  return out;
}

function detectUrgency(lower) {
  if (URGENCY_HIGH.some((w) => lower.includes(w))) return "high";
  if (URGENCY_MEDIUM.some((w) => lower.includes(w))) return "medium";
  return "low";
}

function anyHit(lower, words) {
  return words.some((w) => lower.includes(w));
}

function detectMobilityRange(lower, ageGroups, accessibilityNeeds) {
  if (accessibilityNeeds.includes("wheelchair") || accessibilityNeeds.includes("walker")) return "short";
  if (ageGroups.includes("senior") || ageGroups.includes("infant") || ageGroups.includes("child")) return "short";
  if (anyHit(lower, MOBILITY_SHORT_WORDS)) return "short";
  return "unknown";
}

export function keywordParse(query) {
  const text = String(query || "");
  const lower = text.toLowerCase();
  const dietaryFlags = detectMulti(lower, DIETARY_KEYWORDS);
  const ageGroups = detectAgeGroups(lower);
  const accessibilityNeeds = detectMulti(lower, ACCESSIBILITY_KEYWORDS);
  return {
    detectedLanguage: detectLanguageIso(text),
    need: detectNeed(lower),
    ageGroups,
    dietaryFlags,
    accessibilityNeeds,
    urgency: detectUrgency(lower),
    mobilityRange: detectMobilityRange(lower, ageGroups, accessibilityNeeds),
    heatSensitive: anyHit(lower, HEAT_SENSITIVE_WORDS),
    needsRestroom: anyHit(lower, RESTROOM_WORDS),
    crossingCaution: anyHit(lower, CROSSING_CAUTION_WORDS),
    allergyWarning: dietaryFlags.includes("allergy"),
  };
}

// Haversine distance in miles.
export function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.7613;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Decorate each site with a distance, a matchChips[] array, and a rank score.
// Filters are RANKING, never exclusion — every site stays in the returned list.
//
// `overlays` (optional): the loaded overlays.json object. When present,
// mobilityRange / heatSensitive / needsRestroom / crossingCaution add
// weighted chips that name the source dataset (dataset labels sourced
// from overlays.json _meta.sources so if that block is updated, the
// chips update too).
export function rankSites(sites, parsed, origin, overlays) {
  const needsAccess =
    parsed && Array.isArray(parsed.accessibilityNeeds) &&
    parsed.accessibilityNeeds.some((n) => n !== "none");
  const needsDiet =
    parsed && Array.isArray(parsed.dietaryFlags) &&
    parsed.dietaryFlags.some((f) => f !== "none");
  const urgencyHigh = parsed && parsed.urgency === "high";
  const mobilityShort = parsed && parsed.mobilityRange === "short";
  const heatSensitive = parsed && parsed.heatSensitive === true;
  const needsRestroom = parsed && parsed.needsRestroom === true;
  const crossingCaution = parsed && parsed.crossingCaution === true;

  // Pull dataset display labels from overlays.json _meta so the chips
  // don't have to duplicate them.
  const sources = overlays?._meta?.sources ?? {};
  const label = {
    trees:         sources.trees?.dataset         ?? "NYC Street Tree Census (uvpi-gqnh)",
    benches:       sources.benches?.dataset       ?? "NYC DOT CityBench (kuxa-tauh)",
    pedCollisions: sources.pedCollisions?.dataset ?? "NYPD Collisions (h9gi-nx95)",
    restrooms:     sources.restrooms?.dataset     ?? "NYC Public Restrooms (i7jb-7jku)",
    aps:           sources.aps?.dataset           ?? "NYC DOT APS (de3m-c5p4)",
  };

  const decorated = sites.map((site) => {
    const distanceMiles =
      origin && site.lat != null && site.lng != null
        ? haversineMiles(origin.lat, origin.lng, site.lat, site.lng)
        : null;

    const chips = [];
    let score = 0;
    const overlay = overlays?.[site.id] ?? null;

    if (needsAccess) {
      if (site.entranceStepFree === true && site.verifiedBy) {
        chips.push({ kind: "match", text: "step-free entrance verified" });
        score += 20;
      } else if (site.entranceStepFree === false) {
        chips.push({ kind: "block", text: "entrance not step-free" });
      } else {
        chips.push({ kind: "unknown", text: "step-free status unknown — call ahead" });
      }
    }

    if (needsDiet) {
      // sites.json contract carries no ingredient / dietary data.
      chips.push({ kind: "unknown", text: "dietary details unknown — call ahead" });
    }

    if (urgencyHigh) score += 2;

    // ---- Corridor-context weights (overlays must be loaded) ----
    if (mobilityShort && overlay) {
      const benchNearStation = overlay.benches?.nearestToStationMeters;
      if (typeof benchNearStation === "number" && benchNearStation <= 100) {
        chips.push({
          kind: "match",
          text: `bench within ${benchNearStation}m of the station`,
          source: label.benches,
        });
        score += 8;
      } else if ((overlay.benches?.count ?? 0) > 0) {
        chips.push({
          kind: "match",
          text: `${overlay.benches.count} bench${overlay.benches.count === 1 ? "" : "es"} in corridor`,
          source: label.benches,
        });
        score += 3;
      }
      // Shorter station distance up. Uses census.milesToAdaStation which
      // Layer 5 populated per site.
      const milesToAda = overlay.census?.milesToAdaStation;
      if (typeof milesToAda === "number" && milesToAda <= 0.4) {
        chips.push({
          kind: "match",
          text: `ADA station only ${milesToAda.toFixed(2)} mi from site`,
          source: "MTA + sites.json",
        });
        score += 6;
      }
    }

    if (heatSensitive && overlay) {
      const treeCount = overlay.trees?.count ?? 0;
      const largeCount = overlay.trees?.largeCount ?? 0;
      if (treeCount >= 100) {
        chips.push({
          kind: "match",
          text: `${treeCount} street trees in corridor${largeCount ? ` (${largeCount} mature)` : ""}`,
          source: label.trees,
        });
        score += 5;
      } else if (treeCount >= 30) {
        chips.push({
          kind: "match",
          text: `${treeCount} street trees in corridor`,
          source: label.trees,
        });
        score += 3;
      }
    }

    if (needsRestroom && overlay) {
      const rc = overlay.restrooms?.count ?? 0;
      if (rc > 0) {
        const near = overlay.restrooms.nearestToSiteMeters;
        const changing = overlay.restrooms.hasChangingStation;
        chips.push({
          kind: "match",
          text: `${rc} operational restroom${rc === 1 ? "" : "s"}${near != null ? `, nearest ${near}m` : ""}${changing ? " (with changing station)" : ""}`,
          source: label.restrooms,
        });
        score += 5;
      }
    }

    if (crossingCaution && overlay) {
      const c = overlay.pedCollisions?.count;
      const months = overlay.pedCollisions?.lookbackMonths ?? 24;
      if (typeof c === "number") {
        if (c <= 3) {
          chips.push({
            kind: "match",
            text: `low pedestrian-injury count in corridor (${c} in ${months} mo)`,
            source: label.pedCollisions,
          });
          score += 4;
        } else if (c >= 40) {
          chips.push({
            kind: "warn",
            text: `high pedestrian-injury count in corridor (${c} in ${months} mo) — take extra care crossing`,
            source: label.pedCollisions,
          });
          // No score change — the site is not penalized. Chip is informational.
        }
      }
      const aps = overlay.aps?.count ?? 0;
      if (aps > 0) {
        chips.push({
          kind: "match",
          text: `${aps} accessible pedestrian signal${aps === 1 ? "" : "s"} in corridor`,
          source: label.aps,
        });
        score += 3;
      }
    }

    return { site, distanceMiles, chips, score };
  });

  decorated.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const da = a.distanceMiles ?? Infinity;
    const db = b.distanceMiles ?? Infinity;
    return da - db;
  });

  return decorated;
}
