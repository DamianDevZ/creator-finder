// YouTube Data API v3 client. Quota-conscious: search.list costs 100 units,
// everything else here costs 1/unit per call. Free quota is ~10k/day.

const API = 'https://www.googleapis.com/youtube/v3';

export class YouTube {
  constructor(apiKey, cache) {
    this.apiKey = apiKey;
    this.cache = cache;
  }

  async get(endpoint, params) {
    const qs = new URLSearchParams({ ...params, key: this.apiKey });
    const url = `${API}/${endpoint}?${qs}`;
    const res = await fetch(url);
    const j = await res.json();
    if (!res.ok) {
      const reason = j?.error?.errors?.[0]?.reason || j?.error?.message || `HTTP ${res.status}`;
      throw new Error(`YouTube ${endpoint} failed: ${reason}`);
    }
    return j;
  }

  // 100 units per call — always cached for 24h. Pages beyond the first
  // each cost another 100 units; pass pages=2 for deeper discovery.
  async searchVideos(query, maxResults = 50, pages = 1) {
    const all = [];
    let pageToken = '';
    for (let p = 0; p < pages; p++) {
      const j = await this.cache.wrap(`search:${query}:${maxResults}:p${p}`, async () =>
        this.get('search', {
          part: 'snippet',
          type: 'video',
          q: query,
          maxResults,
          order: 'relevance',
          videoCategoryId: '20', // Gaming
          ...(pageToken ? { pageToken } : {}),
        })
      );
      pageToken = j.nextPageToken || '';
      all.push(
        ...(j.items || []).map((it) => ({
          videoId: it.id.videoId,
          channelId: it.snippet.channelId,
          channelTitle: it.snippet.channelTitle,
          title: it.snippet.title,
          publishedAt: it.snippet.publishedAt,
        }))
      );
      if (!pageToken) break;
    }
    return all;
  }

  // Per-item caching: each video/channel is cached individually so channels
  // seen under a different game never cost quota again within the TTL.
  // videos: cached 30 days (view counts on uploads age slowly).
  // channels: cached 7 days (sub counts drift slowly).
  async #byId(kind, endpoint, part, ids, ttlMs) {
    const out = await this.cache.getMany(ids.map((id) => `${kind}:${id}`), ttlMs);
    const missing = ids.filter((id) => !out.has(`${kind}:${id}`));
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      const j = await this.get(endpoint, { part, id: batch.join(','), maxResults: 50 });
      this.cache.setMany((j.items || []).map((item) => [`${kind}:${item.id}`, item]));
      for (const item of j.items || []) out.set(`${kind}:${item.id}`, item);
    }
    this.cache.save();
    return ids.map((id) => out.get(`${kind}:${id}`)).filter(Boolean);
  }

  async videos(videoIds) {
    const MONTH = 30 * 24 * 60 * 60 * 1000;
    return this.#byId('video', 'videos', 'snippet,statistics,contentDetails', videoIds, MONTH);
  }

  async channels(channelIds) {
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    return this.#byId('channel', 'channels', 'snippet,statistics,brandingSettings,contentDetails', channelIds, WEEK);
  }

  // Channel search for manual adds — 100 units per call, cached 24h.
  // Falls back to scraping the channel-filtered results page when quota dies.
  async searchChannels(query, maxResults = 8) {
    try {
      const j = await this.cache.wrap(`chsearch:${query.toLowerCase()}`, async () =>
        this.get('search', { part: 'snippet', type: 'channel', q: query, maxResults }));
      const ids = (j.items || []).map((it) => it.snippet?.channelId).filter(Boolean);
      const chans = await this.channels(ids);
      return chans.map((c) => ({
        channelId: c.id, name: c.snippet?.title || '',
        thumb: c.snippet?.thumbnails?.default?.url || '',
        subs: Number(c.statistics?.subscriberCount || 0),
      }));
    } catch {
      return searchChannelsScrape(query, maxResults);
    }
  }

  // Latest uploads via the channel's official RSS feed — ZERO quota.
  // Falls back to the playlistItems API path on any failure. When the API is
  // dead, returns title/description/date parsed straight from the RSS XML.
  async recentVideosRSS(channelId, maxResults = 15) {
    try {
      const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`);
      if (!res.ok) throw new Error(`RSS ${res.status}`);
      const xml = await res.text();
      const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]).slice(0, maxResults);
      const ids = entries.map((e) => e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1]).filter(Boolean);
      try {
        return ids.length ? await this.videos(ids) : [];
      } catch {
        return entries.map((e) => ({
          id: e.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1],
          snippet: {
            title: decodeXml(e.match(/<title>([^<]*)<\/title>/)?.[1] || ''),
            description: decodeXml(e.match(/<media:description>([^<]*)<\/media:description>/)?.[1] || ''),
            publishedAt: e.match(/<published>([^<]+)<\/published>/)?.[1],
          },
        })).filter((v) => v.id);
      }
    } catch {
      return this.recentVideos(channelId, maxResults).catch(() => []);
    }
  }

  // Latest uploads for a channel — used for recency + recent-views scoring.
  // 1 unit for the uploads playlist id, then playlistItems is 1 unit/page.
  async recentVideos(channelId, maxResults = 15) {
    const ch = await this.channels([channelId]);
    const uploadsId = ch[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploadsId) return [];
    const j = await this.cache.wrap(`uploads:${channelId}:${maxResults}`, async () => {
      return this.get('playlistItems', {
        part: 'contentDetails',
        playlistId: uploadsId,
        maxResults,
      });
    });
    const ids = (j.items || []).map((it) => it.contentDetails.videoId);
    return ids.length ? this.videos(ids) : [];
  }
}

// ---- Quota-free fallbacks: scrape ytInitialData off public pages ----
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const decodeXml = (s) => String(s).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function ytPage(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!res.ok) throw new Error(`yt page HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/ytInitialData\s*=\s*(\{[\s\S]+?\})\s*;\s*<\/script>/) || html.match(/ytInitialData\s*=\s*(\{[\s\S]+?\})\s*;/);
  if (!m) throw new Error('ytInitialData not found');
  return JSON.parse(m[1]);
}

function* walkJson(o) {
  if (!o || typeof o !== 'object') return;
  yield o;
  for (const v of Object.values(o)) if (v && typeof v === 'object') yield* walkJson(v);
}

function parseSubsTxt(t) {
  const m = String(t || '').match(/([\d.,]+)\s*([KMB])?/i);
  if (!m) return 0;
  return Math.round(parseFloat(m[1].replace(/,/g, '')) * ({ K: 1e3, M: 1e6, B: 1e9 }[(m[2] || '').toUpperCase()] || 1));
}

async function searchChannelsScrape(query, maxResults = 8) {
  const data = await ytPage(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}&sp=EgIQAg%3D%3D`);
  const out = [];
  for (const o of walkJson(data)) {
    const c = o.channelRenderer;
    if (!c || !c.channelId) continue;
    const thumb = c.thumbnail?.thumbnails?.[0]?.url || '';
    out.push({
      channelId: c.channelId,
      name: c.title?.simpleText || '',
      thumb: thumb.startsWith('//') ? 'https:' + thumb : thumb,
      subs: parseSubsTxt(c.subscriberCountText?.simpleText || c.subscriberCountText?.runs?.[0]?.text),
    });
    if (out.length >= maxResults) break;
  }
  return out;
}

// Channel basics when the API quota is dead: name/description/subscriber
// count/avatar scraped off the public channel page.
export async function channelProfileScrape(channelId) {
  const data = await ytPage(`https://www.youtube.com/channel/${channelId}`);
  const meta = data.metadata?.channelMetadataRenderer || {};
  // Sub count must come from the channel header — the page also contains
  // subscriberCountText nodes for *other* channels (related/featured).
  let subs = 0, thumb = '';
  const header = data.header?.pageHeaderRenderer || data.header?.c4TabbedHeaderRenderer || {};
  for (const o of walkJson(header)) {
    if (!subs && o.subscriberCountText?.simpleText) subs = parseSubsTxt(o.subscriberCountText.simpleText);
    // Newer header: metadata rows like "9.79M subscribers"
    if (!subs && o.contentMetadataViewModel?.metadataRows) {
      for (const row of o.contentMetadataViewModel.metadataRows) {
        for (const part of row.metadataParts || []) {
          const t = part.text?.content || '';
          if (/subscribers/i.test(t)) subs = parseSubsTxt(t);
        }
      }
    }
    if (!thumb && o.avatar?.thumbnails?.length) thumb = o.avatar.thumbnails.slice(-1)[0].url;
    if (!thumb && o.image?.sources?.length) thumb = o.image.sources.slice(-1)[0].url;
    if (subs && thumb) break;
  }
  if (!subs) {
    for (const o of walkJson(data)) {
      if (o.subscriberCountText?.simpleText) { subs = parseSubsTxt(o.subscriberCountText.simpleText); break; }
    }
  }
  return { channelId, name: meta.title || '', desc: meta.description || '', subs, thumb };
}
