# praze-website

PRAZE brand site + personal second brain. Plain HTML/CSS/JS — no build step, deploys as static files.

## Pages

- `index.html` — public PRAZE landing page
- `brain.html` — private second brain: an Obsidian-like app with browser-style tabs

## Second brain

Five tabs, routed by URL hash so browser back/forward walk between them:

- **IDEAS** (`#ideas`) — capture notes with tags, full-text search (`/` to focus), `[[wiki-links]]` with backlinks, pins, draft autosave. Once you have 5+ notes, a built-in similarity engine (TF-IDF, fully offline) auto-links related ideas as **Related** chips and suggests tags your similar notes share.
- **DIARY** (`#diary`) — one honest paragraph a day. Entries are grouped by day, mood is detected from your words (good / rough / neutral, plus an "active" marker on training days), and the diary streak keeps you showing up.
- **CLIPS** (`#clips`) — save videos from social media: paste a link, note why it matters. Platform is auto-detected (Instagram / TikTok / YouTube badges, YouTube thumbnails).
- **GOALS** (`#goals`) — automatic day-streak flames for ideas and diary (current + best ever), plus settable goals with progress bars. Hitting 100% throws lime confetti and moves the goal to the permanent WINS list.
- **GRAPH** (`#graph`) — the web of your brain: every note is a node, solid lines are `[[wiki-links]]`, dashed lines are auto-detected similarity. Drag nodes, click one to jump to it.

### AI (optional)

The similarity auto-linking works offline with no setup. For real AI, open Settings (⚙) and paste your own Anthropic API key:

- **AI tags** on any idea — Claude suggests 1–3 tags, preferring your existing vocabulary
- **AI reflect** on any diary entry — 2–3 themes plus one grounded observation

The key is stored only in this browser (`praze.brain.apikey`), never included in exports, and requests go directly from your browser to Claude — there is no server in between. Keys are at [console.anthropic.com](https://console.anthropic.com/).

### Data

- All data lives in **this browser's localStorage** (key `praze.brain.v1`). No account, no server, no sync.
- **Export regularly** (IDEAS tab → Export) — the JSON file is your only backup and also moves data between devices. Import merges by id, never duplicates.
- The page is unlinked from the landing page and noindexed — bookmark `/brain.html` directly.
- Keyboard: `/` search, `Esc` clear/cancel, `Ctrl/Cmd+Enter` save.

## Run locally

```
python3 -m http.server 8000
# http://localhost:8000/          — landing page
# http://localhost:8000/brain.html — second brain
```
