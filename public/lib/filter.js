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
    "comida", "almuerzo", "desayuno", "cena", "hambre",
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

export function keywordParse(query) {
  const text = String(query || "");
  const lower = text.toLowerCase();
  const dietaryFlags = detectMulti(lower, DIETARY_KEYWORDS);
  return {
    detectedLanguage: detectLanguageIso(text),
    need: detectNeed(lower),
    ageGroups: detectAgeGroups(lower),
    dietaryFlags,
    accessibilityNeeds: detectMulti(lower, ACCESSIBILITY_KEYWORDS),
    urgency: detectUrgency(lower),
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
export function rankSites(sites, parsed, origin) {
  const needsAccess =
    parsed && Array.isArray(parsed.accessibilityNeeds) &&
    parsed.accessibilityNeeds.some((n) => n !== "none");
  const needsDiet =
    parsed && Array.isArray(parsed.dietaryFlags) &&
    parsed.dietaryFlags.some((f) => f !== "none");
  const urgencyHigh = parsed && parsed.urgency === "high";

  const decorated = sites.map((site) => {
    const distanceMiles =
      origin && site.lat != null && site.lng != null
        ? haversineMiles(origin.lat, origin.lng, site.lat, site.lng)
        : null;

    const chips = [];
    let score = 0;

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
