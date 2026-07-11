# praze-website

PRAZE brand site + personal second brain. Plain HTML/CSS/JS — no build step, deploys as static files.

## Pages

- `index.html` — public PRAZE landing page
- `brain.html` — private second brain: capture notes, tag them, full-text search, `[[wiki-links]]`

## Second brain notes

- The page is **unlinked and noindexed** — bookmark `/brain.html` directly.
- Write `[[Note Title]]` in any note body to link to the note with that title (case-insensitive). Linked notes show a "Linked from" row of backlinks. A `[[link]]` to a title that doesn't exist yet is a click-to-create affordance — it prefills the capture form.
- **Pin** keeps a note at the top of the list. **Quick add** chips under the tags field toggle your existing tags without retyping. A half-typed note is autosaved as a draft and restored after a refresh.
- Keyboard: `/` focuses search, `Esc` clears it (or cancels an inline edit), `Ctrl/Cmd+Enter` saves a capture or an edit.
- All notes live in **this browser's localStorage** (key `praze.brain.v1`). Nothing is sent to any server, and there is no account or sync — a visitor who opens the URL sees an empty app, never your notes.
- That also means: clearing browser data deletes everything, and notes don't follow you across devices. **Export regularly** (Export button → JSON file) and use Import to restore or move to another device. Import merges by note id, so importing the same file twice never duplicates.

## Run locally

```
python3 -m http.server 8000
# http://localhost:8000/          — landing page
# http://localhost:8000/brain.html — second brain
```
