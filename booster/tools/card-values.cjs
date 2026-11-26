// Builds the card value table from draft-match logs (--playout runs).
//
//   node tools/card-values.cjs <games.jsonl>... [--out card-values.json] [--k0 8] [--z 2] [--scale 100]
//
// Main signal (controlled): in every logged draft each offered card was
// picked for real on a copy of the same position and played 3-6 turns
// ahead. A card's advantage in that draft = its playout value minus the mean
// of the offer (position strength cancels out). Per card: the mean advantage
// is shrunk toward 0 with k0 pseudo-draws, and a card gets points only when
// |mean| > z standard errors (otherwise 0). Points = shrunk advantage /
// scale (100 cp -> 1 point; one star in the game's draft score = 2 points),
// clamped to +-3.
// Cross-check (confounded, not used for points): a logistic regression of
// game results on the cards each side picked; its correlation with the
// playout advantages is reported.
"use strict";
const fs = require("fs");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const files = args.filter((x, i) => !x.startsWith("--") && !(args[i - 1] ?? "").startsWith("--"));
const out = opt("out", "card-values.json"), k0 = Number(opt("k0", 8)), z = Number(opt("z", 2)), scale = Number(opt("scale", 100));

const games = files.flatMap((f) => fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const workers = [...new Set(games.map((g) => g.worker).filter(Boolean))];

// 1. playout advantages within each offer
const acc = new Map(); // card -> { n, sum, sq }
let draftsUsed = 0;
for (const g of games) for (const d of g.drafts || []) {
  if (!d.playout) continue;
  const vals = Object.entries(d.playout).filter(([, v]) => typeof v === "number");
  if (vals.length < 2) continue;
  draftsUsed++;
  const mean = vals.reduce((s, [, v]) => s + v, 0) / vals.length;
  for (const [id, v] of vals) {
    const e = acc.get(id) || { n: 0, sum: 0, sq: 0 };
    const a = v - mean; e.n++; e.sum += a; e.sq += a * a; acc.set(id, e);
  }
}

// 2. cross-check: logistic regression of results on picked cards
const cards = [...new Set(games.flatMap((g) => (g.drafts || []).map((d) => d.pick)))];
const idx = new Map(cards.map((c, i) => [c, i]));
const rows = games.filter((g) => typeof g.result === "number" && !g.error).map((g) => {
  const x = new Float64Array(cards.length);
  for (const d of g.drafts || []) x[idx.get(d.pick)] += d.actor === "white" ? 1 : -1;
  return { x, y: g.result };
});
const w = new Float64Array(cards.length); let b = 0;
const lambda = 1, lr = 0.05;
for (let it = 0; it < 400 && rows.length; it++) {
  const gw = new Float64Array(cards.length); let gb = 0;
  for (const { x, y } of rows) {
    let s = b; for (let j = 0; j < x.length; j++) if (x[j]) s += w[j] * x[j];
    const err = 1 / (1 + Math.exp(-s)) - y;
    gb += err; for (let j = 0; j < x.length; j++) if (x[j]) gw[j] += err * x[j];
  }
  b -= lr * gb / rows.length;
  for (let j = 0; j < w.length; j++) w[j] -= lr * (gw[j] / rows.length + lambda * w[j] / rows.length);
}

// 3. table
const points = {}, detail = {};
for (const [id, e] of acc) {
  const mean = e.sum / e.n;
  const sd = e.n > 1 ? Math.sqrt(Math.max(0, (e.sq - e.n * mean * mean) / (e.n - 1))) : Infinity;
  const se = sd / Math.sqrt(e.n);
  const shrunk = e.sum / (e.n + k0);
  const sure = Number.isFinite(se) && Math.abs(mean) > z * se;
  const p = sure ? Math.max(-3, Math.min(3, shrunk / scale)) : 0;
  if (p) points[id] = +p.toFixed(2);
  detail[id] = { n: e.n, adv: Math.round(mean), se: Number.isFinite(se) ? Math.round(se) : null, shrunk: Math.round(shrunk), points: +p.toFixed(2), resultCoef: idx.has(id) ? +w[idx.get(id)].toFixed(3) : null };
}
// correlation playout advantage vs result coefficient (cards with n >= 10)
const pairs = Object.values(detail).filter((d) => d.n >= 10 && d.resultCoef !== null).map((d) => [d.adv, d.resultCoef]);
const corr = (() => {
  if (pairs.length < 5) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length, my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (const [x, y] of pairs) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; }
  return +(sxy / Math.sqrt(sxx * syy || 1)).toFixed(3);
})();

const table = { built: new Date().toISOString(), workers, games: games.length, draftsUsed, k0, z, scale, crossCheckCorr: corr, crossCheckCards: pairs.length, points, detail };
fs.writeFileSync(out, JSON.stringify(table, null, 1));
// --js file: the points as a page script for the extension (window.__acbCardValues)
const jsOut = opt("js", null);
if (jsOut) fs.writeFileSync(jsOut, `// Card value table (draft points added to the game's AI draft score).
// Built ${table.built} from ${table.games} games, ${table.draftsUsed} drafts with playouts. See tools/card-values.cjs.
window.__acbCardValues = ${JSON.stringify(points)};
`);
const nz = Object.entries(points).sort((a, b2) => b2[1] - a[1]);
console.log(`games ${games.length}, drafts with playouts ${draftsUsed}, cards seen ${acc.size}, cards with points ${nz.length}; cross-check corr ${corr} over ${pairs.length} cards; workers ${workers.join(",")}`);
console.log("top:", nz.slice(0, 8).map(([k, v]) => `${k} ${v}`).join(", "));
console.log("bottom:", nz.slice(-5).map(([k, v]) => `${k} ${v}`).join(", "));
