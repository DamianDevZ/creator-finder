// Local web UI: node server.js -> http://localhost:3456
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Cache } from './src/cache.js';
import { SupaCache } from './src/sbcache.js';
import { YouTube, channelProfileScrape } from './src/youtube.js';
import { buildFingerprint, expandFrontier } from './src/steam.js';
import { findCreators } from './src/pipeline.js';
import { extractContacts, extractAlias, classifyChannel } from './src/contacts.js';
import { scoreChannel, daysSince } from './src/scoring.js';
import { aiNotesBatch, campaignTemplate } from './src/gemini.js';
import { PRIVACY_MD, TERMS_MD } from './src/legal.js';

function loadEnv() {
  try {
    for (const line of readFileSync('.env', 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch {}
}
loadEnv();

const PORT = 3456;
const cache =
  process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY
    ? new SupaCache(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
    : new Cache(process.env.VERCEL ? '/tmp/creator-finder-cache.json' : 'cache.json');
const yt = new YouTube(process.env.YOUTUBE_API_KEY, cache);
const notesJobs_unused = null;
const DAY = 24 * 60 * 60 * 1000;

// Supabase Auth proxy — service key stays server-side; clients get user tokens.
const SB_URL = process.env.SUPABASE_URL, SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const sbAuth = (path, body) =>
  fetch(`${SB_URL}/auth/v1${path}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
async function sbUser(token) {
  if (!SB_URL || !token) return null;
  try {
    const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j?.id ? j : null;
  } catch { return null; }
}
const sbRest = (path, opts = {}) =>
  fetch(`${SB_URL}/rest/v1${path}`, {
    ...opts,
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
async function ensureProfile(uid) {
  const r = await sbRest(`/cf_profiles?user_id=eq.${uid}&select=plan`);
  const rows = await r.json().catch(() => []);
  if (Array.isArray(rows) && rows[0]) return rows[0];
  await sbRest('/cf_profiles', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: uid, plan: 'free' }),
  }).catch(() => {});
  return { plan: 'free' };
}
const setPlan = (uid, plan) =>
  sbRest('/cf_profiles', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({ user_id: uid, plan, updated_at: new Date().toISOString() }),
  }).catch(() => {});
const FREE_SCANS_PER_DAY = 2;

// ---- Creator/game knowledge graph --------------------------------------
// Every scan logs which creators cover which games; known creators merge
// back into future results and well-covered games skip their search query.
const normGame = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const COVERED_MIN = 8;
async function dbKnownCreators(simNames) {
  if (!SB_URL || !SB_KEY || !simNames.length) return { counts: {}, creators: [] };
  try {
    const keys = simNames.map(normGame);
    const r = await sbRest(`/cf_coverage?game=in.(${keys.map(encodeURIComponent).join(',')})&select=game,game_name,channel_id`);
    const rows = await r.json().catch(() => []);
    if (!Array.isArray(rows) || !rows.length) return { counts: {}, creators: [] };
    const counts = {}; const byId = new Map();
    for (const row of rows) {
      counts[row.game] = (counts[row.game] || 0) + 1;
      if (!byId.has(row.channel_id)) byId.set(row.channel_id, new Set());
      byId.get(row.channel_id).add(row.game_name);
    }
    const cr = await sbRest(`/cf_creators?channel_id=in.(${[...byId.keys()].map(encodeURIComponent).join(',')})&select=channel_id,data`);
    const crows = await cr.json().catch(() => []);
    const creators = (Array.isArray(crows) ? crows : []).map((c) => ({
      ...(c.data || {}), games: [...new Set([...((c.data || {}).games || []), ...byId.get(c.channel_id)])],
    }));
    return { counts, creators };
  } catch { return { counts: {}, creators: [] }; }
}
async function dbLogScan(fp, simNames, results) {
  if (!SB_URL || !SB_KEY || !results.length) return;
  try {
    const now = new Date().toISOString();
    const games = [fp.name, ...simNames];
    await sbRest('/cf_games', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(games.map((g) => {
        const meta = (fp.similarGames || []).find((x) => normGame(x.name) === normGame(g));
        const appid = normGame(g) === normGame(fp.name) ? fp.appid : meta && !String(meta.appid).startsWith('manual') ? meta.appid : '';
        return { key: normGame(g), name: g, appid: String(appid || ''), tags: fp.tags || [], similar_games: (fp.similarGames || []).map((x) => x.name), updated_at: now };
      })),
    }).catch(() => {});
    await sbRest('/cf_creators', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(results.map((r) => ({ channel_id: r.channelId, data: r, updated_at: now }))),
    }).catch(() => {});
    const edges = [];
    for (const r of results)
      for (const g of r.games && r.games.length ? r.games : games)
        edges.push({ game: normGame(g), game_name: g, channel_id: r.channelId, seen_at: now });
    if (edges.length)
      await sbRest('/cf_coverage', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(edges),
      }).catch(() => {});
  } catch (e) { console.error('dbLogScan:', e.message); }
}

// Steam store search autocomplete (game names -> appids).
async function searchGames(term) {
  return cache.wrap(`gsearch:${term.toLowerCase()}`, async () => {
    const res = await fetch(
      `https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=english&cc=US`
    );
    const j = await res.json();
    const items = (j.items || [])
      .filter((it) => it.type === 'app')
      .map((it) => ({ appid: it.id, name: it.name, img: it.tiny_image || null }));
    // Prefer entries that have art.
    items.sort((a, b) => (b.img ? 1 : 0) - (a.img ? 1 : 0));
    return items.slice(0, 8);
  });
}

// Steam's own popular tag list for tag autocomplete.
async function searchTags(term) {
  const all = await cache.wrap('steamtags:all', async () => {
    const res = await fetch('https://store.steampowered.com/tagdata/populartags/english');
    return res.json();
  });
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const t = norm(term);
  return all.filter((x) => norm(x.name).includes(t)).slice(0, 8).map((x) => x.name);
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"><title>Creator Finder</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#0b0e14;--panel:#121722;--panel2:#18202f;--line:#232c3d;--txt:#e8ecf4;--dim:#8a94a8;--acc:#5b8cff;--acc2:#7c5bff;--good:#3ddc84;--warn:#ffb454;--bad:#ff6b6b}
  *{box-sizing:border-box;scrollbar-width:thin;scrollbar-color:var(--line) transparent}
  html{overflow-y:scroll}
  ::-webkit-scrollbar{width:10px;height:10px}
  ::-webkit-scrollbar-track{background:transparent}
  ::-webkit-scrollbar-thumb{background:#2b3548;border-radius:6px;border:2px solid var(--bg)}
  ::-webkit-scrollbar-thumb:hover{background:#3a4763}
  ::-webkit-scrollbar-corner{background:transparent}
  body{margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:radial-gradient(1200px 600px at 70% -10%,#1a2340 0%,var(--bg) 55%);color:var(--txt);min-height:100vh}
  .shell{display:flex;min-height:100vh}
  #nav{width:230px;flex-shrink:0;border-right:1px solid var(--line);padding:22px 14px;position:sticky;top:0;height:100vh;overflow-y:auto;display:flex;flex-direction:column;background:var(--bg2)}
  .navlogo{font-size:15px;letter-spacing:1px;margin-bottom:24px;color:var(--dim)}
  .navlogo b{color:var(--acc)}
  .navsec{font-size:10px;letter-spacing:2px;color:var(--dim);margin-bottom:8px;padding:0 6px}
  .navitem{display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:8px;cursor:pointer;font-size:13px;margin-bottom:2px;position:relative}
  .navitem:hover{background:var(--bg3)}
  .navitem.on{background:var(--bg3);color:var(--txt)}
  .navitem .nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .navitem .g{font-size:10px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .navdots{color:var(--dim);padding:0 4px;font-size:14px;visibility:hidden}
  .navitem:hover .navdots{visibility:visible}
  .navmenu{display:none;position:absolute;right:8px;top:100%;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:4px;z-index:60;min-width:110px;box-shadow:0 10px 28px rgba(0,0,0,.5)}
  .navmenu.open{display:block}
  .navmenu .mi{padding:7px 10px;border-radius:6px;font-size:12px;cursor:pointer;color:var(--txt)}
  .navmenu .mi:hover{background:var(--bg3)}
  .navmenu .mi.danger{color:var(--bad)}
  .navadd{width:100%;margin-top:8px;padding:7px;border:1px dashed var(--line);border-radius:8px;background:transparent;color:var(--dim);font-size:12px;cursor:pointer}
  .navadd:hover{color:var(--txt);border-color:var(--dim)}
  .navguest{padding:12px 8px;margin-bottom:18px;border-bottom:1px solid var(--line)}
  .navacct-wrap{margin-top:auto;padding:12px 8px;border-top:1px solid var(--line)}
  .fadeout{opacity:0;transform:translateX(10px);transition:opacity .18s ease,transform .18s ease}
  .qt tr,.qcard2{transition:opacity .18s ease,transform .18s ease}
  .navacct{width:100%;padding:8px;margin-top:6px;border-radius:8px;border:1px solid var(--acc);background:var(--acc);color:#fff;font-size:12px;font-weight:600;cursor:pointer}
  .navacct.ghost{background:transparent;color:var(--txt);border-color:var(--line)}
  .navacct.ghost:hover{border-color:var(--dim)}
  .wrap{max-width:1200px;margin:0 auto;padding:36px 20px;flex:1;display:flex;flex-direction:column}
  .wrap.home{justify-content:flex-start;align-items:center}
  .wrap.home>*{width:min(920px,92%)}
  .wrap.home .titlerow{justify-content:center !important;margin-top:12vh}
  .wrap.home #viewtitle{font-size:clamp(28px,3.2vw,38px);letter-spacing:4px;font-weight:400}
  .wrap.home .sub{text-align:center;font-size:15px;margin-top:12px;line-height:1.6}
  .wrap.home .searchbar{padding:14px;border-radius:16px;margin-top:30px}
  .wrap.home .searchbar input{font-size:17px}
  .wrap.home .searchbar .btn{padding:12px 28px;font-size:15px}
  .howto{display:none;gap:16px;margin-top:40px}
  .wrap.home .howto{display:grid;grid-template-columns:repeat(3,1fr)}
  .howcard{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:22px 22px 20px;transition:border-color .15s}
  .howcard:hover{border-color:rgba(91,140,255,.45)}
  .howcard .hic{width:32px;height:32px;border-radius:9px;background:rgba(91,140,255,.14);color:var(--acc);font-size:15px;display:flex;align-items:center;justify-content:center}
  .howcard b{display:block;font-size:14.5px;margin:14px 0 8px}
  .howcard p{margin:0;font-size:13px;color:var(--dim);line-height:1.6}
  @media (max-width:760px){.wrap.home .howto{grid-template-columns:1fr}}
  .logo{font-size:13px;letter-spacing:3px;text-transform:uppercase;color:var(--dim)}
  .logo b{color:var(--acc)}
  h1{font-size:28px;font-weight:700;margin:6px 0 4px}
  .sub{color:var(--dim);font-size:14px;margin-bottom:28px}
  .searchbar{display:flex;gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:10px;box-shadow:0 8px 30px rgba(0,0,0,.35)}
  .searchbar input{flex:1;background:transparent;border:none;color:var(--txt);font-size:16px;padding:10px 12px;outline:none}
  .btn{background:linear-gradient(135deg,var(--acc),var(--acc2));border:none;color:#fff;font-weight:600;padding:10px 22px;border-radius:10px;cursor:pointer;font-size:14px;transition:.15s}
  .btn:hover{filter:brightness(1.15);transform:translateY(-1px)}
  .btn:disabled{opacity:.5;cursor:default;transform:none}
  .btn.ghost{background:var(--panel2);border:1px solid var(--line);color:var(--txt)}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px;margin-top:18px}
  .gameline{display:flex;gap:14px;align-items:center;margin-bottom:14px}
  .gameline img{border-radius:8px}
  .gametitle{font-size:18px;font-weight:700}
  .meta{color:var(--dim);font-size:12.5px}
  .seclabel{margin:18px 0 10px;font-size:11px;text-transform:uppercase;letter-spacing:1.5px;color:var(--dim);display:flex;align-items:center;gap:10px}
  .seclabel::after{content:'';flex:1;height:1px;background:var(--line)}
  /* --- similar-game cards --- */
  .gamegrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
  .gcard{position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:var(--panel2);transition:.15s}
  .gcard:hover{border-color:#3a527a;transform:translateY(-2px)}
  .gcard img{width:100%;object-fit:cover;display:block;background:var(--line)}
  .gcard .gname{padding:7px 10px 3px;font-size:12.5px;font-weight:600;line-height:1.3;min-height:32px}
  .gcard .gtags{display:flex;flex-wrap:wrap;gap:4px;padding:0 10px 8px;min-height:22px}
  .tag.sm{font-size:9.5px;padding:2px 7px}
  .gcard .x{position:absolute;top:5px;right:5px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.75);color:var(--bad);display:none;align-items:center;justify-content:center;cursor:pointer;font-size:14px;line-height:1}
  .gcard:hover .x{display:flex}
  .addcard{display:flex;align-items:center;justify-content:center;border:1px dashed var(--line);border-radius:10px;color:var(--dim);cursor:pointer;font-size:13px;min-height:100px;transition:.15s}
  .addcard:hover{border-color:var(--acc);color:var(--acc)}
  .searchcard{border:1px solid var(--acc) !important;border-style:solid !important;padding:8px;cursor:default}
  .searchcard input{width:100%;background:transparent;border:none;color:var(--txt);font-size:13px;outline:none}
  /* --- game search results: same card grid --- */
  .dd.gdd{position:static;border:none;background:transparent;box-shadow:none;width:100%;max-height:none;padding:0;margin-top:12px}
  .dd.gdd .gddgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:10px}
  .dd.gdd .gitem{display:block;position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:var(--panel2);cursor:pointer;transition:.15s;padding:0}
  .dd.gdd .gitem:hover{border-color:var(--acc);transform:translateY(-2px);box-shadow:0 6px 18px rgba(91,140,255,.15)}
  .dd.gdd .gitem img{width:100%;object-fit:cover;display:block;background:var(--line)}
  .dd.gdd .gitem .noimg{width:100%;aspect-ratio:231/87;background:var(--line);display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--dim)}
  .dd.gdd .gitem span{display:block;padding:7px 10px;font-size:12.5px;font-weight:600;line-height:1.3;min-height:36px}
  .dd.gdd .gitem::after{content:'+ add';position:absolute;top:6px;right:6px;background:rgba(0,0,0,.7);color:var(--good);font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px;opacity:0;transition:.15s}
  .dd.gdd .gitem:hover::after{opacity:1}
  .gdd-title{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);margin:0 0 8px}
  /* --- tag pills --- */
  .tagbox{display:flex;flex-wrap:wrap;gap:6px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:10px 12px;cursor:text}
  .tagbox:focus-within{border-color:var(--acc)}
  .tag{display:flex;align-items:center;gap:5px;background:#25324a;border:1px solid #3a527a;border-radius:999px;padding:3px 11px;font-size:12.5px}
  .tag .x{color:var(--bad);cursor:pointer;opacity:.7;font-weight:700}
  .tag .x:hover{opacity:1}
  .tagbox input{background:transparent;border:none;color:var(--txt);font-size:13px;outline:none;flex:1;min-width:140px;padding:4px}
  .addbox{position:relative}
  .dd{position:absolute;top:38px;left:0;width:340px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;overflow:hidden;z-index:10;box-shadow:0 12px 30px rgba(0,0,0,.5)}
  .dd .dditem{padding:8px 12px;cursor:pointer;display:flex;gap:10px;align-items:center;font-size:13px}
  .dd .dditem:hover{background:#223050}
  /* --- options bar --- */
  .controls{display:flex;gap:12px;align-items:stretch;flex-wrap:wrap;margin-top:18px;padding-top:16px;border-top:1px solid var(--line)}
  .ctl{background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:8px 14px;display:flex;flex-direction:column;gap:4px}
  .ctl span{font-size:10px;text-transform:uppercase;letter-spacing:1px;color:var(--dim)}
  .ctl input{width:90px;background:transparent;border:none;color:var(--txt);font-size:15px;font-weight:600;outline:none;padding:0}
  .switch{flex-direction:row !important;align-items:center;gap:10px;cursor:pointer}
  .switch input{display:none}
  .sw{width:36px;height:20px;border-radius:999px;background:var(--line);position:relative;transition:.2s;flex-shrink:0}
  .sw::after{content:'';position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:.2s}
  .switch input:checked + .sw{background:var(--acc)}
  .switch input:checked + .sw::after{left:18px}
  #status{margin:14px 2px 8px;color:var(--dim);font-size:13px;min-height:18px}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid var(--line);border-top-color:var(--acc);border-radius:50%;animation:spin .8s linear infinite;vertical-align:-2px;margin-right:8px}
  @keyframes spin{to{transform:rotate(360deg)}}
  table{width:100%;border-collapse:collapse;margin-top:6px;font-size:14px;table-layout:fixed}
  th:nth-child(1){width:60px}th:nth-child(2){width:200px}th:nth-child(3){width:90px}
  th:nth-child(4){width:70px}th:nth-child(5){width:88px}th:nth-child(7){width:90px}
  td{word-break:break-word}
  th{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:var(--dim);text-align:left;padding:10px 12px;border-bottom:1px solid var(--line);cursor:pointer;user-select:none;white-space:nowrap}
  th:hover{color:var(--txt)}
  td{padding:12px;border-bottom:1px solid var(--line);vertical-align:middle}
  tr:hover td{background:rgba(91,140,255,.04)}
  .pill{display:inline-block;min-width:44px;text-align:center;padding:5px 10px;border-radius:8px;font-weight:700;font-size:15px}
  .p-good{background:rgba(61,220,132,.12);color:var(--good)}
  .p-mid{background:rgba(255,180,84,.12);color:var(--warn)}
  .p-bad{background:rgba(255,107,107,.12);color:var(--bad)}
  .chan{display:flex;gap:12px;align-items:center}
  .chan img{width:42px;height:42px;border-radius:50%;object-fit:cover}
  .channame{font-weight:600}
  .channame a{color:var(--txt);text-decoration:none}
  .channame a:hover{color:var(--acc)}
  .num{font-variant-numeric:tabular-nums}
  .emailchip{display:inline-block;background:rgba(91,140,255,.1);border:1px solid rgba(91,140,255,.3);border-radius:6px;padding:3px 8px;font-size:11px;margin:1px 2px 1px 0;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
  td .emailchip{max-width:210px}
  select{appearance:none;cursor:pointer}
  select, select option{color-scheme:dark;background:var(--panel2);color:var(--txt)}
  .dd-btn{font-size:14px;font-weight:600;color:var(--txt)}
  .dd-menu{display:none;position:absolute;top:calc(100% + 8px);left:0;min-width:170px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:5px;z-index:50;box-shadow:0 12px 32px rgba(0,0,0,.5)}
  .dd-menu.open{display:block}
  .dd-menu .opt{padding:8px 12px;border-radius:7px;font-size:13px;cursor:pointer;color:var(--txt)}
  .dd-menu .opt:hover{background:var(--acc);color:#fff}
  .dd-menu .opt.sel{color:var(--acc);font-weight:700}
  .notes-cell>div{min-height:60px;display:flex;flex-direction:column;justify-content:center}
  /* --- lists & triage --- */
  .listbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .lpbtn{display:flex;align-items:center;gap:8px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;color:var(--txt);padding:8px 14px;font-size:14.5px;font-weight:700;cursor:pointer}
  .lpbtn:hover{border-color:var(--dim)}
  .lpbtn .car{font-size:9px;color:var(--dim)}
  .lpmenu{position:absolute;top:calc(100% + 6px);left:0;min-width:200px;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:5px;z-index:80;box-shadow:0 12px 32px rgba(0,0,0,.55);max-height:280px;overflow-y:auto}
  .lpmi{padding:8px 10px;border-radius:7px;font-size:13px;cursor:pointer}
  .lpmi:hover{background:var(--bg3)}
  .lpmi.on{color:var(--acc);font-weight:600}
  .lmodal{position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(4,7,12,.84);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;z-index:200}
  .lmbox{position:relative;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 22px;width:300px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
  .mx{position:absolute;top:10px;right:14px;background:none;border:none;color:var(--dim);font-size:16px;cursor:pointer;padding:4px}
  .lmbox.wide{width:820px;max-width:94vw}
  .ttitle{font-size:24px;font-weight:700;text-align:center}
  .tsub{color:var(--dim);font-size:13.5px;text-align:center;margin:8px 0 24px}
  .tiergrid{display:grid;grid-template-columns:1fr 1fr;gap:18px}
  .tcard{position:relative;background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:26px 24px;display:flex;flex-direction:column;gap:16px}
  .tcard.pro{border:1.5px solid var(--acc)}
  .tbadge{position:absolute;top:-11px;left:50%;transform:translateX(-50%);background:var(--acc);color:#fff;font-size:10.5px;font-weight:700;letter-spacing:.9px;padding:4px 12px;border-radius:20px;white-space:nowrap}
  .tname{font-size:12px;font-weight:700;letter-spacing:1.6px;color:var(--dim)}
  .tcard.pro .tname{color:var(--acc)}
  .tprice{font-size:38px;font-weight:800}
  .tprice span{font-size:13px;color:var(--dim);font-weight:500}
  .tfeats{display:flex;flex-direction:column;gap:9px;font-size:13.5px;color:var(--txt);flex:1}
  .tfeats .fi{display:flex;gap:9px;align-items:baseline}
  .tfeats .fi i{font-style:normal;color:var(--acc);font-weight:700;flex:none}
  .tfeats .flabel{color:var(--dim);font-size:11.5px;letter-spacing:.5px;margin-bottom:2px}
  .tcta{width:100%;justify-content:center;padding:12px;font-size:14px}
  .tcur{text-align:center;color:var(--dim);font-size:12.5px;padding:12px;border:1px dashed var(--line);border-radius:9px}
  .planchip{display:inline-block;background:var(--panel2);border:1px solid var(--line);border-radius:20px;padding:3px 12px;font-size:11.5px;color:var(--dim);margin-left:8px}
  .prochip{display:inline-block;background:var(--acc);color:#fff;border-radius:6px;padding:2px 7px;font-size:10px;font-weight:700;letter-spacing:.8px;margin-bottom:8px}
  .tlink{color:var(--acc);cursor:pointer;font-size:12px;background:none;border:none;padding:0}
  .tlink:hover{text-decoration:underline}
  .tplansum{display:flex;justify-content:space-between;align-items:center;background:var(--panel2);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:18px}
  .tpsname{font-weight:700;font-size:14px}
  .tpsprice{color:var(--dim);font-size:12px;margin-top:2px}
  .tlabel{display:block;font-size:12px;color:var(--dim);margin:0 0 6px}
  .tlabel+input{margin-bottom:14px;padding:11px 12px}
  .tfine{text-align:center;color:var(--dim);font-size:11.5px;margin-top:12px}
  .tdone{text-align:center;padding:14px 0}
  .tdone .big{font-size:40px;color:var(--good)}
  .mx:hover{color:var(--txt)}
  #notifs{position:fixed;top:14px;right:14px;z-index:400;display:flex;flex-direction:column;gap:8px;max-width:360px}
  .notifitem{background:var(--panel);border:1px solid var(--acc);border-radius:10px;padding:10px 14px;font-size:12px;box-shadow:0 8px 30px rgba(0,0,0,.5);display:flex;gap:10px;align-items:center}
  .kchip{display:inline-block;background:var(--bg3);border:1px solid var(--line);border-radius:6px;padding:2px 8px;font:11px monospace;cursor:pointer;margin:2px 4px 2px 0}
  .kchip.claimed{border-color:#d4a017;color:#e8c35a}.kchip.redeemed{border-color:var(--good);color:var(--good)}
  .campsec{background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:14px}
  .cs-head{display:flex;align-items:center;gap:10px;font-size:11px;font-weight:700;letter-spacing:.8px;text-transform:uppercase;color:var(--dim);margin-bottom:12px}
  .cs-ic{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:rgba(91,140,255,.14);color:var(--acc);font-size:13px;flex-shrink:0}
  .ptabs{display:flex;border-bottom:1px solid var(--line);background:var(--panel2)}
  .ptab{flex:1;background:none;border:none;border-bottom:2px solid transparent;padding:14px;font-size:14px;font-weight:700;color:var(--dim);cursor:pointer;font-family:inherit}
  .ptab.on{color:var(--txt);background:var(--panel)}
  .ptab:hover{color:var(--txt)}
  .keyrow{display:grid;grid-template-columns:minmax(0,1fr) 86px 140px 66px 86px 26px;gap:10px;align-items:center;padding:8px 4px;border-top:1px solid var(--line);font-size:12px}
  .keyrow.khead{border-top:none;padding:0 4px 8px;color:var(--dim);font-size:10px;letter-spacing:.7px;text-transform:uppercase;font-weight:700}
  .keyrow .kmono{font-family:monospace;background:var(--bg3);border:1px solid var(--line);border-radius:6px;padding:3px 8px;display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis}
  .draftcard{border:1px solid var(--line);border-radius:12px;padding:14px 16px;margin-bottom:12px;background:var(--panel2)}
  .dc-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
  .dc-av{width:34px;height:34px;border-radius:50%;flex-shrink:0;background:var(--bg3)}
  .dmail{border:1px solid var(--line);border-radius:10px;margin-top:10px;overflow:hidden}
  .dmail .dm-head{background:var(--panel2);padding:8px 14px;font-size:11px;color:var(--dim);display:flex;gap:16px;flex-wrap:wrap;border-bottom:1px solid var(--line)}
  .dmail .dm-head b{color:var(--txt);font-weight:600}
  .dmail .dm-body{padding:13px 16px;font-size:12.5px;line-height:1.65;color:var(--txt);white-space:pre-wrap;font-family:inherit;background:var(--bg3)}
  .apick:hover{background:var(--panel2)}
  .mtab{font-size:15px;font-weight:700;color:var(--dim);cursor:pointer;padding:4px 2px;border-bottom:2px solid transparent;background:none;border-top:none;border-left:none;border-right:none;font-family:inherit}
  .mtab.on{color:var(--txt);border-bottom-color:var(--acc)}
  .mtab:hover{color:var(--txt)}
  .lmbox input{width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:9px;color:var(--txt);padding:9px 12px;font-size:13px;outline:none}
  .listbar select,.listbar input{background:var(--panel2);border:1px solid var(--line);border-radius:9px;color:var(--txt);padding:8px 12px;font-size:13px;outline:none}
  .vbtns{display:flex;gap:6px}
  .vb{border:1px solid var(--line);background:var(--panel2);color:var(--txt);border-radius:8px;padding:5px 12px;cursor:pointer;font-size:13px;font-weight:600}
  .vb.ok:hover{background:rgba(61,220,132,.15);border-color:var(--good);color:var(--good)}
  .vb.no:hover{background:rgba(240,80,80,.15);border-color:var(--bad);color:var(--bad)}
  .vb.ok.on{background:rgba(61,220,132,.15);border-color:var(--good);color:var(--good)}
  .vb.no.on{background:rgba(240,80,80,.15);border-color:var(--bad);color:var(--bad)}
  .qrow{display:flex;align-items:center;gap:12px;padding:10px 14px;border-bottom:1px solid var(--line)}
  .qrow:last-child{border-bottom:none}
  .qrow img{width:36px;height:36px;border-radius:50%}
  .qcard{flex:1;background:var(--panel2);border:1px solid var(--line);border-radius:12px;padding:16px;text-align:left}
  .qcard img{width:52px;height:52px;border-radius:50%}
  .ltab{padding:6px 14px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--dim);cursor:pointer;font-size:12px;font-weight:600}
  .ltab.on{background:var(--acc);border-color:var(--acc);color:#fff}
  .mailchip{display:inline-block;background:var(--bg3);border:1px solid var(--line);border-radius:7px;padding:2px 8px;font-size:11px;color:var(--txt);white-space:nowrap;cursor:pointer}
  /* queue table */
  .qt{width:100%;border-collapse:collapse;table-layout:fixed}
  .qt th{padding:10px 14px;text-align:left}
  .qt td{padding:11px 14px;vertical-align:middle;border-top:1px solid var(--line)}
  .qt .channame{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .qt .channame a{color:var(--txt);text-decoration:none}
  .qt .channame a:hover{color:var(--acc)}
  .qt .qnotes{font-size:12px;line-height:1.5;color:var(--dim);min-height:36px}
  .scanload{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:70px 24px}
  .skl{background:linear-gradient(90deg,var(--panel2) 25%,var(--bg3) 50%,var(--panel2) 75%);background-size:200% 100%;animation:shimmer 1.4s infinite}
  @keyframes shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}
  .qt td:last-child{padding-right:20px}
  /* detailed creator card */
  .qcard2{display:flex;gap:16px;background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin-bottom:12px}
  .qc-status{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;min-width:96px;padding-left:18px;border-left:1px solid var(--line)}
  .qc-status .qc-sl{font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim);font-weight:700}
  .qc-status .pill{font-size:12px;padding:5px 12px;min-width:0;text-decoration:none}
  .qc-left{width:190px;flex-shrink:0;text-align:center;align-self:center}
  .qc-left img{width:84px;height:84px;border-radius:50%}
  .qcard2 .qc-name{display:block;font-weight:700;font-size:15px;color:var(--txt);text-decoration:none;margin-top:10px}
  .qcard2 .qc-name:hover{color:var(--acc)}
  .qcard2 .qc-sub{font-size:11.5px;color:var(--dim);margin-top:4px}
  .qc-main{flex:1;min-width:0}
  .qc-stats{display:flex;gap:10px;align-items:stretch;margin-bottom:14px}
  .qstat{flex:1;background:var(--bg3);border:1px solid var(--line);border-radius:10px;padding:10px 12px}
  .qstat .qs-l{font-size:10px;letter-spacing:.6px;color:var(--dim);text-transform:uppercase;font-weight:700}
  .qstat .qs-v{font-size:15px;font-weight:700;margin-top:4px}
  .qc-low{display:grid;grid-template-columns:3fr 1fr;gap:12px}
  .qc-rows{display:grid;grid-template-columns:64px 1fr;row-gap:9px;font-size:12.5px;align-content:start}
  .qc-lbl{color:var(--dim);font-size:10.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;padding-top:1px}
  .qc-val{color:var(--txt);line-height:1.55}
  .qc-act{align-self:end;display:flex;gap:8px}
  .vb.big{flex:1;padding:12px 0;font-size:13px;border-radius:10px;min-width:0}
  .soc a{color:var(--dim);font-size:12px;text-decoration:none;margin-right:8px}
  .soc a:hover{color:var(--acc)}
  .covers{font-size:12.5px;color:var(--dim);line-height:1.6}
  .covers b{color:var(--acc);font-weight:600}
  .empty{color:var(--dim);text-align:center;padding:30px}
</style>
</head>
<body>
<div class="shell">
<aside id="nav">
  <div class="navlogo"><b>CREATOR</b><span>FINDER</span></div>
  <div class="navguest">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <div style="width:30px;height:30px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--dim)">G</div>
      <div><div style="font-size:13px;font-weight:600">Guest</div><div class="meta" style="font-size:10.5px">lists saved locally</div></div>
    </div>
  </div>
  <div class="navsec">LISTS</div>
  <div id="navlists"></div>
  <button class="navadd" data-act="newlist">+ New list</button>
  <div id="newlistbox" style="display:none;margin-top:8px">
    <input id="navlistname" placeholder="List name…" style="width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--txt);padding:8px 10px;font-size:13px;outline:none">
  </div>
  <div class="navacct-wrap" id="navacctwrap">
    <button class="navacct" data-act="acct">Create account</button>
    <button class="navacct ghost" data-act="acct">Log in</button>
  </div>
</aside>
<div class="wrap">
  <div class="titlerow" style="display:flex;align-items:baseline;justify-content:space-between;gap:12px">
    <h1 id="viewtitle">Creator Finder</h1>
    <button class="ltab" id="backlist" data-act="backlist" style="display:none">← Back to list</button>
  </div>
  <div class="sub">Paste a Steam link. We profile the game, scan YouTube for channels covering similar titles, and rank who's most likely to say yes.</div>

  <div class="searchbar" style="position:relative">
    <input id="link" placeholder="Paste a Steam link or type a game name…" autofocus>
    <div class="dd" id="linkdd" style="display:none;left:10px;right:10px;width:auto;top:100%"></div>
    <button class="btn" id="load">Analyze game</button>
  </div>

  <div class="howto">
    <div class="howcard"><div class="hic">◈</div><b>Profile your game</b><p>Drop a Steam link and we pull its tags, developer, capsule art, and the games players actually compare it to.</p></div>
    <div class="howcard"><div class="hic">◎</div><b>Find real fits</b><p>We scan YouTube for channels covering your game or its neighbors, then rank them by meaningful tag overlap, activity, and reach.</p></div>
    <div class="howcard"><div class="hic">✦</div><b>Personalized outreach</b><p>AI notes capture what each channel does, so every email draft reads like you genuinely watch their content.</p></div>
    <div class="howcard"><div class="hic">⚿</div><b>Track every key</b><p>Paste your Steam keys once, assign one or more per creator, and follow each from sent to claimed to redeemed.</p></div>
    <div class="howcard"><div class="hic">⚑</div><b>Know when they cover you</b><p>We keep checking your contacted creators and flag anyone who may have made a video about your game.</p></div>
    <div class="howcard"><div class="hic">☰</div><b>Lists with a goal</b><p>Set how many creators you want to reach. The queue keeps refilling with fresh candidates until you get there.</p></div>
  </div>

  <div id="base" style="display:none">
    <div class="panel">
      <div id="gamepanel" style="display:flex;gap:20px">
        <div style="width:50%;flex-shrink:0">
          <img id="gameimg" style="display:none;width:100%;border-radius:10px">
          <div class="gametitle" id="gametitle"></div>
          <div class="meta" id="gamemeta"></div>
          <div id="gametags" style="display:flex;flex-wrap:wrap;gap:5px;margin-top:7px"></div>
        </div>
        <div id="reldev" style="flex:1;min-width:0"></div>
        <div id="relpub" style="flex:1;min-width:0"></div>
      </div>
    </div>

    <div class="panel">
      <div class="seclabel" style="margin-top:0">Creators covering these or similar games will be found</div>
      <div class="gamegrid" id="simchips">
        <div class="addcard" id="addcardbtn">+ Add game</div>
      </div>
      <div class="dd gdd" id="simdd" style="display:none;position:static;margin-top:10px"></div>
    </div>



    <div class="panel">
      <div class="seclabel" style="margin-top:0">Filters</div>
      <div class="controls" style="border-top:none;margin-top:0;padding-top:0;justify-content:center">
        <div class="ctl"><span>Min subs</span><input id="minsubs" inputmode="numeric" value="1,000"></div>
        <div class="ctl"><span>Max subs</span><input id="maxsubs" inputmode="numeric" value="5,000,000"></div>
        <input type="hidden" id="top" value="400">
        <input type="hidden" id="deep" checked>
        <input type="hidden" id="devonly" value="on">
        <div class="ctl" style="position:relative"><span>Language</span>
          <input type="hidden" id="langfilter" value="English">
          <div class="dd-btn" id="langbtn" style="cursor:pointer;display:flex;align-items:center;gap:6px">English <span style="font-size:9px;color:var(--dim)">▾</span></div>
          <div class="dd-menu" id="langmenu"></div>
        </div>
        <div class="ctl" style="position:relative"><span>Last post</span>
          <input type="hidden" id="postfilter" value="any">
          <div class="dd-btn" id="postbtn" style="cursor:pointer;display:flex;align-items:center;gap:6px">Anytime <span style="font-size:9px;color:var(--dim)">▾</span></div>
          <div class="dd-menu" id="postmenu"></div>
        </div>
      </div>
      <div style="display:flex;justify-content:center;margin-top:14px">
        <button class="btn" id="go" style="padding:11px 34px;font-size:14px">Find creators</button>
      </div>
    </div>
  </div>

  <div id="status"></div>
  <div id="out"></div>
  <div id="lists"></div>

  <div id="lmodal" class="lmodal" style="display:none">
    <div class="lmbox">
      <div style="font-weight:700;margin-bottom:4px">Create a list</div>
      <div class="meta" style="font-size:11.5px;margin-bottom:12px">Verdicts need a list to live in.</div>
      <input id="lmname" placeholder="e.g. Release outreach" autocomplete="off">
      <input id="lmgoal" placeholder="Goal — how many creators? (optional)" inputmode="numeric" style="margin-top:8px">
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button class="ltab" data-act="lmcancel">Cancel</button>
        <button class="btn" data-act="lmcreate" style="padding:8px 18px;font-size:13px">Create</button>
      </div>
    </div>
  </div>

  <div id="amodal" class="lmodal" style="display:none">
    <div class="lmbox" style="width:400px">
      <button class="mx" data-act="amcancel">✕</button>
      <div style="font-weight:700;margin-bottom:4px">Add a creator</div>
      <div class="meta" style="font-size:11.5px;margin-bottom:12px">Search YouTube — pick a channel to add it to this list.</div>
      <input id="aq" placeholder="Channel name…" autocomplete="off">
      <div id="ares" style="margin-top:8px;max-height:280px;overflow-y:auto"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button class="ltab" data-act="amcancel">Close</button>
      </div>
    </div>
  </div>

  <div id="emodal" class="lmodal" style="display:none">
    <div class="lmbox" style="width:420px">
      <button class="mx" data-act="ecancel">✕</button>
      <div style="font-weight:700;margin-bottom:4px">Edit creator</div>
      <div class="meta" id="echname" style="font-size:11.5px;margin-bottom:4px"></div>
      <div class="meta" style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px">Alias (first name)</div>
      <input id="ealias" autocomplete="off">
      <div class="meta" style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px">Notes</div>
      <input id="enote" autocomplete="off">
      <div class="meta" style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px">Covers — games, comma-separated</div>
      <input id="egames" autocomplete="off">
      <div class="meta" style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin:10px 0 4px">Emails — comma-separated</div>
      <input id="eemails" autocomplete="off">
      <div style="display:flex;gap:8px;align-items:center;margin-top:14px">
        <button class="ltab" data-act="eremove" style="color:#e06c75;border-color:#e06c75;font-size:11.5px">Remove from list</button>
        <span style="margin-left:auto"></span>
        <button class="ltab" data-act="ecancel">Cancel</button>
        <button class="btn" data-act="esave" style="padding:8px 18px;font-size:13px">Save</button>
      </div>
    </div>
  </div>

  <div class="lmodal" id="authmodal" style="display:none">
    <div class="lmbox" style="position:relative">
      <button class="mx" data-act="authcancel">✕</button>
      <b>Account</b>
      <div class="meta" style="margin:4px 0 12px;font-size:12px">Sign in to sync your lists to the cloud.</div>
      <label style="font-size:11px;color:var(--dim)">Email</label>
      <input id="aemail" type="email" style="margin-top:4px">
      <label style="font-size:11px;color:var(--dim);display:block;margin-top:10px">Password</label>
      <input id="apass" type="password" style="margin-top:4px">
      <div id="aerr" style="color:var(--bad);font-size:11.5px;margin-top:8px;min-height:15px"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:8px">
        <button class="ltab" data-act="authcancel">Cancel</button>
        <button class="btn" data-act="authdo" data-v="login" style="padding:8px 16px;font-size:13px">Log in</button>
        <button class="btn" data-act="authdo" data-v="signup" style="padding:8px 16px;font-size:13px">Sign up</button>
      </div>
      <div style="text-align:center;margin-top:12px"><button class="tlink" data-act="tiers">New here? See plans and create an account</button></div>
    </div>
  </div>

  <div class="lmodal" id="tiermodal" style="display:none">
    <div class="lmbox wide" id="tierbox" style="position:relative"></div>
  </div>

  <div id="notifs"></div>
  <div class="flexsp" style="flex:1"></div>
  <footer class="meta" style="margin-top:36px;padding-top:16px;border-top:1px solid var(--line);display:flex;gap:18px;justify-content:center;font-size:12px">
    <a href="/privacy" style="color:var(--dim)">Privacy Policy</a>
    <a href="/terms" style="color:var(--dim)">Terms of Service</a>
    <span style="color:var(--dim)">Powered by the <b style="color:#f00">YouTube</b> Data API</span>
  </footer>
</div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const simMap = new Map();
let fpTags = [];

// Tag profile = the game's own tags + every base game's defining tags.
// Derived, not editable — change the game list to change the profile.
const derivedTags = () => {
  const s = new Set(fpTags);
  for (const [, v] of simMap) (v?.tags || []).forEach((t) => s.add(t));
  return [...s];
};

function renderChips() {
  const el = $('simchips');
  el.querySelectorAll('.gcard').forEach(c => c.remove());
  $('addcardbtn').style.display = simMap.size >= 10 ? 'none' : '';
  for (const [name, v] of simMap) {
    const d = document.createElement('div');
    d.className = 'gcard';
    const src = v?.img || (v?.appid ? 'https://cdn.akamai.steamstatic.com/steam/apps/' + v.appid + '/header.jpg' : null);
    if (src) {
      const im = document.createElement('img');
      const tries = [
        v?.appid ? 'https://cdn.akamai.steamstatic.com/steam/apps/' + v.appid + '/header.jpg' : null,
        v?.appid ? 'https://cdn.akamai.steamstatic.com/steam/apps/' + v.appid + '/capsule_616x353.jpg' : null,
        v?.appid ? 'https://cdn.akamai.steamstatic.com/steam/apps/' + v.appid + '/capsule_231x87.jpg' : null,
      ].filter(Boolean);
      im.src = src;
      im.style.cssText = 'width:100%;display:block';
      im.onerror = () => { const n = tries.shift(); if (n) im.src = n; else im.remove(); };
      d.appendChild(im);
    }
    if (v?.appid) { d.style.cursor = 'pointer'; d.onclick = () => window.open('https://store.steampowered.com/app/' + v.appid + '/', '_blank'); }
    d.insertAdjacentHTML('beforeend', '<div class="gname">' + name + '</div>'
      + '<div class="gtags">' + (v?.tags || []).slice(0, 3).map((t) => '<span class="tag sm">' + t + '</span>').join('') + '</div><span class="x">&times;</span>');
    d.querySelector('.x').onclick = (e) => { e.stopPropagation(); simMap.delete(name); renderChips(); };
    el.insertBefore(d, $('addcardbtn'));
  }
}
$('addcardbtn').onclick = () => {
  const card = $('addcardbtn');
  if (card.classList.contains('searchcard')) return;
  card.classList.add('searchcard');
  card.innerHTML = '<input id="addsim" placeholder="Search Steam…" autocomplete="off">';
  const inp = card.querySelector('input');
  inp.onclick = (e) => e.stopPropagation();
  inp.focus();
  let timer;
  inp.oninput = () => {
    clearTimeout(timer);
    const q = inp.value.trim();
    if (q.length < 2) { $('simdd').style.display = 'none'; return; }
    timer = setTimeout(async () => {
      const items = await (await fetch('/api/search-games?term=' + encodeURIComponent(q))).json();
      const dd = $('simdd');
      dd.innerHTML = '<div class="gdd-title">Steam results — click to add</div><div class="gddgrid"></div>';
      const grid = dd.querySelector('.gddgrid');
      for (const it of items) {
        const d = document.createElement('div');
        d.className = 'gitem';
        const img = document.createElement('img');
        img.src = it.img || 'https://cdn.akamai.steamstatic.com/steam/apps/' + it.appid + '/capsule_184x69.jpg';
        img.onerror = () => { const ph = document.createElement('div'); ph.className = 'noimg'; ph.textContent = 'NO ART'; img.replaceWith(ph); };
        img.onload = () => { img.style.aspectRatio = img.naturalWidth + '/' + img.naturalHeight; };
        const lbl = document.createElement('span');
        lbl.textContent = it.name;
        d.append(img, lbl);
        d.onclick = () => {
          if (simMap.size >= 10) { dd.style.display = 'none'; resetAddCard(); return; }
          simMap.set(it.name, { appid: it.appid, img: it.img, tags: [] });
          renderChips()
          dd.style.display = 'none'; resetAddCard();
          // Fill in the new base game's own defining tags in the background.
          fetch('/api/fingerprint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: it.appid }) })
            .then((r) => r.json()).then((j) => {
              const v = simMap.get(it.name);
              if (v) { v.tags = (j.tags || []).slice(0, 4); renderChips() }
            }).catch(() => {});
        };
        grid.appendChild(d);
      }
      dd.style.display = items.length ? 'block' : 'none';
    }, 250);
  };
  inp.onblur = () => setTimeout(() => { $('simdd').style.display = 'none'; if (!inp.value.trim()) resetAddCard(); }, 200);
};
function resetAddCard() {
  const card = $('addcardbtn');
  card.classList.remove('searchcard');
  card.innerHTML = '+ Add game';
}

// --- autocomplete dropdowns ---
function autocomplete(inputId, ddId, endpoint, onPick) {
  const inp = $(inputId), dd = $(ddId);
  let timer;
  inp.oninput = () => {
    clearTimeout(timer);
    const q = inp.value.trim();
    if (q.length < 2) { dd.style.display = 'none'; return; }
    timer = setTimeout(async () => {
      const res = await fetch(endpoint + '?term=' + encodeURIComponent(q));
      const items = await res.json();
      if (!items.length) { dd.style.display = 'none'; return; }
      dd.innerHTML = '';
      for (const it of items) {
        const d = document.createElement('div');
        d.className = 'dditem';
        if (typeof it === 'object') {
          d.innerHTML = '<img src="https://cdn.akamai.steamstatic.com/steam/apps/' + it.appid + '/capsule_184x69.jpg" onerror="this.remove()"><span>' + it.name + '</span>';
          d.onclick = () => { onPick(it); dd.style.display = 'none'; inp.value = ''; };
        } else {
          d.innerHTML = '<span>' + it + '</span>';
          d.onclick = () => { onPick(it); dd.style.display = 'none'; inp.value = ''; };
        }
        dd.appendChild(d);
      }
      dd.style.display = 'block';
    }, 250);
  };
  inp.onblur = () => setTimeout(() => dd.style.display = 'none', 200);
}

// Main bar: typing a name (not a URL/appid) searches Steam directly.
(() => {
  const inp = $('link'), dd = $('linkdd');
  let timer;
  inp.oninput = () => {
    clearTimeout(timer);
    const q = inp.value.trim();
    if (q.length < 3 || /steampowered\.com|^\\d+$/.test(q)) { dd.style.display = 'none'; return; }
    timer = setTimeout(async () => {
      const items = await (await fetch('/api/search-games?term=' + encodeURIComponent(q))).json();
      dd.innerHTML = '';
      for (const it of items) {
        const d = document.createElement('div');
        d.className = 'dditem';
        const im = document.createElement('img');
        im.src = it.img; im.style.cssText = 'height:26px;border-radius:4px';
        im.onerror = () => im.remove();
        const s = document.createElement('span'); s.textContent = it.name;
        d.append(im, s);
        d.onclick = () => {
          inp.value = 'https://store.steampowered.com/app/' + it.appid + '/';
          dd.style.display = 'none';
          $('load').click();
        };
        dd.appendChild(d);
      }
      dd.style.display = items.length ? 'block' : 'none';
    }, 250);
  };
  inp.onblur = () => setTimeout(() => dd.style.display = 'none', 200);
})();

$('load').onclick = async () => {
  $('status').innerHTML = '';
  // Clear the previous game's results — a new game means a new queue.
  lastResults = []; lastGame = ''; $('lists').innerHTML = '';
  // Skeleton state while profiling — panels appear only once data is ready.
  $('base').style.display = 'block';
  $('gametitle').innerHTML = '<span class="spinner" style="width:15px;height:15px;border-width:2px;display:inline-block;vertical-align:middle;margin-right:8px"></span>Analyzing game…';
  $('gamemeta').textContent = 'Pulling the store page, tags and similar games…';
  $('gametags').innerHTML = '';
  $('gameimg').style.display = 'none';
  $('reldev').innerHTML = ''; $('relpub').innerHTML = '';
  const chips = $('simchips');
  chips.querySelectorAll('.gcard').forEach((c) => c.remove());
  for (let i = 0; i < 10; i++) {
    const sk = document.createElement('div');
    sk.className = 'gcard';
    sk.innerHTML = '<div class="skl" style="width:100%;height:78px"></div>'
      + '<div class="skl" style="width:65%;height:12px;border-radius:5px;margin:10px"></div>'
      + '<div class="skl" style="width:85%;height:9px;border-radius:4px;margin:0 10px 12px"></div>';
    chips.insertBefore(sk, $('addcardbtn'));
  }
  const res = await fetch('/api/fingerprint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: $('link').value }) });
  const j = await res.json();
  if (!res.ok) { $('status').textContent = 'Error: ' + j.error; return; }
  $('status').textContent = '';
  $('base').style.display = 'block';
  if (activeList) $('backlist').style.display = '';
  $('gametitle').textContent = j.name;
  $('gamemeta').textContent = [(j.developers || []).join(', '), (j.publishers || []).filter(p => !(j.developers || []).includes(p)).join(', ')].filter(Boolean).join(' · ') || j.genres.join(' · ');
  $('gametags').innerHTML = (j.topTags || []).map((t) => '<span class="tag">' + t + '</span>').join('');
  renderRelated('reldev', j.developers?.[0], j.relatedByDeveloper);
  renderRelated('relpub', j.publishers?.[0], j.relatedByPublisher);
  $('gameimg').style.display = 'none';
  if (j.appid && !String(j.appid).startsWith('manual')) {
    const img = $('gameimg');
    img.onerror = () => { img.style.display = 'none'; };
    img.onload = () => { img.style.display = 'block'; };
    img.src = j.headerImage || 'https://cdn.akamai.steamstatic.com/steam/apps/' + j.appid + '/header.jpg';
  }
  simMap.clear();
  fpTags = (j.tags || []).slice(0, 20);
  j.similarGames.forEach(g => { simMap.set(g.name, String(g.appid).startsWith('manual') ? null : { appid: g.appid, img: g.img || null, tags: g.topTags || [] }); gameAppids[g.name.toLowerCase()] = g.appid; });
  gameAppids[j.name.toLowerCase()] = j.appid;
  renderChips()
};

function renderRelated(elId, creator, games) {
  const el = $(elId);
  el.innerHTML = '';
  if (!games || !games.length || !creator) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const h = document.createElement('div');
  h.className = 'meta';
  h.style.marginBottom = '8px';
  h.textContent = 'More by ' + creator + ' — click to analyze:';
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(110px,1fr));gap:8px';
  for (const g of games.slice(0, 10)) {
    const c = document.createElement('div');
    c.style.cssText = 'border-radius:8px;overflow:hidden;border:1px solid var(--line);cursor:pointer;transition:.15s;background:var(--panel2)';
    const im = document.createElement('img');
    im.src = g.img || 'https://cdn.akamai.steamstatic.com/steam/apps/' + g.appid + '/header.jpg';
    im.style.cssText = 'width:100%;display:block;aspect-ratio:460/215;object-fit:cover';
    const tries = [
      'https://cdn.akamai.steamstatic.com/steam/apps/' + g.appid + '/header.jpg',
      'https://cdn.akamai.steamstatic.com/steam/apps/' + g.appid + '/capsule_616x353.jpg',
      'https://cdn.akamai.steamstatic.com/steam/apps/' + g.appid + '/capsule_231x87.jpg',
    ].filter(Boolean);
    im.onerror = () => { const n = tries.shift(); if (n) im.src = n; else im.remove(); };
    const s = document.createElement('span');
    s.textContent = g.name;
    s.style.cssText = 'display:block;padding:5px 8px;font-size:11px;font-weight:600;line-height:1.25';
    c.append(im, s);
    c.onmouseenter = () => c.style.borderColor = 'var(--acc)';
    c.onmouseleave = () => c.style.borderColor = 'var(--line)';
    c.onclick = () => {
      $('link').value = 'https://store.steampowered.com/app/' + g.appid + '/';
      $('load').click();
    };
    grid.appendChild(c);
  }
  el.append(h, grid);
}

let lastResults = [];
const fmt = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : n;
const LANGS = ['English','French','Spanish','Portuguese','German','Russian/Ukrainian','Chinese','Japanese','Korean','any'];
function buildLangMenu() {
  const cur = $('langfilter').value;
  $('langmenu').innerHTML = LANGS.map(l =>
    '<div class="opt' + (l === cur ? ' sel' : '') + '" data-l="' + l + '">' + (l === 'any' ? 'Any' : l) + '</div>').join('');
}
buildLangMenu();
setTimeout(() => renderLists(), 0);
$('langbtn').onclick = (e) => { e.stopPropagation(); buildLangMenu(); $('langmenu').classList.toggle('open'); };
$('langmenu').addEventListener('click', (e) => {
  const o = e.target.closest('.opt'); if (!o) return;
  $('langfilter').value = o.dataset.l;
  $('langbtn').childNodes[0].textContent = o.dataset.l === 'any' ? 'Any' : o.dataset.l;
  $('langmenu').classList.remove('open');
});
document.addEventListener('click', () => { $('langmenu').classList.remove('open'); $('postmenu').classList.remove('open'); });

const POST_OPTS = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['90', 'Last 3 months'], ['180', 'Last 6 months'], ['365', 'Last year'], ['any', 'Anytime']];
$('postbtn').onclick = (e) => {
  e.stopPropagation();
  const cur = $('postfilter').value;
  $('postmenu').innerHTML = POST_OPTS.map(([v, l]) => '<div class="opt' + (v === cur ? ' sel' : '') + '" data-v="' + v + '">' + l + '</div>').join('');
  $('postmenu').classList.toggle('open');
};
$('postmenu').addEventListener('click', (e) => {
  const o = e.target.closest('.opt'); if (!o) return;
  $('postfilter').value = o.dataset.v;
  $('postbtn').childNodes[0].textContent = o.textContent;
  $('postmenu').classList.remove('open');
});


document.addEventListener('click', (e) => {
  const el = e.target.closest('.copymail');
  if (!el) return;
  navigator.clipboard.writeText(el.dataset.e);
  const old = el.textContent;
  el.textContent = 'copied!';
  setTimeout(() => el.textContent = old, 900);
});

$('go').onclick = async () => {
  $('go').disabled = true;
  $('out').innerHTML = '';
  lastResults = []; lastGame = ''; $('lists').innerHTML = '';
  if (activeList) $('backlist').style.display = '';
  $('status').innerHTML = '';
  $('lists').innerHTML = '<div class="panel"><div class="scanload"><div class="spinner" style="width:38px;height:38px;border-width:4px"></div>'
    + '<div style="font-size:16px;font-weight:700;margin-top:16px">Finding creators…</div>'
    + '<div class="meta" style="margin-top:6px">Searching YouTube for channels covering these games — usually 30–60s on a cold run.</div></div></div>';
  const baseBody = {
    input: $('link').value,
    tags: derivedTags().join(','),
    minsubs: +$('minsubs').value.replace(/[^\\d]/g, '') || 0, maxsubs: +$('maxsubs').value.replace(/[^\\d]/g, '') || null,
    top: +$('top').value || 400, deep: true, hidedev: true,
    emailonly: true,
    lang: $('langfilter').value, lastpost: $('postfilter').value, ainotes: true, dlp: true, expand: true,
  };
  // Progressive scan: the base games are searched in small sequential chunks,
  // each merged into the pool as it lands — first creators appear in seconds
  // instead of one long wait.
  const simNames = [...simMap.keys()];
  lastInput = $('link').value;
  expandDone = false; expandBuffer = [];
  let first = true;
  const scanId = 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  curScanId = scanId;
  for (let i = 0; i < simNames.length; i += 3) {
    const res = await fetch('/api/find', {
      method: 'POST', headers: scanHeaders(),
      body: JSON.stringify({ ...baseBody, scan: scanId, initial: i === 0, similar: simNames.slice(i, i + 3).join(',') }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.status === 429) { $('go').disabled = false; openTiers(j.error || 'Daily scan limit reached.'); return; }
    if (!res.ok || !j.results) {
      if (first) { $('lists').innerHTML = '<div class="panel"><div class="scanload" style="color:var(--rej)">Error: ' + esc(j.error || 'scan failed') + '</div></div>'; $('go').disabled = false; return; }
      continue;
    }
    if (first) {
      first = false;
      lastGame = j.game;
      usedGameNames = new Set([j.game, ...simNames].map((n) => n.toLowerCase()));
      pools[j.game] = {};
      for (const [n, a] of Object.entries(j.appids || {})) gameAppids[n.toLowerCase()] = a;
    }
    const pool = pools[j.game];
    for (const r of j.results) if (!pool[r.channelId]) pool[r.channelId] = snap(r);
    lastResults = j.results;
    savePools();
    triageTab = 'queue';
    renderLists();
    requestNotes(j.results.map((r) => pool[r.channelId]).filter(Boolean));
  }
  $('go').disabled = false;
  if (first) { $('lists').innerHTML = '<div class="panel"><div class="scanload" style="color:var(--rej)">Scan returned nothing — check the link and try again.</div></div>'; return; }
  maybeExpand();
};

// Rolling expansion: keep ~100 unscored candidates ahead at all times.
// Frontier rounds run continuously in the background — verdicts should never
// outrun the pool unless the frontier is genuinely exhausted.
async function maybeExpand() {
  if (expanding || !lastGame || expandDone) return;
  const left = () => Object.values(poolFor(lastGame)).filter((r) => !((lists[activeList] && lists[activeList].verdicts) || {})[r.channelId]).length;
  if (left() >= 100) return;
  expanding = true;
  try {
    const pool = (pools[lastGame] ||= {});
    let added = 0, rounds = 0;
    while (added < 50 && rounds < 4) {
      if (!expandBuffer.length) {
        if (!await fetchRound()) { expandDone = true; break; }
        rounds++;
      }
      const r = expandBuffer.shift();
      if (!r) break;
      if (!pool[r.channelId]) {
        const nc = notesCache[r.channelId];
        if (nc) { const ns = typeof nc === 'string' ? { note: nc } : nc; r.aiNote = ns.note || ''; r.aiNoteCard = ns.card || null; r.aiPending = false; }
        pool[r.channelId] = r; added++;
      }
    }
    savePools(); updTabs();
    if (added) renderLists();
  } catch {}
  expanding = false;
  maybeExpand();
}

// One frontier round: next pick per base game -> scan -> buffer candidates.
// Each base is queried in its own parallel call — small enough to never
// time out, and one base's failure doesn't sink the round.
async function fetchRound() {
  const base = [...simMap.entries()].filter(([, v]) => v && v.appid).map(([name, v]) => ({ name, appid: v.appid }));
  const picks = (await Promise.all(base.map(async (b) => {
    try {
      const er = await fetch('/api/expand-games', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ base: [b], used: [...usedGameNames], tags: derivedTags().join(',') }),
      });
      const ej = await er.json().catch(() => ({}));
      return er.ok ? (ej.names || [])[0] : null;
    } catch { return null; }
  }))).filter(Boolean);
  const batch = picks.filter((g) => !usedGameNames.has(g.name.toLowerCase()));
  batch.forEach((g) => { usedGameNames.add(g.name.toLowerCase()); gameAppids[g.name.toLowerCase()] = g.appid; });
  if (!batch.length) return false;
  const res = await fetch('/api/find', {
    method: 'POST', headers: scanHeaders(),
    body: JSON.stringify({
      input: lastInput, scan: curScanId, similar: batch.map((g) => g.name).join(','), tags: derivedTags().join(','), expand: true,
      minsubs: +$('minsubs').value.replace(/[^\\d]/g, '') || 0,
      maxsubs: +$('maxsubs').value.replace(/[^\\d]/g, '') || null,
      top: 400, deep: true, hidedev: true, emailonly: true,
      lang: $('langfilter').value, lastpost: $('postfilter').value, ainotes: true, dlp: true,
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.results) return true; // round consumed; keep advancing
  const pool = poolFor(j.game);
  const fresh = j.results.map(snap).filter((r) => !pool[r.channelId] && !expandBuffer.some((b) => b.channelId === r.channelId));
  expandBuffer.push(...fresh);
  requestNotes(fresh);
  return true;
}

// ============ LISTS (guest mode, localStorage; Supabase sync later) ============
const LKEY = 'cf_lists';
const PKEY = 'cf_pools';
let lists = {}, pools = {};
try { lists = JSON.parse(localStorage.getItem(LKEY)) || {}; } catch { lists = {}; }
try { pools = JSON.parse(localStorage.getItem(PKEY)) || {}; } catch { pools = {}; }
// migrate pools that lived inside lists
for (const [n, l] of Object.entries(lists)) {
  if (l.pool) { pools[l.game] = { ...(pools[l.game] || {}), ...l.pool }; delete l.pool; }
}
const saveLists = () => { localStorage.setItem(LKEY, JSON.stringify(lists)); cloudPush(); };
const savePools = () => localStorage.setItem(PKEY, JSON.stringify(pools));

// ---- Accounts & cloud sync -------------------------------------------
const SESKEY = 'cf_session';
let session = null; try { session = JSON.parse(localStorage.getItem(SESKEY)); } catch {}
function renderAcct() {
  const w = $('navacctwrap'); if (!w) return;
  w.innerHTML = session
    ? '<div class="meta" style="font-size:10.5px;margin-bottom:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(session.email || '') + '">' + esc(session.email || 'signed in') + '</div>'
      + (isPro() ? '<div class="prochip">PRO</div>' : '<button class="navacct" data-act="tiers" style="margin-bottom:6px">Upgrade to Pro</button>')
      + '<button class="navacct ghost" data-act="logout">Log out</button>'
    : '<button class="navacct" data-act="tiers">Create account</button>'
      + '<button class="navacct ghost" data-act="acct">Log in</button>';
}
function saveSession(s) { session = s; if (s) localStorage.setItem(SESKEY, JSON.stringify(s)); else localStorage.removeItem(SESKEY); renderAcct(); }
let pushT = null;
function cloudPush(now) {
  if (!session) return;
  clearTimeout(pushT);
  const go = () => {
    localStorage.setItem('cf_lastpush', String(Date.now()));
    fetch('/api/lists', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.at }, body: JSON.stringify({ lists }) }).catch(() => {});
  };
  if (now) go(); else pushT = setTimeout(go, 700);
}
async function cloudPull() {
  if (!session) return;
  const j = await fetch('/api/lists', { headers: { Authorization: 'Bearer ' + session.at } }).then((r) => r.json()).catch(() => null);
  if (!j) return;
  const remote = j.lists || {};
  const remoteNewer = j.updated_at ? new Date(j.updated_at).getTime() > (+localStorage.getItem('cf_lastpush') || 0) : false;
  lists = remoteNewer ? { ...lists, ...remote } : { ...remote, ...lists };
  saveLists(); renderLists();
}
async function initSession() {
  renderAcct();
  if (!session) return;
  const j = await fetch('/api/auth/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session.rt }) }).then((r) => r.json()).catch(() => null);
  if (j && j.access_token) {
    session.at = j.access_token; session.rt = j.refresh_token || session.rt;
    localStorage.setItem(SESKEY, JSON.stringify(session));
    cloudPull();
    if (new URLSearchParams(location.search).get('upgraded')) {
      await refreshMe();
      toast(isPro() ? 'Welcome to Pro, everything is unlocked.' : 'Plan will update shortly.');
      history.replaceState(null, '', location.pathname);
    }
  } else saveSession(null);
}
initSession();

// ---- Plans ---------------------------------------------------------------
const PRO_PRICE = '$5';
const PLAN_LIMITS = { guest: { adds: 5 }, free: { adds: 5 }, pro: { adds: Infinity } };
const ADDSKEY = 'cf_adds';
const addsToday = () => { try { const j = JSON.parse(localStorage.getItem(ADDSKEY)); return j && j.d === new Date().toDateString() ? (j.n || 0) : 0; } catch { return 0; } };
const addsLeft = () => Math.max(0, PLAN_LIMITS[plan()].adds - addsToday());
const bumpAdds = () => localStorage.setItem(ADDSKEY, JSON.stringify({ d: new Date().toDateString(), n: addsToday() + 1 }));
const plan = () => localStorage.getItem('cf_dev_plan') || (session && session.plan) || 'guest';
const isPro = () => plan() === 'pro';
async function refreshMe() {
  if (!session) return;
  const j = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + session.at } }).then((r) => r.ok ? r.json() : null).catch(() => null);
  if (j) { session.plan = j.plan; session.email = j.email || session.email; localStorage.setItem(SESKEY, JSON.stringify(session)); renderAcct(); }
}
const scanHeaders = () => ({
  'Content-Type': 'application/json',
  ...(session ? { Authorization: 'Bearer ' + session.at } : {}),
  ...(localStorage.getItem('cf_dev_key') ? { 'x-dev-key': localStorage.getItem('cf_dev_key') } : {}),
});
function toast(msg) {
  const d = document.createElement('div');
  d.className = 'panel';
  d.style.cssText = 'position:fixed;bottom:22px;left:50%;transform:translateX(-50%);padding:12px 24px;z-index:300;font-size:13px';
  d.textContent = msg; document.body.appendChild(d);
  setTimeout(() => d.remove(), 4200);
}
let onb = { step: 'plans', plan: 'free' };
function openTiers(reason) { onb = { step: 'plans', plan: 'free', reason: reason || '' }; renderTiers(); $('tiermodal').style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;z-index:200;background:rgba(4,7,12,.84);backdrop-filter:blur(3px)'; }
const feat = (t) => '<div class="fi"><i>✓</i>' + t + '</div>';
function renderTiers() {
  const box = $('tierbox');
  box.style.width = onb.step === 'plans' ? '' : '480px';
  if (onb.step === 'plans') {
    box.innerHTML = '<button class="mx" data-act="tiercancel">✕</button>'
      + '<div class="ttitle">Choose your plan</div>'
      + '<div class="tsub">Start free, upgrade when your outreach grows. Your lists sync to your account either way.</div>'
      + (onb.reason ? '<div style="text-align:center;color:#e0a458;font-size:12.5px;margin:-6px 0 14px">' + esc(onb.reason) + '</div>' : '')
      + '<div class="tiergrid">'
      + '<div class="tcard">'
      + '<div class="tname">FREE</div>'
      + '<div class="tprice">$0<span> forever</span></div>'
      + '<div class="tfeats">' + feat('Unlimited lists') + feat('2 game analyses per day') + feat('5 creator adds per day') + feat('Cloud sync across devices') + feat('Email drafts and key tracking') + '</div>'
      + (session ? '<div class="tcur">Current plan</div>' : '<button class="ltab tcta" data-act="tierpick" data-v="free">Continue with Free</button>')
      + '</div>'
      + '<div class="tcard pro">'
      + '<div class="tbadge">MOST POPULAR</div>'
      + '<div class="tname">PRO</div>'
      + '<div class="tprice">' + PRO_PRICE + '<span> /month, cancel anytime</span></div>'
      + '<div class="tfeats"><div class="flabel">EVERYTHING IN FREE, PLUS</div>' + feat('Unlimited game analyses') + feat('Unlimited creator adds') + feat('Coverage alerts when creators post') + feat('Priority AI personalization') + feat('Early access to new features') + '</div>'
      + '<button class="btn tcta" data-act="tierpick" data-v="pro">Go Pro</button>'
      + '</div></div>'
      + '<div id="tierr" style="color:var(--bad);font-size:11.5px;text-align:center;margin-top:12px;min-height:14px"></div>';
  } else if (onb.step === 'account') {
    box.innerHTML = '<button class="mx" data-act="tiercancel">✕</button>'
      + '<div class="ttitle" style="margin-top:4px">Create your account</div>'
      + '<div class="tsub" style="margin-bottom:20px">Your lists sync automatically once you are in.</div>'
      + '<div class="tplansum"><div><div class="tpsname">' + (onb.plan === 'pro' ? 'Pro' : 'Free') + '</div><div class="tpsprice">' + (onb.plan === 'pro' ? PRO_PRICE + '/month · cancel anytime' : 'Free forever') + '</div></div><button class="tlink" data-act="tierback">Change plan</button></div>'
      + '<label class="tlabel">Email</label><input id="temail" type="email" placeholder="you@studio.com" autocomplete="email">'
      + '<label class="tlabel">Password</label><input id="tpass" type="password" placeholder="6+ characters" autocomplete="new-password">'
      + '<div id="tierr" style="color:var(--bad);font-size:12px;min-height:16px;margin-top:10px"></div>'
      + '<button class="btn tcta" data-act="tiercreate" style="margin-top:6px">' + (onb.plan === 'pro' ? 'Create account and continue to checkout' : 'Create account') + '</button>'
      + '<div class="tfine">' + (onb.plan === 'pro' ? 'Secure checkout via Stripe. Cancel anytime.' : 'No card required. Upgrade anytime.') + '</div>';
    setTimeout(() => $('temail').focus(), 50);
  } else {
    box.innerHTML = '<button class="mx" data-act="tiercancel">✕</button><div class="tdone">'
      + '<div class="big">✓</div><div class="ttitle">You are in</div>'
      + '<div class="tsub" id="tdonemsg">Signed in as ' + esc(session && session.email || '') + '. Your lists now sync to this account.</div>'
      + '<button class="btn tcta" data-act="tierdone" style="max-width:240px;margin:0 auto">Start finding creators</button></div>';
  }
}
async function checkoutPro() {
  const err = (m) => { const e = $('tierr'); if (e) e.textContent = m; };
  const j = await fetch('/api/billing/checkout', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + session.at }, body: '{}' })
    .then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) })).catch(() => null);
  if (j && j.j && j.j.url) { location.href = j.j.url; return true; }
  err((j && j.j && j.j.error) || 'Could not start checkout.');
  return false;
}
let activeList = null, triageTab = 'queue', triageMode = 'detailed', qi = 0, lastGame = '', pendingVerdict = null, lpOpen = false, curScanId = null;
let creatorTab = 'acc', campTab = 'tmpl', keyAddOpen = false;
let lastInput = '', usedGameNames = new Set(), expanding = false, expandDone = false, expandBuffer = [];
const notesCache = {}; // channelId -> AI note; survives until candidates enter the pool
const gameAppids = {}; // lowercase game name -> steam appid, for Covers links

const noteOf = (r) => (typeof r?.aiNote === 'string' ? r.aiNote : r?.aiNote?.note) || (r?.notes || [])[0] || '';
const snap = (r) => ({
  channelId: r.channelId, channel: r.channel, url: r.url, thumb: r.thumb,
  score: r.score, subs: r.subs, medianViews: r.medianViews, games: r.games || [], alias: r.alias,
  language: r.language || 'English', notes: r.notes || [], emails: r.emails || [],
  vidTitles: r.vidTitles || [], description: r.description || '',
  aiNote: r.aiNote || null, aiNoteCard: r.aiNoteCard || null, daysSince: r.daysSince ?? null,
});
const poolFor = (game) => pools[game] || {};
const queueFor = (l) => Object.values(poolFor(lastGame)).filter((r) => !(lists[l].verdicts || {})[r.channelId]);

function verdict(listName, cid, v, quiet) {
  const l = lists[listName];
  if (!l) return;
  l.verdicts ||= {}; l.channels ||= {};
  if (v === 'a' && l.verdicts[cid] !== 'a' && addsLeft() <= 0) {
    openTiers('You used your 5 free creator adds for today. Resets at midnight, or go Pro for unlimited.');
    return;
  }
  const wasA = l.verdicts[cid] === 'a';
  if (v === null) delete l.verdicts[cid]; else l.verdicts[cid] = v;
  if (v === 'a' && !wasA) bumpAdds();
  // Leaving Accepted releases that creator's steam keys back to the pool.
  if (v !== 'a' && l.keys) l.keys.forEach((k) => { if (k.cid === cid) { k.st = 'free'; delete k.cid; delete k.at; } });
  const r = poolFor(lastGame)[cid] || lastResults.find((x) => x.channelId === cid);
  if (r && !l.channels[cid]) l.channels[cid] = snap(r);
  saveLists();
  renderNav();
  if (!quiet) renderLists();
}

function updTabs() {
  const l = lists[activeList];
  if (!l) return;
  const cnt = { queue: queueFor(activeList).length, acc: 0, rej: 0 };
  for (const v of Object.values(l.verdicts || {})) cnt[v === 'a' ? 'acc' : 'rej']++;
  for (const [k, label] of [['acc', 'Accepted'], ['rej', 'Rejected']]) {
    const t = $('lists').querySelector('[data-act="ctab"][data-v="' + k + '"]');
    if (t) t.textContent = label + ' (' + cnt[k] + ')';
  }
  const ct = $('lists').querySelector('[data-act="tab"][data-v="camp"]');
  if (ct) ct.textContent = '✉ Campaign';
}

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }
function fmtAge(d) {
  if (d == null) return '—';
  if (d < 30) return d + 'd ago';
  if (d < 365) return Math.round(d / 30) + 'mo ago';
  return (d / 365).toFixed(1) + 'y ago';
}

function chanLine(r) {
  const thumb = r.thumb ? '<img src="' + r.thumb + '">' : '<img style="background:var(--bg3)">';
  return thumb + '<div style="min-width:0;flex:1">'
    + '<div style="display:flex;gap:8px;align-items:center;min-width:0"><a href="' + r.url + '" target="_blank" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(r.channel) + '</a></div>'
    + '<div class="meta" style="font-size:11px">' + fmt(r.subs) + ' subs · avg ' + fmt(r.medianViews) + ' views · ' + esc(r.language || 'English') + '</div></div>';
}

function detailCard(r, btns, status) {
  const thumb = r.thumb ? '<img src="' + r.thumb + '">' : '<img style="background:var(--bg3)">';
  return '<div class="qcard2">'
    + '<a class="qc-left" href="' + r.url + '" target="_blank" style="text-decoration:none;color:inherit">' + thumb
    + '<span class="qc-name" style="display:block">' + esc(r.channel) + '</span>'
    + '<span class="qc-sub">Alias: ' + (r.alias ? esc(r.alias) : '—') + '</span></a>'
    + '<div class="qc-main">'
    + '<div class="qc-stats">'
    + '<div class="qstat"><div class="qs-l">Subscribers</div><div class="qs-v">' + fmt(r.subs) + '</div></div>'
    + '<div class="qstat"><div class="qs-l">Avg views</div><div class="qs-v">' + fmt(r.medianViews) + '</div></div>'
    + '<div class="qstat"><div class="qs-l">Language</div><div class="qs-v">' + esc(r.language || 'English') + '</div></div>'
    + '<div class="qstat"><div class="qs-l">Last post</div><div class="qs-v">' + fmtAge(r.daysSince) + '</div></div></div>'
    + '<div class="qc-low"><div class="qc-rows">'
    + '<div class="qc-lbl">Covers</div><div class="qc-val covers">' + (r.games || []).map((g) => '<a href="' + (gameAppids[g.toLowerCase()] ? 'https://store.steampowered.com/app/' + gameAppids[g.toLowerCase()] + '/' : 'https://store.steampowered.com/search/?term=' + encodeURIComponent(g)) + '" target="_blank" style="color:inherit"><b>' + esc(g) + '</b></a>').join(', ') + '</div>'
    + '<div class="qc-lbl">Notes</div><div class="qc-val">' + (r.aiPending ? '<span class="spinner" style="width:11px;height:11px;border-width:2px;display:inline-block;vertical-align:middle"></span>' : esc(((s) => s ? s[0].toUpperCase() + s.slice(1) : s)(r.aiNoteCard || noteOf(r) || '—'))) + '</div>'
    + (r.emails.length ? '<div class="qc-lbl">Contact</div><div class="qc-val">' + r.emails.map((e) => '<span class="mailchip copymail" data-e="' + esc(e) + '" title="' + esc(e) + '">' + esc(e) + '</span>').join(' ') + '</div>' : '')
    + (r.coverage ? '<div class="qc-lbl">' + (r.coverage.confirmed ? 'Covered' : 'Coverage?') + '</div><div class="qc-val">'
      + '<a href="' + esc(r.coverage.url) + '" target="_blank" style="color:inherit"><b>' + esc(r.coverage.title) + '</b></a>'
      + (r.coverage.confirmed ? ' <span class="pill p-good">✓</span>'
        : ' <button class="vb ok" data-act="covok" data-cid="' + r.channelId + '" style="margin-left:6px">Confirm</button>'
        + '<button class="vb" data-act="covno" data-cid="' + r.channelId + '" style="margin-left:4px">Dismiss</button>')
      + '</div>' : '')
    + '</div>'
    + '<div class="qc-act">' + btns + '</div>'
    + '</div></div>'
    + (status ? '<div class="qc-status"><span class="qc-sl">Status</span>' + status + '</div>' : '')
    + '</div>';
}

function qRow(r, btns, statusFn) {
  const thumb = r.thumb ? '<img src="' + r.thumb + '" style="width:34px;height:34px;border-radius:50%">' : '<img style="width:34px;height:34px;border-radius:50%;background:var(--panel2)">';
  return '<tr><td><div class="chan">' + thumb + '<div class="channame"><a href="' + r.url + '" target="_blank">' + esc(r.channel) + '</a></div></div></td>'
    + '<td class="num">' + fmt(r.subs) + '</td>'
    + '<td><span class="meta" style="font-size:12px">' + esc(r.language || 'English') + '</span></td>'
    + '<td>' + (r.emails.length ? '<span class="emailchip">Yes</span>' : '<span class="meta">—</span>') + '</td>'
    + '<td><div class="vbtns">' + btns(r) + '</div></td>'
    + (statusFn ? '<td>' + statusFn(r) + '</td>' : '') + '</tr>';
}

function qTable(rows, lastW, btns, statusFn) {
  return '<table class="qt">'
    + '<tr><th>Channel</th><th style="width:70px">Subs</th><th style="width:78px">Language</th><th style="width:62px">Email</th><th style="width:' + lastW + 'px"></th>' + (statusFn ? '<th style="width:96px">Status</th>' : '') + '</tr>'
    + rows.map((r) => qRow(r, btns, statusFn)).join('') + '</table>';
}

let renaming = null, openMenu = null;
function renderNav() {
  const names = Object.keys(lists).sort();
  $('navlists').innerHTML = names.map((n) => {
    if (n === renaming)
      return '<div class="navitem on"><input id="navrename" value="' + esc(n) + '" style="flex:1;min-width:0;background:var(--bg3);border:1px solid var(--acc);border-radius:6px;color:var(--txt);padding:4px 8px;font-size:13px;outline:none"></div>';
    const l = lists[n];
    const cnt = Object.keys(l.verdicts).length;
    return '<div class="navitem' + (n === activeList ? ' on' : '') + '" data-act="openlist" data-n="' + esc(n) + '">'
      + '<div class="nm"><div>' + esc(n) + '</div><div class="g">' + (cnt ? cnt + ' reviewed' : '') + '</div></div>'
      + '<span class="navdots" data-act="itemmenu" data-n="' + esc(n) + '">⋮</span>'
      + '<div class="navmenu' + (openMenu === n ? ' open' : '') + '">'
      + '<div class="mi" data-act="rename" data-n="' + esc(n) + '">Rename</div>'
      + '<div class="mi danger" data-act="deletelist" data-n="' + esc(n) + '">Delete</div></div></div>';
  }).join('') || '<div class="meta" style="padding:6px;font-size:11.5px">No lists yet</div>';
}

function skelCards() {
  const one = '<div class="qcard2"><div class="qc-left" style="align-self:center">'
    + '<div class="skl" style="width:84px;height:84px;border-radius:50%;margin:0 auto"></div>'
    + '<div class="skl" style="width:110px;height:13px;border-radius:6px;margin:12px auto 0"></div>'
    + '<div class="skl" style="width:80px;height:10px;border-radius:5px;margin:7px auto 0"></div></div>'
    + '<div class="qc-main"><div class="qc-stats">'
    + '<div class="qstat"><div class="skl" style="width:60px;height:10px;border-radius:5px"></div><div class="skl" style="width:44px;height:20px;border-radius:6px;margin-top:8px"></div></div>'.repeat(4)
    + '</div><div class="skl" style="width:70%;height:11px;border-radius:5px;margin:6px 0 10px"></div>'
    + '<div class="skl" style="width:92%;height:11px;border-radius:5px;margin-bottom:14px"></div>'
    + '<div class="meta" style="display:flex;align-items:center;gap:8px"><span class="spinner" style="width:12px;height:12px;border-width:2px"></span>Searching for creators…</div>'
    + '</div></div>';
  return one + one + one;
}

function renderLists() {
  const el = $('lists');
  $('viewtitle').innerHTML = activeList ? esc(activeList) : '<b style="color:var(--acc)">CREATOR</b><span style="color:var(--dim)">FINDER</span>';
  renderNav();
  const l = activeList ? lists[activeList] : null;
  const game = lastGame || '';
  document.querySelector('.wrap').classList.toggle('home', !activeList && !game);
  if (!game && !Object.keys(lists).length) { el.innerHTML = ''; return; }
  const pool = poolFor(game);
  const gameLists = Object.keys(lists);
  const acc = l ? Object.entries(l.verdicts || {}).filter(([, v]) => v === 'a').map(([c]) => c) : [];
  const rej = l ? Object.entries(l.verdicts || {}).filter(([, v]) => v === 'r').map(([c]) => c) : [];
  const queue = Object.values(pool).filter((r) => !((l && l.verdicts) || {})[r.channelId]).slice(qi);
  const shown = triageMode === 'detailed' ? queue.slice(0, 3) : queue.slice(0, 10);

  let body = '';

  if (!l) {
    if (!queue.length) {
      if (!lastGame) { el.innerHTML = ''; return; }
      body += expandDone
        ? '<div class="meta" style="padding:24px;text-align:center">Pool exhausted — the whole frontier has been scanned. Run a new scan or widen filters.</div>'
        : skelCards();
      el.innerHTML = '<div class="panel" style="margin-top:16px">' + body + '</div>';
      return;
    }
    body += triageMode === 'detailed'
      ? shown.map((r) => detailCard(r,
        '<button class="vb big no" data-act="verdict" data-cid="' + r.channelId + '" data-v="r">✗ Reject</button>'
        + '<button class="vb big ok" data-act="verdict" data-cid="' + r.channelId + '" data-v="a">✓ Accept</button>')).join('')
      : qTable(shown, 100, (r) =>
        '<button class="vb no" data-act="verdict" data-cid="' + r.channelId + '" data-v="r">✗</button>'
        + '<button class="vb ok" data-act="verdict" data-cid="' + r.channelId + '" data-v="a">✓</button>');
    el.innerHTML = '<div class="panel" style="margin-top:16px">' + body + '</div>';
    return;
  }
  l.verdicts ||= {}; l.channels ||= {};

  if (triageTab === 'queue') {
    if (!shown.length) {
      body += expandDone
        ? '<div class="meta" style="padding:24px;text-align:center">Pool exhausted — all candidates reviewed (' + acc.length + ' accepted, ' + rej.length + ' rejected). Run a new scan to refill.</div>'
        : skelCards();
    } else if (triageMode === 'detailed') {
      body += shown.map((r) => detailCard(r,
        '<button class="vb big no" data-act="verdict" data-cid="' + r.channelId + '" data-v="r">✗ Reject</button>'
        + '<button class="vb big ok" data-act="verdict" data-cid="' + r.channelId + '" data-v="a">✓ Accept</button>')).join('');
    } else {
      // compact: mini-table — score, channel, subs, language, notes, email, verdict
      body += qTable(shown, 100, (r) =>
        '<button class="vb no" data-act="verdict" data-cid="' + r.channelId + '" data-v="r">✗</button>'
        + '<button class="vb ok" data-act="verdict" data-cid="' + r.channelId + '" data-v="a">✓</button>');
    }
  } else if (triageTab === 'camp') {
    if ($('ctemplate') || $('ckeys')) saveCampaign(); // preserve unsaved edits across re-renders
    body += '<div style="display:flex;gap:8px;justify-content:center;margin-bottom:14px">'
      + [['tmpl', 'Template'], ['keys', 'Keys'], ['drafts', 'Drafts']].map(([k, lbl]) =>
        '<button class="ltab' + (campTab === k ? ' on' : '') + '" data-act="camptab" data-v="' + k + '">' + lbl + '</button>').join('')
      + '</div>';
    if (campTab === 'tmpl') {
      const c = l.campaign || {};
      const s = senderPrefs();
      body += campSec('<span class="cs-ic">◈</span>Your details',
        '<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px">'
        + campField('Game', 'cgame', c.game || lastGame || '')
        + campField('Your name', 'cdev', c.dev || s.dev || '')
        + campField('Your email', 'cemail', c.email || s.email || '')
        + '</div><div style="margin-top:10px">'
        + campField('Subject', 'csubject', c.subject || '') + '</div>')
        + campSec('<span class="cs-ic">✉</span>Email template<button class="ltab" id="cgenbtn" data-act="cgen" style="margin-left:auto;font-size:11px;text-transform:none">✦ Generate with AI</button>',
          '<textarea id="ctemplate" rows="16" style="width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:9px;color:var(--txt);padding:10px 12px;font-size:12.5px;line-height:1.6;outline:none;resize:vertical;font-family:inherit">'
          + esc(tplFor(c)) + '</textarea>'
          + '<div class="meta" style="font-size:10.5px;margin-top:6px">Variables: {name} channel · {alias} first name · {note} what they do · {keyoffer} count-aware key offer · {keys} key list (each line labeled Steam Key:) · {keycount} number · {game} · {dev}</div>'
          + '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:10px"><button class="ltab" data-act="creset" style="font-size:11px">Reset to default</button><button class="btn" data-act="csave" style="padding:8px 18px;font-size:13px">Save template</button></div>');
    } else if (campTab === 'keys') {
      const chans = l.channels || {};
      body += (keyAddOpen
        ? campSec('<span class="cs-ic">⚿</span>Add keys',
          '<textarea id="ckeys" rows="5" placeholder="Paste keys, one per line — they get added to the ledger below" style="width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:9px;color:var(--txt);padding:10px 12px;font-size:12px;outline:none;resize:vertical;font-family:monospace"></textarea>'
          + '<div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px">'
          + '<div class="meta" id="ckeycount"></div>'
          + '<div><button class="ltab" data-act="keyadd" style="font-size:11px;margin-right:8px">Cancel</button>'
          + '<button class="btn" data-act="keyssave" style="padding:7px 16px;font-size:12px">Add keys</button></div></div>')
        : '')
        + campSec('<span class="cs-ic">☰</span>All keys — ' + (l.keys || []).length
          + '<button class="ltab" data-act="keyadd" style="margin-left:auto;font-size:11px;text-transform:none">+ Add keys</button>',
          (l.keys || []).length
            ? '<div class="keyrow khead"><span>Key</span><span>Added</span><span>Assigned to</span><span>Status</span><span>Since</span><span></span></div>'
            + l.keys.map((k) => {
              const who = k.cid && chans[k.cid] ? chans[k.cid].channel : null;
              const st = k.st === 'free' ? 'free' : k.st === 'assigned' ? 'assigned' : k.st;
              return '<div class="keyrow">'
                + '<span><span class="kmono">' + esc(k.k) + '</span></span>'
                + '<span class="meta" style="font-size:11px">' + (k.added ? fmtAge(Math.floor((Date.now() - k.added) / 86400000)).replace(' ago', '') + ' ago' : '—') + '</span>'
                + '<span style="font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (who ? '→ ' + esc(who) : '—') + '</span>'
                + '<span class="pill ' + (st === 'free' ? 'p-mid' : st === 'sent' ? 'p-bad' : 'p-good') + '" style="font-size:10px">' + st + '</span>'
                + '<span class="meta" style="font-size:11px">' + (k.at && who ? fmtAge(Math.floor((Date.now() - k.at) / 86400000)) : '—') + '</span>'
                + (st === 'free' ? '<button class="vb no" data-act="keydel" data-k="' + esc(k.k) + '" style="padding:1px 8px">×</button>' : '<span></span>')
                + '</div>';
            }).join('')
            : '<div class="meta" style="padding:14px;text-align:center">No keys yet.</div>');
    } else {
      body += '<div id="cpreviews"></div>';
    }
  } else {
    body += '<div style="display:flex;align-items:center;margin-bottom:14px">'
      + '<span style="flex:1"></span>'
      + '<div style="display:flex;gap:8px">'
      + '<button class="ltab' + (creatorTab === 'acc' ? ' on' : '') + '" data-act="ctab" data-v="acc">Accepted (' + acc.length + ')</button>'
      + '<button class="ltab' + (creatorTab === 'rej' ? ' on' : '') + '" data-act="ctab" data-v="rej">Rejected (' + rej.length + ')</button></div>'
      + '<span style="flex:1;display:flex;justify-content:flex-end;gap:8px">'
      + '<button class="ltab" data-act="goal" style="font-size:11.5px" title="Click to set or edit the outreach goal">🎯 '
      + (l.goal ? '<b>' + acc.length + ' / ' + l.goal + '</b>' + (acc.length >= l.goal ? ' — reached' : '') : 'set goal')
      + '</button>'
      + '<button class="ltab" data-act="addcreator" style="font-size:11.5px">+ Creator</button></span></div>';
    const ids = creatorTab === 'acc' ? acc : rej;
    const rows = ids.map((cid) => l.channels[cid]).filter(Boolean);
    const moveBtns = (r) => '<button class="vb" data-act="editchan" data-cid="' + r.channelId + '">Edit</button>';
    body += rows.length
      ? (triageMode === 'detailed'
        ? rows.map((r) => detailCard(r, moveBtns(r), creatorTab === 'acc' ? chanStatus(l, r) : '')).join('')
        : qTable(rows, 110, moveBtns, creatorTab === 'acc' ? (r) => chanStatus(l, r) : null))
      : '<div class="meta" style="padding:24px;text-align:center">Nothing here yet.</div>';
  }
  el.innerHTML = l
    ? '<div class="panel" style="margin-top:16px;padding:0;overflow:hidden"><div class="ptabs">'
      + '<button class="ptab' + (triageTab === 'creators' ? ' on' : '') + '" data-act="tab" data-v="creators">&#x1F464;&#xFE0E; Creators</button>'
      + '<button class="ptab' + (triageTab === 'camp' ? ' on' : '') + '" data-act="tab" data-v="camp">✉ Campaign</button>'
      + '</div><div style="padding:20px">' + body + '</div></div>'
    : '<div class="panel" style="margin-top:16px">' + body + '</div>';
  if (triageTab === 'camp' && l) { updKeyCount(); renderPreviews(); }
}

document.addEventListener('click', (e) => {
  if (lpOpen && !e.target.closest('.lpmenu') && !e.target.closest('[data-act="lpmenu"]')) {
    lpOpen = false; renderLists();
  }
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'lpmenu') {
    lpOpen = !lpOpen; renderLists();
  } else if (act === 'lpick') {
    lpOpen = false; activeList = b.dataset.v; triageTab = 'creators'; qi = 0; renderLists();
  } else if (act === 'lnew') {
    lpOpen = false; pendingVerdict = null;
    $('lmodal').style.display = 'flex';
    setTimeout(() => $('lmname').focus(), 50);
  } else if (act === 'startlist') {
    const name = ($('newlist').value || $('lpick')?.value || '').trim();
    if (!name) return;
    if (!lists[name]) lists[name] = { verdicts: {}, channels: {} };
    activeList = name; triageTab = 'creators'; qi = 0; saveLists(); renderLists();
  } else if (act === 'verdict') {
    if (!activeList) {
      pendingVerdict = { cid: b.dataset.cid, v: b.dataset.v || null };
      $('lmodal').style.display = 'flex';
      setTimeout(() => $('lmname').focus(), 50);
      return;
    }
    const row = b.closest('tr, .qcard2, .qrow');
    const onQueue = triageTab === 'queue';
    // The candidate just below the visible window replaces this one in place.
    const winSize = triageMode === 'detailed' ? 3 : 10;
    const repl = onQueue ? queueFor(activeList)[winSize] : null;
    if (!row) { verdict(activeList, b.dataset.cid, b.dataset.v || null); return; }
    const parent = row.parentNode;
    const nextSib = row.nextElementSibling;
    row.classList.add('fadeout');
    setTimeout(() => {
      verdict(activeList, b.dataset.cid, b.dataset.v || null, true);
      row.remove();
      if (repl) {
        const html = triageMode === 'detailed'
          ? detailCard(repl,
            '<button class="vb big no" data-act="verdict" data-cid="' + repl.channelId + '" data-v="r">✗ Reject</button>'
            + '<button class="vb big ok" data-act="verdict" data-cid="' + repl.channelId + '" data-v="a">✓ Accept</button>')
          : qRow(repl, (x) =>
            '<button class="vb no" data-act="verdict" data-cid="' + x.channelId + '" data-v="r">✗</button>'
            + '<button class="vb ok" data-act="verdict" data-cid="' + x.channelId + '" data-v="a">✓</button>');
        const frag = document.createElement('template');
        frag.innerHTML = html;
        if (nextSib && nextSib.parentNode === parent) parent.insertBefore(frag.content.firstChild, nextSib);
        else parent.appendChild(frag.content.firstChild);
      }
      const remaining = triageMode === 'detailed'
        ? parent.querySelectorAll('.qcard2').length
        : parent.querySelectorAll('tr').length - 1;
      if (onQueue && !remaining) renderLists();
      else updTabs();
      maybeExpand();
    }, 180);
  } else if (act === 'lmcreate') {
    const name = $('lmname').value.trim();
    if (!name) return;
    if (!lists[name]) lists[name] = { verdicts: {}, channels: {} };
    const g = parseInt($('lmgoal').value.replace(/[^\\d]/g, ''), 10);
    if (g > 0) lists[name].goal = g;
    activeList = name; triageTab = 'creators'; qi = 0;
    $('lmodal').style.display = 'none'; $('lmname').value = ''; $('lmgoal').value = '';
    saveLists();
    const pv = pendingVerdict; pendingVerdict = null;
    if (pv) verdict(activeList, pv.cid, pv.v); else renderLists();
  } else if (act === 'lmcancel') {
    $('lmodal').style.display = 'none'; pendingVerdict = null;
  } else if (act === 'tab') {
    triageTab = b.dataset.v; renderLists();
  } else if (act === 'mode') {
    triageMode = triageMode === 'detailed' ? 'compact' : 'detailed'; renderLists();
  } else if (act === 'closelist') {
    activeList = null; renderLists();
  } else if (act === 'backlist') {
    $('base').style.display = 'none';
    $('backlist').style.display = 'none';
    renderLists();
  } else if (act === 'openlist') {
    activeList = b.dataset.n; triageTab = 'creators'; qi = 0; openMenu = null;
    $('base').style.display = 'none'; $('backlist').style.display = 'none';
    renderLists();
  } else if (act === 'itemmenu') {
    e.stopPropagation();
    openMenu = openMenu === b.dataset.n ? null : b.dataset.n; renderNav();
  } else if (act === 'rename') {
    openMenu = null; renaming = b.dataset.n; renderNav();
    setTimeout(() => $('navrename')?.focus(), 0);
  } else if (act === 'deletelist') {
    openMenu = null;
    if (confirm('Delete list "' + b.dataset.n + '"? Verdicts will be lost.')) {
      delete lists[b.dataset.n];
      if (activeList === b.dataset.n) activeList = null;
      saveLists(); renderLists();
    }
  } else if (act === 'newlist') {
    const box = $('newlistbox');
    box.style.display = box.style.display === 'none' ? 'block' : 'none';
    if (box.style.display === 'block') $('navlistname').focus();
  } else if (act === 'acct') {
    $('aerr').textContent = '';
    $('authmodal').style.display = 'flex';
    setTimeout(() => $('aemail').focus(), 50);
  } else if (act === 'authcancel') {
    $('authmodal').style.display = 'none';
  } else if (act === 'authdo') {
    const email = $('aemail').value.trim(), pw = $('apass').value;
    if (!email || !pw) { $('aerr').textContent = 'Email and password required.'; return; }
    b.disabled = true; $('aerr').textContent = '';
    fetch('/api/auth/' + b.dataset.v, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })
      .then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) }))
      .then(({ ok, j }) => {
        b.disabled = false;
        if (!ok) { $('aerr').textContent = j.error_description || j.msg || j.error || 'Failed.'; return; }
        if (j.access_token) {
          saveSession({ at: j.access_token, rt: j.refresh_token, email: (j.user && j.user.email) || email });
          $('authmodal').style.display = 'none'; $('apass').value = '';
          refreshMe(); cloudPull();
        } else {
          $('aerr').style.color = 'var(--good)';
          $('aerr').textContent = 'Account created — check your email to confirm, then log in.';
          setTimeout(() => { $('aerr').style.color = 'var(--bad)'; }, 3000);
        }
      }).catch(() => { b.disabled = false; $('aerr').textContent = 'Network error.'; });
  } else if (act === 'logout') {
    saveSession(null); renderLists();
  } else if (act === 'tiers') {
    $('authmodal').style.display = 'none';
    openTiers();
  } else if (act === 'tiercancel' || act === 'tierdone') {
    $('tiermodal').style.display = 'none';
  } else if (act === 'tierback') {
    onb.step = 'plans'; renderTiers();
  } else if (act === 'tierpick') {
    if (b.dataset.v === 'pro') {
      if (session) checkoutPro();
      else { onb.plan = 'pro'; onb.step = 'account'; renderTiers(); }
    } else if (!session) { onb.plan = 'free'; onb.step = 'account'; renderTiers(); }
  } else if (act === 'tiercreate') {
    const email = $('temail').value.trim(), pw = $('tpass').value;
    if (!email || !pw) { $('tierr').textContent = 'Email and password required.'; return; }
    b.disabled = true; $('tierr').textContent = '';
    fetch('/api/auth/signup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: pw }) })
      .then(async (r) => ({ ok: r.ok, j: await r.json().catch(() => ({})) }))
      .then(async ({ ok, j }) => {
        b.disabled = false;
        if (!ok || !j.access_token) { $('tierr').textContent = j.error || j.msg || 'Signup failed.'; return; }
        saveSession({ at: j.access_token, rt: j.refresh_token, email: (j.user && j.user.email) || email, plan: 'free' });
        await refreshMe(); cloudPull();
        if (onb.plan === 'pro') {
          const started = await checkoutPro();
          if (!started) { onb.step = 'done'; renderTiers(); $('tdonemsg').textContent = 'Account created. Checkout is not available yet, so you are on Free for now.'; }
        } else { onb.step = 'done'; renderTiers(); }
      }).catch(() => { b.disabled = false; $('tierr').textContent = 'Network error.'; });
  } else if (act === 'addcreator') {
    $('amodal').style.display = 'flex'; $('aq').value = ''; $('ares').innerHTML = '';
    setTimeout(() => $('aq').focus(), 50);
  } else if (act === 'amcancel') {
    $('amodal').style.display = 'none';
  } else if (act === 'apick') {
    const l = lists[activeList]; if (!l) return;
    if (l.verdicts[b.dataset.cid] !== 'a' && addsLeft() <= 0) {
      $('amodal').style.display = 'none';
      openTiers('You used your 5 free creator adds for today. Resets at midnight, or go Pro for unlimited.');
      return;
    }
    b.style.pointerEvents = 'none'; b.style.opacity = '.5';
    fetch('/api/channel-profile', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: b.dataset.cid }) })
      .then((r) => r.json()).then((p) => {
        if (p.error) { b.style.pointerEvents = ''; b.style.opacity = ''; return; }
        l.channels ||= {}; l.verdicts ||= {};
        const wasA = l.verdicts[p.channelId] === 'a';
        l.channels[p.channelId] = snap(p); l.verdicts[p.channelId] = 'a';
        if (!wasA) bumpAdds();
        saveLists(); $('amodal').style.display = 'none'; renderLists();
        requestNotes([l.channels[p.channelId]]).then(() => { if (l.channels[p.channelId].aiNote) saveLists(); });
      }).catch(() => { b.style.pointerEvents = ''; b.style.opacity = ''; });
  } else if (act === 'cgen') {
    const btn = $('cgenbtn'); btn.disabled = true; btn.textContent = 'Generating…';
    const c = readCampForm();
    fetch('/api/campaign-template', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ game: c.game || 'my game', dev: c.dev || 'the developer' }) })
      .then((r) => r.json()).then((j) => { if (j.template) $('ctemplate').value = j.template; })
      .finally(() => { btn.disabled = false; btn.textContent = '✦ Generate with AI'; });
  } else if (act === 'csave') {
    saveCampaign(); renderPreviews();
  } else if (act === 'creset') {
    if ($('ctemplate')) $('ctemplate').value = DEF_TPL;
    saveCampaign(); renderLists();
  } else if (act === 'copyc') {
    const l = lists[activeList], r = l?.channels?.[b.dataset.cid];
    if (r) navigator.clipboard.writeText(draftFor(r, l)).then(() => { b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy draft', 1200); });
  } else if (act === 'camptab') {
    campTab = b.dataset.v; renderLists();
  } else if (act === 'ctab') {
    creatorTab = b.dataset.v; renderLists();
  } else if (act === 'keyadd') {
    keyAddOpen = !keyAddOpen; renderLists();
    if (keyAddOpen) setTimeout(() => $('ckeys') && $('ckeys').focus(), 50);
  } else if (act === 'keyssave') {
    const l = lists[activeList]; if (!l || !$('ckeys')) return;
    const want = $('ckeys').value.split('\\n').map((x) => x.trim()).filter(Boolean);
    const have = new Set((l.keys || []).map((k) => k.k));
    const seen = new Set();
    let added = 0;
    l.keys ||= [];
    for (const k of want) { if (!have.has(k) && !seen.has(k)) { seen.add(k); l.keys.push({ k, st: 'free', added: Date.now() }); added++; } }
    $('ckeys').value = ''; keyAddOpen = false;
    saveLists(); renderLists();
  } else if (act === 'keydel') {
    const l = lists[activeList]; if (!l) return;
    l.keys = (l.keys || []).filter((k) => !(k.k === b.dataset.k && k.st === 'free'));
    saveLists(); renderLists();
  } else if (act === 'draftc') {
    const l = lists[activeList]; if (!l) return;
    saveCampaign();
    if (!assignKeys(l, b.dataset.cid)) alert('Not enough free keys — add more in the Keys tab.');
    saveLists(); renderLists();
  } else if (act === 'draftall') {
    const l = lists[activeList]; if (!l) return;
    saveCampaign();
    let failed = 0;
    for (const r of accChannels(l)) {
      if (assignedKeys(l, r.channelId).length) continue;
      if (!assignKeys(l, r.channelId)) failed++;
    }
    if (failed) alert(failed + ' creator(s) left undrafted — not enough free keys.');
    saveLists(); renderLists();
  } else if (act === 'marksent') {
    const l = lists[activeList]; if (!l) return;
    l.sent ||= {}; l.sent[b.dataset.cid] = Date.now();
    (l.keys || []).forEach((k) => { if (k.cid === b.dataset.cid && k.st === 'assigned') k.st = 'sent'; });
    saveLists(); renderLists();
  } else if (act === 'markunsent') {
    const l = lists[activeList]; if (!l) return;
    delete (l.sent || {})[b.dataset.cid];
    (l.keys || []).forEach((k) => { if (k.cid === b.dataset.cid) k.st = 'assigned'; });
    saveLists(); renderLists();
  } else if (act === 'goal') {
    const l = lists[activeList]; if (!l) return;
    const v = prompt('Outreach goal — how many creators to contact? (empty to clear)', l.goal || '');
    if (v === null) return;
    const g = parseInt(v.replace(/[^\\d]/g, ''), 10);
    if (g > 0) l.goal = g; else delete l.goal;
    saveLists(); renderLists();
  } else if (act === 'keyadj') {
    const l = lists[activeList]; if (!l) return;
    l.alloc ||= {};
    const cur = l.alloc[b.dataset.cid] || 1;
    l.alloc[b.dataset.cid] = Math.min(Math.max(1, cur + (+b.dataset.d)), Math.max(1, freeKeys(l).length));
    saveLists(); renderPreviews();
  } else if (act === 'keycycle') {
    const l = lists[activeList]; if (!l) return;
    const k = (l.keys || []).find((x) => x.k === b.dataset.k && x.cid === b.dataset.cid);
    if (k && k.st !== 'free' && k.st !== 'assigned') { k.st = KNEXT[k.st] || 'sent'; saveLists(); renderPreviews(); }
  } else if (act === 'editchan') {
    const r = lists[activeList]?.channels?.[b.dataset.cid]; if (!r) return;
    editCid = b.dataset.cid;
    $('echname').textContent = r.channel;
    $('ealias').value = r.alias || '';
    $('enote').value = noteOf(r) || (r.notes || []).join(' · ');
    $('egames').value = (r.games || []).join(', ');
    $('eemails').value = (r.emails || []).join(', ');
    $('emodal').style.display = 'flex';
  } else if (act === 'ecancel') {
    $('emodal').style.display = 'none'; editCid = null;
  } else if (act === 'esave') {
    const r = lists[activeList]?.channels?.[editCid];
    if (r) {
      r.alias = $('ealias').value.trim();
      const note = $('enote').value.trim();
      if (note) { r.aiNote = note; r.aiNoteCard = null; r.notes = [note]; }
      r.games = $('egames').value.split(',').map((x) => x.trim()).filter(Boolean);
      r.emails = $('eemails').value.split(',').map((x) => x.trim()).filter(Boolean);
      saveLists();
    }
    $('emodal').style.display = 'none'; editCid = null; renderLists();
  } else if (act === 'eremove') {
    const l = lists[activeList];
    if (l && editCid) { verdict(activeList, editCid, null); delete l.channels[editCid]; saveLists(); }
    $('emodal').style.display = 'none'; editCid = null; renderLists();
  } else if (act === 'dtoggle') {
    const cid = b.dataset.cid;
    if (draftOpen.has(cid)) draftOpen.delete(cid); else draftOpen.add(cid);
    renderPreviews();
  } else if (act === 'dexpall' || act === 'dcolall') {
    const l0 = lists[activeList];
    draftOpen.clear();
    if (act === 'dexpall' && l0) accChannels(l0).forEach((r) => { if (assignedKeys(l0, r.channelId).length) draftOpen.add(r.channelId); });
    renderPreviews();
  } else if (act === 'covok') {
    const l = lists[activeList]; const ch = l?.channels?.[b.dataset.cid];
    if (ch?.coverage) { ch.coverage.confirmed = true; saveLists(); renderLists(); renderNotifs(); }
  } else if (act === 'covno') {
    const l = lists[activeList]; const ch = l?.channels?.[b.dataset.cid];
    if (ch) { delete ch.coverage; ch.coverageChecked = Date.now(); saveLists(); renderLists(); renderNotifs(); }
  } else if (act === 'notifview') {
    const n = pendingNotifs[+b.dataset.i]; if (!n) return;
    activeList = n.list; triageTab = 'creators'; qi = 0;
    $('base').style.display = 'none'; $('backlist').style.display = 'none';
    pendingNotifs.splice(+b.dataset.i, 1);
    renderLists(); renderNotifs();
  } else if (act === 'notifx') {
    pendingNotifs.splice(+b.dataset.i, 1); renderNotifs();
  }
});

// ---- Email campaign -----------------------------------------------
const SKEY = 'cf_sender';
const senderPrefs = () => { try { return JSON.parse(localStorage.getItem(SKEY)) || {}; } catch { return {}; } };
const campSec = (title, inner) =>
  '<div class="campsec">'
  + '<div class="cs-head">' + title + '</div>' + inner + '</div>';
const campField = (label, id, val) =>
  '<div><div class="meta" style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px">' + label + '</div>'
  + '<input id="' + id + '" value="' + esc(val) + '" style="width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:9px;color:var(--txt);padding:9px 12px;font-size:13px;outline:none"></div>';
const DEF_TPL = "Hi {alias},\\n\\nI'm {dev}, the developer of {game}. I noticed that you {note}, so I think {game} would be a really good fit for your audience. It would be great to see it played in a video on your channel.\\n\\nI'd love to send you {keyoffer} if you're interested.\\n\\n{keys}\\n\\nHappy to answer any questions, and thanks for your time.\\n\\nKind regards,\\n{dev}";
const OLD_TPLS = [
  "Hi {alias},\\n\\nI'm {dev}, the developer of {game}. I noticed that you {note}, so I think {game} would be a really good fit for your channel.\\n\\nI'd love to send you {keyoffer}:\\n\\n{keys}\\n\\nHappy to answer any questions, and thanks for your time.\\n\\nKind regards,\\n{dev}",
  "Hi {alias},\\n\\nI'm {dev}, the developer of {game}. I noticed that you {note}, and I think {game} would be a great fit for your audience.\\n\\nI'd love to send you {keyoffer}:\\n\\n{keys}\\n\\nHappy to answer any questions — thanks for your time!\\n\\nKind regards,\\n{dev}",
  "Hi {alias},\\n\\nI'm {dev}, the developer of {game}. Your channel stood out to me — {note} — and I think {game} would be a great fit for your audience.\\n\\nI'd love to send you 2 Steam keys (one for you, one for a friend or a giveaway):\\n\\n{keys}\\n\\nHappy to answer any questions — thanks for your time!\\n\\nKind regards,\\n{dev}",
];
const tplFor = (c) => (!c.template || OLD_TPLS.includes(c.template) ? DEF_TPL : c.template);
const accChannels = (l) => Object.entries(l.verdicts || {}).filter(([, v]) => v === 'a').map(([c]) => l.channels[c]).filter(Boolean);
const assignedKeys = (l, cid) => (l.keys || []).filter((k) => k.cid === cid);
const chanStatus = (l, r) => {
  if (r.coverage) return '<a class="pill p-mid" href="' + esc(r.coverage.url) + '" target="_blank" title="Suspected coverage — click to open the video">Covered?</a>';
  const ks = assignedKeys(l, r.channelId);
  if (ks.some((k) => k.st === 'claimed' || k.st === 'redeemed')) return '<span class="pill p-good">Claimed</span>';
  if (l.sent && l.sent[r.channelId]) return '<span class="pill p-mid">Sent</span>';
  return '<span class="pill" style="background:rgba(140,150,170,.12);color:var(--dim)">Not sent</span>';
};
const freeKeys = (l) => (l.keys || []).filter((k) => k.st === 'free');
const KSTATUS = { sent: 'sent', claimed: 'claimed', redeemed: 'redeemed' };
const KNEXT = { sent: 'claimed', claimed: 'redeemed', redeemed: 'sent' };

function fillTemplate(tpl, c, camp, keyText) {
  let note = (noteOf(c) || 'cover games like this').replace(/[.\s]+$/, '');
  note = note.charAt(0).toLowerCase() + note.slice(1);
  const nKeys = keyText ? keyText.split('\\n').filter(Boolean).length : 0;
  const map = {
    '{name}': c.channel || '', '{alias}': c.alias || c.channel || 'there',
    '{note}': note, '{game}': camp.game || '', '{dev}': camp.dev || '',
    '{keys}': keyText || '(keys will be assigned when you send)',
    '{keycount}': String(Math.max(nKeys, 1)),
    '{keyoffer}': nKeys > 1
      ? nKeys + ' Steam keys for ' + (camp.game || 'the game') + ' (one for you, the rest for friends or a giveaway)'
      : 'a Steam key for ' + (camp.game || 'the game'),
  };
  return String(tpl || '').replace(/\{(name|alias|note|game|dev|keys|keycount|keyoffer)\}/g, (m) => map[m] ?? m);
}
const keyTextFor = (l, cid) => assignedKeys(l, cid).map((k) => 'Steam Key: ' + k.k).join('\\n');

function readCampForm() {
  const c = (lists[activeList] && lists[activeList].campaign) || {};
  const s = senderPrefs();
  const gv = (id) => ($(id) ? $(id).value.trim() : null);
  return {
    game: gv('cgame') ?? c.game ?? lastGame ?? '',
    dev: gv('cdev') ?? c.dev ?? s.dev ?? '',
    email: gv('cemail') ?? c.email ?? s.email ?? '',
    subject: gv('csubject') ?? c.subject ?? '',
    template: $('ctemplate') ? $('ctemplate').value : tplFor(c),
  };
}
const draftFor = (r, l) => fillTemplate(readCampForm().template, r, readCampForm(), keyTextFor(l, r.channelId));
function updKeyCount() {
  const l = lists[activeList]; if (!l || !$('ckeycount')) return;
  const free = freeKeys(l).length, used = (l.keys || []).length - free;
  $('ckeycount').textContent = (l.keys || []).length ? free + ' free · ' + used + ' assigned (click a key chip in the drafts to cycle its status)' : 'No keys yet — paste them above and click Add keys.';
}
function saveCampaign() {
  const l = lists[activeList]; if (!l) return;
  const c = readCampForm(); l.campaign = c;
  let s = {}; try { s = JSON.parse(localStorage.getItem(SKEY)) || {}; } catch {}
  localStorage.setItem(SKEY, JSON.stringify({ ...s, dev: c.dev, email: c.email }));
  saveLists(); updKeyCount();
}
// Bind "want" free keys to a creator. Returns false if the pool can't cover it.
function assignKeys(l, cid) {
  const want = (l.alloc && l.alloc[cid]) || 1;
  const have = assignedKeys(l, cid).length;
  if (have >= want) return true;
  const free = freeKeys(l);
  if (free.length < want - have) return false;
  free.slice(0, want - have).forEach((k) => { k.st = 'assigned'; k.cid = cid; k.at = Date.now(); });
  return true;
}

let draftOpen = new Set();
function draftRow(l, r, camp, free) {
  const to = (r.emails || [])[0];
  const assigned = assignedKeys(l, r.channelId);
  const sent = l.sent && l.sent[r.channelId];
  const open = draftOpen.has(r.channelId);
  const av = r.thumb ? '<img class="dc-av" src="' + r.thumb + '">' : '<div class="dc-av"></div>';
  let lower;
  if (!assigned.length) {
    const want = Math.min((l.alloc && l.alloc[r.channelId]) || 1, Math.max(1, free));
    lower = '<div style="margin-top:10px;display:flex;align-items:center;gap:6px;font-size:11px" class="meta">keys:'
      + ' <button class="vb" data-act="keyadj" data-cid="' + r.channelId + '" data-d="-1" style="padding:1px 8px">−</button>'
      + ' <b>' + want + '</b>'
      + ' <button class="vb" data-act="keyadj" data-cid="' + r.channelId + '" data-d="1" style="padding:1px 8px">+</button>'
      + ' <span style="margin-left:8px">(' + free + ' free)</span>'
      + ' <button class="vb ok" data-act="draftc" data-cid="' + r.channelId + '" style="margin-left:auto">Draft</button></div>';
  } else {
    lower = '<div style="margin-top:10px">' + assigned.map((k) =>
      '<span class="kchip ' + (k.st === 'sent' || k.st === 'assigned' ? '' : k.st) + '"'
      + (sent ? ' data-act="keycycle" data-cid="' + r.channelId + '" data-k="' + esc(k.k) + '" title="click: ' + k.st + ' → ' + KNEXT[k.st] + '"' : ' title="' + k.st + ' — locked when marked sent"')
      + '>' + esc(k.k) + '</span>').join('') + '</div>'
      + '<div class="dmail" style="display:' + (open ? 'block' : 'none') + '">'
      + '<div class="dm-head"><span>To: <b>' + esc(to || '—') + '</b></span>'
      + '<span>Subject: <b>' + esc(fillTemplate(camp.subject || '', r, camp, '')) + '</b></span></div>'
      + '<div class="dm-body">' + esc(fillTemplate(camp.template, r, camp, keyTextFor(l, r.channelId))) + '</div></div>';
  }
  return '<div class="draftcard">'
    + '<div class="dc-head">' + av
    + '<div style="min-width:0;flex:1"><div style="font-size:13px;font-weight:700">' + esc(r.channel) + '</div>'
    + '<div class="meta" style="font-size:11px">' + (to ? esc(to) : 'no email on file') + '</div></div>'
    + (sent ? '<span class="pill p-good" style="font-size:10px">Sent</span>' : '')
    + (assigned.length
      ? '<button class="vb" data-act="dtoggle" data-cid="' + r.channelId + '">' + (open ? 'Collapse' : 'Expand') + '</button>'
      + '<button class="vb" data-act="copyc" data-cid="' + r.channelId + '">Copy</button>'
      + '<button class="vb ' + (sent ? '' : 'ok') + '" data-act="' + (sent ? 'markunsent' : 'marksent') + '" data-cid="' + r.channelId + '">'
      + (sent ? 'Mark unsent' : 'Mark sent') + '</button>'
      : '')
    + '</div>' + lower + '</div>';
}

function renderPreviews() {
  const l = lists[activeList]; if (!l || !$('cpreviews')) return;
  const camp = readCampForm();
  const rows = accChannels(l);
  const free = freeKeys(l).length;
  const undrafted = rows.filter((r) => !assignedKeys(l, r.channelId).length).length;
  $('cpreviews').innerHTML =
    '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">'
    + '<span style="margin-left:auto"></span>'
    + '<button class="ltab" data-act="dexpall" style="font-size:11px">Expand all</button>'
    + '<button class="ltab" data-act="dcolall" style="font-size:11px">Collapse all</button>'
    + (undrafted ? '<button class="btn" data-act="draftall" style="padding:7px 18px;font-size:12px">Draft all (' + undrafted + ')</button>' : '')
    + '</div>'
    + (rows.length ? rows.map((r) => draftRow(l, r, camp, free)).join('')
      : '<div class="meta" style="padding:16px;text-align:center">No accepted creators yet — accept some in the Creators tab.</div>');
}

// ---- Manual creator add ---------------------------------------------
let aqT = null;
$('aq').oninput = () => {
  clearTimeout(aqT);
  const q = $('aq').value.trim();
  if (q.length < 2) { $('ares').innerHTML = ''; return; }
  $('ares').innerHTML = '<div class="meta" style="padding:10px;font-size:12px">Searching…</div>';
  aqT = setTimeout(async () => {
    try {
      const rs = await fetch('/api/channel-search?q=' + encodeURIComponent(q)).then((r) => r.json());
      $('ares').innerHTML = rs.length ? rs.map((c) =>
        '<div class="apick" data-act="apick" data-cid="' + c.channelId + '" style="display:flex;align-items:center;gap:10px;padding:8px;border-radius:8px;cursor:pointer">'
        + '<img src="' + c.thumb + '" style="width:30px;height:30px;border-radius:50%">'
        + '<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(c.name) + '</div>'
        + '<div class="meta" style="font-size:11px">' + fmt(c.subs) + ' subs</div></div></div>').join('')
        : '<div class="meta" style="padding:10px;font-size:12px">No channels found.</div>';
    } catch { $('ares').innerHTML = '<div class="meta" style="padding:10px;font-size:12px">Search failed.</div>'; }
  }, 350);
};

let editCid = null;

// ---- Coverage detection --------------------------------------------
// On load: re-scan uploads of every creator we've contacted, looking for
// videos since the send date that mention the game in title/description.
let pendingNotifs = [];
function renderNotifs() {
  $('notifs').innerHTML = pendingNotifs.map((n, i) =>
    '<div class="notifitem"><div style="flex:1"><b>' + esc(n.ch.channel) + '</b> may have made a video about <b>' + esc(n.game) + '</b></div>'
    + '<button class="vb ok" data-act="notifview" data-i="' + i + '">View</button>'
    + '<button class="vb" data-act="notifx" data-i="' + i + '">✕</button></div>').join('');
}
async function checkCoverage() {
  if (!isPro()) return;
  for (const [n, l] of Object.entries(lists)) {
    const game = ((l.campaign && l.campaign.game) || lastGame || '').trim();
    if (!game || !l.sent) continue;
    const creators = accChannels(l)
      .filter((c) => l.sent[c.channelId] && !(c.coverage && c.coverage.confirmed)
        && (!c.coverageChecked || Date.now() - c.coverageChecked > 86400000))
      .map((c) => ({ channelId: c.channelId, since: l.sent[c.channelId] }));
    if (!creators.length) continue;
    try {
      const j = await fetch('/api/check-coverage', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ game, creators }),
      }).then((r) => r.json());
      for (const h of j.hits || []) {
        const ch = l.channels[h.channelId]; if (!ch) continue;
        ch.coverage = { ...h.video, confirmed: false };
        pendingNotifs.push({ list: n, ch, game });
      }
      creators.forEach((c) => { const ch = l.channels[c.channelId]; if (ch) ch.coverageChecked = Date.now(); });
      saveLists();
    } catch {}
  }
  renderNotifs();
  if (activeList) renderLists();
}
setTimeout(checkCoverage, 1500);

document.addEventListener('input', (e) => {
  if (e.target.id !== 'minsubs' && e.target.id !== 'maxsubs') return;
  e.target.value = e.target.value.replace(/[^\\d]/g, '');
});
document.addEventListener('change', (e) => {
  if (e.target.id !== 'minsubs' && e.target.id !== 'maxsubs') return;
  const n = e.target.value.replace(/[^\\d]/g, '');
  e.target.value = n ? Number(n).toLocaleString('en-US') : '';
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'lmname') {
    e.target.closest('.lmbox').querySelector('[data-act="lmcreate"]').click();
    return;
  }
  if (e.target.id === 'navlistname') {
    const name = e.target.value.trim();
    if (!name) return;
    if (!lists[name]) lists[name] = { verdicts: {}, channels: {} };
    activeList = name; e.target.value = ''; $('newlistbox').style.display = 'none';
    saveLists(); renderLists();
  } else if (e.target.id === 'navrename') {
    const old = renaming, name = e.target.value.trim();
    renaming = null;
    if (name && name !== old && !lists[name]) {
      lists[name] = lists[old]; delete lists[old];
      if (activeList === old) activeList = name;
      saveLists();
    }
    renderLists();
  }
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.navitem') && !e.target.closest('.navmenu')) {
    if (openMenu) { openMenu = null; renderNav(); }
  }
});

// AI notes are fetched synchronously per batch — no server-side jobs, so it
// works identically on localhost and serverless.
async function requestNotes(list) {
  const pending = list.filter((r) => r && !r.aiNote && !notesCache[r.channelId]);
  if (!pending.length) return;
  pending.forEach((r) => { r.aiPending = true; });
  renderLists();
  for (let i = 0; i < pending.length; i += 20) {
    const chunk = pending.slice(i, i + 20);
    try {
      const j = await fetch('/api/notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channels: chunk.map((r) => ({
            channelId: r.channelId, channel: r.channel, subs: r.subs,
            games: r.games, description: r.description, vidTitles: r.vidTitles,
          })),
        }),
      }).then((r) => r.json());
      chunk.forEach((r) => {
        r.aiPending = false;
        const n = j.notes && j.notes[r.channelId];
        if (n) { const ns = typeof n === 'string' ? { note: n } : n; if (ns.note) { r.aiNote = ns.note; r.aiNoteCard = ns.card || null; notesCache[r.channelId] = ns; } }
      });
      savePools(); renderLists();
    } catch { chunk.forEach((r) => { r.aiPending = false; }); }
  }
}
</script>
</body>
</html>`;

const list = (s) => (Array.isArray(s) ? s : (s || '').split(',')).map((t) => t.trim()).filter(Boolean);
const readBody = async (req) => {
  let b = '';
  for await (const c of req) b += c;
  return JSON.parse(b);
};

export const handler = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const json = (code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  try {
    if (req.method === 'GET' && url.pathname === '/api/search-games') {
      return json(200, await searchGames(url.searchParams.get('term') || ''));
    }
    if (req.method === 'GET' && url.pathname === '/api/search-tags') {
      return json(200, await searchTags(url.searchParams.get('term') || ''));
    }
    if (req.method === 'POST' && url.pathname === '/api/expand-games') {
      const b = await readBody(req);
      const picks = await expandFrontier(b.base || [], b.used || [], list(b.tags));
      return json(200, { names: picks });
    }
    if (req.method === 'GET' && url.pathname === '/api/channel-search') {
      return json(200, await yt.searchChannels(url.searchParams.get('q') || '', 8));
    }
    if (req.method === 'POST' && url.pathname === '/api/channel-profile') {
      const b = await readBody(req);
      const [ch] = await yt.channels([b.channelId]).catch(() => []);
      const recent = await yt.recentVideosRSS(b.channelId, 10).catch(() => []);
      let base;
      if (ch) {
        base = {
          channelId: ch.id,
          channel: ch.snippet?.title || '',
          subs: Number(ch.statistics?.subscriberCount || 0),
          thumb: ch.snippet?.thumbnails?.medium?.url || ch.snippet?.thumbnails?.default?.url || '',
          desc: ch.snippet?.description || '',
        };
      } else {
        // API quota dead — scrape the public channel page instead.
        const p = await channelProfileScrape(b.channelId).catch(() => null);
        if (!p || !p.name) return json(404, { error: 'Channel not found' });
        base = { channelId: p.channelId, channel: p.name, subs: p.subs, thumb: p.thumb, desc: p.desc };
      }
      const texts = [base.desc, ...recent.flatMap((v) => [v.snippet?.title, v.snippet?.description])].filter(Boolean);
      const { emails, socials } = extractContacts(texts);
      const alias = extractAlias(texts, emails);
      const { niche, styles, language } = classifyChannel(texts);
      const medViews = recent.length
        ? Math.round(recent.reduce((s, v) => s + Number(v.statistics?.viewCount || 0), 0) / recent.length)
        : null;
      const ds = recent[0]?.snippet?.publishedAt ? daysSince(recent[0].snippet.publishedAt) : null;
      const { score, breakdown } = scoreChannel({
        relevantVideoCount: 0, medianRecentViews: medViews, subscriberCount: base.subs, daysSinceLastUpload: ds,
      });
      return json(200, {
        channelId: base.channelId,
        channel: base.channel,
        thumb: base.thumb,
        url: `https://youtube.com/channel/${base.channelId}`,
        subs: base.subs, medianViews: medViews, daysSince: ds,
        description: base.desc.slice(0, 300),
        alias, niche, language,
        notes: [styles.length ? styles.join(' · ') : 'General gaming'],
        vidTitles: recent.map((v) => v.snippet?.title).filter(Boolean).slice(0, 8),
        games: [], emails, socials, score, breakdown,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/campaign-template') {
      const b = await readBody(req);
      if (!process.env.GEMINI_API_KEY) return json(200, { template: null });
      return json(200, { template: await campaignTemplate(process.env.GEMINI_API_KEY, { game: b.game || 'my game', dev: b.dev || 'the developer' }).catch(() => null) });
    }
    if (req.method === 'POST' && url.pathname === '/api/check-coverage') {
      const b = await readBody(req);
      const game = (b.game || '').toLowerCase().trim();
      const out = [];
      await Promise.all((b.creators || []).slice(0, 60).map(async (c) => {
        const vids = await yt.recentVideosRSS(c.channelId, 15).catch(() => []);
        const hit = vids
          .filter((v) => new Date(v.snippet?.publishedAt || 0).getTime() >= (c.since || 0))
          .find((v) => (String(v.snippet?.title) + ' ' + String(v.snippet?.description || '')).toLowerCase().includes(game));
        if (hit) out.push({
          channelId: c.channelId,
          video: { videoId: hit.id, title: hit.snippet.title, date: hit.snippet.publishedAt, url: 'https://youtu.be/' + hit.id },
        });
      }));
      return json(200, { hits: out });
    }
    if (req.method === 'POST' && url.pathname === '/api/fingerprint') {
      const b = await readBody(req);
      return json(200, await buildFingerprint(b.input, { manualTags: list(b.tags) }));
    }
    if (req.method === 'POST' && url.pathname === '/api/find') {
      const b = await readBody(req);
      // Scan credits: only the first batch of an analysis counts; continuation
      // batches of the same scan pass through. Guests are limited per IP,
      // signed-in users per account; Pro and dev keys bypass.
      const bypass = process.env.DEV_SCAN_KEY && req.headers['x-dev-key'] === process.env.DEV_SCAN_KEY;
      if (b.initial && !bypass) {
        const bearer = (req.headers.authorization || '').replace(/^Bearer /i, '');
        const u = bearer ? await sbUser(bearer) : null;
        const p = u ? await ensureProfile(u.id) : { plan: 'guest' };
        if (p.plan !== 'pro') {
          const subject = u ? `u:${u.id}` : `ip:${String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?').split(',')[0].trim()}`;
          const r = await sbRest('/rpc/bump_scans', {
            method: 'POST',
            body: JSON.stringify({ p_subject: subject, p_day: new Date().toISOString().slice(0, 10) }),
          });
          const used = await r.json().catch(() => null);
          if (typeof used === 'number' && used > FREE_SCANS_PER_DAY)
            return json(429, { error: `Daily scan limit reached. Free gets ${FREE_SCANS_PER_DAY} game analyses per day — Pro is unlimited.` });
        }
      }
      // Knowledge graph: well-covered similar games skip their search query;
      // their known creators merge into the results instead of being re-fetched.
      const simNames = list(b.similar);
      const known = await dbKnownCreators(simNames);
      const skipGames = simNames.filter((n) => (known.counts[normGame(n)] || 0) >= COVERED_MIN);
      const { fp, queries, channelCount, ranked } = await findCreators(b.input, yt, {
        manualTags: list(b.tags),
        manualSimilar: simNames,
        minSubs: b.minsubs || 0,
        maxSubs: b.maxsubs || Infinity,
        deep: !!b.deep,
        dlp: !!b.dlp,
        skipGames,
      });
      const passesFilters = (r) =>
        (!b.emailonly || (r.emails || []).length) &&
        (!b.hidedev || r.niche !== 'Dev/studio') &&
        (!b.lang || b.lang === 'any' || (r.language || 'English') === b.lang) &&
        (b.lastpost === 'any' || !b.lastpost || (r.daysSince != null && r.daysSince <= +b.lastpost));
      // Server-side filters BEFORE slicing, so top N is filled with matches.
      let results = ranked.filter(passesFilters);
      const seen = new Set(results.map((r) => r.channelId));
      const dbCands = known.creators.filter((r) =>
        !seen.has(r.channelId) && passesFilters(r) &&
        (r.subs || 0) >= (b.minsubs || 0) && (r.subs || 0) <= (b.maxsubs || Infinity)
      );
      results = [...results, ...dbCands]
        .sort((x, y) => (y.score || 0) - (x.score || 0))
        .slice(0, b.expand ? (b.top || 400) : 20);
      await dbLogScan(fp, simNames, results);
      return json(200, {
        game: fp.name, queries: queries.length, channelCount, results,
        appids: { [fp.name]: fp.appid, ...Object.fromEntries(fp.similarGames.filter((g) => !String(g.appid).startsWith('manual')).map((g) => [g.name, g.appid])) },
      });
    }
    if (req.method === 'GET' && (url.pathname === '/privacy' || url.pathname === '/terms')) {
      const md = url.pathname === '/privacy' ? PRIVACY_MD : TERMS_MD;
      const html = md
        .replace(/</g, '&lt;')
        .replace(/^# (.*)$/gm, '<h1>$1</h1>')
        .replace(/^## (.*)$/gm, '<h2>$1</h2>')
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>')
        .replace(/^- (.*)$/gm, '<li>$1</li>')
        .replace(/(<li>.*<\/li>(\n|$))+/g, (m) => '<ul>' + m + '</ul>')
        .split(/\n\n+/).map((b) => /^<(h1|h2|ul)/.test(b.trim()) ? b : '<p>' + b.replace(/\n/g, '<br>') + '</p>').join('\n');
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Creator Finder</title>
<style>body{background:#0b0e14;color:#c8d0e0;font:15px/1.75 system-ui;max-width:680px;margin:0 auto;padding:48px 20px 80px}
h1{color:#fff;font-size:26px;margin:0 0 24px;padding-bottom:14px;border-bottom:1px solid #2a3142}
h2{color:#e6ebf5;font-size:18px;margin:32px 0 10px}p{margin:12px 0}ul{padding-left:22px}li{margin:6px 0}
strong{color:#e6ebf5}a{color:#8b9dff}.back{display:inline-block;margin-top:32px;padding:8px 16px;border:1px solid #2a3142;border-radius:8px;text-decoration:none}
</style></head><body>${html}<a class="back" href="/">← Back to Creator Finder</a></body></html>`);
    }
    if (url.pathname.startsWith('/api/auth/')) {
      if (!SB_URL || !SB_KEY) return json(503, { error: 'Accounts not configured' });
      const b = await readBody(req);
      if (url.pathname === '/api/auth/signup' && req.method === 'POST') {
        // Admin-create so no confirmation email is needed — signup = logged in.
        const r = await fetch(`${SB_URL}/auth/v1/admin/users`, {
          method: 'POST',
          headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: b.email, password: b.password, email_confirm: true }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
          const dup = j.error_code === 'email_exists' || j.code === 422 || /already been registered/i.test(j.msg || '');
          return json(dup ? 409 : r.status, { error: dup ? 'An account with this email already exists.' : (j.msg || j.error || 'Signup failed') });
        }
        if (j.id) await ensureProfile(j.id);
        const lr = await sbAuth('/token?grant_type=password', { email: b.email, password: b.password });
        return json(lr.status, await lr.json().catch(() => ({})));
      }
      if (url.pathname === '/api/auth/login' && req.method === 'POST') {
        const r = await sbAuth('/token?grant_type=password', { email: b.email, password: b.password });
        return json(r.status, await r.json().catch(() => ({})));
      }
      if (url.pathname === '/api/auth/refresh' && req.method === 'POST') {
        const r = await sbAuth('/token?grant_type=refresh_token', { refresh_token: b.refresh_token });
        return json(r.status, await r.json().catch(() => ({})));
      }
      return json(404, { error: 'unknown auth route' });
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      if (!SB_URL || !SB_KEY) return json(503, { error: 'Accounts not configured' });
      const u = await sbUser((req.headers.authorization || '').replace(/^Bearer /i, ''));
      if (!u) return json(401, { error: 'Not signed in' });
      const p = await ensureProfile(u.id);
      return json(200, { email: u.email, plan: p.plan || 'free' });
    }
    if (url.pathname === '/api/billing/checkout' && req.method === 'POST') {
      const u = await sbUser((req.headers.authorization || '').replace(/^Bearer /i, ''));
      if (!u) return json(401, { error: 'Not signed in' });
      const SKEY = process.env.STRIPE_SECRET_KEY, PRICE = process.env.STRIPE_PRICE_ID;
      if (!SKEY || !PRICE) return json(503, { error: 'Payments not configured yet' });
      const appUrl = process.env.APP_URL || `http://${req.headers.host}`;
      const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SKEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          mode: 'subscription',
          'line_items[0][price]': PRICE,
          'line_items[0][quantity]': '1',
          success_url: `${appUrl}/?upgraded=1`,
          cancel_url: `${appUrl}/`,
          client_reference_id: u.id,
          customer_email: u.email || '',
        }),
      });
      const j = await r.json().catch(() => ({}));
      return json(r.ok ? 200 : r.status, { url: j.url, error: j.error && j.error.message });
    }
    if (url.pathname === '/api/billing/webhook' && req.method === 'POST') {
      if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) return json(503, { error: 'Payments not configured' });
      let raw = '';
      for await (const c of req) raw += c;
      const secret = process.env.STRIPE_WEBHOOK_SECRET;
      {
        const parts = Object.fromEntries((req.headers['stripe-signature'] || '').split(',').map((p) => p.split('=')));
        const exp = createHmac('sha256', secret).update(`${parts.t}.${raw}`).digest('hex');
        const ok = parts.t && parts.v1 && exp.length === parts.v1.length && timingSafeEqual(Buffer.from(exp), Buffer.from(parts.v1));
        if (!ok) return json(400, { error: 'bad signature' });
      }
      const ev = JSON.parse(raw);
      if (ev.type === 'checkout.session.completed' && ev.data && ev.data.object && ev.data.object.client_reference_id)
        await setPlan(ev.data.object.client_reference_id, 'pro');
      return json(200, { received: true });
    }
    if (url.pathname === '/api/lists') {
      if (!SB_URL || !SB_KEY) return json(503, { error: 'Accounts not configured' });
      const u = await sbUser((req.headers.authorization || '').replace(/^Bearer /i, ''));
      if (!u) return json(401, { error: 'Not signed in' });
      const uid = u.id;
      const base = `${SB_URL}/rest/v1/cf_user_lists`;
      const H = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };
      if (req.method === 'GET') {
        const r = await fetch(`${base}?user_id=eq.${uid}&select=lists,updated_at`, { headers: H });
        const rows = await r.json().catch(() => []);
        return json(200, Array.isArray(rows) && rows[0] ? rows[0] : { lists: {}, updated_at: null });
      }
      if (req.method === 'POST') {
        const b = await readBody(req);
        const r = await fetch(base, {
          method: 'POST',
          headers: { ...H, Prefer: 'resolution=merge-duplicates,return=minimal' },
          body: JSON.stringify({ user_id: uid, lists: b.lists || {}, updated_at: new Date().toISOString() }),
        });
        return json(r.ok ? 200 : r.status, { ok: r.ok });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/notes') {
      const b = await readBody(req);
      if (!process.env.GEMINI_API_KEY) return json(200, { notes: {} });
      const chans = (b.channels || []).slice(0, 25);
      const map = {};
      const norm = (n) => (typeof n === 'string' ? n : n?.note);
      const card = (n) => (typeof n === 'object' && n != null ? n.card || null : null);
      const idx = (n) => (typeof n === 'object' && n != null && n.i != null ? n.i : null);
      const apply = (list, arr) => (arr || []).forEach((n, i) => { const k = idx(n) ?? i; if (norm(n) && list[k]) map[list[k].channelId] = { note: norm(n), card: card(n) }; });
      apply(chans, await aiNotesBatch(process.env.GEMINI_API_KEY, chans).catch((e) => { console.error('AI notes:', e.message); return []; }));
      const missing = chans.filter((c) => !map[c.channelId]);
      if (missing.length) apply(missing, await aiNotesBatch(process.env.GEMINI_API_KEY, missing).catch(() => []));
      return json(200, { notes: map });
    }
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
    res.end(HTML);
  } catch (e) {
    json(500, { error: e.message });
  }
};

export default handler;

if (!process.env.VERCEL) {
  createServer(handler).listen(PORT, () => console.log(`http://localhost:${PORT}`));
}
