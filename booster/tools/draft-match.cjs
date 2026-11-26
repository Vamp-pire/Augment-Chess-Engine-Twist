// Full games with the game's own rules (drafts included), both sides played
// by the fast adapter. Side A drafts with the draft-time probe (C) added to a
// base draft score, side B with the base score only. Each pair replays one
// seed with colors swapped.
//
//   node tools/draft-match.cjs <worker.js> [--pairs 10] [--ms 400] [--workers 2] [--seed 1] [--mode normal] [--log games.jsonl]
//
// Base draft score (simplified copy of the game's evaluateDraftCardForAi,
// without its board-context bonuses): stars x 2 + piece card 0.8 + effect
// bonus + passive 0.7; weighted pick, temperature 1.1 within 2.8 of the best.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { fork } = require("child_process");

const EFFECT_BONUS = {
  holdout: 0.8, fileSurge: 0.8, rookLift: 0.8, inertia: 0.75, chimera: 0.9, canceling: 0.7, underpromotion: 0.6, stake: 0.5,
  finalWeapon: 0.9, localConscription: 0.5, fanaticalRitual: 0.8, recycling: 0.6, pawnStorm: 0.6, queenAfterimage: 0.6,
  deathSquad: 0.5, desperado: 0.7, whiteBox: 0.7, blackBox: 0.7, trolley: 0.8, pawnSprint: 0.65, pawnLeap: 0.7,
  pawnConversion: 0.65, schrodingerPawns: 0.65, imperialStudies: 0.8, religiousVictory: 0.55, scarecrow: 0.45,
  necromancy: 0.65, othello: 0.7, fianchetto: 0.45, ruleTicket: 0.45, insight: 0.5, prophecy: 0.75, charge: 0.75
};
const MAX_BONUS = 4, PROBE_MS = 400, PROBE_BUDGET = 5800, PROBE_BUDGET_OPENING = 9300;

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function pickVariety(scored, rand, temperature = 1.1, window = 2.8) {
  const best = Math.max(...scored.map((e) => e.score));
  const pool = scored.filter((e) => e.score >= best - window);
  const w = pool.map((e) => Math.exp((e.score - best) / temperature));
  let t = rand() * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < pool.length; i++) { t -= w[i]; if (t <= 0) return pool[i]; }
  return pool[pool.length - 1];
}

async function playGame(game, useC, seedText, ms, rand, stats, pickers = null) {
  const configuration = await game.createGameConfiguration({ mode: stats.mode });
  const session = await game.CanonicalEditorSession.create({
    gameId: crypto.randomUUID(), configuration,
    seed: crypto.createHash("sha256").update(seedText).digest("base64url"),
    localOptions: { deathmatchEnabled: true }
  });
  session.disableLocalFirstMoveLimit?.();
  const baseScore = (cardId) => {
    const d = game.cardDefinition(cardId) || {};
    return (d.ratingHalfStars || 0) + (d.draftCategory === "PIECE" ? 0.8 : 0) + (EFFECT_BONUS[d.effect] || 0) + (d.activation === "PASSIVE" ? 0.7 : 0);
  };
  const drafts = [];
  for (let step = 0; step < 600; step++) {
    const g = session.snapshot().game;
    if (g.status === "FINISHED") {
      const w = g.position?.winner ?? g.winner ?? null;
      return { result: w === "white" ? 1 : w === "black" ? 0 : 0.5, plies: g.moveCount, drafts, end: g.position?.termination ?? null };
    }
    if (g.status === "DRAFTING") {
      const actor = g.cardState.draft.pickingColor ?? g.position.turn;
      const q = session.draftChoices(actor);
      if (!q.ok) return { result: 0.5, error: `draftChoices ${q.code}`, drafts };
      const scored = q.choices.map((c) => ({ c, score: baseScore(c.cardId) }));
      let probe = null;
      if (useC[actor]) { // first draft too, with a longer budget (as the extension)
        try {
          const snap = await game.prepareCanonicalAiSearchSnapshot(session.searchSnapshot());
          probe = await game.adapter.draftProbe(snap, actor, null, { perMs: PROBE_MS, deadline: performance.now() + (g.moveCount > 0 ? PROBE_BUDGET : PROBE_BUDGET_OPENING) });
        } catch (e) { probe = { ok: false, reason: String(e?.message || e) }; }
        if (process.env.DUMP_FAIL && probe && !probe.ok) fs.writeFileSync(process.env.DUMP_FAIL, JSON.stringify({ actor, ids: q.choices.map((c) => c.cardId), snap: session.searchSnapshot() }));
        if (probe?.ok) for (const e of scored) {
          const gain = probe.gains[e.c.cardId]?.gain;
          if (typeof gain === "number") e.score += Math.min(MAX_BONUS, gain / 100);
        }
      }
      const chosen = pickVariety(scored, rand);
      const r = await session.dispatch(actor, { schemaVersion: 1, kind: "draft_pick", payload: { offerId: q.offerId, choiceId: chosen.c.choiceId } });
      if (!r.ok) return { result: 0.5, error: `draft ${r.code}`, drafts };
      drafts.push({ actor, ply: g.moveCount, offer: q.choices.map((c) => c.cardId), pick: chosen.c.cardId, c: Boolean(useC[actor]), gains: probe?.ok ? Object.fromEntries(Object.entries(probe.gains).map(([k, v]) => [k, v.gain ?? (v.passive ? "P" : "x")])) : probe ? probe.reason : null });
      continue;
    }
    if (session.localAiAutomaticCardsDue?.()) {
      const r = await session.advanceLocalAiAutomaticCards();
      if (!r?.ok) return { result: 0.5, error: `automatic ${r?.code}`, drafts };
      continue;
    }
    let applied = false;
    try {
      const snap = await game.prepareCanonicalAiSearchSnapshot(session.searchSnapshot());
      const r = await (pickers?.[g.position.turn] ?? game.adapter).pick(snap, { timeMs: ms, includeCards: true, maxCardProbes: 12 });
      if (r.ok && r.candidate) applied = (await game.applyCanonicalAiCandidate(session, r.candidate))?.ok;
    } catch (e) { stats.pickErrors = (stats.pickErrors || 0) + 1; }
    if (!applied) {
      // fallback: the game's own first legal action
      const q = await game.canonicalAiActionCandidates(session, { includeCards: false, maxCardProbes: 0, canContinue: () => true, moveCanContinue: () => true });
      const a = q.actions[0];
      if (!a || !(await game.applyCanonicalAiCandidate(session, a))?.ok) return { result: 0.5, error: "no action", drafts, plies: g.moveCount };
      stats.fallbacks = (stats.fallbacks || 0) + 1;
    }
    if (g.moveCount >= 200) return { result: 0.5, plies: g.moveCount, drafts, end: "ply cap" };
  }
  return { result: 0.5, error: "step cap", drafts };
}

function worker() {
  process.on("message", async ({ workerPath, seeds, ms, mode, seed, adapterA, adapterB, cSide }) => {
    const { loadGame } = require(path.join(__dirname, "harness.cjs"));
    const { game } = loadGame(workerPath, { adapterPath: adapterA });
    // side B's adapter (another fast-adapter.js), else the same as A
    const gameB = adapterB ? loadGame(workerPath, { adapterPath: adapterB }).game : game;
    const rand = rng(seed);
    const out = [];
    for (const s of seeds) {
      for (const aWhite of [true, false]) {
        const stats = { mode };
        const t0 = Date.now();
        const useC = cSide === "none" ? { white: false, black: false } : { white: aWhite, black: !aWhite };
        const pickers = { white: aWhite ? game.adapter : gameB.adapter, black: aWhite ? gameB.adapter : game.adapter };
        let g;
        try { g = await playGame(game, useC, `pair-${s}`, ms, rand, stats, pickers); } catch (e) { g = { result: 0.5, error: String(e?.stack || e).slice(0, 300) }; }
        const scoreA = aWhite ? g.result : 1 - g.result;
        out.push({ pair: s, aWhite, scoreA, ms: Date.now() - t0, ...g, stats });
        process.send({ progress: out[out.length - 1] });
      }
    }
    process.send({ done: out });
    process.exit(0);
  });
}

function summarize(games) {
  const n = games.length, w = games.filter((g) => g.scoreA === 1).length, d = games.filter((g) => g.scoreA === 0.5).length, l = n - w - d;
  const p = (w + d / 2) / n;
  const elo = (x) => -400 * Math.log10(1 / Math.min(Math.max(x, 1e-3), 1 - 1e-3) - 1);
  const byPair = new Map();
  for (const g of games) byPair.set(g.pair, (byPair.get(g.pair) || []).concat(g.scoreA));
  const pairs = [...byPair.values()].filter((v) => v.length === 2).map((v) => (v[0] + v[1]) / 2);
  const mean = pairs.reduce((s, x) => s + x, 0) / Math.max(1, pairs.length);
  const sd = Math.sqrt(pairs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, pairs.length - 1));
  const se = sd / Math.sqrt(Math.max(1, pairs.length));
  const errors = games.filter((g) => g.error).length;
  const mid = games.flatMap((g) => g.drafts || []).filter((x) => x.ply > 0);
  const midC = mid.filter((x) => x.c);
  const changed = midC.filter((x) => x.gains && typeof x.gains === "object" && Object.values(x.gains).some((v) => typeof v === "number" && v > 0)).length;
  return `A side: ${w}W ${d}D ${l}L of ${n}, ${(p * 100).toFixed(1)}%, Elo ${elo(p).toFixed(0)} [${elo(p - 1.96 * se).toFixed(0)}, ${elo(p + 1.96 * se).toFixed(0)}]` +
    `\nerrors ${errors}, mid-game drafts ${mid.length} (C side ${midC.length}, with a positive gain ${changed})`;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
  const workerPath = args[0];
  const pairs = Number(opt("pairs", 10)), ms = Number(opt("ms", 400)), workers = Number(opt("workers", 2)), seed = Number(opt("seed", 1));
  const mode = opt("mode", "normal"), logPath = opt("log", null);
  // --adapter-a/--adapter-b: fast-adapter.js files per side; --c a|none: which side drafts with C
  const adapterA = opt("adapter-a", null), adapterB = opt("adapter-b", null), cSide = opt("c", "a");
  const seeds = Array.from({ length: pairs }, (_, i) => seed * 100000 + i);
  const t0 = Date.now();
  const all = [];
  await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((res, rej) => {
    const child = fork(__filename, ["--child"], { execArgv: ["--max-old-space-size=4096"] });
    child.on("message", (m) => {
      if (m.progress) {
        const g = m.progress;
        all.push(g);
        if (logPath) fs.appendFileSync(logPath, JSON.stringify(g) + "\n");
        console.log(`pair ${g.pair} A=${g.aWhite ? "white" : "black"} scoreA=${g.scoreA} plies=${g.plies ?? "?"} ${Math.round(g.ms / 1000)}s${g.error ? " ERROR " + g.error.slice(0, 120) : ""} drafts=${(g.drafts || []).filter((x) => x.ply > 0).length}`);
      }
      if (m.done) res();
    });
    child.on("error", rej);
    child.on("exit", (code) => { if (code) res(); });
    child.send({ workerPath, seeds: seeds.filter((_, i) => i % workers === w), ms, mode, seed: seed + w, adapterA, adapterB, cSide });
  })));
  console.log(`${mode}, ${ms} ms/move, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(summarize(all));
}

// --summarize <games.jsonl>...: merge result logs (e.g. from cloud shards)
function summarizeFiles(files) {
  const games = files.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  console.log(summarize(games));
}

if (process.argv.includes("--child")) worker();
else if (process.argv.includes("--summarize")) summarizeFiles(process.argv.slice(process.argv.indexOf("--summarize") + 1));
else main();
