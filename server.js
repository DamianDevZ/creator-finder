// Local web UI: node server.js -> http://localhost:3456
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Cache } from './src/cache.js';
import { SupaCache } from './src/sbcache.js';
import { YouTube } from './src/youtube.js';
import { buildFingerprint, expandFrontier } from './src/steam.js';
import { findCreators } from './src/pipeline.js';
import { aiNotesBatch } from './src/gemini.js';
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
  *{box-sizing:border-box}
  body{margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:radial-gradient(1200px 600px at 70% -10%,#1a2340 0%,var(--bg) 55%);color:var(--txt);min-height:100vh}
  .shell{display:flex;min-height:100vh}
  #nav{width:230px;flex-shrink:0;border-right:1px solid var(--line);padding:22px 14px;position:sticky;top:0;height:100vh;overflow-y:auto;display:flex;flex-direction:column;background:var(--bg2)}
  .navlogo{font-size:15px;letter-spacing:1px;margin-bottom:24px}
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
  .wrap{max-width:1200px;margin:0 auto;padding:36px 20px;flex:1}
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
  .lmodal{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:200}
  .lmbox{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px 22px;width:300px;box-shadow:0 20px 60px rgba(0,0,0,.5)}
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
  .qt td:last-child{padding-right:20px}
  /* detailed creator card */
  .qcard2{display:flex;gap:22px;background:var(--panel2);border:1px solid var(--line);border-radius:14px;padding:20px 22px;margin-bottom:12px}
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
  <div class="navlogo"><b>CREATOR</b>FINDER</div>
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
  <div class="navacct-wrap">
    <button class="navacct" data-act="acct">Create account</button>
    <button class="navacct ghost" data-act="acct">Log in</button>
  </div>
</aside>
<div class="wrap">
  <div style="display:flex;align-items:baseline;justify-content:space-between;gap:12px">
    <h1 id="viewtitle">Creator Finder</h1>
    <button class="ltab" id="backlist" data-act="backlist" style="display:none">← Back to list</button>
  </div>
  <div class="sub">Paste a Steam link. We profile the game, scan YouTube for channels covering similar titles, and rank who's most likely to say yes.</div>

  <div class="searchbar" style="position:relative">
    <input id="link" placeholder="Paste a Steam link or type a game name…" autofocus>
    <div class="dd" id="linkdd" style="display:none;left:10px;right:10px;width:auto;top:100%"></div>
    <button class="btn" id="load">Analyze game</button>
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
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px">
        <button class="ltab" data-act="lmcancel">Cancel</button>
        <button class="btn" data-act="lmcreate" style="padding:8px 18px;font-size:13px">Create</button>
      </div>
    </div>
  </div>

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
    const src = (v?.appid ? 'https://cdn.akamai.steamstatic.com/steam/apps/' + v.appid + '/header.jpg' : null) || v?.img;
    if (src) {
      const im = document.createElement('img');
      const tries = [
        v?.appid ? 'https://cdn.akamai.steamstatic.com/steam/apps/' + v.appid + '/capsule_616x353.jpg' : null,
        v?.appid ? 'https://cdn.akamai.steamstatic.com/steam/apps/' + v.appid + '/capsule_231x87.jpg' : null,
        v?.img,
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
  $('status').innerHTML = '<span class="spinner"></span>Profiling game…';
  // Clear the previous game's results — a new game means a new queue.
  lastResults = []; lastGame = ''; $('lists').innerHTML = '';
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
  for (const g of games.slice(0, 9)) {
    const c = document.createElement('div');
    c.style.cssText = 'border-radius:8px;overflow:hidden;border:1px solid var(--line);cursor:pointer;transition:.15s;background:var(--panel2)';
    const im = document.createElement('img');
    im.src = 'https://cdn.akamai.steamstatic.com/steam/apps/' + g.appid + '/header.jpg';
    im.style.cssText = 'width:100%;display:block;aspect-ratio:460/215;object-fit:cover';
    const tries = [
      'https://cdn.akamai.steamstatic.com/steam/apps/' + g.appid + '/capsule_616x353.jpg',
      'https://cdn.akamai.steamstatic.com/steam/apps/' + g.appid + '/capsule_231x87.jpg',
      g.img,
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

let sortKey = 'score', sortDir = -1, lastResults = [];
const fmt = n => n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(1)+'K' : n;
const COLS = [
  ['score','Score',r=>r.score],['channel','Channel',r=>r.channel.toLowerCase()],['alias','Alias',r=>(r.alias||'~')],
  ['subs','Subs',r=>r.subs],
  ['views','Avg views',r=>r.medianViews],
  ['covers','Covers',r=>(r.games||[]).length],['lang','Language',r=>r.language||'English'],['notes','Notes',r=>(r.notes||[]).length],['email','Email',r=>r.emails.length],
];
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
document.addEventListener('click', () => $('langmenu').classList.remove('open'));


function renderTable(results) {
  lastResults = results;
  const arrow = k => k === sortKey ? (sortDir === -1 ? ' ↓' : ' ↑') : '';
  const head = '<tr>' + COLS.map(([k,l]) => '<th data-k="' + k + '" onclick="sortBy(this.dataset.k)">' + l + arrow(k) + '</th>').join('') + '</tr>';
  const filtered = results;
  const sorted = [...filtered].sort((a,b) => {
    const f = COLS.find(c=>c[0]===sortKey)[2], x=f(a), y=f(b);
    return (x<y?-1:x>y?1:0)*sortDir;
  });
  const rows = sorted.map(r => {
    const cls = r.score >= 60 ? 'p-good' : r.score >= 45 ? 'p-mid' : 'p-bad';
    const thumb = r.thumb ? '<img src="' + r.thumb + '">' : '<img style="background:var(--panel2)">';
    return '<tr><td><span class="pill ' + cls + '" title="fit ' + r.breakdown.topicFit + ' · reach ' + r.breakdown.reach + ' · eng ' + r.breakdown.engagement + ' · rec ' + r.breakdown.recency + '">' + r.score + '</span></td>'
      + '<td><div class="chan">' + thumb + '<div><div class="channame"><a href="' + r.url + '" target="_blank">' + r.channel + '</a></div></div></div></td>'
      + '<td style="white-space:nowrap">' + (r.alias ? '<b>' + r.alias + '</b>' : '<span class="meta">—</span>') + '</td>'
      + '<td class="num">' + fmt(r.subs) + '</td>'
      + '<td class="num" title="Average views across their recent uploads">' + fmt(r.medianViews) + '</td>'
      + '<td class="covers" style="max-width:170px">' + (r.games||[]).map(g=>'<b>'+g+'</b>').join('<br>') + '</td>'
      + '<td><span class="meta" style="font-size:12px">' + (r.language || 'English') + '</span></td>'
      + '<td class="meta notes-cell" data-cid="' + r.channelId + '" style="max-width:190px;font-size:11.5px;line-height:1.5;color:var(--dim)"><div>'
      + (r.aiPending ? '<span><span class="spinner" style="width:11px;height:11px;border-width:2px;display:inline-block;vertical-align:middle"></span> <span style="font-size:10px">AI…</span></span>' : (r.notes||[]).join('<br>')) + '</div></td>'
      + '<td>' + (r.emails.length ? '<span class="emailchip">Yes</span>' : '<span class="meta">—</span>') + '</td></tr>';
  }).join('');
  $('out').innerHTML = '<div class="panel"><div class="meta" style="margin-bottom:8px">' + filtered.length + ' of ' + results.length + ' shown' + (filtered.length < results.length ? ' — adjust filters to see more' : '') + '</div><table>' + head + rows + '</table></div>';
}
window.sortBy = (k) => { sortDir = sortKey === k ? -sortDir : (k === 'channel' ? 1 : -1); sortKey = k; renderTable(lastResults); };
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
  const body = {
    input: $('link').value,
    similar: [...simMap.keys()].join(','), tags: derivedTags().join(','),
    minsubs: +$('minsubs').value.replace(/[^\\d]/g, '') || 0, maxsubs: +$('maxsubs').value.replace(/[^\\d]/g, '') || null,
    top: +$('top').value || 30, deep: true, hidedev: true,
    emailonly: true,
    lang: $('langfilter').value, ainotes: true, dlp: true,
  };
  const res = await fetch('/api/find', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  $('go').disabled = false;
  if (!res.ok) { $('lists').innerHTML = '<div class="panel"><div class="scanload" style="color:var(--rej)">Error: ' + esc(j.error || 'scan failed') + '</div></div>'; return; }
  $('status').textContent = '';
  // Populate language options from what was actually detected.
  lastResults = j.results;
  lastGame = j.game;
  lastInput = $('link').value;
  expandDone = false; expandBuffer = [];
  usedGameNames = new Set([j.game, ...simMap.keys()].map((n) => n.toLowerCase()));
  // Refresh this game's candidate pool (lists are never auto-created).
  pools[j.game] = {};
  for (const r of j.results) pools[j.game][r.channelId] = snap(r);
  savePools();
  // Lists aren't game-tied — the selected list stays, verdicts apply to it.
  triageTab = 'queue';
  renderLists();
  requestNotes(j.results.map((r) => pools[j.game] && pools[j.game][r.channelId]).filter(Boolean));
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
        if (notesCache[r.channelId]) { r.aiNote = notesCache[r.channelId]; r.aiPending = false; }
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
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      input: lastInput, similar: batch.map((g) => g.name).join(','), tags: derivedTags().join(','), expand: true,
      minsubs: +$('minsubs').value.replace(/[^\\d]/g, '') || 0,
      maxsubs: +$('maxsubs').value.replace(/[^\\d]/g, '') || null,
      top: 400, deep: true, hidedev: true, emailonly: true,
      lang: $('langfilter').value, ainotes: true, dlp: true,
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
const saveLists = () => localStorage.setItem(LKEY, JSON.stringify(lists));
const savePools = () => localStorage.setItem(PKEY, JSON.stringify(pools));
let activeList = null, triageTab = 'queue', triageMode = 'detailed', qi = 0, lastGame = '', pendingVerdict = null, lpOpen = false;
let lastInput = '', usedGameNames = new Set(), expanding = false, expandDone = false, expandBuffer = [];
const notesCache = {}; // channelId -> AI note; survives until candidates enter the pool
const gameAppids = {}; // lowercase game name -> steam appid, for Covers links

const snap = (r) => ({
  channelId: r.channelId, channel: r.channel, url: r.url, thumb: r.thumb,
  score: r.score, subs: r.subs, medianViews: r.medianViews, games: r.games || [], alias: r.alias,
  language: r.language || 'English', notes: r.notes || [], emails: r.emails || [],
  vidTitles: r.vidTitles || [], description: r.description || '',
  aiNote: r.aiNote || null,
});
const poolFor = (game) => pools[game] || {};
const queueFor = (l) => Object.values(poolFor(lastGame)).filter((r) => !(lists[l].verdicts || {})[r.channelId]);

function verdict(listName, cid, v, quiet) {
  const l = lists[listName];
  if (!l) return;
  l.verdicts ||= {}; l.channels ||= {};
  if (v === null) delete l.verdicts[cid]; else l.verdicts[cid] = v;
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
  for (const [k, label] of [['queue', 'Queue'], ['acc', 'Accepted'], ['rej', 'Rejected']]) {
    const t = $('lists').querySelector('[data-act="tab"][data-v="' + k + '"]');
    if (t) t.textContent = label + ' (' + cnt[k] + ')';
  }
}

function esc(s) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;'); }

function chanLine(r) {
  const cls = r.score >= 60 ? 'p-good' : r.score >= 45 ? 'p-mid' : 'p-bad';
  const thumb = r.thumb ? '<img src="' + r.thumb + '">' : '<img style="background:var(--bg3)">';
  return thumb + '<div style="min-width:0;flex:1">'
    + '<div style="display:flex;gap:8px;align-items:center;min-width:0"><a href="' + r.url + '" target="_blank" style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + esc(r.channel) + '</a>'
    + '<span class="pill ' + cls + '">' + r.score + '</span></div>'
    + '<div class="meta" style="font-size:11px">' + fmt(r.subs) + ' subs · avg ' + fmt(r.medianViews) + ' views · ' + esc(r.language || 'English') + '</div></div>';
}

function detailCard(r, btns) {
  const cls = r.score >= 60 ? 'p-good' : r.score >= 45 ? 'p-mid' : 'p-bad';
  const thumb = r.thumb ? '<img src="' + r.thumb + '">' : '<img style="background:var(--bg3)">';
  return '<div class="qcard2">'
    + '<a class="qc-left" href="' + r.url + '" target="_blank" style="text-decoration:none;color:inherit">' + thumb
    + '<span class="qc-name" style="display:block">' + esc(r.channel) + '</span>'
    + '<span class="qc-sub">Alias: ' + (r.alias ? esc(r.alias) : '—') + '</span></a>'
    + '<div class="qc-main">'
    + '<div class="qc-stats">'
    + '<div class="qstat"><div class="qs-l">Fit score</div><div class="qs-v"><span class="pill ' + cls + '">' + r.score + '</span></div></div>'
    + '<div class="qstat"><div class="qs-l">Subscribers</div><div class="qs-v">' + fmt(r.subs) + '</div></div>'
    + '<div class="qstat"><div class="qs-l">Avg views</div><div class="qs-v">' + fmt(r.medianViews) + '</div></div>'
    + '<div class="qstat"><div class="qs-l">Language</div><div class="qs-v">' + esc(r.language || 'English') + '</div></div></div>'
    + '<div class="qc-low"><div class="qc-rows">'
    + '<div class="qc-lbl">Covers</div><div class="qc-val covers">' + (r.games || []).map((g) => '<a href="' + (gameAppids[g.toLowerCase()] ? 'https://store.steampowered.com/app/' + gameAppids[g.toLowerCase()] + '/' : 'https://store.steampowered.com/search/?term=' + encodeURIComponent(g)) + '" target="_blank" style="color:inherit"><b>' + esc(g) + '</b></a>').join(', ') + '</div>'
    + '<div class="qc-lbl">Notes</div><div class="qc-val">' + (r.aiPending ? '<span class="spinner" style="width:11px;height:11px;border-width:2px;display:inline-block;vertical-align:middle"></span>' : esc(r.aiNote || (r.notes || []).join(' · ') || '—')) + '</div>'
    + (r.emails.length ? '<div class="qc-lbl">Contact</div><div class="qc-val">' + r.emails.map((e) => '<span class="mailchip copymail" data-e="' + esc(e) + '" title="' + esc(e) + '">' + esc(e) + '</span>').join(' ') + '</div>' : '')
    + '</div>'
    + '<div class="qc-act">' + btns + '</div>'
    + '</div></div></div>';
}

function qRow(r, btns) {
  const cls = r.score >= 60 ? 'p-good' : r.score >= 45 ? 'p-mid' : 'p-bad';
  const thumb = r.thumb ? '<img src="' + r.thumb + '" style="width:34px;height:34px;border-radius:50%">' : '<img style="width:34px;height:34px;border-radius:50%;background:var(--panel2)">';
  return '<tr><td><span class="pill ' + cls + '">' + r.score + '</span></td>'
    + '<td><div class="chan">' + thumb + '<div class="channame"><a href="' + r.url + '" target="_blank">' + esc(r.channel) + '</a></div></div></td>'
    + '<td class="num">' + fmt(r.subs) + '</td>'
    + '<td><span class="meta" style="font-size:12px">' + esc(r.language || 'English') + '</span></td>'
    + '<td>' + (r.emails.length ? '<span class="emailchip">Yes</span>' : '<span class="meta">—</span>') + '</td>'
    + '<td><div class="vbtns">' + btns(r) + '</div></td></tr>';
}

function qTable(rows, lastW, btns) {
  return '<table class="qt">'
    + '<tr><th style="width:56px">Score</th><th>Channel</th><th style="width:70px">Subs</th><th style="width:78px">Language</th><th style="width:62px">Email</th><th style="width:' + lastW + 'px"></th></tr>'
    + rows.map((r) => qRow(r, btns)).join('') + '</table>';
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

function renderLists() {
  const el = $('lists');
  $('viewtitle').textContent = activeList || 'Creator Finder';
  renderNav();
  const l = activeList ? lists[activeList] : null;
  const game = lastGame || '';
  if (!game && !Object.keys(lists).length) { el.innerHTML = ''; return; }
  const pool = poolFor(game);
  const gameLists = Object.keys(lists);
  const acc = l ? Object.entries(l.verdicts || {}).filter(([, v]) => v === 'a').map(([c]) => c) : [];
  const rej = l ? Object.entries(l.verdicts || {}).filter(([, v]) => v === 'r').map(([c]) => c) : [];
  const queue = Object.values(pool).filter((r) => !((l && l.verdicts) || {})[r.channelId]).slice(qi);
  const shown = triageMode === 'detailed' ? queue.slice(0, 3) : queue.slice(0, 10);

  let body = '<div class="listbar" style="margin-bottom:14px">'
    + '<div style="position:relative">'
    + '<button class="lpbtn" data-act="lpmenu">'
    + (l ? esc(activeList) : '<span style="color:var(--dim)">Select list…</span>')
    + '<span class="car">▾</span></button>'
    + (lpOpen
      ? '<div class="lpmenu">'
      + gameLists.map((n) => '<div class="lpmi' + (n === activeList ? ' on' : '') + '" data-act="lpick" data-v="' + esc(n) + '">' + esc(n) + '</div>').join('')
      + '<div class="lpmi" data-act="lnew" style="color:var(--acc)">+ New list…</div></div>'
      : '')
    + '</div>'
    + (l
      ? '<button class="ltab' + (triageTab === 'queue' ? ' on' : '') + '" data-act="tab" data-v="queue">Queue (' + queue.length + ')</button>'
      + '<button class="ltab' + (triageTab === 'acc' ? ' on' : '') + '" data-act="tab" data-v="acc">Accepted (' + acc.length + ')</button>'
      + '<button class="ltab' + (triageTab === 'rej' ? ' on' : '') + '" data-act="tab" data-v="rej">Rejected (' + rej.length + ')</button>'
      : '')
    + '<span style="margin-left:auto"></span>'
    + '</div>';

  if (!l) {
    if (!queue.length) {
      body += '<div class="meta" style="padding:24px;text-align:center">'
        + (lastGame
          ? (expandDone ? 'Pool exhausted — the whole frontier has been scanned. Run a new scan or widen filters.' : 'No creators matched — the scan returned 0 (YouTube quota may be exhausted, or filters too strict). Try again or widen filters.')
          : 'No candidates — run a scan first.')
        + '</div>';
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
      body += '<div class="meta" style="padding:24px;text-align:center">Pool exhausted — all candidates reviewed (' + acc.length + ' accepted, ' + rej.length + ' rejected). Run a new scan to refill.</div>';
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
  } else {
    const ids = triageTab === 'acc' ? acc : rej;
    const rows = ids.map((cid) => l.channels[cid]).filter(Boolean);
    const moveBtns = (r) =>
      '<button class="vb" data-act="verdict" data-cid="' + r.channelId + '" data-v="">' + 'Back to queue' + '</button>'
      + '<button class="vb ' + (triageTab === 'acc' ? 'no' : 'ok') + '" data-act="verdict" data-cid="' + r.channelId + '" data-v="' + (triageTab === 'acc' ? 'r' : 'a') + '">' + (triageTab === 'acc' ? 'Move to rejected' : 'Move to accepted') + '</button>';
    body += rows.length
      ? (triageMode === 'detailed'
        ? rows.map((r) => detailCard(r, moveBtns(r))).join('')
        : qTable(rows, 190, moveBtns))
      : '<div class="meta" style="padding:24px;text-align:center">Nothing here yet.</div>';
  }
  el.innerHTML = '<div class="panel" style="margin-top:16px">' + body + '</div>';
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
    lpOpen = false; activeList = b.dataset.v; triageTab = 'queue'; qi = 0; renderLists();
  } else if (act === 'lnew') {
    lpOpen = false; pendingVerdict = null;
    $('lmodal').style.display = 'flex';
    setTimeout(() => $('lmname').focus(), 50);
  } else if (act === 'startlist') {
    const name = ($('newlist').value || $('lpick')?.value || '').trim();
    if (!name) return;
    if (!lists[name]) lists[name] = { verdicts: {}, channels: {} };
    activeList = name; triageTab = 'queue'; qi = 0; saveLists(); renderLists();
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
    activeList = name; triageTab = 'queue'; qi = 0;
    $('lmodal').style.display = 'none'; $('lmname').value = '';
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
    activeList = b.dataset.n; triageTab = 'queue'; qi = 0; openMenu = null;
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
    alert('Accounts coming soon — your lists are safely stored in this browser for now.');
  }
});

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
        if (n) { r.aiNote = n; notesCache[r.channelId] = n; }
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
    if (req.method === 'POST' && url.pathname === '/api/fingerprint') {
      const b = await readBody(req);
      return json(200, await buildFingerprint(b.input, { manualTags: list(b.tags) }));
    }
    if (req.method === 'POST' && url.pathname === '/api/find') {
      const b = await readBody(req);
      const { fp, queries, channelCount, ranked } = await findCreators(b.input, yt, {
        manualTags: list(b.tags),
        manualSimilar: list(b.similar),
        minSubs: b.minsubs || 0,
        maxSubs: b.maxsubs || Infinity,
        deep: !!b.deep,
        dlp: !!b.dlp,
      });
      // Server-side filters BEFORE slicing, so top N is filled with matches.
      let results = ranked.filter((r) =>
        (!b.emailonly || r.emails.length) &&
        (!b.hidedev || r.niche !== 'Dev/studio') &&
        (!b.lang || b.lang === 'any' || (r.language || 'English') === b.lang)
      );
      results = results.slice(0, b.expand ? (b.top || 400) : 20);
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
    if (req.method === 'POST' && url.pathname === '/api/notes') {
      const b = await readBody(req);
      if (!process.env.GEMINI_API_KEY) return json(200, { notes: {} });
      const chans = (b.channels || []).slice(0, 25);
      const map = {};
      const norm = (n) => (typeof n === 'string' ? n : n?.note);
      const idx = (n) => (typeof n === 'object' && n != null && n.i != null ? n.i : null);
      const apply = (list, arr) => (arr || []).forEach((n, i) => { const k = idx(n) ?? i; if (norm(n) && list[k]) map[list[k].channelId] = norm(n); });
      apply(chans, await aiNotesBatch(process.env.GEMINI_API_KEY, chans).catch((e) => { console.error('AI notes:', e.message); return []; }));
      const missing = chans.filter((c) => !map[c.channelId]);
      if (missing.length) apply(missing, await aiNotesBatch(process.env.GEMINI_API_KEY, missing).catch(() => []));
      return json(200, { notes: map });
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
  } catch (e) {
    json(500, { error: e.message });
  }
};

export default handler;

if (!process.env.VERCEL) {
  createServer(handler).listen(PORT, () => console.log(`http://localhost:${PORT}`));
}
