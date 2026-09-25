// League ratings from a folder of match-result.json files (artifact `match-result` of match.yml).
//   gh run download <id> -n match-result -D results/<id>      (one folder per run)
//   node tools/league/league.js results [--anchor handcoded/d3] [--anchor-elo 0]
//        [--handicap 0|any] [--elo0 0 --elo1 10] [--json out.json]
//
// Participants are "<model spec>/d<depth>[/L<limits>][/P<params>]" (see match-summary.js).
// Results of the same pairing (any orientation, any number of runs) are pooled. Ratings
// are fit by maximum likelihood under the normal approximation of the pair-score mean
// (weights = pairs / pair-score variance, variance shrunk toward 0.0625 with 4 pseudo-pairs
// so tiny samples cannot get zero weight), one rating fixed as the anchor. Standard errors
// come from the inverse Fisher information; participants with no path of games to the
// anchor are listed as unlinked instead of being rated. Games played with a handicap are
// not comparable with normal ones, so by default only handicap 0 results are used.
"use strict";
const fs = require("fs");
const path = require("path");
const S = require("./stats.js");

const LN10_400 = Math.LN10 / 400;
const PRIOR_VAR = 0.0625, PRIOR_N = 4;

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else if (e.name.endsWith(".json")) out.push(p);
  }
  return out;
}
function labelOf(r, side) {
  const k = "participant" + side;
  if (r[k]) return r[k];
  const st = r.settings || {};
  const depth = st["depth" + side] || st.depth || 3;
  return require("./match-summary.js").participantLabel(r["model" + side], depth, st["limits" + side], st["params" + side]);
}
function loadResults(dir, opts) {
  const o = Object.assign({ handicap: 0 }, opts || {});
  const used = [], skipped = [];
  for (const f of walk(dir, [])) {
    let r;
    try { r = JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { skipped.push([f, "not JSON"]); continue; }
    if (!r || !r.modelA || !r.modelB || !Array.isArray(r.pairHistogram)) { skipped.push([f, "not a match-result (no pairHistogram)"]); continue; }
    const h = r.settings && r.settings.handicap ? r.settings.handicap : 0;
    if (o.handicap !== "any" && h !== Number(o.handicap)) { skipped.push([f, "handicap " + h]); continue; }
    used.push({ file: f, a: labelOf(r, "A"), b: labelOf(r, "B"), hist: r.pairHistogram.slice(0, 5), wins: r.wins || 0, draws: r.draws || 0, losses: r.losses || 0, run: r.run || null });
  }
  return { used, skipped };
}

// Pool results per unordered pairing; the stored orientation is (a < b) alphabetically.
function aggregate(results) {
  const map = new Map();
  for (const r of results) {
    if (r.a === r.b) continue; // a participant against itself carries no rating information
    const flip = r.a > r.b;
    const a = flip ? r.b : r.a, b = flip ? r.a : r.b, key = a + "\n" + b;
    if (!map.has(key)) map.set(key, { a, b, hist: [0, 0, 0, 0, 0], wins: 0, draws: 0, losses: 0, runs: 0 });
    const m = map.get(key);
    for (let k = 0; k < 5; k += 1) m.hist[k] += r.hist[flip ? 4 - k : k];
    m.wins += flip ? r.losses : r.wins; m.losses += flip ? r.wins : r.losses; m.draws += r.draws; m.runs += 1;
  }
  return [...map.values()].map((m) => {
    const mo = S.momentsFromPairs(m.hist);
    const variance = (mo.n * mo.variance + PRIOR_N * PRIOR_VAR) / (mo.n + PRIOR_N);
    return Object.assign(m, { n: mo.n, score: mo.mean, variance });
  }).filter((m) => m.n > 0);
}

function solve(A, b) { // Gauss-Jordan; returns x with A x = b, and the inverse of A
  const n = A.length;
  const M = A.map((row, i) => row.slice().concat(Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))));
  for (let c = 0; c < n; c += 1) {
    let p = c;
    for (let r = c + 1; r < n; r += 1) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-14) throw new Error("singular system");
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c];
    for (let j = 0; j < 2 * n; j += 1) M[c][j] /= d;
    for (let r = 0; r < n; r += 1) {
      if (r === c) continue;
      const f = M[r][c];
      if (f) for (let j = 0; j < 2 * n; j += 1) M[r][j] -= f * M[c][j];
    }
  }
  const inv = M.map((row) => row.slice(n));
  return { x: inv.map((row) => row.reduce((s, v, j) => s + v * b[j], 0)), inv };
}

function fit(matchups, anchor, anchorElo) {
  const names = [...new Set(matchups.flatMap((m) => [m.a, m.b]))].sort();
  // connected component of the anchor
  const adj = new Map(names.map((n) => [n, []]));
  for (const m of matchups) { adj.get(m.a).push(m.b); adj.get(m.b).push(m.a); }
  const seen = new Set([anchor]), q = [anchor];
  while (q.length) for (const nb of adj.get(q.pop())) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
  const linked = names.filter((n) => seen.has(n));
  const unlinked = names.filter((n) => !seen.has(n));
  const free = linked.filter((n) => n !== anchor);
  const idx = new Map(free.map((n, i) => [n, i]));
  const ms = matchups.filter((m) => seen.has(m.a));
  const theta = new Map(linked.map((n) => [n, anchorElo]));
  const k = free.length;
  const cost = () => ms.reduce((s, m) => { const E = S.scoreFromElo(theta.get(m.a) - theta.get(m.b)); return s + (m.n / m.variance) * (m.score - E) * (m.score - E); }, 0);
  function normal() {
    const H = Array.from({ length: k }, () => new Array(k).fill(0)), g = new Array(k).fill(0);
    for (const m of ms) {
      const E = S.scoreFromElo(theta.get(m.a) - theta.get(m.b));
      const c = E * (1 - E) * LN10_400, w = m.n / m.variance, r = m.score - E;
      const ia = idx.get(m.a), ib = idx.get(m.b);
      if (ia !== undefined) { H[ia][ia] += w * c * c; g[ia] += w * c * r; }
      if (ib !== undefined) { H[ib][ib] += w * c * c; g[ib] -= w * c * r; }
      if (ia !== undefined && ib !== undefined) { H[ia][ib] -= w * c * c; H[ib][ia] -= w * c * c; }
    }
    return { H, g };
  }
  // Levenberg-Marquardt on the weighted squared score residuals
  let lambda = 1e-3, cur = cost();
  for (let it = 0; it < 200 && k; it += 1) {
    const { H, g } = normal();
    const Hd = H.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
    const step = solve(Hd, g).x;
    const old = free.map((n) => theta.get(n));
    free.forEach((n, i) => theta.set(n, old[i] + step[i]));
    const next = cost();
    if (next <= cur) { const dmax = Math.max(...step.map(Math.abs)); cur = next; lambda = Math.max(1e-9, lambda / 5); if (dmax < 1e-7) break; }
    else { free.forEach((n, i) => theta.set(n, old[i])); lambda *= 10; if (lambda > 1e12) break; }
  }
  // covariance = inverse Fisher information at the optimum
  let cov = [];
  if (k) { const { H } = normal(); cov = solve(H.map((row, i) => row.map((v, j) => (i === j ? v + 1e-12 : v))), new Array(k).fill(0)).inv; }
  const ratings = linked.map((n) => {
    const i = idx.get(n);
    const se = i === undefined ? 0 : Math.sqrt(Math.max(0, cov[i][i]));
    let games = 0, pairs = 0;
    for (const m of ms) if (m.a === n || m.b === n) { pairs += m.n; games += 2 * m.n; }
    return { name: n, elo: theta.get(n), se, ci95: [theta.get(n) - S.Z95 * se, theta.get(n) + S.Z95 * se], pairs, games, anchor: n === anchor };
  }).sort((x, y) => y.elo - x.elo);
  return { ratings, unlinked, cost: cur, dof: Math.max(0, ms.length - k) };
}

const sgn = (x) => (x >= 0 ? "+" : "") + x.toFixed(0);
function report(agg, fitted, sprtOpts) {
  const out = [];
  out.push("Ratings (Elo, anchor fixed; 95% CI = +-1.96 SE)");
  const w = Math.max(...fitted.ratings.map((r) => r.name.length), ...agg.flatMap((m) => [m.a.length, m.b.length]), 11);
  out.push("rank  " + "participant".padEnd(w) + "  " + "Elo".padStart(7) + "  " + "+-95%".padStart(6) + "  " + "pairs".padStart(6));
  fitted.ratings.forEach((r, i) => out.push(String(i + 1).padStart(4) + "  " + r.name.padEnd(w) + "  " + sgn(r.elo).padStart(7) + "  " + (r.anchor ? "anchor" : (1.96 * r.se).toFixed(0)).padStart(6) + "  " + String(r.pairs).padStart(6)));
  if (fitted.unlinked.length) out.push("", "Unlinked to the anchor (no rating): " + fitted.unlinked.join(", "));
  out.push("", "Pairwise (direct results, pooled over runs)");
  out.push("A".padEnd(w) + "  " + "B".padEnd(w) + "  pairs   W   D   L  score%  direct Elo [95% CI]         LOS%  SPRT[" + sprtOpts.elo0 + "," + sprtOpts.elo1 + "]");
  for (const m of agg.slice().sort((x, y) => (x.a + x.b).localeCompare(y.a + y.b))) {
    const s = S.summarize({ pairs: m.hist }, sprtOpts);
    const ci = (x) => (Number.isFinite(x) ? sgn(x) : x > 0 ? "inf" : "-inf");
    out.push(m.a.padEnd(w) + "  " + m.b.padEnd(w) + "  " + String(m.n).padStart(5) + " " + String(m.wins).padStart(3) + " " + String(m.draws).padStart(3) + " " + String(m.losses).padStart(3) + "  " + (s.score * 100).toFixed(1).padStart(6) + "  " + (sgn(s.elo) + " [" + ci(s.eloCi95[0]) + ", " + ci(s.eloCi95[1]) + "]").padEnd(24) + "  " + (s.los * 100).toFixed(0).padStart(3) + "  " + s.sprt.decision);
  }
  return out.join("\n");
}

module.exports = { loadResults, aggregate, fit, report };

if (require.main === module) {
  const a = process.argv.slice(2);
  const get = (k, d) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : d; };
  const dir = a.find((x, i) => !x.startsWith("--") && (i === 0 || !a[i - 1].startsWith("--")));
  if (!dir) { console.error("usage: node tools/league/league.js <folder of match-result.json> [--anchor handcoded/d3] [--anchor-elo 0] [--handicap 0|any] [--elo0 0 --elo1 10] [--json out.json]"); process.exit(1); }
  const hc = get("handicap", "0");
  const { used, skipped } = loadResults(dir, { handicap: hc === "any" ? "any" : Number(hc) });
  const agg = aggregate(used);
  if (!agg.length) { console.error("no usable match-result files in " + dir + " (skipped " + skipped.length + "; a participant against itself and handicap runs do not count)"); process.exit(1); }
  const names = [...new Set(agg.flatMap((m) => [m.a, m.b]))];
  let anchor = get("anchor", "handcoded/d3");
  if (!names.includes(anchor)) {
    const g = new Map(names.map((n) => [n, 0]));
    for (const m of agg) { g.set(m.a, g.get(m.a) + m.n); g.set(m.b, g.get(m.b) + m.n); }
    const alt = [...g.entries()].sort((x, y) => y[1] - x[1])[0][0];
    console.error("anchor " + anchor + " is not among the participants; using " + alt + " (most pairs)");
    anchor = alt;
  }
  const fitted = fit(agg, anchor, Number(get("anchor-elo", 0)));
  const sprtOpts = { elo0: Number(get("elo0", 0)), elo1: Number(get("elo1", 10)) };
  console.log(used.length + " result file(s) used, " + skipped.length + " skipped, " + agg.length + " pairing(s), handicap " + hc + "\n");
  console.log(report(agg, fitted, sprtOpts));
  if (get("json")) fs.writeFileSync(get("json"), JSON.stringify({ anchor, ratings: fitted.ratings, unlinked: fitted.unlinked, pairings: agg }, null, 2));
}
