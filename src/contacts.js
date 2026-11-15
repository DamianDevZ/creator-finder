// Contact extraction — no About-page scraping (ToS-gray + CAPTCHA). We pull
// emails and socials from channel descriptions and video descriptions, which
// are legitimately served by the API.

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Filters out common non-contact addresses.
const EMAIL_DENY = /(noreply|no-reply|example\.com|@youtube|@google|@steam|sentry)/i;

const SOCIAL_RE = /(twitter\.com|x\.com|discord\.gg|discord\.com\/invite|twitch\.tv|instagram\.com|tiktok\.com)\/[^\s)]+/gi;

// Best-effort real-name extraction for outreach greeting ("Hi Mark" > "Hi MarkPlays42").
const NAME_RE = [
  /\b(?:my name is|name's|i am|i'm|im)\s+([A-Z][a-z]{2,15})\b/i,
  /\b(?:hi|hey|hello)[,!]?\s+(?:i am|i'm|im|it's)\s+([A-Z][a-z]{2,15})\b/i,
  /\b(?:call me)\s+([A-Z][a-z]{2,15})\b/i,
];
const NAME_DENY = new Set([
  'Welcome','Subscribe','Today','This','Here','Just','Also','Sorry','Thanks','Hello','There','Check','Follow','Support','The','Your','Game','Video','Channel','New','Back','Live','Now','First','Best','Top','Get','Make','Want','Love','Hope','Sure','Free','Full','Official','Business','Contact','Email','Discord','Twitter','Twitch','Patreon','Sponsored','One','Still','Not','Really','Very','So','More','Most','Even','Only','Already','Again','Out','All',
  // Verbs/gerunds that follow "I am" — never names.
  'Playing','Watching','Reading','Doing','Going','Trying','Making','Taking','Giving','Getting','Bringing','Checking','Reacting','Reviewing','Unboxing','Streaming','Gaming','Recording','Editing','Uploading','Testing','Ranking','Opening','Building','Exploring','Surviving','Cooking','Showing','Covering','Looking','Running','Starting','Finishing','Posting','Sharing','Learning','Talking','Walking','Sitting','Working','Living','Feeling','Hoping','Waiting','Using','Buying','Selling','Having','Being','Coming','Leaving','Putting','Picking','Choosing','Finding','Winning','Losing','Fighting','Grinding','Farming','Crafting','Looting','Raiding','Questing','Leveling','Solving','Fixing','Breaking','Driving','Flying','Swimming','Digging','Mining','Fishing','Hunting','Trapping','Trading','Visiting','Spending','Saving','Collecting','Completing','Beating','Beating','Mastering','Practicing','Training','Coaching','Teaching','Studying','Reading','Writing','Drawing','Painting','Singing','Dancing','Jumping','Climbing','Falling','Crawling','Hiding','Seeking','Chasing','Escaping','Growing','Shrinking','Dying','Respawning','Speedrunning','Roleplaying','Cosplaying','Vlogging','Blogging','Podcasting','Broadcasting','Narrating','Commentating','Reviewing','Recapping','Analyzing','Comparing','Debating','Arguing','Discussing','Chatting','Hanging','Partying','Celebrating','Traveling','Touring','Visiting','Staying','Moving','Packing','Unpacking','Assembling','Disassembling','Installing','Uninstalling','Downloading','Deleting','Updating','Upgrading','Downgrading','Restarting','Shutting','Booting','Loading','Saving','Exporting','Importing','Converting','Rendering','Compiling','Debugging','Programming','Coding','Scripting','Hacking','Modding','Cheating','Exploiting','Glitching','Bugging','Crashing','Freezing','Lagging','Buffering','Muting','Blocking','Reporting','Banning','Kicking','Inviting','Hosting','Joining','Leaving','Creating','Deleting','Archiving','Backing','Restoring','Syncing','Copying','Pasting','Cutting','Dragging','Dropping','Clicking','Scrolling','Swiping','Tapping','Pinching','Zooming','Rotating','Flipping','Sliding','Typing','Texting','Calling','Messaging','Emailing','Faxing','Printing','Scanning','Photocopying','Filing','Organizing','Sorting','Arranging','Planning','Scheduling','Booking','Reserving','Canceling','Confirming','Paying','Charging','Refunding','Donating','Tipping','Investing','Saving','Borrowing','Lending','Owing','Earning','Winning','Losing','Betting','Gambling','Risking','Wagering','Playing',
]);
const EMAIL_GENERIC = /^(business|contact|info|hello|mail|collab|support|admin|team|press|inquiries|mgmt|media|yt|youtube|the)/i;

export function extractAlias(texts, emails = []) {
  for (const text of texts) {
    if (!text) continue;
    for (const re of NAME_RE) {
      const m = text.match(re);
      if (m) {
        const name = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
        if (!NAME_DENY.has(name)) return name;
      }
    }
  }
  // Email local-part fallback: "sasha790.sz@" -> "Sasha", "j.smith@" -> "J".
  for (const e of emails) {
    const local = e.split('@')[0];
    if (EMAIL_GENERIC.test(local)) continue;
    const token = local.split(/[._\-\d]/)[0];
    if (/^[a-z]{3,12}$/i.test(token)) return token[0].toUpperCase() + token.slice(1).toLowerCase();
  }
  return '';
}

// Classify the channel's niche and content style from descriptions/titles.
export function classifyChannel(texts) {
  const blob = texts.filter(Boolean).join('\n').toLowerCase()
    // Strip URLs — "discord.com/…" would otherwise match language stopwords.
    .replace(/https?:\/\/\S+|www\.\S+|\S+\.(com|gg|tv|io|net|org|gg|me|co)\S*/g, ' ');
  const has = (re) => re.test(blob);

  const dev = /(indie )?game dev(eloper|elopment)?|dev studio|we (make|create|develop|are making) games|game development|steam game.*(we|our) (made|built)/.test(blob)
    || /(official (game|studio) channel)/.test(blob);
  const media = /(gaming news|game news|esports|gaming magazine|game trailers? channel)/.test(blob);
  const niche = dev ? 'Dev/studio' : media ? 'Media' : 'Gaming creator';

  // Rough language detection from non-ASCII ranges + common stopwords.
  let language = null;
  if (/[а-яёіїєґ]/i.test(blob)) language = 'Russian/Ukrainian';
  else if (/[一-鿿]/.test(blob)) language = 'Chinese';
  else if (/[぀-ヿ]/.test(blob)) language = 'Japanese';
  else if (/[가-힯]/.test(blob)) language = 'Korean';
  else if (/\b(le|la|les|des|une|pour|avec|dans|sur|est|jeu|joue|chaîne)\b/.test(blob)) language = 'French';
  else if (/\b(el|la|los|las|una|para|con|juego|jugar|canal|vídeo|gracias)\b/.test(blob)) language = 'Spanish';
  else if (/\b(o|os|uma|para|com|jogo|jogar|canal|obrigado|você)\b/.test(blob)) language = 'Portuguese';
  else if (/\b(der|die|das|und|mit|für|ich|spiel|kanal|und|nicht)\b/.test(blob)) language = 'German';

  const styles = [];
  if (has(/no[\s-]?commentary/)) styles.push('No-commentary');
  if (has(/walkthrough|longplay|full playthrough|100%/)) styles.push('Walkthroughs');
  if (has(/let'?s play|first look|first impressions|first time playing/)) styles.push("Let's plays");
  if (has(/\breview|reviewed|is it worth/)) styles.push('Reviews');
  if (has(/speedrun/)) styles.push('Speedruns');
  if (has(/funny|meme|montage|highlights|fails|comedy/)) styles.push('Comedy/montage');
  if (has(/tutorial|guide|how to|tips and|tips &|build guide|beginner/)) styles.push('Guides');
  if (has(/co-?op|multiplayer|with friends|with my (friends|wife|husband|girlfriend|boyfriend)/)) styles.push('Co-op/group');
  if (has(/challenge|hard mode|only \w+ run|no damage/)) styles.push('Challenge runs');
  return { niche, styles: styles.slice(0, 3), language };
}

export function extractContacts(texts) {
  const emails = new Set();
  const socials = new Set();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(EMAIL_RE)) {
      if (!EMAIL_DENY.test(m[0])) emails.add(m[0].toLowerCase());
    }
    for (const m of text.matchAll(SOCIAL_RE)) socials.add(m[0]);
  }
  return { emails: [...emails], socials: [...socials].slice(0, 8) };
}
