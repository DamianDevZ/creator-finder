// Shared pipeline: steam link -> fingerprint -> YouTube search -> ranked creators.
// Used by both index.js (CLI) and server.js (web UI).

import { buildFingerprint } from './steam.js';
import { scoreChannel, medianViews, daysSince } from './scoring.js';

// yt-dlp is a local-only test provider (gitignored, not in the audited repo).
let searchDlp = null;
try {
  ({ searchDlp } = await import('./dlp.js'));
  console.log('yt-dlp provider loaded');
} catch (e) {
  console.log('yt-dlp provider unavailable:', e.message);
}
import { extractContacts, extractAlias, classifyChannel } from './contacts.js';

const normalize = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const BRAND_DENY = /playstation|xbox|nintendo|devolverdigital|steam$/i;

export async function findCreators(input, yt, {
  manualTags = [],
  manualSimilar = [],
  minSubs = 0,
  maxSubs = Infinity,
  deep = false,
  deepTop = 30,
  topN = 20,
  pages = 2,
  dlp = false,
  skipGames = [],
} = {}) {
  const fp = await buildFingerprint(input, { manualTags });
  if (manualSimilar.length) fp.similarGames = manualSimilar.map((name, i) => ({ appid: `manual-${i}`, name }));

  const names = [fp.name, ...fp.similarGames.map((g) => g.name)];
  const skip = new Set(skipGames.map(normalize));
  const queries = names
    .flatMap((n, i) => (i === 0 ? [`"${n}" gameplay`, `"${n}" review`] : [`"${n}" gameplay`]).map((q) => ({ q, n })))
    .filter(({ n }) => !skip.has(normalize(n)))
    .map(({ q }) => q)
    .slice(0, 22);

  const hits = new Map();
  for (const q of queries) {
    const gameName = names.find((n) => q.toLowerCase().includes(n.toLowerCase())) || q;
    let results = [];
    try {
      results = dlp && searchDlp ? await searchDlp(q, 50 * pages) : await yt.searchVideos(q, 50, pages);
    } catch (e) {
      console.error(`search failed (${dlp && searchDlp ? 'dlp' : 'api'}) for "${q}":`, e.message);
      if (dlp && searchDlp) {
        try { results = await yt.searchVideos(q, 50, pages); } catch (e2) { console.error(`api fallback also failed for "${q}":`, e2.message); }
      }
    }
    for (const r of results) {
      const h = hits.get(r.channelId) || { channelTitle: r.channelTitle, videos: new Map(), games: new Set() };
      h.videos.set(r.videoId, { title: r.title, publishedAt: r.publishedAt, query: q });
      h.games.add(gameName);
      hits.set(r.channelId, h);
    }
  }

  // Drop official game/publisher channels.
  const searchNames = new Set(names.map(normalize));
  for (const [id, h] of hits) {
    const t = normalize(h.channelTitle);
    if (searchNames.has(t) || [...searchNames].some((n) => n.length > 5 && t.length > 5 && (t.includes(n) || n.includes(t)))) hits.delete(id);
    else if (BRAND_DENY.test(h.channelTitle)) hits.delete(id);
  }

  const allVideoIds = [...hits.values()].flatMap((h) => [...h.videos.keys()]);
  const videoDetails = new Map((await yt.videos(allVideoIds)).map((v) => [v.id, v]));
  const channelDetails = new Map((await yt.channels([...hits.keys()])).map((c) => [c.id, c]));

  const candidates = [];
  for (const [channelId, h] of hits) {
    const ch = channelDetails.get(channelId);
    const vids = [...h.videos.keys()].map((id) => videoDetails.get(id)).filter(Boolean);
    const subs = Number(ch?.statistics?.subscriberCount || 0);
    if (subs < minSubs || subs > maxSubs) continue;
    const newest = Math.max(...vids.map((v) => new Date(v.snippet.publishedAt).getTime()));
    candidates.push({
      channelId,
      channel: ch?.snippet?.title || h.channelTitle,
      subs,
      vids,
      medViews: Math.round(vids.reduce((s, v) => s + Number(v.statistics?.viewCount || 0), 0) / (vids.length || 1)),
      daysSince: Number.isFinite(newest) ? daysSince(new Date(newest).toISOString()) : null,
      description: ch?.snippet?.description || '',
      thumb: ch?.snippet?.thumbnails?.medium?.url || ch?.snippet?.thumbnails?.default?.url || '',
      games: [...h.games],
    });
  }

  // --deep: pull recent uploads for the top candidates so views/recency
  // reflect current channel activity, not just our matched videos.
  if (deep) {
    const preRanked = [...candidates]
      .sort((a, b) => b.vids.length - a.vids.length || b.medViews - a.medViews)
      .slice(0, deepTop);
    await Promise.all(
      preRanked.map(async (c) => {
        const recent = await yt.recentVideosRSS(c.channelId, 10);
        if (recent.length) {
          c.medViews = Math.round(recent.reduce((s, v) => s + Number(v.statistics?.viewCount || 0), 0) / recent.length);
          c.daysSince = daysSince(recent[0].snippet.publishedAt);
          c.recentTitles = recent.map((v) => v.snippet?.title).filter(Boolean);
        }
      })
    );
  }

  const ranked = candidates.map((c) => {
    const { score, breakdown } = scoreChannel({
      relevantVideoCount: c.vids.length,
      medianRecentViews: c.medViews,
      subscriberCount: c.subs,
      daysSinceLastUpload: c.daysSince,
    });
    const texts = [c.description, ...c.vids.map((v) => v.snippet?.description), ...c.vids.map((v) => v.snippet?.title)];
    const { emails, socials } = extractContacts(texts);
    const alias = extractAlias(texts, emails);
    const { niche, styles, language } = classifyChannel(texts);
    const notes = [];
    notes.push(styles.length ? styles.join(' · ') : 'General gaming');
    return {
      channel: c.channel,
      channelId: c.channelId,
      thumb: c.thumb,
      alias,
      niche,
      language,
      notes,
      vidTitles: [
        ...c.vids.map((v) => v.snippet?.title).filter(Boolean),
        ...(c.recentTitles || []),
      ].slice(0, 8),
      description: c.description.slice(0, 300),
      url: `https://youtube.com/channel/${c.channelId}`,
      subs: c.subs,
      medianViews: c.medViews,
      daysSince: c.daysSince,
      relevantVideos: c.vids.length,
      games: c.games,
      emails,
      socials,
      score,
      breakdown,
    };
  });

  ranked.sort((a, b) => b.score - a.score);
  return { fp, queries, channelCount: hits.size, ranked };
}
