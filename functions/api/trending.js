// Cloudflare Pages Function: GET /api/trending
// Returns how many summaries each book got over the last 7 days: { counts: { "wonder": 12, ... }, days: 7 }
// Counts are stored in the Workers KV namespace bound as STATS (one key per day: "d:YYYY-MM-DD").

const DAYS = 7;

export async function onRequestGet({ env }) {
  if (!env.STATS) return json({ counts: {}, days: DAYS, note: "no STATS binding" });

  const keys = [];
  const now = Date.now();
  for (let i = 0; i < DAYS; i++) keys.push("d:" + new Date(now - i * 86400000).toISOString().slice(0, 10));

  const counts = {};
  const days = await Promise.all(keys.map(k => env.STATS.get(k, "json").catch(() => null)));
  for (const day of days) {
    if (!day) continue;
    for (const [book, n] of Object.entries(day)) counts[book] = (counts[book] || 0) + (Number(n) || 0);
  }
  return json({ counts, days: DAYS }, 200, "public, max-age=120");
}

function json(obj, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": cache } });
}
