#!/usr/bin/env node
// Texel tuning for evaluateState()'s hand-picked weighted-sum coefficients
// (engine-merged.js, ~L15699-15713). Fits the 8 "*Enemy"/material multipliers
// against real self-play win/loss/draw data instead of leaving them as
// hand-tuned guesses (1.35, 0.88, 0.72, 0.65, 0.82, 0.82, 0.92, 0.9).
//
// Method (classic Texel tuning): for each kept position, run
// evaluateStateComponents() once to get its named sub-scores (this never
// touches engine-merged.js -- see tools/tune/tuned-eval.js for the
// weighted-sum recombination used elsewhere at search time), squash the
// resulting score with a sigmoid(score/K) to predict a win probability, and
// gradient-descend (Adam) the 8 tunable coefficients to minimize MSE against
// the real game outcome (1 win / 0.5 draw / 0 loss, from the mover's side).
// The engine's own self-vs-enemy asymmetric formula is exactly preserved --
// only the 8 named coefficients move, everything else (exchange, the *Self
// terms, ultimatum, persistentObjectives, bonus, tacticalSafety) keeps its
// fixed weight of 1 (matching evaluateState()'s own formula), so this can't
// discover a completely different shape, only re-tune the ratios that were
// already hand-picked.
//
// Data format: one JSON object per line (data/experiments/selfplay-data.*),
// each carrying {board, deckSlots, turn, outcome, unfinished,
// explorationTainted, completedDepth, ...} -- see selfplay-worker-merged.js
// L718-733 for how `outcome` is assigned (+1/-1/0 relative to `turn`, the
// side to move in that position; unfinished games get 0 and are skipped
// below, same filter nnue/tune-eval.js already uses).
//
// Streaming: reads every file with gunzip -> readline (never
// fs.readFileSync-ing a whole file, following tools/policy/common.js's
// streamExamples() pattern) and immediately reduces each line to ~10 plain
// numbers (the 8 tunable components + a fixed baseline + the label),
// discarding the board/deckSlots JSON right away. Peak memory is roughly
// (kept examples) * 10 numbers, not raw JSON -- a few hundred thousand
// positions is tens of MB, not the multi-hundred-MB raw file size. Use
// --limit to cap it further on a very low-RAM machine.
//
// Usage:
//   node tools/tune/texel-tune.js <data.jsonl...> [--iterations=200]
//     [--out=tools/tune/weights.json] [--k=400] [--lr=0.05] [--limit=0]
//     [--min-depth=0]
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const ROOT = path.resolve(__dirname, "..", "..");
const engine = require(path.join(ROOT, "engine-merged.js"));
const { TUNABLE, DEFAULT_WEIGHTS } = require("./tuned-eval.js");

function parseArgs(argv) {
  const files = [];
  const opts = { iterations: 200, out: path.join(__dirname, "weights.json"), k: 1200, lr: 0.02, limit: 0, minDepth: 0, reg: 0.02 };
  for (const a of argv) {
    const m = /^--([a-zA-Z-]+)=(.*)$/.exec(a);
    if (!m) { files.push(a); continue; }
    const key = m[1];
    const val = m[2];
    if (key === "iterations") opts.iterations = Number(val);
    else if (key === "out") opts.out = path.resolve(process.cwd(), val);
    else if (key === "k") opts.k = Number(val);
    else if (key === "lr") opts.lr = Number(val);
    else if (key === "limit") opts.limit = Number(val);
    else if (key === "min-depth") opts.minDepth = Number(val);
    else if (key === "reg") opts.reg = Number(val);
    else throw new Error("unknown flag --" + key);
  }
  if (!files.length) throw new Error("usage: node tools/tune/texel-tune.js <data.jsonl...> [--iterations=200] [--out=weights.json] [--k=1200] [--lr=0.02] [--reg=0.02] [--limit=N] [--min-depth=N]");
  return { files, opts };
}

function makeState(board) {
  // Same minimal reconstruction nnue/tune-eval.js's makeState() uses: these
  // records don't carry a full rehydratable state (no piece ids/anchors),
  // just a flat board of {t, c}. deckSlots/captures are left empty and
  // aiSearchNoCards is set so card-dependent sub-scores don't try to read
  // deck state that isn't there.
  const state = engine.cloneState({});
  state.board = board.map((row) => row.map((p) => (p ? { type: p.t, color: p.c, moved: true } : null)));
  state.mode = "play";
  state.deckSlots = { white: [], black: [] };
  state.captures = { white: [], black: [] };
  state.aiSearchNoCards = true;
  engine.setWorkerBoardDimensions(state);
  return state;
}

// Fixed (non-tunable) part of evaluateState()'s formula: everything except
// the 8 TUNABLE coefficients, each at its own hard-coded weight of 1 (or -1
// for persistentObjectivesEnemy), exactly as engine-merged.js's
// evaluateState() computes it (~L15702-15712).
function baselineFromComponents(c) {
  return c.exchange
    + c.positionSelf + c.kingSafetySelf + c.pressureSelf + c.specialSelf
    + c.bloodMoonSelf + c.cardsSelf + c.campaignSelf
    + c.ultimatum
    + (c.persistentObjectivesSelf - c.persistentObjectivesEnemy)
    + c.bonus + c.tacticalSafety;
}

async function streamDataset(files, minDepth, limit, onExample) {
  let kept = 0, skippedFilter = 0, skippedTerminal = 0, total = 0;
  for (const f of files) {
    const input = f.endsWith(".gz") ? fs.createReadStream(f).pipe(zlib.createGunzip()) : fs.createReadStream(f);
    const rl = readline.createInterface({ input, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      total += 1;
      let e;
      try { e = JSON.parse(line); } catch (err) { continue; }
      // Same filter nnue/tune-eval.js applies: exploration plies and
      // unfinished games are noisy/unreliable outcome labels.
      if (e.explorationTainted || e.unfinished) { skippedFilter += 1; continue; }
      if (minDepth && (e.completedDepth || 0) < minDepth) { skippedFilter += 1; continue; }
      if (typeof e.outcome !== "number" || !e.board || !e.turn) { skippedFilter += 1; continue; }
      const state = makeState(e.board);
      const c = engine.evaluateStateComponents(state, e.turn);
      if (c.terminal !== null && c.terminal !== undefined) { skippedTerminal += 1; continue; }
      // Sample weight: same geometric decay by pliesFromEnd nnue/train.js uses
      // (PLIES_FROM_END_DECAY=0.98) -- a whole-game outcome is a much more
      // reliable label for a position a few plies before the result than for
      // one from early/mid-game, where the shallow self-play search that
      // produced this data (completedDepth mostly 0-1) could easily have let
      // the eventual result hinge on unrelated later moves. Missing/older
      // data without pliesFromEnd gets weight 1 (untouched).
      const sw = typeof e.pliesFromEnd === "number" ? Math.pow(0.98, e.pliesFromEnd) : 1;
      const row = { baseline: baselineFromComponents(c), y: (e.outcome + 1) / 2, sw };
      for (const t of TUNABLE) row[t.key] = c[t.component];
      onExample(row);
      kept += 1;
      if (limit && kept >= limit) { rl.close(); input.destroy(); return { kept, skippedFilter, skippedTerminal, total }; }
    }
  }
  return { kept, skippedFilter, skippedTerminal, total };
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

function scoreOf(row, w) {
  let s = row.baseline;
  for (const t of TUNABLE) s += t.sign * w[t.key] * row[t.component];
  return s;
}

// Weighted mean squared error (sample weight = pliesFromEnd decay above).
function meanLoss(rows, w, k) {
  let sum = 0, wsum = 0;
  for (const row of rows) {
    const pred = sigmoid(scoreOf(row, w) / k);
    const diff = pred - row.y;
    sum += row.sw * diff * diff;
    wsum += row.sw;
  }
  return sum / wsum;
}

// Full-batch Adam gradient descent on the 8 tunable coefficients, with L2
// regularization pulling each coefficient back toward evaluateState()'s own
// hand-tuned default. With only 8 correlated features and a noisy/shallow
// self-play outcome label, unregularized descent easily runs away (e.g.
// material's weight collapsing toward 0 while an unrelated term's explodes)
// while still lowering MSE -- classic overfitting to label noise. Pulling
// toward the known-reasonable hand-tuned starting point keeps the fit close
// to "re-tune the existing ratios" rather than "discover an unconstrained
// new formula from a few thousand noisy positions."
// dLoss/dw_t = mean( 2*(pred-y) * pred*(1-pred)/k * sign_t * component_t )
//            + 2*reg*(w_t - default_t).
function fit(rows, opts) {
  const w = { ...DEFAULT_WEIGHTS };
  const m = {}, v = {};
  for (const t of TUNABLE) { m[t.key] = 0; v[t.key] = 0; }
  const beta1 = 0.9, beta2 = 0.999, eps = 1e-8;
  const wsum = rows.reduce((s, r) => s + r.sw, 0);
  const before = meanLoss(rows, w, opts.k);
  for (let iter = 1; iter <= opts.iterations; iter++) {
    const grad = {};
    for (const t of TUNABLE) grad[t.key] = 0;
    for (const row of rows) {
      const score = scoreOf(row, w);
      const pred = sigmoid(score / opts.k);
      const diff = pred - row.y;
      const dLdScore = 2 * row.sw * diff * pred * (1 - pred) / opts.k;
      for (const t of TUNABLE) grad[t.key] += dLdScore * t.sign * row[t.component];
    }
    for (const t of TUNABLE) {
      const g = grad[t.key] / wsum + 2 * opts.reg * (w[t.key] - t.default);
      m[t.key] = beta1 * m[t.key] + (1 - beta1) * g;
      v[t.key] = beta2 * v[t.key] + (1 - beta2) * g * g;
      const mHat = m[t.key] / (1 - beta1 ** iter);
      const vHat = v[t.key] / (1 - beta2 ** iter);
      w[t.key] -= opts.lr * mHat / (Math.sqrt(vHat) + eps);
    }
    if (iter === 1 || iter % Math.max(1, Math.floor(opts.iterations / 10)) === 0 || iter === opts.iterations) {
      console.log(`  iter ${String(iter).padStart(4)}  loss ${meanLoss(rows, w, opts.k).toFixed(5)}`);
    }
  }
  const after = meanLoss(rows, w, opts.k);
  return { w, before, after };
}

// Sign-agreement accuracy on decisive (non-draw) positions -- same metric
// nnue/tune-eval.js reports, comparable across both tools.
function decisiveAccuracy(rows, w) {
  const decisive = rows.filter((r) => r.y !== 0.5);
  if (!decisive.length) return null;
  let correct = 0;
  for (const row of decisive) {
    const score = scoreOf(row, w);
    const label = row.y > 0.5 ? 1 : -1;
    if (Math.sign(score) === label) correct += 1;
  }
  return correct / decisive.length;
}

(async () => {
  const { files, opts } = parseArgs(process.argv.slice(2));
  console.log("data files:", files.join(", "));
  console.log(`streaming (min-depth=${opts.minDepth}, limit=${opts.limit || "none"})...`);

  const rows = [];
  const stats = await streamDataset(files, opts.minDepth, opts.limit, (row) => rows.push(row));
  console.log(`lines seen: ${stats.total}  kept: ${stats.kept}  skipped(filter): ${stats.skippedFilter}  skipped(terminal): ${stats.skippedTerminal}`);
  if (rows.length < 10) throw new Error("too few usable positions to tune (" + rows.length + ") -- pass more/different data files");

  console.log(`\nfitting ${TUNABLE.length} coefficients over ${rows.length} positions (K=${opts.k}, lr=${opts.lr}, iterations=${opts.iterations})...`);
  const { w, before, after } = fit(rows, opts);

  console.log("\nfitted weights (original -> tuned):");
  for (const t of TUNABLE) console.log(`  ${t.key.padEnd(16)} ${t.default.toFixed(4)} -> ${w[t.key].toFixed(4)}`);

  const accBefore = decisiveAccuracy(rows, DEFAULT_WEIGHTS);
  const accAfter = decisiveAccuracy(rows, w);
  console.log(`\nMSE loss   before: ${before.toFixed(5)}   after: ${after.toFixed(5)}   (${(100 * (before - after) / before).toFixed(1)}% reduction)`);
  if (accBefore !== null) console.log(`sign-agreement (decisive positions, in-sample)   before: ${(100 * accBefore).toFixed(1)}%   after: ${(100 * accAfter).toFixed(1)}%`);

  fs.mkdirSync(path.dirname(opts.out), { recursive: true });
  fs.writeFileSync(opts.out, JSON.stringify({ weights: w, k: opts.k, trainedOn: files, examples: rows.length, before, after }, null, 2));
  console.log("\nwrote", opts.out);
})().catch((err) => { console.error(err); process.exit(1); });
