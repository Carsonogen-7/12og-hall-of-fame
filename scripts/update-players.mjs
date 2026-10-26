// Rebuilds players.json: a small id -> [name, position] map cut from Sleeper's ~15 MB player database.
// Run with: node scripts/update-players.mjs
import { writeFile } from "node:fs/promises";

const res = await fetch("https://api.sleeper.app/v1/players/nfl");
if (!res.ok) throw new Error(`Sleeper returned ${res.status}`);
const all = await res.json();

const KEEP = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);
const out = {};
for (const [id, p] of Object.entries(all)) {
  // Two-way players (e.g. a DB who also plays WR) count under their fantasy position.
  const pos = KEEP.has(p.position) ? p.position : (p.fantasy_positions || []).find((x) => KEEP.has(x));
  if (!pos) continue;
  const name = pos === "DEF" ? `${p.first_name} ${p.last_name} D/ST` : p.full_name || `${p.first_name} ${p.last_name}`;
  out[id] = [name, pos];
}
await writeFile(new URL("../players.json", import.meta.url), JSON.stringify(out));
console.log(`players.json: ${Object.keys(out).length} players`);
