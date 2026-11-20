// Cloudflare Pages Function: POST /api/summarize
// Keeps your Gemini API key secret on the server (free tier from https://aistudio.google.com/apikey).
// In Cloudflare: Pages project → Settings → Variables and Secrets → add GEMINI_API_KEY (type: Secret).

const MODEL = "gemini-2.5-flash"; // free-tier model; change here if Google renames it

export async function onRequestPost({ request, env }) {
  if (!env.GEMINI_API_KEY) return json({ error: "Server is missing GEMINI_API_KEY." }, 500);

  let body;
  try { body = await request.json(); } catch { return json({ error: "Bad request." }, 400); }

  const prompt = String(body.prompt || "").slice(0, 80000);
  const images = Array.isArray(body.images) ? body.images.slice(0, 8) : [];
  if (!prompt) return json({ error: "Missing prompt." }, 400);

  const parts = [{ text: prompt }];
  for (const img of images) {
    if (img && img.data && /^image\//.test(img.mime || "")) {
      parts.push({ inline_data: { mime_type: img.mime, data: img.data } });
    }
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
      generationConfig: { temperature: 0.4, responseMimeType: "application/json" }
    })
  });

  if (res.status === 429) return json({ error: "Lots of students are using Chapter Buddy right now. Try again in a minute." }, 429);
  if (!res.ok) return json({ error: "The summarizer had a problem. Please try again." }, 502);

  const data = await res.json();
  const text = (data.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("");
  if (!text) return json({ error: "No summary came back. Try again or paste the text instead." }, 502);
  return json({ text });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
}
