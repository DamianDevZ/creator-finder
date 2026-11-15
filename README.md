# Creator Finder

A tool for indie game developers to discover YouTube creators who cover games
similar to theirs — for outreach and marketing.

## How it works

1. Paste a Steam game URL or search by name.
2. The tool builds a fingerprint: tags, genres, and similar games (via Steam's
   own "More Like This" recommendations).
3. It searches YouTube for videos covering those games (`search.list`), then
   retrieves channel stats, recent uploads, and contact info (`channels.list`,
   `videos.list`, `playlistItems.list`).
4. Creators are ranked by topic fit, reach, engagement, and upload recency.

## Setup

```bash
npm install
cp .env.example .env   # add your YouTube Data API key
npm start              # web UI at http://localhost:3456
```

CLI also available:

```bash
node cli.js find <steam-link-or-appid> --similar "Overcooked 2, PlateUp" --top 30
```

## API usage

Read-only calls against the YouTube Data API v3. Search results are cached
24h, channel data 7 days, video stats 30 days, to minimize quota usage.
Optionally uses the Gemini API for AI-generated channel notes.
