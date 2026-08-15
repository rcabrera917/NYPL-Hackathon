// Client-side helpers for the search flow. Two exports:
//   keywordParse(query)      — pure fallback when /api/parse is unavailable.
//                              Produces the same 6-field shape.
//   filterSites(sites, parsed) — filter and rank sites.json by a parse result.
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
  health: ["clinic", "doctor", "medical", "hospital", "urgent care"],
};

const NEIGHBORHOODS = [
  "Manhattan", "Brooklyn", "Queens", "Bronx", "Staten Island",
  "LES", "Lower East Side", "Harlem", "Chinatown", "Astoria",
  "Forest Hills", "Flushing", "Williamsburg", "Bushwick", "Bed-Stuy",
];

const URGENCY_HIGH = ["urgent", "today", "now", "immediately", "asap", "紧急", "срочно"];
const URGENCY_MEDIUM = ["tomorrow", "this week", "soon"];

const DIETARY = ["halal", "kosher", "vegetarian", "vegan", "gluten-free", "nut-free"];

const AGE_WORDS = ["infant", "toddler", "child", "children", "kid", "kids", "teen", "adult", "senior"];

function detectLanguage(text) {
  if (/[一-鿿]/.test(text)) return "Mandarin";
  if (/[ঀ-৿]/.test(text)) return "Bengali";
  if (/[Ѐ-ӿ]/.test(text)) return "Russian";
  if (/[áéíóúñ¿¡]/i.test(text) || /\b(necesito|comida|niño|hijo|cerca)\b/i.test(text)) return "Spanish";
  return "English";
}

function detectNeed(lower) {
  for (const [need, kws] of Object.entries(NEED_KEYWORDS)) {
    if (kws.some((kw) => lower.includes(kw.toLowerCase()))) return need;
  }
  return "unknown";
}

function detectAgeGroups(lower) {
  const groups = new Set();
  for (const w of AGE_WORDS) if (lower.includes(w)) groups.add(w);
  const ageMatch = lower.match(/\b(\d{1,2})\s*(?:year|yr|año|años|岁|বছর|лет|года|год)/);
  if (ageMatch) groups.add(`${ageMatch[1]} year old`);
  return [...groups];
}

function detectDietary(lower) {
  return DIETARY.filter((flag) => lower.includes(flag));
}

function detectNeighborhood(text) {
  for (const n of NEIGHBORHOODS) {
    if (text.toLowerCase().includes(n.toLowerCase())) return n;
  }
  if (/皇后区|皇后/.test(text)) return "Queens";
  if (/曼哈顿/.test(text)) return "Manhattan";
  if (/布鲁克林/.test(text)) return "Brooklyn";
  if (/ব্রুকলিন/.test(text)) return "Brooklyn";
  if (/Манхэттен/i.test(text)) return "Manhattan";
  if (/Бронкс/i.test(text)) return "Bronx";
  return null;
}

function detectUrgency(lower) {
  if (URGENCY_HIGH.some((w) => lower.includes(w))) return "high";
  if (URGENCY_MEDIUM.some((w) => lower.includes(w))) return "medium";
  return "unknown";
}

export function keywordParse(query) {
  const text = String(query || "");
  const lower = text.toLowerCase();
  return {
    detectedLanguage: detectLanguage(text),
    need: detectNeed(lower),
    ageGroups: detectAgeGroups(lower),
    dietaryFlags: detectDietary(lower),
    neighborhood: detectNeighborhood(text),
    urgency: detectUrgency(lower),
  };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function siteScore(site, parsed, todayLabel) {
  let score = 0;
  if (parsed.neighborhood) {
    const hay = `${site.address ?? ""} ${site.name ?? ""}`.toLowerCase();
    if (hay.includes(parsed.neighborhood.toLowerCase())) score += 10;
  }
  if (parsed.urgency === "high" && Array.isArray(site.daysOpen) && site.daysOpen.includes(todayLabel)) {
    score += 5;
  }
  if (Array.isArray(parsed.ageGroups) && parsed.ageGroups.length > 0) {
    const ageNum = parseInt(parsed.ageGroups.find((g) => /^\d/.test(g)) ?? "", 10);
    if (!Number.isNaN(ageNum)) {
      if (
        (site.ageMin == null || ageNum >= site.ageMin) &&
        (site.ageMax == null || ageNum <= site.ageMax)
      ) {
        score += 3;
      }
    }
  }
  return score;
}

// Returns { sites, applied } where applied lists the filters that took effect.
// A "food" or "unknown" need shows every site (this is a summer-meals app);
// other needs return an empty set because we don't have that data.
export function filterSites(sites, parsed, date = new Date()) {
  const applied = [];
  if (!parsed || !Array.isArray(sites)) return { sites: [], applied };

  if (parsed.need !== "food" && parsed.need !== "unknown") {
    applied.push(`need=${parsed.need} (no matching data in this app)`);
    return { sites: [], applied };
  }

  const todayLabel = DAY_NAMES[date.getDay()];
  const scored = sites
    .map((s) => ({ site: s, score: siteScore(s, parsed, todayLabel) }))
    .sort((a, b) => b.score - a.score);

  if (parsed.neighborhood) applied.push(`neighborhood=${parsed.neighborhood}`);
  if (parsed.urgency === "high") applied.push(`urgency=high (prefers open today: ${todayLabel})`);
  if (parsed.ageGroups?.length) applied.push(`age=${parsed.ageGroups.join(",")}`);

  return { sites: scored.map((s) => s.site), applied };
}
