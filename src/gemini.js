// Optional AI notes via Gemini free tier. One batched call per scan.
// Needs GEMINI_API_KEY in .env (free at aistudio.google.com).

export async function aiNotesBatch(apiKey, channels) {
  const items = channels.map((c, i) => ({
    i,
    channel: c.channel,
    subs: c.subs,
    covers: (c.games || []).join(', '),
    description: (c.description || '').slice(0, 300),
    videoTitles: (c.vidTitles || []).slice(0, 6),
  }));
  const prompt = `You are helping an indie game developer write outreach emails to YouTubers.
For each channel below, write ONE short "notes" line (under 90 characters, roughly 10-12 words) describing their content style and personality — e.g. "Chill co-op let's plays with friends, loves chaotic party games" or "Analytical reviews, dry humor". Focus on: commentary style, solo vs group, tone (chill/hype/analytical/funny), format (let's play/review/stream clips). No view counts, no video titles, no subscriber numbers.

Return ONLY a JSON array of objects like {"i": 0, "note": "..."} — one per input, every index covered, no markdown.

${JSON.stringify(items)}`;
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  const j = await res.json();
  if (!res.ok) throw new Error(j?.error?.message || `Gemini HTTP ${res.status}`);
  const text = j.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
  return JSON.parse(text.replace(/```json|```/g, '').trim());
}
