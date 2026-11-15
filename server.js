// Local web UI: node server.js -> http://localhost:3456
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Cache } from './src/cache.js';
import { SupaCache } from './src/sbcache.js';
import { YouTube } from './src/youtube.js';
import { buildFingerprint } from './src/steam.js';
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
const notesJobs = new Map();
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
  .navguest{margin-top:auto;padding:12px 8px;border-top:1px solid var(--line)}
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
  .gamegrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
  .gcard{position:relative;border-radius:10px;overflow:hidden;border:1px solid var(--line);background:var(--panel2);transition:.15s}
  .gcard:hover{border-color:#3a527a;transform:translateY(-2px)}
  .gcard img{width:100%;object-fit:cover;display:block;background:var(--line)}
  .gcard .gname{padding:7px 10px;font-size:12.5px;font-weight:600;line-height:1.3;min-height:36px}
  .gcard .x{position:absolute;top:5px;right:5px;width:20px;height:20px;border-radius:50%;background:rgba(0,0,0,.75);color:var(--bad);display:none;align-items:center;justify-content:center;cursor:pointer;font-size:14px;line-height:1}
  .gcard:hover .x{display:flex}
  .addcard{display:flex;align-items:center;justify-content:center;border:1px dashed var(--line);border-radius:10px;color:var(--dim);cursor:pointer;font-size:13px;min-height:100px;transition:.15s}
  .addcard:hover{border-color:var(--acc);color:var(--acc)}
  .searchcard{border:1px solid var(--acc) !important;border-style:solid !important;padding:8px;cursor:default}
  .searchcard input{width:100%;background:transparent;border:none;color:var(--txt);font-size:13px;outline:none}
  /* --- game search results: same card grid --- */
  .dd.gdd{position:static;border:none;background:transparent;box-shadow:none;width:100%;max-height:none;padding:0;margin-top:12px}
  .dd.gdd .gddgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
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
  .qt .qnotes{font-size:12px;line-height:1.5;color:var(--dim)}
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
  .qc-rows{display:grid;grid-template-columns:64px 1fr;row-gap:9px;font-size:12.5px;margin-bottom:14px}
  .qc-lbl{color:var(--dim);font-size:10.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;padding-top:1px}
  .qc-val{color:var(--txt);line-height:1.55}
  .qc-act{display:flex;gap:10px;align-items:stretch}
  .vb.big{padding:0 18px;font-size:13px;border-radius:10px;min-width:96px}
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
  <div class="navsec">LISTS</div>
  <div id="navlists"></div>
  <button class="navadd" data-act="newlist">+ New list</button>
  <div id="newlistbox" style="display:none;margin-top:8px">
    <input id="navlistname" placeholder="List name…" style="width:100%;background:var(--panel2);border:1px solid var(--line);border-radius:8px;color:var(--txt);padding:8px 10px;font-size:13px;outline:none">
  </div>
  <div class="navguest">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">
      <div style="width:30px;height:30px;border-radius:50%;background:var(--bg3);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:var(--dim)">G</div>
      <div><div style="font-size:13px;font-weight:600">Guest</div><div class="meta" style="font-size:10.5px">lists saved locally</div></div>
    </div>
    <button class="navacct" data-act="acct">Create account</button>
    <button class="navacct ghost" data-act="acct">Log in</button>
  </div>
</aside>
<div class="wrap">
  <div class="logo"><b>CREATOR</b>FINDER</div>
  <h1>Find creators for your game</h1>
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
        </div>
        <div id="reldev" style="flex:1;min-width:0"></div>
        <div id="relpub" style="flex:1;min-width:0"></div>
      </div>
    </div>

    <div class="panel">
      <div class="seclabel" style="margin-top:0">Similar games — creators covering these will be found</div>
      <div class="gamegrid" id="simchips">
        <div class="addcard" id="addcardbtn">+ Add game</div>
      </div>
      <div class="dd gdd" id="simdd" style="display:none;position:static;margin-top:10px"></div>
    </div>

    <div class="panel">
      <div class="seclabel" style="margin-top:0">Tags — used to refine the profile</div>
      <div class="tagbox" id="tagbox">
        <div class="addbox" style="flex:1;display:flex">
          <input id="addtag" placeholder="Search Steam tags…" autocomplete="off" style="flex:1">
          <div class="dd" id="tagdd" style="display:none"></div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="seclabel" style="margin-top:0">Filters</div>
      <div class="controls" style="border-top:none;margin-top:0;padding-top:0">
        <div class="ctl"><span>Min subs</span><input id="minsubs" value="5000"></div>
        <div class="ctl"><span>Max subs</span><input id="maxsubs" value="500000"></div>
        <div class="ctl"><span>Results</span><input id="top" value="30"></div>
        <input type="hidden" id="deep" checked>
        <label class="ctl switch" title="Only show channels where we found an email"><input type="checkbox" id="emailonly"><span class="sw"></span><span style="text-transform:none;font-size:12px">Has email</span></label>
        <input type="hidden" id="devonly" value="on">
        <label class="ctl switch" title="Rewrite notes with AI (needs GEMINI_API_KEY)"><input type="checkbox" id="ainotes"><span class="sw"></span><span style="text-transform:none;font-size:12px">AI notes</span></label>
        <label class="ctl switch" title="Quota-free search via yt-dlp. Local testing only — not for the deployed app."><input type="checkbox" id="dlp"><span class="sw"></span><span style="text-transform:none;font-size:12px">yt-dlp</span></label>
        <div class="ctl" style="position:relative"><span>Language</span>
          <input type="hidden" id="langfilter" value="English">
          <div class="dd-btn" id="langbtn" style="cursor:pointer;display:flex;align-items:center;gap:6px">English <span style="font-size:9px;color:var(--dim)">▾</span></div>
          <div class="dd-menu" id="langmenu"></div>
        </div>
        <button class="btn" id="go" style="margin-left:auto;align-self:center">Find creators</button>
      </div>
    </div>
  </div>

  <div id="status"></div>
  <div id="out"></div>
  <div id="lists"></div>

  <footer class="meta" style="margin-top:36px;padding-top:16px;border-top:1px solid var(--line);display:flex;gap:18px;justify-content:center;font-size:12px">
    <a href="/privacy" style="color:var(--dim)">Privacy Policy</a>
    <a href="/terms" style="color:var(--dim)">Terms of Service</a>
    <span style="color:var(--dim)">Powered by the <b style="color:#f00">YouTube</b> Data API</span>
  </footer>
</div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const simMap = new Map(), tagSet = new Set();

function renderChips(kind) {
  if (kind === 'sim') {
    const el = $('simchips');
    el.querySelectorAll('.gcard').forEach(c => c.remove());
    for (const [name, v] of simMap) {
      const d = document.createElement('div');
      d.className = 'gcard';
      const src = v?.img || (v?.appid ? 'https://cdn.akamai.steamstatic.com/steam/apps/' + v.appid + '/capsule_184x69.jpg' : null);
      if (src) {
        const im = document.createElement('img');
        im.src = src;
        im.onerror = () => im.remove();
        im.onload = () => { im.style.aspectRatio = im.naturalWidth + '/' + im.naturalHeight; };
        d.appendChild(im);
      }
      d.insertAdjacentHTML('beforeend', '<div class="gname">' + name + '</div><span class="x">&times;</span>');
      d.querySelector('.x').onclick = (e) => { e.stopPropagation(); simMap.delete(name); renderChips('sim'); };
      el.insertBefore(d, $('addcardbtn'));
    }
  } else {
    const box = $('tagbox');
    box.querySelectorAll('.tag').forEach(t => t.remove());
    for (const t of tagSet) {
      const d = document.createElement('span');
      d.className = 'tag';
      d.innerHTML = t + ' <span class="x">&times;</span>';
      d.querySelector('.x').onclick = () => { tagSet.delete(t); renderChips('tag'); };
      box.insertBefore(d, box.lastElementChild);
    }
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
        d.onclick = () => { simMap.set(it.name, { appid: it.appid, img: it.img }); renderChips('sim'); dd.style.display = 'none'; resetAddCard(); };
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
autocomplete('addtag', 'tagdd', '/api/search-tags', (t) => { tagSet.add(t); renderChips('tag'); });

// Main bar: typing a name (not a URL/appid) searches Steam directly.
(() => {
  const inp = $('link'), dd = $('linkdd');
  let timer;
  inp.oninput = () => {
    clearTimeout(timer);
    const q = inp.value.trim();
    if (q.length < 3 || /steampowered\.com|^\d+$/.test(q)) { dd.style.display = 'none'; return; }
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
  const res = await fetch('/api/fingerprint', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input: $('link').value }) });
  const j = await res.json();
  if (!res.ok) { $('status').textContent = 'Error: ' + j.error; return; }
  $('status').textContent = '';
  $('base').style.display = 'block';
  $('gametitle').textContent = j.name;
  $('gamemeta').textContent = [(j.developers || []).join(', '), (j.publishers || []).filter(p => !(j.developers || []).includes(p)).join(', ')].filter(Boolean).join(' · ') || j.genres.join(' · ');
  renderRelated('reldev', j.developers?.[0], j.relatedByDeveloper);
  renderRelated('relpub', j.publishers?.[0], j.relatedByPublisher);
  $('gameimg').style.display = 'none';
  if (j.appid && !String(j.appid).startsWith('manual')) {
    const img = $('gameimg');
    img.onerror = () => { img.style.display = 'none'; };
    img.onload = () => { img.style.display = 'block'; };
    img.src = j.headerImage || 'https://cdn.akamai.steamstatic.com/steam/apps/' + j.appid + '/header.jpg';
  }
  simMap.clear(); tagSet.clear();
  j.similarGames.forEach(g => simMap.set(g.name, String(g.appid).startsWith('manual') ? null : { appid: g.appid, img: g.img || null }));
  j.tags.slice(0, 12).forEach(t => tagSet.add(t));
  renderChips('sim'); renderChips('tag');
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
    im.src = g.img; im.style.cssText = 'width:100%;display:block';
    im.onload = () => { im.style.aspectRatio = im.naturalWidth + '/' + im.naturalHeight; };
    im.onerror = () => im.remove();
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
  $('status').innerHTML = '<span class="spinner"></span>Scanning YouTube… usually 30–60s on a cold run.';
  const body = {
    input: $('link').value,
    similar: [...simMap.keys()].join(','), tags: [...tagSet].join(','),
    minsubs: +$('minsubs').value || 0, maxsubs: +$('maxsubs').value || null,
    top: +$('top').value || 30, deep: true, hidedev: true,
    emailonly: $('emailonly').checked,
    lang: $('langfilter').value, ainotes: $('ainotes').checked, dlp: $('dlp').checked,
  };
  const res = await fetch('/api/find', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await res.json();
  $('go').disabled = false;
  if (!res.ok) { $('status').textContent = 'Error: ' + j.error; return; }
  $('status').textContent = j.game + ' — ' + j.channelCount + ' channels found · ' + j.queries + ' searches';
  // Populate language options from what was actually detected.
  lastResults = j.results;
  lastGame = j.game;
  // Auto-create "{game} General" if this game has no list yet,
  // and auto-open the game's list so the queue shows immediately.
  let gameList = Object.keys(lists).find((n) => lists[n].game === j.game);
  if (!gameList) {
    gameList = j.game + ' General';
    lists[gameList] = { game: j.game, verdicts: {}, channels: {} };
    saveLists();
  }
  if (!activeList) activeList = gameList;
  triageTab = 'queue';
  renderLists();
  if (j.notesId) pollNotes(j.notesId);
};

// ============ LISTS (guest mode, localStorage; Supabase sync later) ============
const LKEY = 'cf_lists';
let lists = {};
try { lists = JSON.parse(localStorage.getItem(LKEY)) || {}; } catch { lists = {}; }
const saveLists = () => localStorage.setItem(LKEY, JSON.stringify(lists));
let activeList = null, triageTab = 'queue', triageMode = 'compact', qi = 0, lastGame = '';

const snap = (r) => ({
  channelId: r.channelId, channel: r.channel, url: r.url, thumb: r.thumb,
  score: r.score, subs: r.subs, medianViews: r.medianViews, games: r.games || [], alias: r.alias,
  language: r.language || 'English', notes: r.notes || [], emails: r.emails || [],
});
const queueFor = (l) => lastResults.filter((r) => !(lists[l].verdicts || {})[r.channelId]);

function verdict(listName, cid, v) {
  const l = lists[listName];
  if (!l) return;
  l.verdicts ||= {}; l.channels ||= {};
  if (v === null) delete l.verdicts[cid]; else l.verdicts[cid] = v;
  const r = lastResults.find((x) => x.channelId === cid);
  if (r && !l.channels[cid]) l.channels[cid] = snap(r);
  saveLists();
  renderLists();
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

let renaming = null, openMenu = null;
function renderNav() {
  const names = Object.keys(lists).sort((a, b) => (lists[a].game + a).localeCompare(lists[b].game + b));
  $('navlists').innerHTML = names.map((n) => {
    if (n === renaming)
      return '<div class="navitem on"><input id="navrename" value="' + esc(n) + '" style="flex:1;min-width:0;background:var(--bg3);border:1px solid var(--acc);border-radius:6px;color:var(--txt);padding:4px 8px;font-size:13px;outline:none"></div>';
    const l = lists[n];
    const cnt = Object.keys(l.verdicts).length;
    return '<div class="navitem' + (n === activeList ? ' on' : '') + '" data-act="openlist" data-n="' + esc(n) + '">'
      + '<div class="nm"><div>' + esc(n) + '</div><div class="g">' + esc(l.game || '') + (cnt ? ' · ' + cnt : '') + '</div></div>'
      + '<span class="navdots" data-act="itemmenu" data-n="' + esc(n) + '">⋮</span>'
      + '<div class="navmenu' + (openMenu === n ? ' open' : '') + '">'
      + '<div class="mi" data-act="rename" data-n="' + esc(n) + '">Rename</div>'
      + '<div class="mi danger" data-act="deletelist" data-n="' + esc(n) + '">Delete</div></div></div>';
  }).join('') || '<div class="meta" style="padding:6px;font-size:11.5px">No lists yet</div>';
}

function renderLists() {
  const el = $('lists');
  if (!lastResults.length && !Object.keys(lists).length) { el.innerHTML = ''; renderNav(); return; }
  renderNav();

  renderNav();
  // --- no active list: nav drives selection; panel hidden ---
  if (!activeList) { el.innerHTML = ''; return; }

  const l = lists[activeList];
  if (!l) { activeList = null; renderLists(); return; }
  l.verdicts ||= {}; l.channels ||= {};
  const acc = Object.entries(l.verdicts).filter(([, v]) => v === 'a').map(([c]) => c);
  const rej = Object.entries(l.verdicts).filter(([, v]) => v === 'r').map(([c]) => c);
  const queue = queueFor(activeList).slice(qi);
  const shown = triageMode === 'detailed' ? queue.slice(0, 3) : queue.slice(0, 10);

  let body = '<div class="listbar" style="margin-bottom:14px">'
    + '<b>' + esc(activeList) + '</b><span class="meta">' + esc(l.game) + '</span>'
    + '<button class="ltab' + (triageTab === 'queue' ? ' on' : '') + '" data-act="tab" data-v="queue">Queue (' + queue.length + ')</button>'
    + '<button class="ltab' + (triageTab === 'acc' ? ' on' : '') + '" data-act="tab" data-v="acc">Accepted (' + acc.length + ')</button>'
    + '<button class="ltab' + (triageTab === 'rej' ? ' on' : '') + '" data-act="tab" data-v="rej">Rejected (' + rej.length + ')</button>'
    + (triageTab === 'queue' ? '<button class="ltab" data-act="mode" style="margin-left:auto">' + (triageMode === 'detailed' ? 'Compact view' : 'Detailed view') + '</button>' : '')
    + '<button class="ltab" data-act="closelist">Done</button>'
    + '</div>';

  if (triageTab === 'queue') {
    if (!shown.length) {
      body += '<div class="meta" style="padding:24px;text-align:center">Queue empty — every candidate has a verdict. ' + acc.length + ' accepted, ' + rej.length + ' rejected.</div>';
    } else if (triageMode === 'detailed') {
      body += shown.map((r) => {
        const cls = r.score >= 60 ? 'p-good' : r.score >= 45 ? 'p-mid' : 'p-bad';
        const thumb = r.thumb ? '<img src="' + r.thumb + '">' : '<img style="background:var(--bg3)">';
        return '<div class="qcard2">'
          + '<div class="qc-left">' + thumb
          + '<a class="qc-name" href="' + r.url + '" target="_blank">' + esc(r.channel) + '</a>'
          + '<div class="qc-sub">Alias: ' + (r.alias ? esc(r.alias) : '—') + '</div></div>'
          + '<div class="qc-main">'
          + '<div class="qc-stats">'
          + '<div class="qstat"><div class="qs-l">Fit score</div><div class="qs-v"><span class="pill ' + cls + '">' + r.score + '</span></div></div>'
          + '<div class="qstat"><div class="qs-l">Subscribers</div><div class="qs-v">' + fmt(r.subs) + '</div></div>'
          + '<div class="qstat"><div class="qs-l">Avg views</div><div class="qs-v">' + fmt(r.medianViews) + '</div></div>'
          + '<div class="qstat"><div class="qs-l">Language</div><div class="qs-v">' + esc(r.language || 'English') + '</div></div>'
          + '<div class="qc-act"><button class="vb big no" data-act="verdict" data-cid="' + r.channelId + '" data-v="r">✗ Reject</button>'
          + '<button class="vb big ok" data-act="verdict" data-cid="' + r.channelId + '" data-v="a">✓ Accept</button></div></div>'
          + '<div class="qc-rows">'
          + '<div class="qc-lbl">Covers</div><div class="qc-val covers">' + (r.games || []).map((g) => '<b>' + esc(g) + '</b>').join(', ') + '</div>'
          + '<div class="qc-lbl">About</div><div class="qc-val">' + (r.aiPending ? '<span class="spinner" style="width:11px;height:11px;border-width:2px;display:inline-block;vertical-align:middle"></span>' : (r.notes || []).map(esc).join('<br>')) + '</div>'
          + ((r.vidTitles || []).length ? '<div class="qc-lbl">Videos</div><div class="qc-val" style="color:var(--dim)">' + r.vidTitles.slice(0, 3).map(esc).join('<br>') + '</div>' : '')
          + (r.emails.length ? '<div class="qc-lbl">Contact</div><div class="qc-val">' + r.emails.map((e) => '<span class="mailchip copymail" data-e="' + esc(e) + '" title="' + esc(e) + '">' + esc(e) + '</span>').join(' ') + '</div>' : '')
          + '</div>'
          + '</div></div>';
      }).join('');
    } else {
      // compact: mini-table — score, channel, subs, language, notes, email, verdict
      body += '<table class="qt">'
        + '<tr><th style="width:56px">Score</th><th style="width:175px">Channel</th><th style="width:64px">Subs</th><th style="width:72px">Language</th><th>Notes</th><th style="width:62px">Email</th><th style="width:100px"></th></tr>'
        + shown.map((r) => {
          const cls = r.score >= 60 ? 'p-good' : r.score >= 45 ? 'p-mid' : 'p-bad';
          const thumb = r.thumb ? '<img src="' + r.thumb + '" style="width:34px;height:34px;border-radius:50%">' : '<img style="width:34px;height:34px;border-radius:50%;background:var(--panel2)">';
          return '<tr><td><span class="pill ' + cls + '">' + r.score + '</span></td>'
            + '<td><div class="chan">' + thumb + '<div class="channame"><a href="' + r.url + '" target="_blank">' + esc(r.channel) + '</a></div></div></td>'
            + '<td class="num">' + fmt(r.subs) + '</td>'
            + '<td><span class="meta" style="font-size:12px">' + esc(r.language || 'English') + '</span></td>'
            + '<td><div class="qnotes">'
            + (r.aiPending ? '<span class="spinner" style="width:11px;height:11px;border-width:2px;display:inline-block;vertical-align:middle"></span> <span style="font-size:10px">AI…</span>' : (r.notes || []).map(esc).join('<br>')) + '</div></td>'
            + '<td>' + (r.emails.length ? '<span class="emailchip">Yes</span>' : '<span class="meta">—</span>') + '</td>'
            + '<td><div class="vbtns"><button class="vb no" data-act="verdict" data-cid="' + r.channelId + '" data-v="r">✗</button>'
            + '<button class="vb ok" data-act="verdict" data-cid="' + r.channelId + '" data-v="a">✓</button></div></td></tr>';
        }).join('') + '</table>';
    }
  } else {
    const ids = triageTab === 'acc' ? acc : rej;
    const rows = ids.map((cid) => l.channels[cid]).filter(Boolean);
    body += rows.length
      ? rows.map((r) =>
        '<div class="qrow">' + chanLine(r)
        + (triageTab === 'acc' && r.emails.length ? '<div>' + r.emails.map((e) => '<span class="mailchip copymail" data-e="' + esc(e) + '" title="' + esc(e) + '">' + esc(e) + '</span>').join(' ') + '</div>' : '')
        + '<div class="vbtns"><button class="vb" data-act="verdict" data-cid="' + r.channelId + '" data-v="' + (triageTab === 'acc' ? 'r' : 'a') + '">' + (triageTab === 'acc' ? 'Move to rejected' : 'Move to accepted') + '</button>'
        + '<button class="vb" data-act="verdict" data-cid="' + r.channelId + '" data-v="">Back to queue</button></div></div>'
      ).join('')
      : '<div class="meta" style="padding:24px;text-align:center">Nothing here yet.</div>';
  }
  el.innerHTML = '<div class="panel" style="margin-top:16px">' + body + '</div>';
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  const act = b.dataset.act;
  if (act === 'startlist') {
    const name = ($('newlist').value || $('lpick')?.value || '').trim();
    if (!name) return;
    if (!lists[name]) lists[name] = { game: lastGame, verdicts: {}, channels: {} };
    activeList = name; triageTab = 'queue'; qi = 0; saveLists(); renderLists();
  } else if (act === 'verdict') {
    verdict(activeList, b.dataset.cid, b.dataset.v || null);
  } else if (act === 'tab') {
    triageTab = b.dataset.v; renderLists();
  } else if (act === 'mode') {
    triageMode = triageMode === 'detailed' ? 'compact' : 'detailed'; renderLists();
  } else if (act === 'closelist') {
    activeList = null; renderLists();
  } else if (act === 'openlist') {
    activeList = b.dataset.n; triageTab = 'queue'; qi = 0; openMenu = null; renderLists();
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

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'navlistname') {
    const name = e.target.value.trim();
    if (!name) return;
    if (!lists[name]) lists[name] = { game: lastGame || 'General', verdicts: {}, channels: {} };
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

let notesPollTimer = null;
async function pollNotes(id) {
  lastResults.forEach(r => { r.aiPending = true; });
  renderLists();
  clearTimeout(notesPollTimer);
  const tick = async () => {
    try {
      const j = await fetch('/api/notes?id=' + id).then(r => r.json());
      if (j.done) {
        lastResults.forEach(r => {
          r.aiPending = false;
          if (j.notes && j.notes[r.channelId]) r.notes = [j.notes[r.channelId]];
        });
        renderLists();
        return;
      }
    } catch {}
    notesPollTimer = setTimeout(tick, 2500);
  };
  tick();
}
</script>
</body>
</html>`;

const list = (s) => (s || '').split(',').map((t) => t.trim()).filter(Boolean);
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
      results = results.slice(0, b.top || 30);
      // Optional AI-written notes — runs in background so the table renders instantly.
      let notesId = null;
      if (b.ainotes && process.env.GEMINI_API_KEY && results.length) {
        notesId = crypto.randomUUID();
        notesJobs.set(notesId, { done: false, notes: {} });
        aiNotesBatch(process.env.GEMINI_API_KEY, results)
          .then((notes) => {
            const map = {};
            results.forEach((r, i) => { if (notes[i]) map[r.channelId] = notes[i]; });
            notesJobs.set(notesId, { done: true, notes: map });
          })
          .catch((e) => {
            console.error('AI notes failed:', e.message);
            notesJobs.set(notesId, { done: true, notes: {}, error: e.message });
          });
        setTimeout(() => notesJobs.delete(notesId), 10 * 60 * 1000);
      }
      return json(200, { game: fp.name, queries: queries.length, channelCount, results, notesId });
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
    if (req.method === 'GET' && url.pathname === '/api/notes') {
      const job = notesJobs.get(url.searchParams.get('id'));
      return json(200, job || { done: true, notes: {} });
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
