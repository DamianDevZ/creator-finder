// Supabase-backed cache — same interface as the local JSON Cache but
// persisted in Postgres so serverless deployments share state.
// Table: api_cache (key text pk, value jsonb, created_at timestamptz)

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export class SupaCache {
  constructor(url, serviceKey) {
    this.base = `${url}/rest/v1/api_cache`;
    this.headers = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates',
    };
  }

  async get(key, ttlMs = DEFAULT_TTL_MS) {
    const m = await this.getMany([key], ttlMs);
    return m.get(key) ?? null;
  }

  async getMany(keys, ttlMs = DEFAULT_TTL_MS) {
    const out = new Map();
    if (!keys.length) return out;
    try {
      const res = await fetch(`${this.base}?key=in.(${keys.map(encodeURIComponent).join(',')})&select=key,value,created_at`, { headers: this.headers });
      const rows = await res.json();
      const cutoff = Date.now() - ttlMs;
      for (const r of rows || []) {
        if (new Date(r.created_at).getTime() > cutoff) out.set(r.key, r.value);
      }
    } catch (e) {
      console.error('SupaCache read failed:', e.message);
    }
    return out;
  }

  set(key, value) {
    this.setMany([[key, value]]);
  }

  setMany(entries) {
    const rows = entries.map(([key, value]) => ({ key, value }));
    fetch(this.base, {
      method: 'POST',
      headers: { ...this.headers, Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(rows),
    }).catch((e) => console.error('SupaCache write failed:', e.message));
  }

  async wrap(key, fn, ttlMs) {
    const hit = await this.get(key, ttlMs);
    if (hit !== null) return hit;
    const v = await fn();
    this.set(key, v);
    return v;
  }

  save() {} // writes are per-call; no flush needed
}
