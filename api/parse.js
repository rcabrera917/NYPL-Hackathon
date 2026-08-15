// Vercel serverless function. POSTs a free-text query and returns the strict
// parse shape defined by CLAUDE.md's search flow. Key from process.env.
// Model parses the query only — it NEVER returns site data.

const MODEL = "claude-opus-4-7";
const API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `You parse short, free-text messages from New York City residents \
looking for social-services help (food, transit, housing, health). You only extract \
what the user actually says. You never invent locations, sites, program names, or \
services. Detect the language the user wrote in. If a field is not present, use null \
(for neighborhood) or "unknown" (for enums) or [] (for arrays). Do not translate or \
paraphrase — extract only.

Field guide:
- detectedLanguage: common English name of the language (e.g. "Spanish", "Mandarin", \
  "Bengali", "Russian", "English").
- need: single closest match from the enum. "unknown" if unclear.
- ageGroups: descriptors mentioned or clearly implied ("infant", "toddler", "child", \
  "teen", "adult", "senior"), or specific ages ("5 year old"). Empty [] if no age.
- dietaryFlags: dietary restrictions mentioned ("halal", "kosher", "vegetarian", \
  "vegan", "gluten-free", "nut-free"). Empty [] if none.
- neighborhood: NYC neighborhood, borough, or landmark named verbatim in English. \
  null if not specified.
- urgency: "high" for "today"/"urgent"/"now"; "medium" for planning within \
  days/weeks; "low" for general browsing; "unknown" if unclear.`;

const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    detectedLanguage: { type: "string" },
    need: { type: "string", enum: ["food", "transit", "housing", "health", "unknown"] },
    ageGroups: { type: "array", items: { type: "string" } },
    dietaryFlags: { type: "array", items: { type: "string" } },
    neighborhood: { anyOf: [{ type: "string" }, { type: "null" }] },
    urgency: { type: "string", enum: ["low", "medium", "high", "unknown"] },
  },
  required: ["detectedLanguage", "need", "ageGroups", "dietaryFlags", "neighborhood", "urgency"],
  additionalProperties: false,
};

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    try { return JSON.parse(req.body); } catch { return null; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(raw); } catch { return null; }
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
  if (!query) {
    return res.status(400).json({ error: "missing_query" });
  }
  if (query.length > 500) {
    return res.status(400).json({ error: "query_too_long" });
  }

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
        max_tokens: 512,
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
  return res.status(200).json(parsed);
}
