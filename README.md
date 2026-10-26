# 12 Ordinary Gentlemen Hall of Fame

A fantasy football Hall of Fame for the 12 Ordinary Gentlemen Sleeper league. It's a static site with no build step and no server.

- **Live data:** every visit pulls standings, matchups and playoff brackets from Sleeper's public API, following the `previous_league_id` chain back to 2023. Finished seasons are cached in the browser. The current season refreshes every 5 minutes while the page is open, plus whenever someone presses **Refresh**.
- **Player names:** these come from `players.json`, a trimmed copy of Sleeper's player database. A GitHub Action refreshes it every Tuesday. To refresh it by hand, run `node scripts/update-players.mjs`.

## Features

- **Champions, records and history:** champions, the current season race with a live scoreboard, all-time standings, the record book, season pages, head-to-head records, manager profiles and awards.
- **The Gentlemen's Gazette:** a recap of every finished week, generated in the browser once Sleeper marks the week final. Each issue has its own link, like `#week-2026-6`.
- **Draft grades:** each team's grade is fixed right after the draft, based on an ADP (average draft position) snapshot in `drafts/<season>.json`. The *Snapshot draft ADP* workflow checks daily and saves a snapshot when a new draft finishes. The snapshots come from an unofficial Sleeper endpoint, which Sleeper could change without notice.
- **Trade history:** every trade, scored by the starting-lineup points each side's new players scored for them afterward. Traded picks count the player drafted with them. Trades undone within a day are marked reversed and left out of the records.
- **Sign in:** members enter their Sleeper username to personalize the page. It's remembered on that device, and no password is involved; all of the league's data is already public on Sleeper.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout and styles |
| `app.js` | Fetches league history from Sleeper, computes records and renders every section |
| `players.json` | Player ID → name and position |
| `scripts/update-players.mjs` | Rebuilds `players.json` |
| `drafts/<season>.json` | Draft-day ADP snapshots that fix each season's grades |
| `scripts/snapshot-draft-adp.mjs` | Saves a snapshot for any finished draft that doesn't have one yet |

## Run locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. The page has to be served over HTTP; opening `index.html` directly as a file won't work.

## Changing leagues

Set `LEAGUE_ID` at the top of `app.js` to the newest season's league ID.
