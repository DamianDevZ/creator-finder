// Steam metadata: appid parsing, appdetails, SteamSpy tags + similar games.

export function parseAppId(input) {
  // Accepts: full store URL, short URL, or bare appid
  const urlMatch = input.match(/store\.steampowered\.com\/app\/(\d+)/i);
  if (urlMatch) return urlMatch[1];
  const shortMatch = input.match(/steam\.community\/linkfilter|s\.team|store\.steampowered\.com\/.*[?&]appids?=(\d+)/i);
  if (shortMatch) return shortMatch[1];
  const bare = input.match(/^\d{2,8}$/);
  if (bare) return bare[0];
  return null;
}

// Steam's own "More Like This" recommendations — scraped from the rendered
// page, which also embeds each game's real capsule image URL.
export async function fetchMoreLikeThis(appid, limit = 10) {
  const res = await fetch(`https://store.steampowered.com/recommended/morelike/app/${appid}`, {
    headers: { Cookie: 'birthtime=568022401; mature_content=1' },
  });
  if (!res.ok) return [];
  const html = await res.text();
  const out = [];
  // Each recommendation block has data-ds-appid, a capsule img, and an /app/slug link.
  const blocks = html.split('data-ds-appid="').slice(1);
  for (const b of blocks) {
    const id = b.match(/^(\d+)/)?.[1];
    if (!id || id === String(appid) || out.some((g) => g.appid === id)) continue;
    const img = b.match(/(https:\/\/shared\.[^"\\]*capsule_231x87[^"\\]*)/)?.[1]
      || b.match(/(https:\/\/[^"\\]*capsule[^"\\]*)/)?.[1];
    const slug = b.match(/store\.steampowered\.com\/app\/\d+\/([^/"?]+)\//)?.[1];
    const name = slug ? decodeURIComponent(slug).replace(/_/g, ' ') : null;
    if (name) out.push({ appid: id, name, img });
    if (out.length >= limit) break;
  }
  return out;
}

// Unreleased/small games often lack SteamSpy tags but still have tags on the
// store page itself. Scrape them from the page HTML (class="glance_tags").
export async function fetchStorePageMeta(appid) {
  const res = await fetch(`https://store.steampowered.com/app/${appid}/?l=english&agecheck=1`, {
    headers: { Cookie: 'birthtime=568022401; mature_content=1' },
  });
  if (!res.ok) return { tags: [], image: null };
  const html = await res.text();
  const tags = [...new Set([...html.matchAll(/class="app_tag"[^>]*>\s*([^<]+?)\s*<\/a>/g)].map((m) => m[1].trim()))];
  const image = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1] || null;
  return { tags, image };
}

export async function fetchAppDetails(appid) {
  const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&filters=basic,genres,categories,developers,publishers,release_date`);
  if (!res.ok) throw new Error(`appdetails HTTP ${res.status}`);
  const json = await res.json();
  const entry = json?.[appid];
  if (!entry?.success || !entry.data) throw new Error(`No Steam data for appid ${appid}`);
  const d = entry.data;
  return {
    appid,
    name: d.name,
    type: d.type,
    genres: (d.genres || []).map((g) => g.description),
    categories: (d.categories || []).map((c) => c.description),
    developers: d.developers || [],
    publishers: d.publishers || [],
    releaseDate: d.release_date?.date || null,
  };
}

export async function fetchSteamSpy(appid) {
  const res = await fetch(`https://steamspy.com/api.php?request=appdetails&appid=${appid}`);
  if (!res.ok) throw new Error(`steamspy HTTP ${res.status}`);
  const j = await res.json();
  return {
    tags: Object.keys(j.tags || {}),
    owners: j.owners || null,
    positive: j.positive ?? null,
    negative: j.negative ?? null,
    price: j.price ?? null,
  };
}

// Tags too broad to identify a game's niche — excluded from similarity queries.
const GENERIC_TAGS = new Set([
  'indie', 'singleplayer', 'multiplayer', 'casual', '2d', '3d', 'great soundtrack',
  'early access', 'free to play', 'action', 'adventure', 'rpg', 'simulation',
  'strategy', 'sports', 'racing', 'story rich', 'funny', 'colorful', 'atmospheric',
  'open world', 'co-op', 'controller', 'family friendly', 'difficult', 'replay value',
]);

// Similar games via tag overlap: games that appear under MULTIPLE of our
// specific tags are real neighbors. Returns them ranked by overlap count.
export async function fetchSimilarGames(appid, tags, limit = 8) {
  const specificTags = (tags || []).filter((t) => !GENERIC_TAGS.has(t.toLowerCase())).slice(0, 6);
  const scores = new Map(); // appid -> {name, overlap, weight, owners}
  const TOP_PER_TAG = 60; // only the canonical examples of each tag
  await Promise.all(
    specificTags.map(async (tag, tagIdx) => {
      const res = await fetch(`https://steamspy.com/api.php?request=tag&tag=${encodeURIComponent(tag)}`);
      if (!res.ok) return;
      const j = await res.json();
      // Tags earlier in the list matter more (Steam orders by votes).
      const tagWeight = 1 - tagIdx * 0.12;
      Object.values(j).slice(0, TOP_PER_TAG).forEach((g, rank) => {
        if (String(g.appid) === String(appid)) return;
        const e = scores.get(g.appid) || { name: g.name, owners: g.owners, overlap: 0, weight: 0 };
        e.overlap += 1;
        e.weight += tagWeight * (1 - rank / TOP_PER_TAG);
        scores.set(g.appid, e);
      });
    })
  );
  return [...scores.entries()]
    .map(([id, e]) => ({ appid: id, ...e }))
    // Blend = must appear under at least 2 of our tags; then rank by weighted position.
    .filter((e) => e.overlap >= 2 || specificTags.length < 3)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, limit);
}

// Rolling expansion frontier: for each base game, find its best not-yet-used
// neighbor ranked by shared-tag count (base game's tags + our tags), min 3.
// Each call returns up to one pick per base — call again for the next round.
export async function expandFrontier(bases, usedNames, ourTags, neighbors = 20) {
  const used = new Set(usedNames.map((n) => n.toLowerCase()));
  const specific = (ts) => ts.filter((t) => !GENERIC_TAGS.has(t.toLowerCase())).map((t) => t.toLowerCase());
  const our = new Set(specific(ourTags));
  const rankedLists = await Promise.all(
    bases.map(async (base) => {
      if (!base.appid) return [];
      const [mlt, baseSpy] = await Promise.all([
        fetchMoreLikeThis(base.appid, neighbors).catch(() => []),
        fetchSteamSpy(base.appid).catch(() => null),
      ]);
      let baseTags = baseSpy?.tags || [];
      if (!baseTags.length) baseTags = (await fetchStorePageMeta(base.appid).catch(() => ({ tags: [] }))).tags;
      const target = new Set([...our, ...specific(baseTags)]);
      const scored = await Promise.all(
        mlt.map(async (c) => {
          if (used.has(c.name.toLowerCase())) return null;
          // SteamSpy has no tags for tiny games — fall back to store-page tags.
          let tags = (await fetchSteamSpy(c.appid).catch(() => null))?.tags || [];
          if (!tags.length) tags = (await fetchStorePageMeta(c.appid).catch(() => ({ tags: [] }))).tags;
          if (!tags.length) return null;
          const overlap = specific(tags).filter((t) => target.has(t)).length;
          return overlap >= 3 ? { appid: c.appid, name: c.name, overlap } : null;
        })
      );
      return scored.filter(Boolean).sort((a, b) => b.overlap - a.overlap);
    })
  );
  const seen = new Set();
  return rankedLists
    .map((list) => list.find((c) => !seen.has(c.name.toLowerCase()) && seen.add(c.name.toLowerCase())))
    .filter(Boolean);
}

// A game's top defining tags: SteamSpy first (vote-ordered), store page for
// tiny untagged games. Generic tags (3D, singleplayer…) are filtered out.
async function topTagsFor(appid, n = 4) {
  let tags = (await fetchSteamSpy(appid).catch(() => null))?.tags || [];
  if (!tags.length) tags = (await fetchStorePageMeta(appid).catch(() => ({ tags: [] }))).tags;
  return tags.filter((t) => !GENERIC_TAGS.has(t.toLowerCase())).slice(0, n);
}

// Other titles by the same developer/publisher — handy context for users.
async function fetchRelatedByCreator(name, excludeAppid) {
  if (!name) return [];
  const res = await fetch(
    `https://store.steampowered.com/search/results/?query&start=0&count=20&developer=${encodeURIComponent(name)}&json=1`
  );
  if (!res.ok) return [];
  const j = await res.json();
  return (j.items || [])
    .map((it) => ({
      appid: (it.logo || '').match(/apps\/(\d+)/)?.[1],
      name: it.name,
      img: it.logo || null,
    }))
    .filter((g) => g.appid && g.appid !== String(excludeAppid));
}

export async function buildFingerprint(input, { manualTags = [] } = {}) {
  const appid = parseAppId(input);
  if (!appid) throw new Error(`Could not parse a Steam appid from: ${input}`);
  const [details, spy, page] = await Promise.all([fetchAppDetails(appid), fetchSteamSpy(appid), fetchStorePageMeta(appid)]);
  // Tag priority: manual hint > SteamSpy > store page scrape > genres
  let tags = manualTags.length ? manualTags : spy.tags;
  if (!tags.length) tags = page.tags;
  if (!tags.length) tags = details.genres;
  // Similarity priority: Steam's own More-Like-This > tag overlap
  let similar = await fetchMoreLikeThis(appid);
  if (similar.length < 12) {
    // Top up to 12 with tag-overlap neighbors so the panel is always full.
    const tagSims = await fetchSimilarGames(appid, tags, 12);
    const seen = new Set(similar.map((g) => String(g.appid)));
    similar = [...similar, ...tagSims.filter((g) => !seen.has(String(g.appid)))];
  }
  similar = similar.slice(0, 12);
  // Each base game's defining tags — shown on its card and used by expansion.
  await Promise.all(similar.map(async (g) => { g.topTags = await topTagsFor(g.appid); }));
  const dev = details.developers[0], pub = details.publishers[0];
  const [devGames, pubGames] = await Promise.all([
    fetchRelatedByCreator(dev, appid),
    pub && pub !== dev ? fetchRelatedByCreator(pub, appid) : [],
  ]);
  await Promise.all([...devGames, ...pubGames].map(async (g) => { g.topTags = await topTagsFor(g.appid); }));
  return {
    ...details,
    tags,
    topTags: tags.filter((t) => !GENERIC_TAGS.has(t.toLowerCase())).slice(0, 4),
    owners: spy.owners,
    reviewScore:
      spy.positive != null && spy.negative != null && spy.positive + spy.negative > 0
        ? Math.round((spy.positive / (spy.positive + spy.negative)) * 100)
        : null,
    similarGames: similar,
    relatedByDeveloper: devGames,
    relatedByPublisher: pubGames,
    headerImage: page.image,
  };
}
