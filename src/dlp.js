// yt-dlp provider — quota-free YouTube search via the internal API.
// Uses the bundled standalone binary when present (deployed envs),
// otherwise falls back to `python -m yt_dlp` for local dev.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const run = promisify(execFile);

const BIN = fileURLToPath(new URL('../bin/yt-dlp', import.meta.url));
const hasBin = existsSync(BIN);
if (hasBin) {
  try { chmodSync(BIN, 0o755); } catch {}
  console.log('yt-dlp: using bundled binary');
}

export async function searchDlp(query, maxResults = 50) {
  const args = hasBin
    ? [BIN, [`ytsearch${maxResults}:${query}`, '--flat-playlist', '--dump-json', '--quiet', '--no-warnings']]
    : ['python', ['-m', 'yt_dlp', `ytsearch${maxResults}:${query}`, '--flat-playlist', '--dump-json', '--quiet', '--no-warnings']];
  const { stdout } = await run(args[0], args[1], { maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        const e = JSON.parse(l);
        return {
          videoId: e.id || e.url,
          channelId: e.channel_id,
          channelTitle: e.channel || e.channel_title || e.uploader,
          title: e.title,
          publishedAt: e.timestamp ? new Date(e.timestamp * 1000).toISOString() : null,
        };
      } catch {
        return null;
      }
    })
    .filter((r) => r && r.channelId);
}
