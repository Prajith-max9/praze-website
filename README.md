# praze-website

PRAZE brand site + personal second brain. Plain HTML/CSS/JS — no build step, deploys as static files.

## Pages

- `index.html` — public PRAZE landing page
- `brain.html` — private second brain: an Obsidian-like app with browser-style tabs

## Second brain

Tabs routed by URL hash, so browser back/forward walk between them:

- **IDEAS** (`#ideas`) — capture notes with tags, full-text search (`/` to focus), `[[wiki-links]]` with backlinks, pins, draft autosave. Once you have 5+ notes, a built-in similarity engine (TF-IDF, fully offline) auto-links related ideas as **Related** chips and suggests tags your similar notes share.
- **DIARY** (`#diary`) — one honest paragraph a day. Entries are grouped by day, mood is detected from your words (good / rough / neutral, plus an "active" marker on training days), and the diary streak keeps you showing up. A 🎤 **Dictate** button (Chrome/Edge/Safari) speaks your entry into the box, appending to whatever you've typed. Note: browser speech recognition sends audio to the browser vendor's servers, so **dictation needs an internet connection** even though the rest of the app is fully offline; on browsers without speech support (e.g. Firefox) the button simply doesn't appear. With an API key set, **DIGEST THIS WEEK** reads your last 7 days of entries and returns one pattern, one tension, and one question (shown, never stored).
- **CLIPS** (`#clips`) — save videos from social media: paste a link, note why it matters. Platform is auto-detected (Instagram / TikTok / YouTube badges, YouTube thumbnails).
- **GOALS** (`#goals`) — automatic day-streak flames for ideas and diary (current + best ever), plus settable goals with progress bars. Hitting 100% throws lime confetti and moves the goal to the permanent WINS list.
- **TODO** (`#todos`) — a flat, fast checklist, deliberately separate from GOALS (which tracks a number climbing to a target). Type a task, hit ADD. Ticking one off moves it to a collapsed **DONE** section rather than deleting it; Delete removes it outright with an Undo toast. No sub-tasks, no priorities, no AI — it's for capture, not project management. Optionally give a task a due date/time; see **Reminders** below for what that can and can't do.
- **GRAPH** (`#graph`) — the web of your brain: every note is a node, solid lines are `[[wiki-links]]`, dashed lines are auto-detected similarity. Drag nodes, click one to jump to it.

The **HOME** dashboard also surfaces two offline insight cards: **RESURFACED** (a forgotten note from 30+ days ago that matches what you're writing about now — dismissible, click to open) and **ECHOES** (a term you've touched in 3+ notes this week, with a LINK THESE button that tags the matches so they're connected for good).

### Reminders — read this before relying on them

A todo's due time can raise a browser notification, but there is **no server here, so there is no push**. The reminder is a timer inside the page: it fires while the app is open or freshly backgrounded, and stops being dependable once the browser or OS suspends the tab. On mobile PWAs — iOS Safari especially — a fully closed app gets no timer at all, so nothing will fire.

Treat it as a nudge, not an alarm. If you miss one, the app catches up on the next open: a reminder that came due within the last five minutes still pops, and anything older is marked missed and shown in red as **overdue** rather than dumping a stack of popups on you.

Permission is requested once, the first time you set a due time, and never again — decline it and every todo still works as a plain checklist with its due time visible in the list.

### AI (optional)

The similarity auto-linking works offline with no setup. For real AI, open Settings (⚙) and paste your own Anthropic API key:

- **AI tags** on any idea — Claude suggests 1–3 tags, preferring your existing vocabulary
- **AI reflect** on any diary entry — 2–3 themes plus one grounded observation

The key is stored only in this browser (`praze.brain.apikey`), never included in exports, and requests go directly from your browser to Claude — there is no server in between. Keys are at [console.anthropic.com](https://console.anthropic.com/).

### Data

- All data lives in **this browser's localStorage** (key `praze.brain.v1`). No account, no server, no sync.
- **Export regularly** (IDEAS tab → Export) — the JSON file is your only backup and also moves data between devices. Notes, goals and todos are all included; import merges by id, never duplicates. Older backups made before todos existed import fine and leave your list alone.
- The page is unlinked from the landing page and noindexed — bookmark `/brain.html` directly.
- Keyboard: `/` search, `Esc` clear/cancel, `Ctrl/Cmd+Enter` save.

## Run locally

```
python3 -m http.server 8000
# http://localhost:8000/          — landing page
# http://localhost:8000/brain.html — second brain
```
