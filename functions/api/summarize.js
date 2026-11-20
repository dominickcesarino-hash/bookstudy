// Cloudflare Pages Function: POST /api/summarize
// Keeps your Gemini API key secret on the server (free tier from https://aistudio.google.com/apikey).
// In Cloudflare: Pages project → Settings → Variables and Secrets → add GEMINI_API_KEY (type: Secret).
//
// Body: { prompt, book, ground, images: [{mime, data}] }
//   ground: true  → Gemini searches Google for this chapter before answering (used when no text/photos are given)

// Free-tier models, tried in order. If Google retires one, the next is used.
// "think" keeps reasoning short so answers come back fast.
const MODELS = [
  { name: "gemini-2.5-flash",         think: { thinkingBudget: 512 } },
  { name: "gemini-2.5-flash-lite",    think: { thinkingBudget: 512 } },
  { name: "gemini-flash-latest",      think: { thinkingLevel: "low" } },
  { name: "gemini-flash-lite-latest", think: null },
  { name: "gemini-2.0-flash",         think: null }
];

export async function onRequestPost({ request, env, waitUntil }) {
  if (!env.GEMINI_API_KEY) return json({ error: "Server is missing GEMINI_API_KEY." }, 500);
  const started = Date.now();

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400); }

  const prompt = String(body.prompt || "").slice(0, 80000);
  const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
  const ground = body.ground === true && images.length === 0;
  if (!prompt) return json({ error: "Missing prompt." }, 400);

  const parts = [{ text: prompt }];
  for (const img of images) {
    if (img && img.data && /^image\//.test(img.mime || "")) {
      parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
    }
  }

  const build = (think) => {
    const generationConfig = { temperature: 0.2 };
    // JSON mode can't be combined with Google Search on every model, so only use it when not searching.
    if (!ground) generationConfig.responseMimeType = "application/json";
    if (think) generationConfig.thinkingConfig = think;
    const req = { contents: [{ role: "user", parts }], generationConfig };
    if (ground) req.tools = [{ google_search: {} }];
    return JSON.stringify(req);
  };

  // Optional: { model: "<name>" } tries just that model from the list above (used for speed testing).
  const chosen = MODELS.filter(m => !body.model || m.name === body.model);

  let res, data, detail = "", used = "";
  outer:
  for (const model of chosen.length ? chosen : MODELS) {
    // Try with the fast-thinking setting first; if this model rejects it (400), retry once without it.
    for (const think of model.think ? [model.think, null] : [null]) {
      res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model.name}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: build(think)
      });
      if (res.ok) { used = model.name; break outer; }
      try { detail = (await res.json()).error?.message || ""; } catch { detail = ""; }
      if (res.status !== 400) break;
    }
    // Move to the next model if this one is missing, incompatible, or out of free quota.
    if (![400, 404, 429].includes(res.status)) break;
  }

  if (res.status === 429) return json({ error: "Lots of students are using Chapter Buddy right now. Try again in a minute.", detail: detail.slice(0, 300) }, 429);
  if (!res.ok) return json({ error: "The summarizer had a problem. Please try again.", detail: `${res.status} ${detail}`.slice(0, 300) }, 502);

  data = await res.json();
  const cand = data.candidates?.[0] || {};
  const text = (cand.content?.parts || []).filter(p => !p.thought).map(p => p.text || "").join("");
  if (!text) return json({ error: "No summary came back. Try again or paste the text instead." }, 502);

  // Web pages Gemini used when searching (shown under the summary as "Sources checked")
  const seen = new Set();
  const sources = (cand.groundingMetadata?.groundingChunks || [])
    .map(c => c.web).filter(w => w && w.uri)
    .filter(w => { const k = w.title || w.uri; if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 5).map(w => ({ uri: w.uri, title: w.title || "" }));

  // Count this summary toward the book's Trending rank (only the title is stored).
  const book = String(body.book || "").trim().toLowerCase().replace(/\s+/g, " ").slice(0, 80);
  if (book && env.STATS) waitUntil(countSummary(env.STATS, book).catch(() => {}));

  return json({ text, sources, model: used, ms: Date.now() - started });
}

async function countSummary(kv, book) {
  const key = "d:" + new Date().toISOString().slice(0, 10);
  const day = (await kv.get(key, "json")) || {};
  day[book] = (day[book] || 0) + 1;
  await kv.put(key, JSON.stringify(day), { expirationTtl: 60 * 60 * 24 * 10 }); // daily tallies expire after 10 days
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
