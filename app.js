// 12 Ordinary Gentlemen Hall of Fame: pulls the league's full history from Sleeper's public API in the browser.
const LEAGUE_ID = "1378479378115072000";
const API = "https://api.sleeper.app/v1/";
const CACHE = "hof:v2:";
const REFRESH_MS = 5 * 60 * 1000;
const LIVE_REFRESH_MS = 60 * 1000;

const $ = (s) => document.querySelector(s);
let current = null;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(CACHE + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(CACHE + k, JSON.stringify(v)); } catch { /* storage full or blocked */ } },
};

async function get(path) {
  const r = await fetch(API + path, { cache: "no-store" });
  if (!r.ok) throw new Error(`Sleeper returned ${r.status} for ${path}`);
  return r.json();
}

async function fetchSeason(lid) {
  const league = await get(`league/${lid}`);
  const done = league.status === "complete";
  const st = league.settings || {};
  // In-season: every scored week plus the week being played now.
  const last = done ? 18 : Math.max(st.last_scored_leg || 0, st.leg || 0);
  const weeks = Array.from({ length: last }, (_, i) => i + 1);
  const [users, rosters, winners, losers, draftList, ...rest] = await Promise.all([
    get(`league/${lid}/users`), get(`league/${lid}/rosters`),
    get(`league/${lid}/winners_bracket`), get(`league/${lid}/losers_bracket`), get(`league/${lid}/drafts`),
    ...weeks.map((w) => get(`league/${lid}/matchups/${w}`)),
    ...weeks.map((w) => get(`league/${lid}/transactions/${w}`)),
  ]);
  const mus = rest.slice(0, weeks.length), txs = rest.slice(weeks.length);
  const matchups = {};
  weeks.forEach((w, i) => { if (mus[i] && mus[i].length) matchups[w] = mus[i]; });
  const trades = txs.flat().filter((t) => t && t.type === "trade" && t.status === "complete")
    .map((t) => ({ id: t.transaction_id, leg: t.leg, created: t.created, roster_ids: t.roster_ids, adds: t.adds || {}, draft_picks: t.draft_picks || [], waiver_budget: t.waiver_budget || [] }));
  const drafts = await Promise.all((draftList || []).filter((d) => d.status === "complete").map(async (d) => {
    const [draft, picks] = await Promise.all([get(`draft/${d.draft_id}`), get(`draft/${d.draft_id}/picks`)]);
    return {
      id: d.draft_id, season: d.season, start: draft.start_time, slots: draft.slot_to_roster_id || {}, rounds: (draft.settings || {}).rounds,
      picks: picks.map((p) => ({ no: p.pick_no, round: p.round, slot: p.draft_slot, rid: p.roster_id, by: p.picked_by, pid: p.player_id, keeper: !!p.is_keeper,
        name: `${(p.metadata || {}).first_name || ""} ${(p.metadata || {}).last_name || ""}`.trim(), pos: (p.metadata || {}).position || "" })),
    };
  }));
  return { league, users, rosters, winners: winners || [], losers: losers || [], matchups, trades, drafts };
}

// Walks back through previous_league_id. Finished seasons never change, so they are cached.
async function fetchHistory(force) {
  const out = [];
  let lid = LEAGUE_ID;
  while (lid && lid !== "0") {
    let s = force ? null : store.get("season:" + lid);
    if (!s || s.league.status !== "complete") {
      s = await fetchSeason(lid);
      if (s.league.status === "complete") store.set("season:" + lid, s);
    }
    out.push(s);
    lid = s.league.previous_league_id;
  }
  return out;
}

// Draft-day ADP snapshots, saved once per draft by the GitHub Action so grades never drift.
async function fetchSnapshots(years) {
  const out = {};
  await Promise.all(years.map(async (y) => {
    try { const r = await fetch(`drafts/${y}.json`); if (r.ok) out[y] = await r.json(); } catch { /* no snapshot yet */ }
  }));
  return out;
}

async function fetchPlayers() {
  try {
    const r = await fetch("players.json");
    return r.ok ? await r.json() : {};
  } catch { return {}; }
}

// Best possible lineup from everyone on the roster that week, for "points left on the bench".
const FLEX = { FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"] };
function optimal(entry, slots, P) {
  const pool = Object.entries(entry.players_points || {})
    .map(([pid, pts]) => ({ pos: (P[pid] || [])[1] || (/^[A-Z]{2,3}$/.test(pid) ? "DEF" : ""), pts }))
    .sort((a, b) => b.pts - a.pts);
  let total = 0;
  for (const s of slots.slice().sort((a, b) => (FLEX[a] ? 1 : 0) - (FLEX[b] ? 1 : 0))) {
    const ok = FLEX[s] || [s];
    const i = pool.findIndex((p) => ok.includes(p.pos));
    if (i >= 0) { total += pool[i].pts; pool.splice(i, 1); }
  }
  return Math.max(+total.toFixed(2), entry.points || 0);
}

function compute(raw, P, snaps = {}) {
  const seasonsRaw = raw.slice().sort((a, b) => a.league.season.localeCompare(b.league.season));
  const managers = {}, seasons = [], games = [], perfs = [], weekly = [], lineups = [];
  const r2oBy = {};
  let liveWeek = null;
  for (const s of seasonsRaw) {
    const lg = s.league, yr = lg.season, st = lg.settings || {};
    const pws = st.playoff_week_start || 15;
    const done = lg.status === "complete";
    const lastScored = done ? 99 : (st.last_scored_leg || 0);
    const users = Object.fromEntries(s.users.map((u) => [u.user_id, u]));
    const r2o = Object.fromEntries(s.rosters.map((r) => [r.roster_id, r.owner_id]));
    r2oBy[yr] = r2o;
    const slots = (lg.roster_positions || []).filter((p) => !["BN", "IR", "TAXI"].includes(p));
    const teamOf = (o) => (users[o] && users[o].metadata && users[o].metadata.team_name) || (users[o] && users[o].display_name) || "Unknown team";
    for (const r of s.rosters) {
      if (!r.owner_id) continue;
      const u = users[r.owner_id] || {};
      const m = managers[r.owner_id] ||= { id: r.owner_id, seasons: [] };
      m.name = u.display_name || m.name || "Unknown";
      m.avatar = u.avatar || m.avatar;
      m.team = teamOf(r.owner_id);
      m.seasons.push(yr);
    }
    const yearGames = [];
    for (const [wk, ms] of Object.entries(s.matchups)) {
      const w = +wk;
      const by = {};
      for (const x of ms) if (x.matchup_id != null) (by[x.matchup_id] ||= []).push(x);
      if (w > lastScored) {
        if (!done && w === st.leg) {
          liveWeek = { year: yr, week: w, games: Object.values(by).filter((p) => p.length === 2)
            .map(([a, b]) => ({ a: r2o[a.roster_id], b: r2o[b.roster_id], pa: a.points || 0, pb: b.points || 0 })) };
        }
        continue;
      }
      const playoff = w >= pws;
      if (!playoff) for (const x of ms) weekly.push([yr, w, r2o[x.roster_id], x.points || 0]);
      for (const pair of Object.values(by)) {
        if (pair.length !== 2) continue;
        const [a, b] = pair;
        yearGames.push({ y: yr, w, a: r2o[a.roster_id], b: r2o[b.roster_id], pa: a.points || 0, pb: b.points || 0, k: playoff ? "po" : "reg" });
        for (const x of pair) {
          (x.starters || []).forEach((pid, i) => {
            if (pid && pid !== "0") perfs.push([yr, w, r2o[x.roster_id], pid, (x.starters_points || [])[i] || 0]);
          });
          lineups.push([yr, w, r2o[x.roster_id], x.points || 0, optimal(x, slots, P)]);
        }
      }
    }
    const standings = s.rosters.filter((r) => r.owner_id).map((r) => {
      const se = r.settings || {};
      return { o: r.owner_id, team: teamOf(r.owner_id), w: se.wins || 0, l: se.losses || 0, t: se.ties || 0,
        pf: (se.fpts || 0) + (se.fpts_decimal || 0) / 100, pa: (se.fpts_against || 0) + (se.fpts_against_decimal || 0) / 100 };
    }).sort((a, b) => b.w - a.w || b.pf - a.pf);
    standings.forEach((x, i) => { x.seed = i + 1; });
    const info = { year: yr, done, pws, teams: st.playoff_teams || 6, standings, week: done ? null : st.last_scored_leg || 0 };
    const place = (br, p) => br.find((b) => b.p === p);
    const f = place(s.winners, 1);
    if (done && f) {
      const t3 = place(s.winners, 3), t5 = place(s.winners, 5), tb = place(s.losers, 1);
      info.champ = r2o[f.w]; info.runner = r2o[f.l];
      info.third = t3 ? r2o[t3.w] : null;
      info.sacko = tb ? r2o[tb.w] : null; // this league's losers bracket is loser-advances
      info.places = {};
      [[f, 1], [t3, 3], [t5, 5]].forEach(([b, p]) => { if (b) { info.places[r2o[b.w]] = p; info.places[r2o[b.l]] = p + 1; } });
      if (info.sacko) info.places[info.sacko] = standings.length;
      info.po_teams = [...new Set(s.winners.flatMap((b) => [b.t1, b.t2]).filter((t) => typeof t === "number").map((t) => r2o[t]))];
      const rounds = {};
      for (const b of s.winners) {
        if (b.p != null && b.p !== 1) continue;
        (rounds[b.r] ||= []).push([r2o[b.t1], r2o[b.t2], r2o[b.w]]);
      }
      info.bracket = Object.keys(rounds).sort((a, b) => a - b).map((k) => rounds[k]);
      // Some seasons played the last round over two weeks; detect it from the final's result.
      const lastWk = pws + info.bracket.length - 1;
      const nxt = Object.fromEntries((s.matchups[lastWk + 1] || []).map((x) => [r2o[x.roster_id], x.points || 0]));
      const fo = new Set([r2o[f.t1], r2o[f.t2]]);
      const fg = yearGames.find((g) => g.w === lastWk && fo.has(g.a) && fo.has(g.b));
      if (fg && Object.keys(nxt).length && (fg.pa > fg.pb) !== (fg.a === r2o[f.w])) {
        info.twoWeekFinal = true;
        for (const g of yearGames) if (g.w === lastWk) {
          g.pa = +(g.pa + (nxt[g.a] || 0)).toFixed(2); g.pb = +(g.pb + (nxt[g.b] || 0)).toFixed(2); g.w2 = true;
        }
      }
      // Tag playoff games: championship bracket, final, or consolation.
      const wb = new Map();
      for (const b of s.winners) if (typeof b.t1 === "number" && typeof b.t2 === "number") wb.set([r2o[b.t1], r2o[b.t2]].sort().join("|") + "#" + b.r, b);
      for (const g of yearGames) if (g.k === "po") {
        const b = wb.get([g.a, g.b].sort().join("|") + "#" + (g.w - pws + 1));
        g.k = b && (b.p == null || b.p === 1) ? (b.p === 1 ? "final" : "po") : "cons";
      }
    } else if (done) {
      info.done = false; // finished on Sleeper but no bracket to read; show as standings only
    }
    games.push(...yearGames);
    seasons.push(info);
  }

  // Drafts: each pick credited to the manager whose roster made it.
  const drafts = [];
  for (const s of seasonsRaw) for (const d of s.drafts || []) {
    const r2o = r2oBy[d.season] || r2oBy[s.league.season];
    drafts.push({ year: d.season, id: d.id, rounds: d.rounds, slots: d.slots, snap: snaps[d.season] || null,
      picks: d.picks.map((p) => ({ ...p, o: r2o[p.rid] || p.by })).sort((a, b) => a.no - b.no) });
  }
  const draftByYear = Object.fromEntries(drafts.map((d) => [d.year, d]));

  // Trades: what each side received. Traded picks resolve to the player taken with them.
  const trades = [];
  for (const s of seasonsRaw) {
    const yr = s.league.season, r2o = r2oBy[yr];
    for (const t of s.trades || []) {
      const sides = {};
      const side = (o) => (sides[o] ||= { o, players: [], picks: [], faab: 0 });
      (t.roster_ids || []).forEach((r) => side(r2o[r]));
      for (const [pid, rid] of Object.entries(t.adds)) side(r2o[rid]).players.push(pid);
      for (const dp of t.draft_picks) {
        const d = draftByYear[dp.season];
        let pid = null;
        if (d) {
          const slot = Object.entries(d.slots || {}).find(([, rid]) => rid === dp.roster_id);
          const pk = slot && d.picks.find((p) => p.round === dp.round && p.slot === +slot[0]);
          if (pk) pid = pk.pid;
        }
        side(r2o[dp.owner_id]).picks.push({ season: dp.season, round: dp.round, orig: (r2oBy[dp.season] || r2o)[dp.roster_id], pid });
      }
      for (const wb of t.waiver_budget) side(r2o[wb.receiver]).faab += wb.amount || 0;
      trades.push({ id: t.id, y: yr, leg: t.leg, created: t.created, sides: Object.values(sides).filter((x) => x.o), adds: t.adds, picks: t.draft_picks.length });
    }
  }
  // A trade undone within a day (every player sent straight back) is marked reversed, both halves.
  trades.sort((a, b) => a.created - b.created);
  trades.forEach((t, i) => {
    const ids = Object.keys(t.adds);
    if (t.reversed || !ids.length || t.picks) return;
    const back = trades.slice(i + 1).find((u) => !u.reversed && !u.picks && u.created - t.created < 864e5 && u.y === t.y
      && Object.keys(u.adds).length === ids.length && ids.every((pid) => u.adds[pid] != null && u.adds[pid] !== t.adds[pid]));
    if (back) t.reversed = back.reversed = true;
  });
  trades.reverse();

  const pts = {}, best = {};
  for (const p of perfs) {
    const [, , o, pid, v] = p;
    ((pts[o] ||= {})[pid] = (pts[o][pid] || 0) + v);
    if (!best[o] || v > best[o][4]) best[o] = p;
  }
  const mvp = Object.fromEntries(Object.entries(pts).map(([o, m]) => [o, Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, 5)]));
  const topPerfs = perfs.slice().sort((a, b) => b[4] - a[4]).slice(0, 25);
  // Names from draft picks cover anyone missing from players.json.
  const extra = {};
  for (const d of drafts) for (const p of d.picks) if (p.name) extra[p.pid] = [p.name, p.pos];
  const players = new Proxy({}, { get: (_, pid) => P[pid] || extra[pid] || [pid, ""] });
  const curLg = seasonsRaw.at(-1).league;
  return {
    current: curLg.season, managers, seasons, games, weekly, topPerfs, bestPerf: best, mvp, players, liveWeek,
    perfs, lineups, drafts, trades,
    size: curLg.total_rosters || 12,
    scoring: (curLg.scoring_settings || {}).rec === 1 ? "PPR" : (curLg.scoring_settings || {}).rec === 0.5 ? "Half PPR" : "Standard",
    keepers: (curLg.settings || {}).max_keepers || 0,
    avatars: Object.fromEntries(Object.values(managers).filter((m) => m.avatar).map((m) => [m.id, `https://sleepercdn.com/avatars/thumbs/${m.avatar}`])),
  };
}

function render(D) {
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const f2 = (n) => n.toFixed(2);
const f1 = (n) => n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const pct = (n) => isFinite(n) ? n.toFixed(3).replace(/^0/, "") : "—";
const ord = (n) => n + (["th", "st", "nd", "rd"][(n % 100 - 20) % 10] || ["th", "st", "nd", "rd"][n % 100] || "th");
const sum = (a) => a.reduce((x, y) => x + y, 0);

const M = D.managers;
const ME = window.__me && D.managers[window.__me] ? window.__me : null;
const IDS = Object.keys(M);
const CUR = D.current;
const done = D.seasons.filter((s) => s.done);
const live = D.seasons.find((s) => !s.done);
const nm = (id) => M[id].name;
const av = (id, cls = "") => D.avatars[id] ? `<img class="av ${cls}" src="${D.avatars[id]}" alt="" loading="lazy">` : `<span class="av ${cls}"></span>`;
const who = (id, cls = "sm") => `<button class="mgr mgr-link" data-mgr="${id}">${av(id, cls)}<span class="nm">${esc(nm(id))}</span></button>`;
const tag = (g) => g.k === "final" ? " · Final" : g.k === "po" ? " · Playoffs" : g.k === "cons" ? " · Consolation" : "";
const wk = (g) => g.w2 ? `${g.w}–${g.w + 1}` : `${g.w}`;
const when = (g) => `${g.y} Wk ${wk(g)}${tag(g)}`;
const pname = (pid) => (D.players[pid] || [pid])[0];
const ppos = (pid) => (D.players[pid] || ["", ""])[1];
const isFormer = (id) => !M[id].seasons.includes(CUR);
const isRookie = (id) => M[id].seasons.length === 1 && M[id].seasons[0] === CUR;

/* ---------- derived stats ---------- */
// Every side of every game, as rows.
const sides = [];
for (const g of D.games) {
  sides.push({ g, o: g.a, opp: g.b, pf: g.pa, pa: g.pb });
  sides.push({ g, o: g.b, opp: g.a, pf: g.pb, pa: g.pa });
}
sides.forEach((s) => { s.res = s.pf > s.pa ? "W" : s.pf < s.pa ? "L" : "T"; s.margin = s.pf - s.pa; });
// Two-week finals count for wins and losses but not for single-game records.
const single = sides.filter((s) => !s.g.w2);

// All-play per regular-season week.
const weeks = {};
for (const [y, w, o, p] of D.weekly) (weeks[y + "-" + w] ||= []).push({ y, w, o, p });
const allPlay = {}; const highs = {}; const lows = {};
IDS.forEach((id) => { allPlay[id] = { w: 0, l: 0, t: 0, bySeason: {} }; highs[id] = 0; lows[id] = 0; });
for (const list of Object.values(weeks)) {
  if (list.length < 2 || list.every((x) => !x.p)) continue;
  const max = Math.max(...list.map((x) => x.p)), min = Math.min(...list.map((x) => x.p));
  for (const a of list) {
    const ap = allPlay[a.o]; const bs = (ap.bySeason[a.y] ||= { w: 0, l: 0, t: 0 });
    for (const b of list) {
      if (a === b) continue;
      const k = a.p > b.p ? "w" : a.p < b.p ? "l" : "t";
      ap[k]++; bs[k]++;
    }
    if (a.p === max) highs[a.o]++;
    if (a.p === min) lows[a.o]++;
  }
}

function career(id) {
  const mine = sides.filter((s) => s.o === id);
  const reg = mine.filter((s) => s.g.k === "reg");
  const po = mine.filter((s) => s.g.k === "po" || s.g.k === "final");
  const cnt = (arr, r) => arr.filter((s) => s.res === r).length;
  const ap = allPlay[id];
  const apPct = (ap.w + ap.t / 2) / Math.max(1, ap.w + ap.l + ap.t);
  const w = cnt(reg, "W"), l = cnt(reg, "L"), t = cnt(reg, "T");
  return {
    id, mine, reg, w, l, t, games: reg.length,
    pct: (w + t / 2) / Math.max(1, reg.length),
    pf: sum(reg.map((s) => s.pf)), pa: sum(reg.map((s) => s.pa)),
    ppg: sum(reg.map((s) => s.pf)) / Math.max(1, reg.length),
    papg: sum(reg.map((s) => s.pa)) / Math.max(1, reg.length),
    pw: cnt(po, "W"), pl: cnt(po, "L"),
    titles: done.filter((s) => s.champ === id).map((s) => s.year),
    finals: done.filter((s) => s.champ === id || s.runner === id).length,
    playoffs: done.filter((s) => s.po_teams.includes(id)).length,
    sackos: done.filter((s) => s.sacko === id).map((s) => s.year),
    apPct, ap, luck: w - apPct * reg.length,
    seasons: M[id].seasons.length,
    closeL: reg.filter((s) => s.res === "L" && s.margin > -5).length + po.filter((s) => s.res === "L" && s.margin > -5).length,
  };
}
const C = Object.fromEntries(IDS.map((id) => [id, career(id)]));

function finish(season, id) {
  if (!season.done) {
    const r = season.standings.find((x) => x.o === id);
    return r ? { label: `${ord(r.seed)} so far`, cls: "" } : null;
  }
  const p = season.places[id];
  if (p === 1) return { label: "Champion", cls: "gold", place: 1 };
  if (p === 2) return { label: "Runner-up", cls: "win", place: 2 };
  if (p === 3) return { label: "3rd place", cls: "win", place: 3 };
  if (p && p <= 6) return { label: `${ord(p)} place`, cls: "", place: p };
  if (p === 12) return { label: "Toilet Bowl", cls: "rust", place: 12 };
  const r = season.standings.find((x) => x.o === id);
  return r ? { label: `Missed playoffs (${ord(r.seed)})`, cls: "", place: r.seed } : null;
}

/* ---------- masthead ---------- */
{
  const first = D.seasons[0].year;
  const parts = [`Est. ${first}`, `${D.size} teams`, D.scoring, `${D.keepers} keeper${D.keepers === 1 ? "" : "s"}`, `${D.seasons.length} seasons`, `${IDS.length} managers`];
  $("#facts").innerHTML = parts.map((p) => `<span>${p}</span>`).join("");
  const thru = live ? `${live.year} Week ${live.week}` : `${done.at(-1).year} season`;
  $("#foot-src").textContent = `Live data from Sleeper league ${LEAGUE_ID}. Completed games through ${thru}.`;
}

/* ---------- champions ---------- */
{
  const finals = Object.fromEntries(D.games.filter((g) => g.k === "final").map((g) => [g.y, g]));
  const cards = done.slice().reverse().map((s) => {
    const g = finals[s.year];
    const cs = g ? (g.a === s.champ ? [g.pa, g.pb] : [g.pb, g.pa]) : null;
    const seed = s.standings.find((x) => x.o === s.champ).seed;
    const team = s.standings.find((x) => x.o === s.champ).team;
    return `<article class="panel plaque champ">
      <div class="yr">${s.year}</div>
      <div class="who">${av(s.champ)}<div><b>${esc(nm(s.champ))}</b><span class="muted">${esc(team)}</span></div></div>
      ${cs ? `<p class="final-score">Beat ${esc(nm(s.runner))} ${f2(cs[0])}–${f2(cs[1])} in Week ${wk(g)}</p>` : ""}
      <dl><dt>Seed</dt><dd class="num">${ord(seed)}</dd><dt>Runner-up</dt><dd>${esc(nm(s.runner))}</dd><dt>3rd place</dt><dd>${esc(nm(s.third))}</dd><dt>Toilet Bowl</dt><dd>${esc(nm(s.sacko))}</dd></dl>
    </article>`;
  });
  if (live) {
    const lead = live.standings[0];
    cards.unshift(`<article class="panel plaque live">
      <div class="yr">${live.year}</div>
      <div class="who">${av(lead.o)}<div><b>${esc(nm(lead.o))}</b><span class="muted">Leads after Week ${live.week}</span></div></div>
      <p class="final-score">${lead.w}–${lead.l}${lead.t ? "–" + lead.t : ""} · ${f1(lead.pf)} points for</p>
      <dl><dt>Status</dt><dd>In progress</dd><dt>Playoffs begin</dt><dd>Week ${live.pws}</dd><dt>Defending champ</dt><dd>${esc(nm(done.at(-1).champ))}</dd></dl>
    </article>`);
  }
  $("#plaques").innerHTML = cards.join("");
}

/* ---------- 2026 race ---------- */
if (live) {
  $("#race-title").textContent = `The ${live.year} Race`;
  $("#race-sub").textContent = `Standings after Week ${live.week}. The top ${live.teams} make the playoffs and the top two earn a bye; the dashed line marks the cut. Ties in record are broken by points for.`;
  const rows = live.standings.map((r) => {
    const ap = allPlay[r.o].bySeason[live.year] || { w: 0, l: 0, t: 0 };
    const gp = r.w + r.l + r.t;
    const streak = (() => {
      const s = sides.filter((x) => x.o === r.o && x.g.y === live.year).sort((a, b) => b.g.w - a.g.w);
      if (!s.length) return "";
      let n = 0; for (const x of s) { if (x.res === s[0].res) n++; else break; }
      return `<span class="${s[0].res === "W" ? "pos" : "neg"}">${s[0].res}${n}</span>`;
    })();
    return `<tr class="${r.seed === live.teams ? "cut" : ""} ${r.o === ME ? "me" : ""}">
      <td class="num">${r.seed}</td><td class="l">${who(r.o)}</td><td class="l muted">${esc(r.team)}${isRookie(r.o) ? ' <span class="chip">New</span>' : ""}</td>
      <td class="num">${r.w}–${r.l}${r.t ? "–" + r.t : ""}</td><td class="num">${f1(r.pf)}</td><td class="num">${f1(r.pa)}</td>
      <td class="num">${f1(r.pf / Math.max(1, gp))}</td><td class="num">${ap.w}–${ap.l}</td><td class="num">${streak}</td></tr>`;
  }).join("");
  $("#race-table").innerHTML = `<thead><tr><th>#</th><th class="l">Manager</th><th class="l">Team</th><th>Record</th><th>PF</th><th>PA</th><th>PPG</th><th>All-play</th><th>Streak</th></tr></thead><tbody>${rows}</tbody>`;
} else {
  $("#race").hidden = true;
}

/* ---------- all-time standings ---------- */
{
  const cols = [
    { k: "rank", h: "#", v: (c, i) => i + 1, sort: false },
    { k: "mgr", h: "Manager", l: true, v: (c) => who(c.id) + (isFormer(c.id) ? ' <span class="chip">Former</span>' : isRookie(c.id) ? ' <span class="chip">New</span>' : ""), s: (c) => nm(c.id).toLowerCase() },
    { k: "titles", h: "Titles", v: (c) => c.titles.length ? `<span class="trophies" title="${c.titles.join(", ")}">${"🏆".repeat(c.titles.length)}</span>` : "—", s: (c) => c.titles.length * 100 + c.finals * 10 + c.playoffs },
    { k: "seasons", h: "Seasons", v: (c) => c.seasons, s: (c) => c.seasons },
    { k: "rec", h: "W–L", v: (c) => `${c.w}–${c.l}${c.t ? "–" + c.t : ""}`, s: (c) => c.w - c.l },
    { k: "pct", h: "Win %", v: (c) => pct(c.pct), s: (c) => c.pct },
    { k: "po", h: "Playoffs", v: (c) => `${c.playoffs} of ${c.seasons - (c.id && M[c.id].seasons.includes(CUR) && live ? 1 : 0)}`, s: (c) => c.playoffs },
    { k: "porec", h: "Playoff W–L", v: (c) => `${c.pw}–${c.pl}`, s: (c) => c.pw - c.pl / 10 },
    { k: "ppg", h: "PF / game", v: (c) => f2(c.ppg), s: (c) => c.ppg },
    { k: "papg", h: "PA / game", v: (c) => f2(c.papg), s: (c) => c.papg },
    { k: "ap", h: "All-play %", v: (c) => pct(c.apPct), s: (c) => c.apPct },
    { k: "luck", h: "Luck", v: (c) => `<span class="${c.luck >= 0 ? "pos" : "neg"}">${c.luck >= 0 ? "+" : "−"}${Math.abs(c.luck).toFixed(1)}</span>`, s: (c) => c.luck },
  ];
  let sortK = "titles", dir = -1;
  const render = () => {
    const col = cols.find((c) => c.k === sortK);
    const rows = Object.values(C).sort((a, b) => dir * (col.s(a) > col.s(b) ? 1 : col.s(a) < col.s(b) ? -1 : 0) || b.pct - a.pct);
    const head = cols.map((c) => c.sort === false ? `<th>${c.h}</th>` :
      `<th class="${c.l ? "l" : ""}" ${c.k === sortK ? `aria-sort="${dir < 0 ? "descending" : "ascending"}"` : ""}><button data-sort="${c.k}">${c.h}</button></th>`).join("");
    const body = rows.map((c, i) => `<tr class="${isFormer(c.id) ? "former" : ""} ${c.id === ME ? "me" : ""}">${cols.map((col) =>
      `<td class="${col.l ? "l" : "num"}">${col.v(c, i)}</td>`).join("")}</tr>`).join("");
    $("#alltime-table").innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  };
  $("#alltime-table").onclick = (e) => {
    const b = e.target.closest("button[data-sort]"); if (!b) return;
    if (sortK === b.dataset.sort) dir = -dir; else { sortK = b.dataset.sort; dir = sortK === "mgr" || sortK === "papg" ? 1 : -1; }
    render();
  };
  render();
}

/* ---------- record book ---------- */
{
  const top = (arr, f, n = 5) => arr.slice().sort((a, b) => f(b) - f(a)).slice(0, n);
  const winners = single.filter((s) => s.res === "W");
  const card = (title, big, unit, ctx, list) => `<article class="panel rec">
    <h3>${title}</h3><div class="big">${big}<small>${unit}</small></div><p class="ctx">${ctx}</p>
    ${list ? `<ol>${list.map(([a, b]) => `<li><span>${a}</span><span>${b}</span></li>`).join("")}</ol>` : ""}</article>`;
  const out = [];

  const hi = top(single, (s) => s.pf, 6);
  out.push(card("Highest score", f2(hi[0].pf), "pts", `${esc(nm(hi[0].o))} vs ${esc(nm(hi[0].opp))}, ${when(hi[0].g)}`,
    hi.slice(1).map((s) => [`${esc(nm(s.o))} · ${when(s.g)}`, f2(s.pf)])));

  const lo = top(single.filter((s) => s.pf > 0), (s) => -s.pf, 6);
  out.push(card("Lowest score", f2(lo[0].pf), "pts", `${esc(nm(lo[0].o))} vs ${esc(nm(lo[0].opp))}, ${when(lo[0].g)}`,
    lo.slice(1).map((s) => [`${esc(nm(s.o))} · ${when(s.g)}`, f2(s.pf)])));

  const bl = top(winners, (s) => s.margin, 6);
  out.push(card("Biggest blowout", f2(bl[0].margin), "margin", `${esc(nm(bl[0].o))} ${f2(bl[0].pf)}, ${esc(nm(bl[0].opp))} ${f2(bl[0].pa)} · ${when(bl[0].g)}`,
    bl.slice(1).map((s) => [`${esc(nm(s.o))} over ${esc(nm(s.opp))} · ${s.g.y}`, f2(s.margin)])));

  const cl = top(winners, (s) => -s.margin, 6);
  out.push(card("Closest game", f2(cl[0].margin), "margin", `${esc(nm(cl[0].o))} ${f2(cl[0].pf)}, ${esc(nm(cl[0].opp))} ${f2(cl[0].pa)} · ${when(cl[0].g)}`,
    cl.slice(1).map((s) => [`${esc(nm(s.o))} over ${esc(nm(s.opp))} · ${s.g.y}`, f2(s.margin)])));

  const comb = D.games.filter((g) => !g.w2).sort((a, b) => (b.pa + b.pb) - (a.pa + a.pb)).slice(0, 5);
  out.push(card("Highest-scoring game", f2(comb[0].pa + comb[0].pb), "combined", `${esc(nm(comb[0].a))} ${f2(comb[0].pa)}, ${esc(nm(comb[0].b))} ${f2(comb[0].pb)} · ${when(comb[0])}`,
    comb.slice(1).map((g) => [`${esc(nm(g.a))} vs ${esc(nm(g.b))} · ${g.y}`, f2(g.pa + g.pb)])));

  const ml = top(single.filter((s) => s.res === "L"), (s) => s.pf, 5);
  out.push(card("Most points in a loss", f2(ml[0].pf), "pts", `${esc(nm(ml[0].o))} lost to ${esc(nm(ml[0].opp))} (${f2(ml[0].pa)}) · ${when(ml[0].g)}`,
    ml.slice(1).map((s) => [`${esc(nm(s.o))} · ${when(s.g)}`, f2(s.pf)])));

  const fw = top(winners, (s) => -s.pf, 5);
  out.push(card("Fewest points in a win", f2(fw[0].pf), "pts", `${esc(nm(fw[0].o))} beat ${esc(nm(fw[0].opp))} (${f2(fw[0].pa)}) · ${when(fw[0].g)}`,
    fw.slice(1).map((s) => [`${esc(nm(s.o))} · ${when(s.g)}`, f2(s.pf)])));

  const seasonRows = done.flatMap((s) => s.standings.map((r) => ({ ...r, y: s.year, ppg: r.pf / (r.w + r.l + r.t) })));
  const sp = top(seasonRows, (r) => r.ppg, 5);
  out.push(card("Best scoring season", f2(sp[0].ppg), "per game", `${esc(nm(sp[0].o))} in ${sp[0].y}: ${f1(sp[0].pf)} points over ${sp[0].w + sp[0].l + sp[0].t} games`,
    sp.slice(1).map((r) => [`${esc(nm(r.o))} · ${r.y}`, f2(r.ppg)])));

  const br = top(seasonRows, (r) => (r.w - r.l) * 1000 + r.pf, 5);
  out.push(card("Best regular season", `${br[0].w}–${br[0].l}`, "", `${esc(nm(br[0].o))} in ${br[0].y}, ${f1(br[0].pf)} points for`,
    br.slice(1).map((r) => [`${esc(nm(r.o))} · ${r.y}`, `${r.w}–${r.l}`])));

  // Streaks: every game in order, across seasons.
  const streaks = [];
  for (const id of IDS) {
    const g = sides.filter((s) => s.o === id).sort((a, b) => a.g.y.localeCompare(b.g.y) || a.g.w - b.g.w);
    let cur = null, n = 0, start = null;
    let last = null;
    for (const s of g) {
      if (s.res === cur) n++; else { if (cur) streaks.push({ id, res: cur, n, from: start, to: last }); cur = s.res; n = 1; start = s; }
      last = s;
    }
    if (cur) streaks.push({ id, res: cur, n, from: start, to: last, open: true });
  }
  const span = (st) => `${st.from.g.y} Wk ${st.from.g.w} – ${st.to.g.y === st.from.g.y ? "" : st.to.g.y + " "}Wk ${wk(st.to.g)}${st.open ? " (active)" : ""}`;
  const ws = top(streaks.filter((s) => s.res === "W"), (s) => s.n, 5);
  out.push(card("Longest win streak", ws[0].n, "games", `${esc(nm(ws[0].id))}, ${span(ws[0])}`,
    ws.slice(1).map((s) => [`${esc(nm(s.id))} · ${span(s)}`, s.n])));
  const ls = top(streaks.filter((s) => s.res === "L"), (s) => s.n, 5);
  out.push(card("Longest losing streak", ls[0].n, "games", `${esc(nm(ls[0].id))}, ${span(ls[0])}`,
    ls.slice(1).map((s) => [`${esc(nm(s.id))} · ${span(s)}`, s.n])));

  const tp = D.topPerfs;
  out.push(card("Best player game", f2(tp[0][4]), "pts", `${esc(pname(tp[0][3]))} (${ppos(tp[0][3])}) for ${esc(nm(tp[0][2]))}, ${tp[0][0]} Week ${tp[0][1]}`,
    tp.slice(1, 6).map((p) => [`${esc(pname(p[3]))} · ${esc(nm(p[2]))} · ${p[0]}`, f2(p[4])])));

  $("#record-cards").innerHTML = out.join("");
}

/* ---------- seasons ---------- */
{
  const years = D.seasons.map((s) => s.year).reverse();
  let sel = done.length ? done.at(-1).year : years[0];
  const render = () => {
    $("#season-tabs").innerHTML = years.map((y) => `<button role="tab" aria-selected="${y === sel}" data-year="${y}">${y}${y === CUR && live ? " · live" : ""}</button>`).join("");
    const s = D.seasons.find((x) => x.year === sel);
    const rows = s.standings.map((r) => {
      const f = finish(s, r.o);
      const ap = allPlay[r.o].bySeason[s.year] || { w: 0, l: 0 };
      return `<tr class="${r.seed === s.teams ? "cut" : ""} ${r.o === ME ? "me" : ""}"><td class="num">${r.seed}</td><td class="l">${who(r.o)}</td><td class="l muted">${esc(r.team)}</td>
        <td class="num">${r.w}–${r.l}${r.t ? "–" + r.t : ""}</td><td class="num">${f1(r.pf)}</td><td class="num">${f1(r.pa)}</td><td class="num">${ap.w}–${ap.l}</td>
        <td class="l">${s.done ? `<span class="chip ${f.cls}">${f.label}</span>` : ""}</td></tr>`;
    }).join("");
    $("#season-table").innerHTML = `<thead><tr><th>Seed</th><th class="l">Manager</th><th class="l">Team</th><th>Record</th><th>PF</th><th>PA</th><th>All-play</th><th class="l">${s.done ? "Finish" : ""}</th></tr></thead><tbody>${rows}</tbody>`;

    if (s.done) {
      const gm = (a, b) => D.games.find((g) => g.y === s.year && g.k !== "reg" && g.k !== "cons" && ((g.a === a && g.b === b) || (g.a === b && g.b === a)));
      const seed = (id) => s.standings.find((r) => r.o === id).seed;
      const names = ["Quarterfinals", "Semifinals", "Final"];
      const rounds = s.bracket.map((ms, i) => `<div class="round"><span class="eyebrow">${names[i] || "Round " + (i + 1)}</span>${ms.map(([a, b, w]) => {
        const g = gm(a, b); const pts = (id) => g ? f2(g.a === id ? g.pa : g.pb) : "";
        return `<div class="bm">${[a, b].map((id) => `<div class="${id === w ? "w" : ""}"><span class="nm">${seed(id)} ${esc(nm(id))}</span><span class="num">${pts(id)}</span></div>`).join("")}</div>`;
      }).join("")}</div>`).join("");
      $("#season-bracket").innerHTML = `<h3>Playoff bracket</h3><div class="rounds">${rounds}</div>`;
      $("#season-bracket").hidden = false;
    } else {
      $("#season-bracket").hidden = true;
    }

    const yearSides = single.filter((x) => x.g.y === s.year);
    const hi = yearSides.slice().sort((a, b) => b.pf - a.pf)[0];
    const lo = yearSides.filter((x) => x.pf > 0).sort((a, b) => a.pf - b.pf)[0];
    const pfTop = s.standings.slice().sort((a, b) => b.pf - a.pf)[0];
    const robbed = s.standings.filter((r) => r.seed > s.teams).sort((a, b) => b.pf - a.pf)[0];
    const yp = D.topPerfs.filter((p) => p[0] === s.year)[0];
    const lk = s.standings.map((r) => { const a = allPlay[r.o].bySeason[s.year]; const gp = r.w + r.l + r.t; return { o: r.o, luck: r.w - (a.w + a.t / 2) / Math.max(1, a.w + a.l + a.t) * gp }; }).sort((a, b) => b.luck - a.luck);
    const row = (k, v) => `<div class="award"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    $("#season-awards").innerHTML = `<h3>${s.done ? "Season honors" : "So far"}</h3>` + [
      s.done ? row("Champion", `🏆 ${esc(nm(s.champ))}`) : "",
      row("Most points for", `${esc(nm(pfTop.o))} <span class="num muted">${f1(pfTop.pf)}</span>`),
      hi ? row("High week", `${esc(nm(hi.o))} <span class="num muted">${f2(hi.pf)}, Wk ${hi.g.w}</span>`) : "",
      lo ? row("Low week", `${esc(nm(lo.o))} <span class="num muted">${f2(lo.pf)}, Wk ${lo.g.w}</span>`) : "",
      yp ? row("Best player game", `${esc(pname(yp[3]))} <span class="num muted">${f2(yp[4])}</span>`) : "",
      row("Luckiest", `${esc(nm(lk[0].o))} <span class="num pos">+${lk[0].luck.toFixed(1)}</span>`),
      row("Unluckiest", `${esc(nm(lk.at(-1).o))} <span class="num neg">−${Math.abs(lk.at(-1).luck).toFixed(1)}</span>`),
      s.done && robbed ? row("Best team to miss playoffs", `${esc(nm(robbed.o))} <span class="num muted">${f1(robbed.pf)} PF</span>`) : "",
      s.done ? row("Toilet Bowl", `${esc(nm(s.sacko))}`) : "",
    ].join("");
  };
  $("#season-tabs").onclick = (e) => { const b = e.target.closest("button[data-year]"); if (b) { sel = b.dataset.year; render(); } };
  render();
}

/* ---------- head to head ---------- */
const order = Object.values(C).sort((a, b) => b.pct - a.pct).map((c) => c.id);
function series(a, b) {
  return sides.filter((s) => s.o === a && s.opp === b).sort((x, y) => x.g.y.localeCompare(y.g.y) || x.g.w - y.g.w);
}
let pair = null;
function renderSeries() {
  const [a, b] = pair;
  const g = series(a, b);
  const w = g.filter((s) => s.res === "W").length, l = g.filter((s) => s.res === "L").length;
  const pf = sum(g.map((s) => s.pf)), pa = sum(g.map((s) => s.pa));
  $("#series").innerHTML = `<div class="series-head">${who(a, "")}<span class="score">${w}–${l}</span>${who(b, "")}
      <span class="muted num">${g.length} games · ${f1(pf)}–${f1(pa)} total points</span></div>
    <div class="games">${g.map((s) => `<div><span class="muted">${s.g.y} Wk ${wk(s.g)}</span><span>${s.res === "W" ? esc(nm(a)) : esc(nm(b))} won${tag(s.g)}</span><span>${f2(s.pf)}–${f2(s.pa)}</span></div>`).join("") || '<p class="muted">These two have never played.</p>'}</div>`;
  document.querySelectorAll("#h2h button[data-a]").forEach((x) => x.setAttribute("aria-pressed", x.dataset.a === a && x.dataset.b === b));
}
{
  const head = `<thead><tr><th></th>${order.map((id) => `<th title="${esc(nm(id))}">${av(id, "sm")}</th>`).join("")}</tr></thead>`;
  const body = order.map((a) => `<tr class="${a === ME ? "me" : ""}"><th>${who(a)}</th>${order.map((b) => {
    if (a === b) return `<td class="self"></td>`;
    const g = series(a, b); if (!g.length) return `<td class="none">–</td>`;
    const w = g.filter((s) => s.res === "W").length, l = g.filter((s) => s.res === "L").length;
    return `<td><button data-a="${a}" data-b="${b}" class="${w > l ? "up" : w < l ? "down" : ""}" aria-pressed="false" aria-label="${esc(nm(a))} vs ${esc(nm(b))}: ${w} wins, ${l} losses">${w}–${l}</button></td>`;
  }).join("")}</tr>`).join("");
  $("#h2h").innerHTML = head + `<tbody>${body}</tbody>`;
  $("#h2h").onclick = (e) => { const b = e.target.closest("button[data-a]"); if (b) { pair = [b.dataset.a, b.dataset.b]; renderSeries(); } };
  // Open on the most-played rivalry with the most lopsided record.
  let best = null;
  for (const a of order) for (const b of order) if (a !== b) {
    const g = series(a, b); const w = g.filter((s) => s.res === "W").length;
    const score = g.length * 10 + (w - (g.length - w));
    if (!best || score > best[0]) best = [score, a, b];
  }
  pair = [best[1], best[2]];
  if (ME) {
    const opp = order.filter((o) => o !== ME).sort((x, y) => series(ME, y).length - series(ME, x).length)[0];
    if (opp && series(ME, opp).length) pair = [ME, opp];
  }
  renderSeries();
}

/* ---------- profiles ---------- */
function renderProfile(id) {
  current = id;
  const c = C[id]; const m = M[id];
  document.querySelectorAll("#picker button").forEach((b) => b.setAttribute("aria-pressed", b.dataset.pick === id));
  const mine = c.mine.filter((s) => !s.g.w2);
  const best = mine.slice().sort((a, b) => b.pf - a.pf)[0];
  const worst = mine.filter((s) => s.pf > 0).sort((a, b) => a.pf - b.pf)[0];
  const rivals = IDS.filter((o) => o !== id).map((o) => { const g = series(id, o); return { o, n: g.length, w: g.filter((s) => s.res === "W").length, l: g.filter((s) => s.res === "L").length }; }).filter((r) => r.n);
  const nemesis = rivals.slice().sort((a, b) => (b.l - b.w) - (a.l - a.w) || b.n - a.n)[0];
  const victim = rivals.slice().sort((a, b) => (b.w - b.l) - (a.w - a.l) || b.n - a.n)[0];
  const frequent = rivals.slice().sort((a, b) => b.n - a.n)[0];
  const bp = D.bestPerf[id];
  const status = isFormer(id) ? `Former manager · ${m.seasons[0]}–${m.seasons.at(-1)}` : isRookie(id) ? `Joined ${CUR}` : `Member since ${m.seasons[0]}`;
  const tiles = [
    [c.titles.length ? "🏆".repeat(c.titles.length) : "0", c.titles.length ? `Title${c.titles.length > 1 ? "s" : ""} (${c.titles.join(", ")})` : "Titles"],
    [`${c.w}–${c.l}`, `Regular season (${pct(c.pct)})`],
    [`${c.pw}–${c.pl}`, "Playoff record"],
    [f2(c.ppg), "Points per game"],
    [pct(c.apPct), "All-play win rate"],
    [`${c.luck >= 0 ? "+" : "−"}${Math.abs(c.luck).toFixed(1)}`, "Luck (wins vs. expected)"],
    [highs[id], "Weekly high scores"],
  ];
  const seasons = D.seasons.filter((s) => m.seasons.includes(s.year)).slice().reverse().map((s) => {
    const r = s.standings.find((x) => x.o === id); const f = finish(s, id);
    return `<div><span>${s.year} · ${esc(r.team)}</span><span>${r.w}–${r.l} · <span class="chip ${f.cls}">${f.label}</span></span></div>`;
  }).join("");
  $("#profile").innerHTML = `
    <div class="p-head">${av(id, "lg")}<div><h3>${esc(m.name)}</h3><p class="muted">${esc(m.team)} · ${status}</p></div></div>
    <div class="tiles">${tiles.map(([b, s]) => `<div class="tile"><b>${b}</b><span>${s}</span></div>`).join("")}</div>
    <div class="p-cols">
      <div><h3>Season by season</h3><div class="list">${seasons}</div></div>
      <div><h3>Rivals</h3><div class="list">
        ${nemesis ? `<div><span>Nemesis: ${esc(nm(nemesis.o))}</span><span>${nemesis.w}–${nemesis.l}</span></div>` : ""}
        ${victim ? `<div><span>Favorite opponent: ${esc(nm(victim.o))}</span><span>${victim.w}–${victim.l}</span></div>` : ""}
        ${frequent ? `<div><span>Most played: ${esc(nm(frequent.o))}</span><span>${frequent.n} games</span></div>` : ""}
        ${best ? `<div><span>Best game: ${when(best.g)}</span><span>${f2(best.pf)}</span></div>` : ""}
        ${worst ? `<div><span>Worst game: ${when(worst.g)}</span><span>${f2(worst.pf)}</span></div>` : ""}
      </div></div>
      <div><h3>Franchise players</h3><div class="list">
        ${(D.mvp[id] || []).map(([pid, pts]) => `<div><span>${esc(pname(pid))} <span class="muted">${ppos(pid)}</span></span><span>${f1(pts)} pts started</span></div>`).join("")}
        ${bp ? `<div><span>Best single game: ${esc(pname(bp[3]))}, ${bp[0]} Wk ${bp[1]}</span><span>${f2(bp[4])}</span></div>` : ""}
      </div></div>
    </div>`;
}
{
  const ids = Object.values(C).sort((a, b) => (isFormer(a.id) - isFormer(b.id)) || nm(a.id).localeCompare(nm(b.id), undefined, { sensitivity: "base" })).map((c) => c.id);
  $("#picker").innerHTML = ids.map((id) => `<button data-pick="${id}" aria-pressed="false">${av(id, "sm")}${esc(nm(id))}</button>`).join("");
  $("#picker").onclick = (e) => { const b = e.target.closest("button[data-pick]"); if (b) renderProfile(b.dataset.pick); };
  renderProfile(current && M[current] ? current : ME || (done.at(-1) || {}).champ || IDS[0]);
  window.__renderProfile = renderProfile;
}


/* ---------- awards ---------- */
{
  const vets = Object.values(C).filter((c) => c.games >= 10);
  const pick = (arr, f) => arr.slice().sort((a, b) => f(b) - f(a))[0];
  const honor = (title, what, id, stat) => `<article class="panel honor"><h3>${title}</h3>${who(id, "")}<p class="stat num">${stat}</p><p class="what">${what}</p></article>`;
  const out = [];
  const lucky = pick(vets, (c) => c.luck); const unlucky = pick(vets, (c) => -c.luck);
  out.push(honor("Horseshoe Award", "Won the most games beyond what their scoring deserved.", lucky.id, `+${lucky.luck.toFixed(1)} wins over expected`));
  out.push(honor("Black Cat Award", "Lost the most games their scoring should have won.", unlucky.id, `−${Math.abs(unlucky.luck).toFixed(1)} wins below expected`));
  const magnet = pick(vets, (c) => c.papg);
  out.push(honor("Lightning Rod", "Opponents save their best weeks for this team.", magnet.id, `${f2(magnet.papg)} points against per game`));
  const hs = pick(vets, (c) => highs[c.id]);
  out.push(honor("Weekly Kingpin", "Most weeks as the league's top scorer.", hs.id, `${highs[hs.id]} weekly high scores`));
  const ls = pick(vets, (c) => lows[c.id]);
  out.push(honor("Basement Dweller", "Most weeks as the league's lowest scorer.", ls.id, `${lows[ls.id]} weekly low scores`));
  const hb = pick(vets, (c) => c.closeL);
  out.push(honor("Heartbreak Kid", "Most losses by fewer than 5 points.", hb.id, `${hb.closeL} losses by under 5`));
  const sk = pick(vets, (c) => c.sackos.length);
  if (sk.sackos.length) out.push(honor("Toilet Bowl Regular", "Most Toilet Bowl losses.", sk.id, `${sk.sackos.length} (${sk.sackos.join(", ")})`));
  // Bye-week flops: a top-two seed who lost his first playoff game.
  const flops = done.flatMap((s) => {
    const r1 = new Set(s.bracket[0].flat());
    return s.bracket[1].flatMap(([a, b, w]) => [a, b].filter((t) => !r1.has(t) && t !== w).map((t) => ({ y: s.year, t, seed: s.standings.find((r) => r.o === t).seed })));
  });
  if (flops.length) {
    const byMgr = {}; flops.forEach((f) => (byMgr[f.t] ||= []).push(f));
    const top = Object.entries(byMgr).sort((a, b) => b[1].length - a[1].length)[0];
    out.push(honor("Bye-Week Flop", "Earned a first-round bye, then lost the first playoff game.", top[0], top[1].map((f) => `${f.y} (${ord(f.seed)} seed)`).join(", ")));
  }
  const robbed = done.map((s) => ({ y: s.year, r: s.standings.filter((r) => r.seed > s.teams).sort((a, b) => b.pf - a.pf)[0] })).sort((a, b) => b.r.pf - a.r.pf)[0];
  out.push(honor("Robbed", "Most points for in a season without making the playoffs.", robbed.r.o, `${f1(robbed.r.pf)} PF in ${robbed.y} (${robbed.r.w}–${robbed.r.l})`));
  const cinder = done.map((s) => ({ y: s.year, o: s.champ, seed: s.standings.find((r) => r.o === s.champ).seed })).sort((a, b) => b.seed - a.seed)[0];
  out.push(honor("Cinderella", "Lowest seed to win the title.", cinder.o, `${ord(cinder.seed)} seed, ${cinder.y} champion`));
  const finals = D.games.filter((g) => g.k === "final").map((g) => ({ g, m: Math.abs(g.pa - g.pb), l: g.pa > g.pb ? g.b : g.a })).sort((a, b) => a.m - b.m)[0];
  if (finals) out.push(honor("So Close", "Narrowest loss in a championship game.", finals.l, `Lost the ${finals.g.y} final by ${f2(finals.m)}`));
  $("#honors").innerHTML = out.join("");
}

/* ---------- newsletter: The Gentlemen's Gazette ---------- */
{
  const issues = [];
  for (const s of D.seasons) {
    [...new Set(D.games.filter((g) => g.y === s.year).map((g) => g.w))].sort((a, b) => a - b).forEach((w) => issues.push([s.year, w]));
  }
  issues.reverse();
  const key = (i) => `${i[0]}-${i[1]}`;
  const fromHash = (location.hash.match(/^#week-(\d{4})-(\d{1,2})$/) || []);
  let sel = (window.__nlPicked && issues.find((i) => key(i) === window.__nlPicked))
    || (fromHash[1] && issues.find(([y, w]) => y === fromHash[1] && w === +fromHash[2])) || issues[0];
  if (fromHash[1] && !window.__nlPicked && sel) window.__nlPicked = key(sel);

  const isPlayoff = (y, w) => { const s = D.seasons.find((x) => x.year === y); return s && w >= s.pws; };
  $("#nl-week").innerHTML = issues.map((i) => `<option value="${key(i)}">${i[0]} · Week ${i[1]}${isPlayoff(i[0], i[1]) ? " (playoffs)" : ""}</option>`).join("");
  $("#nl-week").onchange = (e) => { window.__nlPicked = e.target.value; sel = issues.find((i) => key(i) === e.target.value); issue(); };

  const recordBefore = (o, y, w) => {
    const g = sides.filter((s) => s.o === o && s.g.y === y && s.g.k === "reg" && s.g.w < w);
    return { w: g.filter((s) => s.res === "W").length, l: g.filter((s) => s.res === "L").length, n: g.length };
  };
  const table = (y, upto) => {
    const rows = {};
    for (const s of sides) if (s.g.y === y && s.g.k === "reg" && s.g.w <= upto) {
      const r = (rows[s.o] ||= { o: s.o, w: 0, pf: 0 });
      r.w += s.res === "W" ? 1 : 0; r.pf += s.pf;
    }
    return Object.values(rows).sort((a, b) => b.w - a.w || b.pf - a.pf).map((r, i) => ({ ...r, rank: i + 1 }));
  };
  const h2hBefore = (a, b, y, w) => {
    const g = sides.filter((s) => s.o === a && s.opp === b && (s.g.y < y || (s.g.y === y && s.g.w < w)));
    return [g.filter((s) => s.res === "W").length, g.filter((s) => s.res === "L").length];
  };

  function issue() {
    if (!sel) { $("#nl-body").innerHTML = '<p class="muted">No finished weeks yet. The first issue appears once Week 1 is final.</p>'; return; }
    $("#nl-week").value = key(sel);
    const [y, w] = sel;
    const wk = sides.filter((s) => s.g.y === y && s.g.w === w);
    const one = wk.filter((s) => !s.g.w2);
    const wins = one.filter((s) => s.res === "W"), losses = one.filter((s) => s.res === "L");
    const by = (arr, f) => arr.slice().sort((a, b) => f(b) - f(a))[0];
    const hi = by(one, (s) => s.pf), lo = by(one.filter((s) => s.pf > 0), (s) => -s.pf);
    const close = by(wins, (s) => -s.margin), blow = by(wins, (s) => s.margin);
    const tough = by(losses, (s) => s.pf), lucky = by(wins, (s) => -s.pf);
    const pow = D.perfs.filter((p) => p[0] === y && p[1] === w).sort((a, b) => b[4] - a[4])[0];
    const lu = D.lineups.filter((l) => l[0] === y && l[1] === w).map((l) => ({ o: l[2], left: l[4] - l[3] }));
    const bench = by(lu, (l) => l.left);
    const perfect = lu.filter((l) => l.left < 0.01).map((l) => l.o);
    // Upset: the winner had the worse record coming in.
    let upset = null;
    if (w > 1) for (const s of wins) {
      const a = recordBefore(s.o, y, w), b = recordBefore(s.opp, y, w);
      if (!a.n || !b.n) continue;
      const gap = b.w / b.n - a.w / a.n;
      if (gap > 0.15 && (!upset || gap > upset.gap)) upset = { s, a, b, gap };
    }
    const lead = upset
      ? `Upset alert: ${esc(nm(upset.s.o))} (${upset.a.w}–${upset.a.l}) knocked off ${esc(nm(upset.s.opp))} (${upset.b.w}–${upset.b.l}), ${f2(upset.s.pf)} to ${f2(upset.s.pa)}.`
      : blow ? `${esc(nm(blow.o))} ran over ${esc(nm(blow.opp))} by ${f2(blow.margin)}, the week's biggest margin.` : "";
    const lead2 = hi ? ` ${esc(nm(hi.o))} posted the top score at ${f2(hi.pf)}${pow ? `, and ${esc(pname(pow[3]))} led all starters with ${f2(pow[4])}` : ""}.` : "";

    // Standings movement (regular season only).
    let movers = "";
    if (wk.some((s) => s.g.k === "reg") && w > 1) {
      const before = Object.fromEntries(table(y, w - 1).map((r) => [r.o, r.rank]));
      const after = table(y, w);
      movers = after.map((r) => {
        const d = (before[r.o] || r.rank) - r.rank;
        return `<div class="${r.o === ME ? "me" : ""}"><span>${r.rank}. ${esc(nm(r.o))}</span><span class="${d > 0 ? "pos" : d < 0 ? "neg" : "muted"}">${d > 0 ? "▲" + d : d < 0 ? "▼" + -d : "–"}</span></div>`;
      }).join("");
    }
    // Active streaks of 3+ inside the season.
    const streaks = [...new Set(wk.map((s) => s.o))].map((o) => {
      const g = sides.filter((s) => s.o === o && s.g.y === y && s.g.w <= w).sort((a, b) => b.g.w - a.g.w);
      let n = 0; for (const s of g) { if (s.res === g[0].res) n++; else break; }
      return { o, res: g[0].res, n };
    }).filter((s) => s.n >= 3 && s.res !== "T").sort((a, b) => b.n - a.n);
    // Next week's games.
    const nextGames = D.games.filter((g) => g.y === y && g.w === w + 1).map((g) => ({ a: g.a, b: g.b }))
      .concat(D.liveWeek && D.liveWeek.year === y && D.liveWeek.week === w + 1 ? D.liveWeek.games : []);
    const nextHtml = nextGames.map((g) => {
      const [hw, hl] = h2hBefore(g.a, g.b, y, w + 1);
      const ra = recordBefore(g.a, y, w + 1), rb = recordBefore(g.b, y, w + 1);
      return `<div class="${g.a === ME || g.b === ME ? "me" : ""}"><span>${esc(nm(g.a))} <span class="muted">(${ra.w}–${ra.l})</span> vs ${esc(nm(g.b))} <span class="muted">(${rb.w}–${rb.l})</span></span><span>${hw + hl ? `series ${hw}–${hl}` : "first meeting"}</span></div>`;
    }).join("");

    let mine = "";
    const my = wk.find((s) => s.o === ME);
    if (my) {
      const rank = one.slice().sort((a, b) => b.pf - a.pf).findIndex((s) => s.o === ME) + 1;
      const myLu = lu.find((l) => l.o === ME);
      const nx = nextGames.find((g) => g.a === ME || g.b === ME);
      const opp = nx && (nx.a === ME ? nx.b : nx.a);
      const [hw, hl] = opp ? h2hBefore(ME, opp, y, w + 1) : [0, 0];
      mine = `<div class="nl-mine"><h3>Your week</h3><p>${my.res === "W" ? "You beat" : my.res === "L" ? "You lost to" : "You tied"} ${esc(nm(my.opp))}, ${f2(my.pf)}–${f2(my.pa)}.
        ${rank ? `That was the ${ord(rank)}-highest score of the week.` : ""}
        ${myLu && myLu.left >= 0.01 ? `You left ${f2(myLu.left)} points on your bench.` : myLu ? "You started your best possible lineup." : ""}
        ${opp ? `Next up: ${esc(nm(opp))}${hw + hl ? `, and you're ${hw}–${hl} against them all-time` : ", for the first time"}.` : ""}</p></div>`;
    }

    const cell = (k, who_, v) => who_ ? `<div class="nl-award"><span class="eyebrow">${k}</span><b>${who_}</b><span class="num muted">${v}</span></div>` : "";
    $("#nl-body").innerHTML = `
      <header class="nl-head"><span class="eyebrow">The Gentlemen's Gazette · ${y} Week ${w}${isPlayoff(y, w) ? " · Playoffs" : ""}</span>
        <p class="nl-lead">${lead}${lead2}</p></header>
      ${mine}
      <div class="nl-awards">
        ${cell("High score", hi && esc(nm(hi.o)), hi && f2(hi.pf))}
        ${cell("Low score", lo && esc(nm(lo.o)), lo && f2(lo.pf))}
        ${cell("Closest game", close && `${esc(nm(close.o))} over ${esc(nm(close.opp))}`, close && `by ${f2(close.margin)}`)}
        ${cell("Biggest blowout", blow && `${esc(nm(blow.o))} over ${esc(nm(blow.opp))}`, blow && `by ${f2(blow.margin)}`)}
        ${cell("Most points in a loss", tough && esc(nm(tough.o)), tough && f2(tough.pf))}
        ${cell("Fewest points in a win", lucky && esc(nm(lucky.o)), lucky && f2(lucky.pf))}
        ${cell("Player of the week", pow && esc(pname(pow[3])), pow && `${f2(pow[4])} for ${esc(nm(pow[2]))}`)}
        ${cell("Most points left on the bench", bench && bench.left >= 0.01 && esc(nm(bench.o)), bench && f2(bench.left))}
        ${cell("Perfect lineup", perfect.length && perfect.map((o) => esc(nm(o))).join(", "), "best possible starters")}
      </div>
      <div class="nl-cols">
        <div><h3>Results</h3><div class="list">${wk.filter((s) => s.res !== "L" && (s.res === "W" || s.o < s.opp)).map((s) =>
          `<div class="${s.o === ME || s.opp === ME ? "me" : ""}"><span><b>${esc(nm(s.o))}</b> over ${esc(nm(s.opp))}${tag(s.g)}</span><span>${f2(s.pf)}–${f2(s.pa)}</span></div>`).join("")}</div></div>
        ${movers ? `<div><h3>Standings</h3><div class="list">${movers}</div></div>` : ""}
        <div>${streaks.length ? `<h3>Streak watch</h3><div class="list">${streaks.map((s) => `<div class="${s.o === ME ? "me" : ""}"><span>${esc(nm(s.o))}</span><span class="${s.res === "W" ? "pos" : "neg"}">${s.res === "W" ? "Won" : "Lost"} ${s.n} straight</span></div>`).join("")}</div>` : ""}
          ${nextHtml ? `<h3 style="margin-top:16px">Next week</h3><div class="list">${nextHtml}</div>` : ""}</div>
      </div>`;
    $("#nl-share").onclick = async () => {
      const url = location.href.split("#")[0] + `#week-${y}-${w}`;
      const title = `The Gentlemen's Gazette: ${y} Week ${w}`;
      try {
        if (navigator.share) await navigator.share({ title, text: `${title} recap`, url });
        else { await navigator.clipboard.writeText(url); $("#nl-share").textContent = "Link copied"; setTimeout(() => { $("#nl-share").textContent = "Share"; }, 2000); }
      } catch { /* share sheet closed */ }
    };
  }
  issue();
}

/* ---------- draft grades ---------- */
{
  const graded = D.drafts.filter((d) => d.snap);
  $("#draft").hidden = !graded.length;
  if (graded.length) {
    const years = graded.map((d) => d.year).sort().reverse();
    let year = years.includes(window.__draftYear) ? window.__draftYear : years[0];
    let open = null;
    const LETTERS = [[1.5, "A+"], [1.0, "A"], [0.6, "A−"], [0.25, "B+"], [-0.1, "B"], [-0.45, "B−"], [-0.8, "C+"], [-1.15, "C"], [-1.5, "C−"], [-Infinity, "D"]];
    const gradeDraft = (d) => {
      const N = d.picks.length, adp = d.snap.adp;
      const a = (pid) => adp[pid] ?? N + 20;
      const teams = {};
      for (const p of d.picks) {
        const t = (teams[p.o] ||= { o: p.o, picks: [], value: 0 });
        const pick = { ...p, adp: adp[p.pid], diff: a(p.pid) - p.no };
        t.picks.push(pick);
        t.value += Math.max(0, N - a(p.pid));
      }
      const list = Object.values(teams);
      const mean = sum(list.map((t) => t.value)) / list.length;
      const sd = Math.sqrt(sum(list.map((t) => (t.value - mean) ** 2)) / list.length) || 1;
      for (const t of list) {
        t.z = (t.value - mean) / sd;
        t.grade = LETTERS.find(([min]) => t.z >= min)[1];
        const drafted = t.picks.filter((p) => !p.keeper);
        t.best = drafted.slice().sort((x, y) => y.diff - x.diff)[0];
        t.worst = drafted.slice().sort((x, y) => x.diff - y.diff)[0];
        t.keepers = t.picks.filter((p) => p.keeper);
      }
      return list.sort((x, y) => y.value - x.value);
    };
    const pickLabel = (p, size) => `${p.round}.${String(((p.no - 1) % size) + 1).padStart(2, "0")}`;
    const render = () => {
      $("#draft-tabs").innerHTML = years.map((y) => `<button role="tab" aria-selected="${y === year}" data-year="${y}">${y}</button>`).join("");
      const d = graded.find((x) => x.year === year);
      const season = D.seasons.find((s) => s.year === year);
      const teams = gradeDraft(d);
      const size = teams.length;
      if (!open || !teams.some((t) => t.o === open)) open = teams.some((t) => t.o === ME) ? ME : teams[0].o;
      const all = teams.flatMap((t) => t.picks.filter((p) => !p.keeper));
      const steal = all.slice().sort((a, b) => b.diff - a.diff)[0], reach = all.slice().sort((a, b) => a.diff - b.diff)[0];
      const fmtPick = (p) => p ? `${esc(pname(p.pid))} <span class="muted num">${pickLabel(p, size)}, ADP ${p.adp != null ? Math.round(p.adp) : "—"}</span>` : "—";
      $("#draft-callouts").innerHTML = `
        <div class="panel nl-award"><span class="eyebrow">Steal of the draft</span><b>${fmtPick(steal)}</b><span class="muted">${esc(nm(steal.o))}, ${Math.round(steal.diff)} picks after ADP</span></div>
        <div class="panel nl-award"><span class="eyebrow">Biggest reach</span><b>${fmtPick(reach)}</b><span class="muted">${esc(nm(reach.o))}, ${Math.round(-reach.diff)} picks before ADP</span></div>`;
      $("#draft-table").innerHTML = `<thead><tr><th class="l">Grade</th><th class="l">Manager</th><th class="l">Best value</th><th class="l">Biggest reach</th><th class="l">Keepers</th>${season && season.done ? '<th class="l">Finish</th>' : ""}</tr></thead><tbody>${teams.map((t) => {
        const f = season && season.done ? finish(season, t.o) : null;
        return `<tr class="${t.o === ME ? "me" : ""} ${t.o === open ? "open" : ""}" data-team="${t.o}" tabindex="0">
          <td class="l"><span class="grade">${t.grade}</span></td><td class="l">${who(t.o)}</td>
          <td class="l">${fmtPick(t.best)}</td><td class="l">${fmtPick(t.worst)}</td>
          <td class="l">${t.keepers.map((p) => esc(pname(p.pid))).join(", ") || '<span class="muted">—</span>'}</td>
          ${f ? `<td class="l"><span class="chip ${f.cls}">${f.label}</span></td>` : ""}</tr>`;
      }).join("")}</tbody>`;
      const t = teams.find((x) => x.o === open);
      $("#draft-detail").innerHTML = `<div class="series-head">${who(t.o, "")}<span class="grade big">${t.grade}</span><span class="muted">Draft class value ${Math.round(t.value)} · league average ${Math.round(sum(teams.map((x) => x.value)) / teams.length)}</span></div>
        <div class="tbl-wrap"><table><thead><tr><th class="l">Pick</th><th class="l">Player</th><th class="l">Pos</th><th>ADP</th><th>Value</th></tr></thead><tbody>${t.picks.map((p) =>
          `<tr><td class="l num">${pickLabel(p, size)}</td><td class="l">${esc(pname(p.pid))}${p.keeper ? ' <span class="chip">Keeper</span>' : ""}</td><td class="l muted">${ppos(p.pid) || p.pos}</td>
           <td class="num">${p.adp != null ? p.adp.toFixed(1) : "—"}</td><td class="num ${p.keeper ? "muted" : p.diff >= 0 ? "pos" : "neg"}">${p.keeper ? "—" : (p.diff >= 0 ? "+" : "−") + Math.abs(Math.round(p.diff))}</td></tr>`).join("")}</tbody></table></div>`;
      $("#draft-note").textContent = `Grades compare each roster to Sleeper's ADP, saved ${new Date(d.snap.taken_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}. Value is how many picks after ADP a player was taken; keepers count toward the roster but not toward steals and reaches.`;
    };
    $("#draft-tabs").onclick = (e) => { const b = e.target.closest("button[data-year]"); if (b) { year = window.__draftYear = b.dataset.year; render(); } };
    const pickRow = (e) => { const r = e.target.closest("tr[data-team]"); if (r && !e.target.closest("button")) { open = r.dataset.team; render(); } };
    $("#draft-table").onclick = pickRow;
    $("#draft-table").onkeydown = (e) => { if (e.key === "Enter") pickRow(e); };
    render();
  }
}

/* ---------- trades ---------- */
{
  const T = D.trades;
  $("#trades").hidden = !T.length;
  if (T.length) {
    const pidx = {};
    for (const [y, w, o, pid, p] of D.perfs) (pidx[o + "|" + pid] ||= []).push([y, w, p]);
    // A player counts for a trade only while that trade kept him on the roster: the rest of that season,
    // later seasons only if he was kept as a keeper each year, and never after he's traded away.
    const kept = new Set();
    for (const d of D.drafts) for (const p of d.picks) if (p.keeper) kept.add(`${d.year}|${p.o}|${p.pid}`);
    const years = D.seasons.map((s) => s.year).sort();
    const tenure = (o, pid, y, w0, created) => {
      const out = D.trades.filter((u) => u.created > created && !u.reversed && u.sides.some((s) => s.o === o)
        && u.sides.some((s) => s.o !== o && s.players.includes(pid))).sort((a, b) => a.created - b.created)[0];
      const ok = new Set([y]);
      for (const yy of years.filter((x) => x > y)) { if (kept.has(`${yy}|${o}|${pid}`)) ok.add(yy); else break; }
      return (pidx[o + "|" + pid] || []).filter(([yy, ww]) => ok.has(yy) && (yy > y || ww >= w0)
        && (!out || yy < out.y || (yy === out.y && ww < out.leg)));
    };
    const scored = T.map((t) => {
      const sidesOut = t.sides.map((s) => {
        const assets = [
          ...s.players.map((pid) => ({ label: esc(pname(pid)), pos: ppos(pid), games: tenure(s.o, pid, t.y, t.leg, t.created) })),
          ...s.picks.map((pk) => ({ label: `${pk.season} round ${pk.round} pick${pk.orig && pk.orig !== s.o ? ` (${esc(nm(pk.orig))}'s)` : ""}${pk.pid ? ` → ${esc(pname(pk.pid))}` : " (not yet used)"}`,
            pos: pk.pid ? ppos(pk.pid) : "", games: pk.pid ? tenure(s.o, pk.pid, pk.season, 1, t.created) : [] })),
        ].map((a) => ({ ...a, pts: sum(a.games.map((g) => g[2])) }));
        return { ...s, assets, pts: sum(assets.map((a) => a.pts)) };
      }).sort((a, b) => b.pts - a.pts);
      const played = sidesOut.some((s) => s.assets.some((a) => a.games.length));
      const margin = sidesOut.length > 1 ? sidesOut[0].pts - sidesOut[1].pts : 0;
      return { ...t, sides: sidesOut, margin, played, winner: !t.reversed && played && margin >= 1 ? sidesOut[0].o : null };
    });

    // Trade record per manager.
    const rec = {};
    for (const t of scored.filter((x) => !x.reversed)) for (const s of t.sides) {
      const r = (rec[s.o] ||= { o: s.o, n: 0, w: 0, l: 0, net: 0 });
      r.n++;
      if (t.winner === s.o) r.w++; else if (t.winner) r.l++;
      if (t.sides.length === 2) r.net += s.pts - t.sides.find((x) => x !== s).pts;
    }
    $("#tr-summary").innerHTML = `<thead><tr><th class="l">Manager</th><th>Trades</th><th>Won</th><th>Lost</th><th>Net points</th></tr></thead><tbody>${Object.values(rec).sort((a, b) => b.net - a.net).map((r) =>
      `<tr class="${r.o === ME ? "me" : ""}"><td class="l">${who(r.o)}</td><td class="num">${r.n}</td><td class="num">${r.w}</td><td class="num">${r.l}</td><td class="num ${r.net >= 0 ? "pos" : "neg"}">${r.net >= 0 ? "+" : "−"}${f1(Math.abs(r.net))}</td></tr>`).join("")}</tbody>`;

    const traders = [...new Set(scored.flatMap((t) => t.sides.map((s) => s.o)))].sort((a, b) => nm(a).localeCompare(nm(b), undefined, { sensitivity: "base" }));
    if (window.__trMgr === undefined) window.__trMgr = ME && traders.includes(ME) ? ME : "";
    $("#tr-mgr").innerHTML = `<option value="">All managers</option>` + traders.map((o) => `<option value="${o}">${esc(nm(o))}${o === ME ? " (you)" : ""}</option>`).join("");
    $("#tr-mgr").value = traders.includes(window.__trMgr) ? window.__trMgr : "";
    $("#tr-sort").value = window.__trSort || "new";
    const date = (ms) => new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const list = () => {
      const m = $("#tr-mgr").value, sort = $("#tr-sort").value;
      const rows = scored.filter((t) => !m || t.sides.some((s) => s.o === m))
        .sort(sort === "lopsided" ? (a, b) => (a.reversed - b.reversed) || b.margin - a.margin : (a, b) => b.created - a.created);
      $("#tr-count").textContent = `${rows.length} trade${rows.length === 1 ? "" : "s"}`;
      $("#tr-list").innerHTML = rows.map((t) => {
        const total = sum(t.sides.map((s) => s.pts)) || 1;
        const verdict = t.reversed ? '<span class="chip">Reversed</span>' : !t.played ? '<span class="chip">Too early to call</span>'
          : t.winner ? `<span class="chip win">${esc(nm(t.winner))} by ${f1(t.margin)}</span>` : '<span class="chip">Even</span>';
        return `<article class="panel trade ${t.sides.some((s) => s.o === ME) ? "mine" : ""} ${t.reversed ? "reversed" : ""}">
          <div class="trade-head"><span class="muted">${date(t.created)} · ${t.y} Week ${t.leg}</span>${verdict}</div>
          <div class="bar">${t.sides.map((s, i) => `<span class="seg s${i}" style="flex:${Math.max(s.pts, total * 0.02)}"></span>`).join("")}</div>
          <div class="trade-sides">${t.sides.map((s, i) => `<div class="side-col">
            <div class="side-top"><span class="key s${i}"></span>${who(s.o)}<span class="num">${f1(s.pts)} pts</span></div>
            <p class="muted small">Received</p>
            ${s.assets.map((a) => `<details><summary><span>${a.label} <span class="muted">${a.pos || ""}</span></span><span class="num">${f1(a.pts)}${a.games.length ? ` · ${a.games.length} starts` : ""}</span></summary>
              <div class="wk-chips">${a.games.length ? a.games.map(([yy, ww, p]) => `<span>${yy !== t.y ? yy + " " : ""}Wk ${ww}: <b class="num">${f1(p)}</b></span>`).join("") : '<span class="muted">No starts for this team yet.</span>'}</div></details>`).join("")}
            ${s.faab ? `<p class="small">$${s.faab} FAAB</p>` : ""}
          </div>`).join("")}</div></article>`;
      }).join("") || '<p class="muted">No trades match.</p>';
    };
    $("#tr-mgr").onchange = () => { window.__trMgr = $("#tr-mgr").value; list(); };
    $("#tr-sort").onchange = () => { window.__trSort = $("#tr-sort").value; list(); };
    list();
  }
}

/* ---------- this week's live scoreboard ---------- */
{
  const lw = D.liveWeek;
  const show = !!(lw && lw.games.length);
  $("#sb-head").hidden = !show; $("#scoreboard").hidden = !show;
  if (show) {
    const started = lw.games.some((g) => g.pa || g.pb);
    $("#sb-title").textContent = `Week ${lw.week} scoreboard${started ? " · live" : " · not started"}`;
    const gamesSorted = lw.games.slice().sort((x, y) => (y.a === ME || y.b === ME) - (x.a === ME || x.b === ME));
    $("#scoreboard").innerHTML = gamesSorted.map((g) => `<div class="panel sb ${g.a === ME || g.b === ME ? "mine" : ""}">${[[g.a, g.pa, g.pb], [g.b, g.pb, g.pa]].map(([o, p, q]) =>
      `<div class="${started && p > q ? "lead" : ""}">${who(o)}<span class="num">${f2(p)}</span></div>`).join("")}</div>`).join("");
  }
}
}

// Any manager name elsewhere on the page opens their profile.
document.addEventListener("click", (e) => {
  const b = e.target.closest("button.mgr-link"); if (!b) return;
  if (window.__renderProfile) window.__renderProfile(b.dataset.mgr);
  document.getElementById("managers").scrollIntoView();
});

let loading = false;
async function load(force) {
  if (loading) return;
  loading = true;
  const btn = $("#refresh"), row = $("#status-row");
  btn.disabled = true;
  $("#status").textContent = "Updating from Sleeper…";
  try {
    const [raw, players] = await Promise.all([fetchHistory(force), fetchPlayers()]);
    const snaps = await fetchSnapshots(raw.map((s) => s.league.season));
    render(compute(raw, players, snaps));
    const first = $("#app").hidden;
    $("#loading").hidden = true; $("#app").hidden = false;
    // Content arrives after the browser's own jump to #anchor, so do the jump once it exists.
    if (first && location.hash.length > 1) {
      const id = location.hash.slice(1);
      const el = document.getElementById(id.startsWith("week-") ? "newsletter" : id);
      if (el) el.scrollIntoView();
    }
    row.className = "status-row ok";
    $("#status").textContent = updateReady ? "A new version of the Hall of Fame is ready."
      : `Live from Sleeper · updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  } catch (err) {
    console.error(err);
    row.className = "status-row err";
    $("#status").textContent = "Couldn't reach Sleeper. Check your connection and press Refresh.";
    if ($("#app").hidden) { $("#loading").classList.add("err"); $("#loading").textContent = `Couldn't load the league from Sleeper (${err.message}). Press Refresh to try again.`; }
  } finally {
    loading = false; btn.disabled = false;
  }
}

// Poll every minute while this week's scores are moving, otherwise every five.
let lastScores = null, scoresMoving = false;
function noteScores() {
  const lw = lastData && lastData.liveWeek;
  const now = lw ? JSON.stringify(lw.games.map((g) => [g.pa, g.pb])) : "";
  scoresMoving = lastScores !== null && now !== lastScores;
  lastScores = now;
}
let lastData = null;
const _render = render;
render = (D) => { lastData = D; _render(D); noteScores(); if ($("#me-area").dataset.mode !== "form") renderMe(); };

// "Sign in" is just saying which Sleeper account you are. All league data is public, so no password is involved.
const ME_KEY = "hof:me";
try { window.__me = localStorage.getItem(ME_KEY) || null; } catch { window.__me = null; }
function rerender() { window.__trMgr = undefined; if (lastData) render(lastData); }
function renderMe() {
  const area = $("#me-area");
  const m = window.__me && lastData && lastData.managers[window.__me];
  if (m) {
    area.innerHTML = '<span>Signed in as <b></b></span><button class="btn" type="button" id="me-out">Sign out</button>';
    area.querySelector("b").textContent = m.name;
    $("#me-out").onclick = () => { window.__me = null; try { localStorage.removeItem(ME_KEY); } catch { /* blocked */ } rerender(); };
  } else if (area.dataset.mode === "form") {
    area.innerHTML = `<form id="me-form" class="me-form"><label for="me-input" class="sr">Sleeper username</label>
      <input id="me-input" autocomplete="username" autocapitalize="none" spellcheck="false" placeholder="Sleeper username" required>
      <button class="btn">Sign in</button><button class="btn" type="button" id="me-cancel">Cancel</button><span id="me-err" role="status"></span></form>`;
    $("#me-input").focus();
    $("#me-cancel").onclick = () => { area.dataset.mode = ""; renderMe(); };
    $("#me-form").onsubmit = async (e) => {
      e.preventDefault();
      const u = $("#me-input").value.trim();
      if (!u) return;
      $("#me-err").textContent = "Checking…";
      try {
        const r = await fetch(API + "user/" + encodeURIComponent(u));
        const user = r.ok ? await r.json() : null;
        if (!user || !user.user_id) { $("#me-err").textContent = "No Sleeper account has that username."; return; }
        if (!lastData || !lastData.managers[user.user_id]) { $("#me-err").textContent = `${user.display_name || u} isn't in this league.`; return; }
        window.__me = user.user_id;
        try { localStorage.setItem(ME_KEY, user.user_id); } catch { /* remembered for this visit only */ }
        area.dataset.mode = "";
        rerender();
      } catch { $("#me-err").textContent = "Couldn't reach Sleeper. Try again."; }
    };
  } else {
    area.innerHTML = '<button class="btn" type="button" id="me-in">Sign in</button>';
    $("#me-in").onclick = () => { area.dataset.mode = "form"; renderMe(); };
  }
}

function schedule() {
  setTimeout(async () => {
    if (document.visibilityState === "visible") { await load(false); await checkForUpdate(); }
    schedule();
  }, scoresMoving ? LIVE_REFRESH_MS : REFRESH_MS);
}

// Reload when a new version of the site is published, so every viewer runs the same code.
const versions = {};
let updateReady = false;
async function checkForUpdate() {
  if (updateReady || location.protocol === "file:") return;
  for (const f of ["app.js", "index.html"]) {
    try {
      const r = await fetch(f, { method: "HEAD", cache: "no-store" });
      const v = r.headers.get("etag") || r.headers.get("last-modified");
      if (!r.ok || !v) continue;
      if (versions[f] && versions[f] !== v) updateReady = true;
      versions[f] = v;
    } catch { /* offline; try again next time */ }
  }
  if (updateReady) {
    $("#status").textContent = "A new version of the Hall of Fame is ready.";
    $("#refresh").textContent = "Update";
    $("#refresh").onclick = () => location.reload();
  }
}

$("#refresh").onclick = () => load(false);
document.addEventListener("visibilitychange", () => {
  if (updateReady && document.visibilityState === "visible") return location.reload();
  if (document.visibilityState === "visible") { load(false); checkForUpdate(); }
});
load(false).then(checkForUpdate);
schedule();
