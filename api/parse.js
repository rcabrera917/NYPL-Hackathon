// Vercel serverless function. POSTs a free-text intent query and returns a
// strict JSON parse. The model NEVER receives the user's address, and NEVER
// returns site data — that lives in public/data/sites.json.
//
// Key from process.env.ANTHROPIC_API_KEY. On any upstream failure returns a
// non-200 with a JSON error body so the client's keyword fallback triggers.

const MODEL = "claude-sonnet-4-6";
const API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `You parse short, free-text messages from New York City residents \
looking for social-services help. You only extract what the user actually says. You \
never invent sites, programs, addresses, or services. Return strict JSON only — no \
prose, no markdown fences.

Field guide:
- detectedLanguage: ISO 639-1 code of the language the user wrote in \
  (e.g. "en", "es", "zh", "bn", "ru"). If the language is not on that list, return \
  the closest ISO 639-1 code.
- need: single closest match from the enum. "unknown" if unclear.
- ageGroups: enum values only. Use "infant" (0-2), "child" (3-12), "teen" (13-17), \
  "adult" (18-64), "senior" (65+). Map specific ages to the closest bracket. \
  Empty [] if no age.
- dietaryFlags: enum values only. Use "allergy" for peanut/tree-nut/shellfish/etc. \
  allergies. "medical" for medically-mandated diets (diabetic, low-sodium). Empty [] \
  if none.
- accessibilityNeeds: enum values only. Empty [] if none mentioned.
- urgency: "high" for words like "today", "urgent", "now"; "medium" for planning \
  within days; "low" for general browsing.
- mobilityRange: "short" if the user says they tire quickly, need to rest, use a \
  walker/cane/wheelchair, is elderly, or is travelling with a small child on foot. \
  "moderate" for a plain walking trip with no signal either way. "unlimited" only \
  if the user says they can walk far or ride. "unknown" if there is no signal at all.
- heatSensitive: true if the user mentions heat, shade, sun, being hot, or brings \
  young kids/elderly outdoors during summer. Otherwise false.
- needsRestroom: true if the user mentions a restroom, bathroom, toilet, or a \
  changing station for a baby. Otherwise false.
- crossingCaution: true if the user mentions a child, a vision impairment, slow \
  walking, or fear of traffic — anything that makes crossing a busy street harder. \
  Otherwise false.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    detectedLanguage: { type: "string" },
    need: { type: "string", enum: ["food", "transit", "housing", "health", "unknown"] },
    ageGroups: {
      type: "array",
      items: { type: "string", enum: ["infant", "child", "teen", "adult", "senior"] },
    },
    dietaryFlags: {
      type: "array",
      items: { type: "string", enum: ["halal", "kosher", "vegetarian", "allergy", "medical", "none"] },
    },
    accessibilityNeeds: {
      type: "array",
      items: { type: "string", enum: ["wheelchair", "walker", "stroller", "vision", "hearing", "none"] },
    },
    urgency: { type: "string", enum: ["high", "medium", "low"] },
    mobilityRange: { type: "string", enum: ["short", "moderate", "unlimited", "unknown"] },
    heatSensitive: { type: "boolean" },
    needsRestroom: { type: "boolean" },
    crossingCaution: { type: "boolean" },
  },
  required: [
    "detectedLanguage", "need", "ageGroups", "dietaryFlags", "accessibilityNeeds",
    "urgency", "mobilityRange", "heatSensitive", "needsRestroom", "crossingCaution",
  ],
  additionalProperties: false,
};

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "method_not_allowed" });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "server_misconfigured", detail: "ANTHROPIC_API_KEY not set" });
  }

  const body = await readJsonBody(req);
  const query = body && typeof body.query === "string" ? body.query.trim() : "";
  if (!query) return res.status(400).json({ error: "missing_query" });
  if (query.length > 500) return res.status(400).json({ error: "query_too_long" });

  let upstream;
  try {
    upstream = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1000,
        system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
        output_config: { format: { type: "json_schema", schema: OUTPUT_SCHEMA } },
        messages: [{ role: "user", content: query }],
      }),
    });
  } catch (err) {
    return res.status(502).json({ error: "upstream_unreachable", detail: String(err) });
  }

  if (!upstream.ok) {
    const detail = await upstream.text();
    return res.status(502).json({ error: "upstream_error", status: upstream.status, detail });
  }

  const data = await upstream.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) return res.status(502).json({ error: "empty_response" });

  let parsed;
  try {
    parsed = JSON.parse(textBlock.text);
  } catch (err) {
    return res.status(502).json({ error: "invalid_json_from_model", detail: String(err) });
  }

  // Server-side derivation: if the caller mentioned an allergy, surface a UI
  // warning flag. sites.json does NOT carry ingredient data — the UI must
  // never assert any site is allergen-safe.
  const allergyWarning = Array.isArray(parsed.dietaryFlags) && parsed.dietaryFlags.includes("allergy");

  return res.status(200).json({ ...parsed, allergyWarning });
}
