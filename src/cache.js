// Minimal JSON-file cache. Every expensive API response gets keyed + TTL'd.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h

export class Cache {
  constructor(path = 'cache.json') {
    this.path = path;
    try {
      this.data = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      this.data = {};
    }
  }

  get(key, ttlMs = DEFAULT_TTL_MS) {
    const e = this.data[key];
    if (!e) return null;
    if (Date.now() - e.t > ttlMs) return null;
    return e.v;
  }

  async getMany(keys, ttlMs = DEFAULT_TTL_MS) {
    const out = new Map();
    for (const k of keys) {
      const v = this.get(k, ttlMs);
      if (v !== null) out.set(k, v);
    }
    return out;
  }

  set(key, value) {
    this.data[key] = { t: Date.now(), v: value };
  }

  setMany(entries) {
    for (const [k, v] of entries) this.set(k, v);
  }

  async wrap(key, fn, ttlMs) {
    const hit = this.get(key, ttlMs);
    if (hit !== null) return hit;
    const v = await fn();
    this.set(key, v);
    this.save();
    return v;
  }

  save() {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data));
  }
}
