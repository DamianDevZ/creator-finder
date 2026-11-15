// yt-dlp provider — quota-free YouTube search via the internal API.
// LOCAL TESTING ONLY. Scraping is outside the official API ToS; do not
// enable this on the deployed/audited app.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

export async function searchDlp(query, maxResults = 50) {
  const { stdout } = await run(
    'python',
    ['-m', 'yt_dlp', `ytsearch${maxResults}:${query}`, '--flat-playlist', '--dump-json', '--quiet', '--no-warnings'],
    { maxBuffer: 64 * 1024 * 1024 }
  );
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
