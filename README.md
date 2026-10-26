# 12 Ordinary Gentlemen Hall of Fame

A fantasy football Hall of Fame for the 12 Ordinary Gentlemen Sleeper league. It's a static site with no build step and no server.

- **Live data:** every visit pulls standings, matchups and playoff brackets from Sleeper's public API, following the `previous_league_id` chain back to 2023. Finished seasons are cached in the browser. The current season refreshes every 5 minutes while the page is open, plus whenever someone presses **Refresh**.
- **Player names:** these come from `players.json`, a trimmed copy of Sleeper's player database. A GitHub Action refreshes it every Tuesday. To refresh it by hand, run `node scripts/update-players.mjs`.

## Files

| File | What it does |
| --- | --- |
| `index.html` | Page layout and styles |
| `app.js` | Fetches league history from Sleeper, computes records and renders every section |
| `players.json` | Player ID → name and position |
| `scripts/update-players.mjs` | Rebuilds `players.json` |

## Run locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000. The page has to be served over HTTP; opening `index.html` directly as a file won't work.

## Changing leagues

Set `LEAGUE_ID` at the top of `app.js` to the newest season's league ID.
