#!/usr/bin/env node
// Train a listwise move-scoring model (PLAN.md track B2).
//
//   node tools/policy/train-policy.js <data.jsonl|.jsonl.gz ...> [--out=model.json] [--epochs=30]
//        [--hidden=0] [--lr=0.01] [--l2=1e-4] [--batch=32] [--min-depth=3] [--val-every=5]
//        [--soft=0] [--tau=60] [--seed=1]
//
// Data: self-play records made with SELFPLAY_RECORD_POLICY=1 and SELFPLAY_RECORD_STATE=1 (policy.state present).
// For every record (completedDepth >= min-depth) all legal actions are regenerated from policy.state, scored, and
// a softmax over ALL of them is trained towards the move the search chose (soft > 0 mixes in
// softmax(searchScore/tau) over the recorded top candidates: target = (1-soft)*onehot + soft*softmax).
// Split by game: game g is validation when g % val-every === 0 (games detected as in nnue/train.js assignGameIds).
// Prints validation top1/top3/top5/MRR for the learned ranking, for the CURRENT ordering (policy.chosenRank) and
// for random ordering, on the same validation records.
//
// Model file (JSON, "policy-model-v1"); score(x) for a sparse feature vector x = {idx[], val[]} of features.js:
//   s = bias + sum_k w[idx_k]*val_k + sum_h v[h] * tanh( b1[h] + sum_k W1[h][idx_k]*val_k )      (hidden part only if hidden > 0)
//   { format, featureVersion, dim, hidden, bias, w:[dim], W1:[hidden][dim], b1:[hidden], v:[hidden], meta:{...} }
// A move's rank is its position when sorting by s descending; only the ordering within one position matters.
"use strict";
const fs = require("fs");
const C = require("./common");
const { FEATURE_DIM, FEATURE_VERSION } = require("./features");

const args = process.argv.slice(2);
const opt = (n, d) => { const a = args.find((x) => x.startsWith("--" + n + "=")); return a ? a.slice(n.length + 3) : d; };
const files = args.filter((a) => !a.startsWith("--"));
if (!files.length) { console.log("usage: node tools/policy/train-policy.js <data ...> [--out=model.json] [--epochs=30] [--hidden=0] ..."); process.exit(1); }
const OUT = opt("out", "policy-model.json");
const EPOCHS = Number(opt("epochs", 30)), H = Number(opt("hidden", 0)), LR = Number(opt("lr", 0.01));
const L2 = Number(opt("l2", 1e-4)), BATCH = Number(opt("batch", 32)), MIN_DEPTH = Number(opt("min-depth", 3));
const VAL_EVERY = Number(opt("val-every", 5)), SOFT = Number(opt("soft", 0)), TAU = Number(opt("tau", 60)), SEED = Number(opt("seed", 1));
let rs = SEED >>> 0 || 1;
const rand = () => ((rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296);

// ---- data (streamed: a cloud-scale round is multi-GB decompressed, does not fit as one
// string/array -- see common.js's streamExamples -- so examples are built and sorted into
// train/val one line at a time instead of loading every raw record first)
const train = [], val = [];
const gamesSeen = new Set();
async function loadData() {
  let n = 0, skipped = 0;
  await C.streamExamples(files, MIN_DEPTH, SOFT > 0 ? TAU : 0, (ex) => {
    n += 1;
    gamesSeen.add(ex.game);
    (ex.game % VAL_EVERY === 0 ? val : train).push(ex);
  }, () => { skipped += 1; });
  console.log(`records with policy.state and depth>=${MIN_DEPTH}, usable: ${n} (skipped ${skipped}); train ${train.length}, validation ${val.length}; games ${gamesSeen.size}`);
  if (!train.length) { console.log("no training data"); process.exit(1); }
}

// ---- model (Adam)
const D = FEATURE_DIM;
const P = { bias: new Float64Array(1), w: new Float64Array(D), b1: new Float64Array(H), v: new Float64Array(H), W1: new Float64Array(H * D) };
for (let i = 0; i < H * D; i++) P.W1[i] = (rand() - 0.5) * 0.1;
for (let h = 0; h < H; h++) P.v[h] = (rand() - 0.5) * 0.2;
const G = {}, M1 = {}, M2 = {};
for (const k in P) { G[k] = new Float64Array(P[k].length); M1[k] = new Float64Array(P[k].length); M2[k] = new Float64Array(P[k].length); }
let step = 0;
function adam() {
  step++;
  const c1 = 1 - Math.pow(0.9, step), c2 = 1 - Math.pow(0.999, step);
  for (const k in P) {
    const p = P[k], g = G[k], m1 = M1[k], m2 = M2[k];
    const decay = k === "bias" || k === "b1" ? 0 : L2;
    for (let i = 0; i < p.length; i++) {
      const gi = g[i] + decay * p[i];
      m1[i] = 0.9 * m1[i] + 0.1 * gi; m2[i] = 0.999 * m2[i] + 0.001 * gi * gi;
      p[i] -= LR * (m1[i] / c1) / (Math.sqrt(m2[i] / c2) + 1e-8);
      g[i] = 0;
    }
  }
}
const hbuf = new Float64Array(H);
function score(f) { // fills hbuf with tanh activations
  let s = P.bias[0];
  const { idx, val } = f;
  for (let k = 0; k < idx.length; k++) s += P.w[idx[k]] * val[k];
  for (let h = 0; h < H; h++) {
    let a = P.b1[h]; const base = h * D;
    for (let k = 0; k < idx.length; k++) a += P.W1[base + idx[k]] * val[k];
    const t = Math.tanh(a); hbuf[h] = t; s += P.v[h] * t;
  }
  return s;
}
// accumulate gradient of the softmax cross-entropy of one position; returns the loss
function accumulate(ex) {
  const n = ex.n, s = new Float64Array(n), hs = H ? new Float64Array(n * H) : null;
  let mx = -Infinity;
  for (let i = 0; i < n; i++) { s[i] = score(ex.feats[i]); if (H) hs.set(hbuf, i * H); if (s[i] > mx) mx = s[i]; }
  let z = 0; for (let i = 0; i < n; i++) { s[i] = Math.exp(s[i] - mx); z += s[i]; }
  let loss = 0;
  for (let i = 0; i < n; i++) {
    const p = s[i] / z;
    const t = (1 - SOFT) * (i === ex.chosen ? 1 : 0) + SOFT * ex.soft[i];
    if (t > 0) loss -= t * Math.log(Math.max(p, 1e-12));
    const g = (p - t) / BATCH;
    const f = ex.feats[i];
    G.bias[0] += g;
    for (let k = 0; k < f.idx.length; k++) G.w[f.idx[k]] += g * f.val[k];
    for (let h = 0; h < H; h++) {
      const th = hs[i * H + h];
      G.v[h] += g * th;
      const ga = g * P.v[h] * (1 - th * th);
      G.b1[h] += ga; const base = h * D;
      for (let k = 0; k < f.idx.length; k++) G.W1[base + f.idx[k]] += ga * f.val[k];
    }
  }
  return loss;
}
function evaluate(set) {
  const mL = C.newMetrics(), mC = C.newMetrics(), mR = C.newMetrics();
  let loss = 0;
  for (const ex of set) {
    const s = ex.feats.map((f) => score(f));
    let rank = 1, mx = -Infinity, z = 0;
    for (let i = 0; i < s.length; i++) { if (i !== ex.chosen && s[i] > s[ex.chosen]) rank++; if (s[i] > mx) mx = s[i]; }
    for (let i = 0; i < s.length; i++) z += Math.exp(s[i] - mx);
    loss -= s[ex.chosen] - mx - Math.log(z);
    C.addRank(mL, rank); C.addRank(mC, ex.curRank); C.addRandom(mR, ex.n);
  }
  return { mL, mC, mR, loss: loss / Math.max(1, set.length) };
}

// ---- train
async function run() {
  await loadData();
  console.log(`features ${D}, hidden ${H}, epochs ${EPOCHS}, lr ${LR}, l2 ${L2}, batch ${BATCH}, soft ${SOFT}`);
  const order = train.map((_, i) => i);
for (let ep = 1; ep <= EPOCHS; ep++) {
  for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  let tl = 0, inBatch = 0;
  for (const oi of order) {
    tl += accumulate(train[oi]);
    if (++inBatch === BATCH) { adam(); inBatch = 0; }
  }
  if (inBatch) adam();
  if (ep === 1 || ep % 5 === 0 || ep === EPOCHS) {
    let msg = `epoch ${ep}: train loss ${(tl / train.length).toFixed(4)}`;
    if (val.length) { const e = evaluate(val); msg += `  val loss ${e.loss.toFixed(4)}  val top1 ${(100 * e.mL.top1 / e.mL.n).toFixed(1)}% MRR ${(e.mL.mrr / e.mL.n).toFixed(3)}`; }
    console.log(msg);
  }
}

// ---- report + save
if (val.length) {
  const e = evaluate(val);
  console.log(`\nvalidation (${val.length} records from games with game%${VAL_EVERY}==0, same records for all three rows)`);
  console.log(C.fmt("learned", e.mL)); console.log(C.fmt("current ordering", e.mC)); console.log(C.fmt("random", e.mR));
} else console.log("\nno validation games (need more games than val-every); numbers on train only:", C.fmt("learned", evaluate(train).mL));
const r = (x) => Number(x.toPrecision(6));
const model = {
  format: "policy-model-v1", featureVersion: FEATURE_VERSION, dim: D, hidden: H, bias: r(P.bias[0]),
  w: Array.from(P.w, r),
  W1: Array.from({ length: H }, (_, h) => Array.from(P.W1.subarray(h * D, (h + 1) * D), r)),
  b1: Array.from(P.b1, r), v: Array.from(P.v, r),
  meta: { files: files.map((f) => require("path").basename(f)), minDepth: MIN_DEPTH, valEvery: VAL_EVERY, soft: SOFT, tau: TAU, epochs: EPOCHS, lr: LR, l2: L2, trainRecords: train.length, valRecords: val.length },
};
fs.writeFileSync(OUT, JSON.stringify(model));
console.log("wrote " + OUT + " (" + (fs.statSync(OUT).size / 1024).toFixed(0) + " KB)");
}
run();
