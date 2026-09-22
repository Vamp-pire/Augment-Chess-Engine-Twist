#!/usr/bin/env node
// Apply a learned move-scoring model (see train-policy.js for the file format).
//
//   const { loadPolicy, scoreActions } = require("./score-actions");
//   const model = loadPolicy("model.json");
//   const scores = scoreActions(model, state, actions, color);   // one number per action, higher = search this first
//
// Sanity check that re-computes the validation numbers independently of the trainer (fresh feature extraction
// from the recorded states, same game split rule stored in the model):
//   node tools/policy/score-actions.js <model.json> <data.jsonl|.jsonl.gz ...> [--min-depth=3] [--all]
//   (--all evaluates every game instead of only the validation games)
"use strict";
const fs = require("fs");
const { featurizeAll, FEATURE_DIM, FEATURE_VERSION } = require("./features");

function loadPolicy(file) {
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  if (m.format !== "policy-model-v1") throw new Error("unknown model format " + m.format);
  if (m.featureVersion !== FEATURE_VERSION || m.dim !== FEATURE_DIM) throw new Error(`feature layout mismatch (model ${m.featureVersion}/${m.dim}, code ${FEATURE_VERSION}/${FEATURE_DIM})`);
  return m;
}

// score of one sparse feature vector {idx, val}
function scoreFeatures(m, f) {
  let s = m.bias || 0;
  const { idx, val } = f;
  for (let k = 0; k < idx.length; k++) s += m.w[idx[k]] * val[k];
  const H = m.hidden || 0;
  for (let h = 0; h < H; h++) {
    const row = m.W1[h];
    let a = m.b1[h];
    for (let k = 0; k < idx.length; k++) a += row[idx[k]] * val[k];
    s += m.v[h] * Math.tanh(a);
  }
  return s;
}

function scoreActions(model, state, actions, color) {
  return featurizeAll(state, actions, color).map((f) => scoreFeatures(model, f));
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n, d) => { const a = args.find((x) => x.startsWith("--" + n + "=")); return a ? a.split("=")[1] : d; };
  const files = args.filter((a) => !a.startsWith("--"));
  const all = args.includes("--all");
  if (files.length < 2) { console.log("usage: node tools/policy/score-actions.js <model.json> <data ...> [--min-depth=3] [--all]"); process.exit(1); }
  const C = require("./common");
  const model = loadPolicy(files[0]);
  const items = C.loadRecords(files.slice(1), Number(opt("min-depth", 3)));
  const every = (model.meta && model.meta.valEvery) || 5;
  const sel = items.filter((x) => all || x.game % every === 0);
  const mL = C.newMetrics(), mC = C.newMetrics(), mR = C.newMetrics();
  for (const { rec } of sel) {
    const ex = C.buildExample(rec, 0);
    if (!ex) continue;
    const s = ex.feats.map((f) => scoreFeatures(model, f));
    let rank = 1;
    for (let i = 0; i < s.length; i++) if (i !== ex.chosen && s[i] > s[ex.chosen]) rank++;
    C.addRank(mL, rank);
    if (ex.curRank) C.addRank(mC, ex.curRank); else C.addRank(mC, 0);
    C.addRandom(mR, ex.n);
  }
  if (!mL.n) { console.log("no usable records"); return; }
  console.log((all ? "all games" : "validation games") + ` (${sel.length} records, depth >= ${opt("min-depth", 3)})`);
  console.log(C.fmt("learned", mL)); console.log(C.fmt("current ordering", mC)); console.log(C.fmt("random", mR));
}
if (require.main === module) main();
module.exports = { loadPolicy, scoreActions, scoreFeatures };
