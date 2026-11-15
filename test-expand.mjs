import { readFileSync } from 'fs';
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^(\w+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
import { buildFingerprint, expandFrontier } from './src/steam.js';
import { findCreators } from './src/pipeline.js';
import { YouTube } from './src/youtube.js';
import { Cache } from './src/cache.js';

const yt = new YouTube(process.env.YOUTUBE_API_KEY, new Cache('cache.json'));
const input = '5478190'; // DeCube
const fp = await buildFingerprint(input);
const bases = fp.similarGames.filter((g) => g.appid);
console.log(`Game: ${fp.name} | tags: ${fp.tags.length} | base similar: ${bases.length}`);
const used = new Set([fp.name, ...bases.map((g) => g.name)].map((n) => n.toLowerCase()));
const seen = new Set();

async function scan(similarNames, label) {
  const t = Date.now();
  const { ranked, channelCount } = await findCreators(input, yt, {
    manualSimilar: similarNames || [], minSubs: 1000, maxSubs: 5_000_000, dlp: true,
  });
  const fresh = ranked.filter((r) => r.emails.length && !seen.has(r.channelId));
  fresh.forEach((r) => seen.add(r.channelId));
  console.log(`${label}: ${channelCount} raw hits, +${fresh.length} new w/email (total ${seen.size}) [${Math.round((Date.now() - t) / 1000)}s]`);
}

await scan(null, 'BASE  (main + 12 similar)');
for (let round = 1; round <= 9; round++) {
  const picks = await expandFrontier(bases, [...used], fp.tags);
  picks.forEach((p) => used.add(p.name.toLowerCase()));
  if (!picks.length) { console.log(`round ${round}: frontier dry`); break; }
  await scan(picks.map((p) => p.name), `ROUND ${round} (${picks.length} games)`);
}
console.log(`DONE — ${seen.size} unique creators with email, 1k-5m subs`);
