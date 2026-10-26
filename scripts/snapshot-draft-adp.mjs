// Saves Sleeper's ADP for every completed draft that doesn't have a snapshot yet, as drafts/<season>.json.
// Draft grades are computed from these files, so a grade is fixed once the draft is done.
// Run with: node scripts/snapshot-draft-adp.mjs
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";

const LEAGUE_ID = "1378479378115072000";
const get = async (url) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return r.json();
};

const dir = new URL("../drafts/", import.meta.url);
await mkdir(dir, { recursive: true });

let lid = LEAGUE_ID;
while (lid && lid !== "0") {
  const league = await get(`https://api.sleeper.app/v1/league/${lid}`);
  const rec = (league.scoring_settings || {}).rec;
  const key = rec === 1 ? "adp_ppr" : rec === 0.5 ? "adp_half_ppr" : "adp_std";
  for (const d of await get(`https://api.sleeper.app/v1/league/${lid}/drafts`)) {
    const file = new URL(`${d.season}.json`, dir);
    if (d.status !== "complete" || existsSync(file)) continue;
    const picks = await get(`https://api.sleeper.app/v1/draft/${d.draft_id}/picks`);
    // Unofficial Sleeper endpoint; it can change without notice.
    const qs = ["QB", "RB", "WR", "TE", "K", "DEF"].map((p) => `position[]=${p}`).join("&");
    const proj = await get(`https://api.sleeper.app/projections/nfl/${d.season}?season_type=regular&${qs}`);
    const byId = Object.fromEntries(proj.map((p) => [p.player_id, (p.stats || {})[key]]));
    const adp = {};
    for (const p of picks) if (byId[p.player_id] != null) adp[p.player_id] = byId[p.player_id];
    await writeFile(file, JSON.stringify({ season: d.season, draft_id: d.draft_id, scoring: key, taken_at: new Date().toISOString(), adp }, null, 1));
    console.log(`drafts/${d.season}.json: ADP for ${Object.keys(adp).length} of ${picks.length} picks`);
  }
  lid = league.previous_league_id;
}
