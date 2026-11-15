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
    const out = new Map();
    const missing = [];
    for (const id of ids) {
      const hit = this.cache.get(`${kind}:${id}`, ttlMs);
      if (hit) out.set(id, hit);
      else missing.push(id);
    }
    for (let i = 0; i < missing.length; i += 50) {
      const batch = missing.slice(i, i + 50);
      const j = await this.get(endpoint, { part, id: batch.join(','), maxResults: 50 });
      for (const item of j.items || []) {
        this.cache.set(`${kind}:${item.id}`, item);
        out.set(item.id, item);
      }
    }
    this.cache.save();
    return ids.map((id) => out.get(id)).filter(Boolean);
  }

  async videos(videoIds) {
    const MONTH = 30 * 24 * 60 * 60 * 1000;
    return this.#byId('video', 'videos', 'snippet,statistics,contentDetails', videoIds, MONTH);
  }

  async channels(channelIds) {
    const WEEK = 7 * 24 * 60 * 60 * 1000;
    return this.#byId('channel', 'channels', 'snippet,statistics,brandingSettings,contentDetails', channelIds, WEEK);
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
