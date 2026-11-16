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
For each channel below, write ONE short line (under 90 characters, roughly 8-12 words) phrased to follow the word "you" in a sentence like "I noticed that you ..." — i.e. a verb-phrase describing what the channel does. Examples: "make chill co-op let's plays with your friends", "do analytical reviews with dry humor", "cover cozy sims and colony builders". Focus on: what they cover, commentary style, tone, format. No view counts, no video titles, no subscriber numbers, never start with "you".

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

// Outreach email template with merge variables the client fills per creator.
export async function campaignTemplate(apiKey, { game, dev }) {
  const prompt = `Write a short outreach email a game developer sends to YouTubers asking them to cover their game "${game}". Sender name: "${dev}".
Use these merge variables literally where appropriate: {name} (channel name), {alias} (creator's first name, used after "Hi"), {note} (a verb-phrase of what the creator does, written to follow "you" — e.g. "cover cozy sims and colony builders" — so write "because you {note}" or "I noticed that you {note}"), {keyoffer} (expands to e.g. "a Steam key" or "3 Steam keys for {game}" — use it for the key offer sentence instead of hardcoding a count), {keys} (where the actual keys are listed), {game}, {dev}.
Under 130 words, warm, direct and human, no marketing-speak, no emojis, no em-dashes. Output ONLY the email body.`;
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
  return (j.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
}
