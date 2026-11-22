// Reanalysis: re-label already-played positions with a DEPTH-FORCED search, so the
// training target carries information a shallow game did not (see PLAN.md
// "데이터 질 개선", ExperimentNote.md 12).
//
// Input: a jsonl(.gz) whose records carry the FULL engine state in
// `policy.state` (self-play with SELFPLAY_RECORD_STATE, e.g. the data branch's
// datasets/policy-round-20260920.jsonl.gz). Records without it are skipped:
// the ordinary datasets keep only board + deck + turn, and re-searching a
// position with guessed turn counters / rule state gives a different game.
//
// Label: NOT the engine's root search score. That score is a path sum -- every
// applied move adds its own heuristic bonus (capture value, +-120 for castling,
// +-35/+-90/... per move type) and the root adds tacticalSafetyAdjustment
// (up to +-3600) and capturePreference on top of the leaf evaluation -- so it is
// not on the evaluateState scale. Instead this walks the principal variation:
// search at depth D, play the best action, search the result at D-1, ... and
// takes the plain evaluateState of the final position from the ROOT mover's
// view (`searchScore`, so nnue/train.js's existing blend reads it). The raw root
// score is kept as `rawSearchScore` for comparison only.
//
// usage: node tools/reanalyze/reanalyze.js --in <file.jsonl[.gz]> --out <file.jsonl>
//          [--depth 3] [--shard 0 --shards 1] [--limit 0] [--hard-ms 60000]
// Each record selected by (stateIndex % shards === shard) is processed, up to --limit (0 = all).
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const ROOT = path.join(__dirname, "..", "..");
const engine = require(path.join(ROOT, "engine-merged.js"));
const { compactBoard, compactDeck, playOneGame } = require(path.join(ROOT, "selfplay-worker-merged.js"));

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const IN = arg("in"), OUT = arg("out");
const DEPTH = Number(arg("depth", 3));
const SHARD = Number(arg("shard", 0)), SHARDS = Number(arg("shards", 1));
const LIMIT = Number(arg("limit", 0));
const HARD_MS = Number(arg("hard-ms", 60000));
// --mode rollout (2026-11-22): label = mean result of N continuations from the position
// (different seeds, softmax move sampling --tau, fast search --rollout-ms), from the root mover's view.
// Cuts the single-game luck/draw noise of `outcome`. Writes rolloutMean/W/D/L/U; searchScore stays the PV-free static eval.
const MODE = arg("mode", "pv");
const ROLLOUTS = Number(arg("rollouts", 8)), ROLLOUT_MS = Number(arg("rollout-ms", 100)), ROLLOUT_PLIES = Number(arg("rollout-plies", 160)), TAU = Number(arg("tau", 60));
function rollout(fullState, seedBase) {
  const root = engine.cloneState(fullState); engine.setWorkerBoardDimensions(root);
  const mover = root.turn; const t0 = Date.now(); let w = 0, d = 0, l = 0, u = 0;
  for (let k = 0; k < ROLLOUTS; k += 1) {
    const g = playOneGame({ initialState: root, seed: seedBase * 1000 + k + 1, searchDepth: 2, searchTimeMs: ROLLOUT_MS, maxPlies: ROLLOUT_PLIES, sampleTau: TAU, recordPolicy: false });
    const o = g.outcome;
    if (o === mover) w += 1; else if (o === "unfinished") u += 1; else if (o === "draw") d += 1; else l += 1;
  }
  const n = w + d + l + u;
  return { rolloutMean: n ? (w - l) / n : 0, rolloutW: w, rolloutD: d, rolloutL: l, rolloutU: u, rollouts: n,
    evalBefore: Math.round(Math.max(-TERMINAL_CAP, Math.min(TERMINAL_CAP, engine.evaluateState(root, mover)))), ms: Date.now() - t0 };
}
// --mode puzzle (2026-11-22): depth-forced root search; keeps the best action, the gap to the
// second-best root candidate, and the candidate count. Positions with a large gap are "only move"
// tactic candidates (a puzzle set that measures move choice without playing games).
function puzzle(fullState) {
  const root = engine.cloneState(fullState); engine.setWorkerBoardDimensions(root);
  const t0 = Date.now(); const r = search(root, DEPTH);
  if (!r || !r.action) return { puzzleGap: null, ms: Date.now() - t0 };
  const c = (r.candidates || []).filter((x) => x && Number.isFinite(x.score)).sort((a, b) => b.score - a.score);
  return { bestAction: r.action, bestScore: Math.round(r.score), puzzleGap: c.length > 1 ? Math.round(c[0].score - c[1].score) : null,
    nCandidates: c.length, completedDepth: r.completedDepth ?? null, reDepth: DEPTH, nodes: r.nodes, state: fullState, ms: Date.now() - t0 };
}
if (!IN || !OUT) { console.error("need --in and --out"); process.exit(2); }

const TERMINAL_CAP = 4000; // terminal scores are +-1e5; keep them on a finite scale

function isCaptureAction(state, action) {
  if (!action || action.type !== "move") return false;
  try { return engine.workerActionCaptureSwing ? engine.workerActionCaptureSwing(state, action, state.turn).count > 0 : Boolean(state.board[action.move.row]?.[action.move.col]); }
  catch (e) { return Boolean(state.board[action.move?.row]?.[action.move?.col]); }
}

function search(state, depth) {
  const color = state.turn;
  const actions = engine.generateActions(state, color);
  if (!actions.length) return null;
  return engine.searchBestAction(state, actions, color, depth, HARD_MS, {
    limits: { depth, minDepth: depth, movetimeMs: HARD_MS, hardTimeMs: HARD_MS, extend: false, predictiveStop: false }
  });
}

function reanalyze(fullState) {
  const root = engine.cloneState(fullState);
  engine.setWorkerBoardDimensions(root);
  const mover = root.turn;
  const staticRoot = engine.evaluateState(root, mover);
  const t0 = Date.now();
  let state = root, nodes = 0, pv = 0, rawSearchScore = null, firstDepth = null, captures = 0, hitCap = false, terminal = false;
  for (let k = 0; k < DEPTH; k += 1) {
    if (state.mode === "gameover") { terminal = true; break; }
    const d = Math.max(1, DEPTH - k);
    const r = search(state, d);
    if (!r || !r.action) break;
    nodes += r.nodes || 0;
    if (k === 0) { rawSearchScore = r.score; firstDepth = r.completedDepth ?? null; }
    if ((r.completedDepth ?? 0) < d) hitCap = true;
    const next = engine.cloneState(state);
    engine.setWorkerBoardDimensions(next);
    if (k < 2 && isCaptureAction(state, r.action)) captures += 1;
    const applied = engine.applyAction(next, r.action, state.turn);
    if (!applied || !applied.ok) break;
    state = next;
    pv += 1;
  }
  if (state.mode === "gameover") terminal = true;
  let leaf = engine.evaluateState(state, mover);
  leaf = Math.max(-TERMINAL_CAP, Math.min(TERMINAL_CAP, leaf));
  return {
    searchScore: Math.round(leaf),
    rawSearchScore: rawSearchScore === null ? null : Math.round(rawSearchScore),
    evalBefore: Math.round(Math.max(-TERMINAL_CAP, Math.min(TERMINAL_CAP, staticRoot))),
    completedDepth: firstDepth,
    reDepth: DEPTH,
    pvLen: pv,
    pvCaptures: captures, // captures among the first two PV moves: >0 = not a quiet position
    terminal,
    hitCap,
    nodes,
    ms: Date.now() - t0
  };
}

async function main() {
  const input = fs.createReadStream(IN);
  const stream = IN.endsWith(".gz") ? input.pipe(zlib.createGunzip()) : input;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const out = fs.createWriteStream(OUT);
  let stateIdx = -1, done = 0, failed = 0, totalMs = 0;
  for await (const line of rl) {
    if (!line) continue;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { continue; }
    const full = rec.policy && rec.policy.state;
    if (!full || !full.board) continue;
    stateIdx += 1;
    if (stateIdx % SHARDS !== SHARD) continue;
    if (full.mode && full.mode !== "play") continue;
    try {
      const res = MODE === "rollout" ? rollout(full, stateIdx) : MODE === "puzzle" ? puzzle(full) : reanalyze(full);
      totalMs += res.ms;
      out.write(JSON.stringify({
        board: compactBoard(full.board),
        deckSlots: compactDeck(full.deckSlots),
        turn: full.turn,
        outcome: rec.outcome ?? 0,
        unfinished: rec.unfinished || undefined,
        tainted: rec.tainted || undefined,
        ...res
      }) + "\n");
      done += 1;
    } catch (e) {
      failed += 1;
      if (failed <= 5) console.error("position", stateIdx, "failed:", e && e.message);
    }
    if (done && done % 100 === 0) console.log(`shard ${SHARD}: ${done} done, ${failed} failed, avg ${(totalMs / done).toFixed(0)} ms/position`);
    if (LIMIT && done >= LIMIT) break;
  }
  await new Promise((res) => out.end(res));
  console.log(`shard ${SHARD}/${SHARDS}: ${done} positions written, ${failed} failed, avg ${done ? (totalMs / done).toFixed(0) : 0} ms/position`);
  if (!done) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
