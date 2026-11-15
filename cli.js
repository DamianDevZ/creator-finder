#!/usr/bin/env node
// Usage:
//   node index.js fingerprint <steam-url-or-appid>
//   node index.js find <steam-url-or-appid> [--tags "A,B"] [--similar "G1,G2"]
//       [--minsubs N] [--maxsubs N] [--deep] [--top N]

import { readFileSync } from 'node:fs';
import { buildFingerprint } from './src/steam.js';
import { Cache } from './src/cache.js';
import { YouTube } from './src/youtube.js';
import { findCreators } from './src/pipeline.js';

function loadEnv() {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}

const [command, input, ...rest] = process.argv.slice(2);
if (!command || !input) {
  console.error('Usage: node index.js <fingerprint|find> <steam-url-or-appid> [--tags "A,B"] [--similar "G1,G2"] [--minsubs N] [--maxsubs N] [--deep] [--top N]');
  process.exit(1);
}
const flagList = (name) => {
  const i = rest.indexOf(name);
  return i !== -1 && rest[i + 1] ? rest[i + 1].split(',').map((t) => t.trim()).filter(Boolean) : [];
};
const flagNum = (name, fallback) => {
  const i = rest.indexOf(name);
  return i !== -1 && rest[i + 1] ? Number(rest[i + 1]) : fallback;
};

loadEnv();
const cache = new Cache('cache.json');

const manualTags = flagList('--tags');
const manualSimilar = flagList('--similar');
const fp = await buildFingerprint(input, { manualTags });
if (manualSimilar.length) fp.similarGames = manualSimilar.map((name, i) => ({ appid: `manual-${i}`, name }));
console.log(`\nGame: ${fp.name} (${fp.appid})`);
console.log(`Genres: ${fp.genres.join(', ') || 'n/a'}`);
console.log(`Tags: ${fp.tags.slice(0, 15).join(', ') || 'n/a'}`);
console.log(`Owners: ${fp.owners || 'n/a'}  Reviews: ${fp.reviewScore ?? 'n/a'}%`);
console.log(`Similar: ${fp.similarGames.map((g) => g.name).join(' | ') || 'n/a'}\n`);

if (command === 'fingerprint') process.exit(0);

const apiKey = process.env.YOUTUBE_API_KEY;
if (!apiKey) {
  console.error('Missing YOUTUBE_API_KEY — copy .env.example to .env and fill it in.');
  process.exit(1);
}
const yt = new YouTube(apiKey, cache);

const topN = flagNum('--top', 20);
const { ranked, queries, channelCount } = await findCreators(input, yt, {
  manualTags,
  manualSimilar,
  minSubs: flagNum('--minsubs', 0),
  maxSubs: flagNum('--maxsubs', Infinity),
  deep: rest.includes('--deep'),
}).then((r) => ({ ...r, ranked: r.ranked.slice(0, topN) }));
console.log(`Searched ${queries.length} queries -> ${channelCount} channels\n`);

const fmt = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n));
console.log('=== Top creators ===\n');
for (const r of ranked) {
  console.log(
    `${String(r.score).padStart(3)}  ${r.channel.slice(0, 30).padEnd(30)}  subs:${fmt(r.subs).padStart(7)}  medViews:${fmt(r.medianViews).padStart(8)}  hits:${r.relevantVideos}`
  );
  console.log(`     ${r.url}`);
  if (r.emails.length) console.log(`     email: ${r.emails.join(', ')}`);
  if (r.socials.length) console.log(`     socials: ${r.socials.slice(0, 3).join(', ')}`);
  console.log(`     fit:${r.breakdown.topicFit} reach:${r.breakdown.reach} eng:${r.breakdown.engagement} recency:${r.breakdown.recency}`);
}
