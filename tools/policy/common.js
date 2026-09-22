// Shared helpers for the policy tools: record loading, state rehydration, action keys, game split, metrics.
"use strict";
const fs = require("fs");
const zlib = require("zlib");
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const engine = require(path.join(ROOT, "engine-merged.js"));
const { featurizeAll } = require("./features");

const clone = (o) => JSON.parse(JSON.stringify(o));
// same as policyKey in selfplay-worker-merged.js
const policyKey = (a) => JSON.stringify(a, (k, v) => (k === "id" || k === "instanceId" || k === "pieceId" ? undefined : v));

// same as rehydrate() in tools/fixtures/generate-fixtures.js
function rehydrate(json) {
  const st = engine.cloneState({});
  Object.assign(st, clone(json));
  st.board = engine.cloneState(clone(json)).board;
  const byAnchor = new Map();
  for (const row of st.board) for (let c = 0; c < row.length; c++) {
    const p = row[c];
    if (!p || p.id || !Number.isInteger(p.anchorRow) || !Number.isInteger(p.anchorCol)) continue;
    const key = p.type + "|" + p.color + "|" + p.anchorRow + "|" + p.anchorCol;
    if (byAnchor.has(key)) row[c] = byAnchor.get(key); else byAnchor.set(key, p);
  }
  engine.setWorkerBoardDimensions(st);
  return st;
}

function readLines(file) {
  const raw = fs.readFileSync(file);
  return (file.endsWith(".gz") ? zlib.gunzipSync(raw) : raw).toString("utf8").split("\n").filter(Boolean);
}
const countPieces = (board) => { let n = 0; for (const row of board) for (const p of row) if (p) n++; return n; };

// Loads records of all files in order. Game ids are assigned per file: a new game starts when the piece count is
// back at 32 after having dropped (same rule as assignGameIds in nnue/train.js). Game ids are globally unique.
function loadRecords(files, minDepth) {
  const out = [];
  let gameBase = 0;
  for (const f of files) {
    const rows = [];
    for (const line of readLines(f)) { try { rows.push(JSON.parse(line)); } catch (e) { /* skip */ } }
    let g = 0, saw = false;
    rows.forEach((r, i) => {
      const cnt = r.board ? countPieces(r.board) : 32;
      if (i > 0 && cnt === 32 && saw) { g++; saw = false; }
      if (cnt < 32) saw = true;
      const p = r.policy;
      if (!p || !p.state || !p.chosen || (r.completedDepth || 0) < minDepth) return;
      out.push({ rec: r, game: gameBase + g });
    });
    gameBase += g + 1;
  }
  return out;
}

// One example: features for all legal actions, chosen index, soft target, current-ordering rank.
function buildExample(rec, tau) {
  const p = rec.policy;
  const st = rehydrate(p.state);
  const color = rec.turn || st.turn;
  const actions = engine.generateActions(st, color);
  if (!actions.length) return null;
  const keys = actions.map(policyKey);
  const chosen = keys.indexOf(p.chosen);
  if (chosen < 0) return null;
  const feats = featurizeAll(st, actions, color);
  const soft = new Array(actions.length).fill(0);
  if (tau && Array.isArray(p.top) && p.top.length) {
    const m = Math.max(...p.top.map((t) => t.s));
    let z = 0;
    const w = p.top.map((t) => { const e = Math.exp((t.s - m) / tau); z += e; return e; });
    p.top.forEach((t, i) => { const j = keys.indexOf(t.a); if (j >= 0) soft[j] += w[i] / z; });
  }
  return { feats, chosen, soft, n: actions.length, curRank: p.chosenRank || 0 };
}

// Metrics over 1-based ranks. Random ordering uses closed-form expectations.
function newMetrics() { return { n: 0, top1: 0, top3: 0, top5: 0, mrr: 0 }; }
function addRank(m, rank) {
  m.n++; if (rank === 1) m.top1++; if (rank >= 1 && rank <= 3) m.top3++; if (rank >= 1 && rank <= 5) m.top5++; m.mrr += rank > 0 ? 1 / rank : 0;
}
function addRandom(m, n) {
  m.n++; m.top1 += 1 / n; m.top3 += Math.min(3, n) / n; m.top5 += Math.min(5, n) / n;
  let h = 0; for (let k = 1; k <= n; k++) h += 1 / k; m.mrr += h / n;
}
function fmt(label, m) {
  const pc = (x) => (100 * x / m.n).toFixed(1).padStart(5) + "%";
  return `${label.padEnd(16)} top1 ${pc(m.top1)}  top3 ${pc(m.top3)}  top5 ${pc(m.top5)}  MRR ${(m.mrr / m.n).toFixed(3)}  (n=${m.n})`;
}
module.exports = { engine, clone, policyKey, rehydrate, readLines, loadRecords, buildExample, newMetrics, addRank, addRandom, fmt };
