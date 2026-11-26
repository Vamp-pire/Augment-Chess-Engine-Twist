// Trains the fast engine's NNUE from gen-data.cjs output.
//
//   node tools/train-nnue.cjs --data <dir or file> --out nnue.json [--hidden 32] [--epochs 8] [--lambda 0.75]
//
// Net: features kind x color x square (built-in kinds), two perspectives
// (side to move first), clipped ReLU [0,1], one output o; eval = 400 * o cp.
// Target: lambda * sigmoid(score / 400) + (1 - lambda) * result, MSE on sigmoid(o).
// Validation: the last data file (or 3% of lines with one file).
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const dataArg = opt("data", "data"), out = opt("out", "nnue.json");
const H = Number(opt("hidden", 32)), EPOCHS = Number(opt("epochs", 8)), LAMBDA = Number(opt("lambda", 0.75));
const BATCH = Number(opt("batch", 4096)), LR = Number(opt("lr", 0.002));
const NK = require(path.join(__dirname, "..", "fast-engine.js"))().BUILTIN ? Object.keys(require(path.join(__dirname, "..", "fast-engine.js"))().BUILTIN).length : 49;
const NF = NK * 2 * 64;

const files = fs.statSync(dataArg).isDirectory()
  ? fs.readdirSync(dataArg, { recursive: true }).map((f) => path.join(dataArg, String(f))).filter((f) => /\.jsonl(\.gz)?$/.test(f)).sort()
  : [dataArg];
console.log(`files=${files.length} NK=${NK} H=${H}`);

// Samples: pieces packed as k*128 + color*64 + sq (Uint16), offsets, side, target.
function load(list) {
  const pieces = [], offs = [0], side = [], target = [];
  for (const f of list) {
    let text = fs.readFileSync(f);
    if (f.endsWith(".gz")) text = zlib.gunzipSync(text);
    for (const line of text.toString("utf8").split("\n")) {
      if (!line) continue;
      let row; try { row = JSON.parse(line); } catch { continue; }
      const p = row.p;
      for (let i = 0; i < p.length; i += 3) pieces.push(p[i] * 128 + p[i + 1] * 64 + p[i + 2]);
      offs.push(pieces.length); side.push(row.s);
      target.push(LAMBDA / (1 + Math.exp(-row.v / 400)) + (1 - LAMBDA) * row.r);
    }
  }
  return { pieces: Uint16Array.from(pieces), offs: Uint32Array.from(offs), side: Uint8Array.from(side), target: Float32Array.from(target), n: side.length };
}
let train, val;
if (files.length > 1) { train = load(files.slice(0, -1)); val = load(files.slice(-1)); }
else {
  const all = load(files);
  const cut = Math.floor(all.n * 0.97);
  const slice = (a, b) => ({ pieces: all.pieces, offs: all.offs.subarray(a, b + 1), side: all.side.subarray(a, b), target: all.target.subarray(a, b), n: b - a });
  train = slice(0, cut); val = slice(cut, all.n);
}
console.log(`train=${train.n} val=${val.n}`);

let seed = 12345;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const W1 = new Float32Array(NF * H).map(() => (rand() - 0.5) * 0.02);
const B1 = new Float32Array(H).fill(0.25);
const W2 = new Float32Array(2 * H).map((_, j) => (j < H ? 1 : -1) * (0.2 + rand() * 0.2));
let B2 = 0;
const gW1 = new Float32Array(NF * H), gB1 = new Float32Array(H), gW2 = new Float32Array(2 * H);
let gB2 = 0;
const touched = new Uint8Array(NF), touchedList = [];
// Adam state
const mW1 = new Float32Array(NF * H), vW1 = new Float32Array(NF * H), mB1 = new Float32Array(H), vB1 = new Float32Array(H);
const mW2 = new Float32Array(2 * H), vW2 = new Float32Array(2 * H);
let mB2 = 0, vB2 = 0, step = 0;
const lastStep = new Int32Array(NF); // lazy Adam for W1 rows

const a = new Float32Array(H), b = new Float32Array(H);
const fA = new Int32Array(256), fB = new Int32Array(256);
function features(d, i) {
  let n = 0;
  const stm = d.side[i];
  for (let q = d.offs[i]; q < d.offs[i + 1]; q++) {
    const v = d.pieces[q], k = v >> 7, c = (v >> 6) & 1, sq = v & 63;
    const fw = ((k * 2 + c) << 6) + sq, fb = ((k * 2 + (c ^ 1)) << 6) + ((7 - (sq >> 3)) * 8 + (sq & 7));
    if (stm === 0) { fA[n] = fw; fB[n] = fb; } else { fA[n] = fb; fB[n] = fw; }
    n++;
  }
  return n;
}
function forward(d, i) {
  const n = features(d, i);
  a.set(B1); b.set(B1);
  for (let q = 0; q < n; q++) {
    const oa = fA[q] * H, ob = fB[q] * H;
    for (let j = 0; j < H; j++) { a[j] += W1[oa + j]; b[j] += W1[ob + j]; }
  }
  let o = B2;
  for (let j = 0; j < H; j++) {
    const x = a[j] < 0 ? 0 : a[j] > 1 ? 1 : a[j], y = b[j] < 0 ? 0 : b[j] > 1 ? 1 : b[j];
    o += W2[j] * x + W2[H + j] * y;
  }
  return { n, o };
}
function evalLoss(d) {
  let s = 0, s0 = 0, mean = 0;
  for (let i = 0; i < d.n; i++) mean += d.target[i];
  mean /= d.n;
  for (let i = 0; i < d.n; i++) {
    const p = 1 / (1 + Math.exp(-forward(d, i).o));
    s += (p - d.target[i]) ** 2; s0 += (mean - d.target[i]) ** 2;
  }
  return { loss: s / d.n, base: s0 / d.n };
}
const B1a = 0.9, B2a = 0.999, EPS = 1e-8;
function adam(w, g, m, v, o, len, lr, t) {
  const c1 = 1 - B1a ** t, c2 = 1 - B2a ** t;
  for (let j = 0; j < len; j++) {
    const gj = g[o + j];
    m[o + j] = B1a * m[o + j] + (1 - B1a) * gj;
    v[o + j] = B2a * v[o + j] + (1 - B2a) * gj * gj;
    w[o + j] -= lr * (m[o + j] / c1) / (Math.sqrt(v[o + j] / c2) + EPS);
    g[o + j] = 0;
  }
}
function trainBatch(d, idx, from, to, lr) {
  for (let t = from; t < to; t++) {
    const i = idx[t];
    const { n, o } = forward(d, i);
    const p = 1 / (1 + Math.exp(-o));
    const g = 2 * (p - d.target[i]) * p * (1 - p);
    gB2 += g;
    for (let j = 0; j < H; j++) {
      const ina = a[j] > 0 && a[j] < 1, inb = b[j] > 0 && b[j] < 1;
      gW2[j] += g * (a[j] < 0 ? 0 : a[j] > 1 ? 1 : a[j]);
      gW2[H + j] += g * (b[j] < 0 ? 0 : b[j] > 1 ? 1 : b[j]);
      const ga = ina ? g * W2[j] : 0, gb = inb ? g * W2[H + j] : 0;
      a[j] = ga; b[j] = gb; // reuse as gradients
      gB1[j] += ga + gb;
    }
    for (let q = 0; q < n; q++) {
      const fa = fA[q], fb = fB[q], oa = fa * H, ob = fb * H;
      for (let j = 0; j < H; j++) { gW1[oa + j] += a[j]; gW1[ob + j] += b[j]; }
      if (!touched[fa]) { touched[fa] = 1; touchedList.push(fa); }
      if (!touched[fb]) { touched[fb] = 1; touchedList.push(fb); }
    }
  }
  step++;
  const scale = 1 / (to - from);
  for (const f of touchedList) for (let j = 0; j < H; j++) gW1[f * H + j] *= scale;
  for (let j = 0; j < H; j++) gB1[j] *= scale;
  for (let j = 0; j < 2 * H; j++) gW2[j] *= scale;
  gB2 *= scale;
  for (const f of touchedList) { adam(W1, gW1, mW1, vW1, f * H, H, lr, step); touched[f] = 0; }
  touchedList.length = 0;
  adam(B1, gB1, mB1, vB1, 0, H, lr, step);
  adam(W2, gW2, mW2, vW2, 0, 2 * H, lr, step);
  mB2 = B1a * mB2 + (1 - B1a) * gB2; vB2 = B2a * vB2 + (1 - B2a) * gB2 * gB2;
  B2 -= lr * (mB2 / (1 - B1a ** step)) / (Math.sqrt(vB2 / (1 - B2a ** step)) + EPS); gB2 = 0;
}

const save = () => fs.writeFileSync(out, JSON.stringify({ H, NK, W1: Array.from(W1, (x) => +x.toFixed(5)), B1: Array.from(B1), W2: Array.from(W2), B2 }));
let best = Infinity;
const v0 = evalLoss(val);
console.log(`start val=${v0.loss.toFixed(5)} (predict-mean ${v0.base.toFixed(5)})`);
const idx = new Uint32Array(train.n).map((_, i) => i);
for (let ep = 1; ep <= EPOCHS; ep++) {
  const t0 = Date.now();
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
  const lr = LR * (ep > EPOCHS * 0.7 ? 0.3 : 1);
  for (let s = 0; s < train.n; s += BATCH) trainBatch(train, idx, s, Math.min(train.n, s + BATCH), lr);
  const v = evalLoss(val);
  console.log(`epoch ${ep} val=${v.loss.toFixed(5)} lr=${lr} ${((Date.now() - t0) / 1000).toFixed(0)}s${v.loss < best ? " *" : ""}`);
  if (v.loss < best) { best = v.loss; save(); }
}
console.log(`best val=${best.toFixed(5)} -> ${out}`);
