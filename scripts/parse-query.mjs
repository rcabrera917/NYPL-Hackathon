#!/usr/bin/env node
// Parse a free-text NYC social-services query into the strict shape:
//   { detectedLanguage, need, ageGroups[], dietaryFlags[], neighborhood, urgency }
//
// The model parses the query only — it does NOT invent sites. Downstream
// filtering against public/data/sites.json is a separate step.
//
// Uses raw fetch (no SDK) so the script has zero dependencies. The
// Vercel function at api/parse.js follows the same pattern.
//
// Usage:
//   ANTHROPIC_API_KEY=... node scripts/parse-query.mjs "necesito comida cerca del Bronx"
//   ANTHROPIC_API_KEY=... node scripts/parse-query.mjs --test

const MODEL = "claude-sonnet-4-6";
const API_URL = "https://api.anthropic.com/v1/messages";

const SYSTEM_PROMPT = `You parse short, free-text messages from New York City residents \
looking for social-services help. You only extract what the user actually says. You \
never invent sites, programs, addresses, or services. Return strict JSON only — no \
prose, no markdown fences.

Field guide:
- detectedLanguage: ISO 639-1 code (e.g. "en", "es", "zh", "bn", "ru").
- need: single closest match from the enum. "unknown" if unclear.
- ageGroups: enum values only. "infant" (0-2), "child" (3-12), "teen" (13-17), \
  "adult" (18-64), "senior" (65+). Map specific ages to the closest bracket. \
  Empty [] if no age.
- dietaryFlags: enum values only. "allergy" for peanut/tree-nut/shellfish/etc. \
  allergies. "medical" for medically-mandated diets. Empty [] if none.
- accessibilityNeeds: enum values only. Empty [] if none.
- urgency: "high" for "today"/"urgent"/"now"; "medium" for planning within days; \
  "low" for general browsing.`;

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
  },
  required: ["detectedLanguage", "need", "ageGroups", "dietaryFlags", "accessibilityNeeds", "urgency"],
  additionalProperties: false,
};

const TEST_QUERIES = [
  { lang: "Spanish", text: "Necesito comida gratis para mi hijo de 8 años cerca del Bronx" },
  { lang: "Mandarin", text: "在皇后区哪里可以找到免费的儿童午餐？" },
  { lang: "Bengali", text: "আমার তিন সন্তানের জন্য ব্রুকলিনে হালাল খাবার দরকার" },
  { lang: "Russian", text: "Где в Манхэттене можно получить бесплатное питание для детей?" },
  { lang: "English", text: "urgent - need food for my 5 year old today, we're on the LES" },
];

async function parseQuery(query) {
  const res = await fetch(API_URL, {
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
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${body}`);
  }
  const data = await res.json();
  const textBlock = data.content.find((b) => b.type === "text");
  if (!textBlock) throw new Error("No text block in response");
  return { parsed: JSON.parse(textBlock.text), usage: data.usage };
}

function printResult(query, parsed, usage, label) {
  const heading = label ? `[${label}]` : "";
  console.log(`\n${heading} Query: ${query}`);
  console.log(JSON.stringify(parsed, null, 2));
  console.log(
    `  usage: in=${usage.input_tokens} out=${usage.output_tokens} ` +
      `cache_read=${usage.cache_read_input_tokens ?? 0} ` +
      `cache_write=${usage.cache_creation_input_tokens ?? 0}`,
  );
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/parse-query.mjs "<query>"   |   --test');
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  if (args[0] === "--test") {
    for (const { lang, text } of TEST_QUERIES) {
      const { parsed, usage } = await parseQuery(text);
      printResult(text, parsed, usage, lang);
    }
    return;
  }

  for (const q of args) {
    const { parsed, usage } = await parseQuery(q);
    printResult(q, parsed, usage);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
