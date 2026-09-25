// Unit tests + Monte-Carlo validation for stats.js. Run: node tools/league/stats.test.js
// (add --quick for a smaller simulation).
"use strict";
const assert = require("assert");
const S = require("./stats.js");

const quick = process.argv.includes("--quick");
function near(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b} (tol ${tol})`); }

// --- known cases ---
near(S.eloFromScore(0.5), 0, 1e-9, "50% = 0 Elo");
near(S.eloFromScore(0.64), 99.98, 0.1, "64% ~ +100 Elo");
near(S.eloFromScore(0.75), 190.85, 0.1, "75% ~ +191 Elo");
near(S.eloFromScore(0.3), -S.eloFromScore(0.7), 1e-9, "antisymmetric");
near(S.scoreFromElo(S.eloFromScore(0.58)), 0.58, 1e-12, "roundtrip");
near(S.normalCdf(0), 0.5, 1e-7, "cdf(0)");
near(S.normalCdf(1.959964), 0.975, 1e-6, "cdf(1.96)");
near(S.normalCdf(-1), 0.158655, 1e-6, "cdf(-1)");

// symmetric result: 20 wins 60 draws 20 losses as games
let r = S.summarize({ w: 20, d: 60, l: 20 });
near(r.score, 0.5, 1e-12, "score");
near(r.los, 0.5, 1e-9, "LOS symmetric");
assert(r.eloCi95[0] < 0 && r.eloCi95[1] > 0, "CI covers 0");
near(r.eloCi95[0], -r.eloCi95[1], 1e-6, "CI symmetric");
// hand-check: variance = (20*.25+20*.25)/99, se = sqrt(var/100)
near(r.scoreSe, Math.sqrt((10 / 99) / 100), 1e-12, "se by hand");

// pairs: all draws vs wins keep the same mean but draws-only pairs have zero variance -> floored, still finite
r = S.summarize({ pairs: [0, 0, 50, 0, 0] });
assert(Number.isFinite(r.scoreSe) && r.scoreSe > 0, "floored se");
// pair variance beats game variance when colours cancel: WL pairs (score .5) are all "0.5 pairs"
const cancel = S.summarize({ pairs: [0, 0, 100, 0, 0] });
const naive = S.summarize({ w: 100, d: 0, l: 100 });
assert(cancel.scoreSe < naive.scoreSe, "pair unit sees colour cancellation");

// more wins -> higher LOS / positive elo
r = S.summarize({ pairs: [2, 5, 20, 20, 13] });
assert(r.elo > 0 && r.los > 0.9, "clear plus is positive");
r = S.summarize({ pairs: [0, 0, 0, 0, 30] });
assert(r.sprt.decision === "H1", "30-0 sweep accepts H1");
r = S.summarize({ pairs: [30, 0, 0, 0, 0] });
assert(r.sprt.decision === "H0", "0-30 sweep accepts H0");
r = S.summarize({ pairs: [0, 0, 5, 0, 0] });
assert(r.sprt.decision === "continue", "under minUnits never decides");
console.log("unit tests ok");

// --- Monte Carlo ---
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function gauss(rand) { return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand()); }
// One game point (0/.5/1) for A given expected score E and draw prob d.
function game(rand, E, d) {
  const dd = Math.min(d, 2 * Math.min(E, 1 - E));
  const u = rand();
  return u < E - dd / 2 ? 1 : u < E + dd / 2 ? 0.5 : 0;
}
// pair: seed-level advantage u (Elo, in favour of white) shared by both games -> colour swap cancels it in the mean but
// adds correlation; sigma=0 gives independent games.
function pair(rand, elo, d, sigma) {
  const u = sigma ? sigma * gauss(rand) : 0;
  const g1 = game(rand, S.scoreFromElo(elo + u), d);
  const g2 = game(rand, S.scoreFromElo(elo - u), d);
  return Math.round((g1 + g2) * 2); // bin index 0..4
}

const N = quick ? 300 : 1500;
const rand = rng(12345);
console.log(`Monte Carlo (${N} runs per row)`);
console.log("-- 95% CI coverage of the true Elo (fixed n pairs)");
for (const [elo, d, sigma, n] of [[0, 0.5, 0, 50], [30, 0.5, 0, 100], [30, 0.5, 150, 100], [-40, 0.45, 100, 200], [100, 0.3, 0, 40]]) {
  const trueScore = S.scoreFromElo(elo);
  // the true pair-mean is the expectation over the seed effect; estimate it once by a large sample
  let big = 0; const M = 200000; for (let i = 0; i < M; i += 1) big += S.PAIR_POINTS[pair(rand, elo, d, sigma)];
  const truth = big / M;
  let cover = 0, coverElo = 0;
  for (let t = 0; t < N; t += 1) {
    const c = [0, 0, 0, 0, 0];
    for (let i = 0; i < n; i += 1) c[pair(rand, elo, d, sigma)] += 1;
    const s = S.summarize({ pairs: c });
    if (s.scoreCi95[0] <= truth && truth <= s.scoreCi95[1]) cover += 1;
    const te = S.eloFromScore(truth);
    if (s.eloCi95[0] <= te && te <= s.eloCi95[1]) coverElo += 1;
  }
  console.log(`elo=${elo} draw=${d} seedSigma=${sigma} pairs=${n}: score-CI coverage ${(100 * cover / N).toFixed(1)}%, elo-CI coverage ${(100 * coverElo / N).toFixed(1)}%  (target 95%; true score ${truth.toFixed(3)} vs nominal ${trueScore.toFixed(3)})`);
  assert(cover / N > 0.92 && cover / N < 0.98, "coverage out of range for row elo=" + elo);
}

console.log("-- SPRT (elo0=0, elo1=10, alpha=beta=0.05), checked after every pair, max 3000 pairs");
const MAXP = 3000, R = quick ? 200 : 600;
function runSprt(elo, d, sigma) {
  let h1 = 0, h0 = 0, none = 0, stopSum = 0;
  for (let t = 0; t < R; t += 1) {
    const c = [0, 0, 0, 0, 0]; let dec = "continue", i = 0;
    for (; i < MAXP; i += 1) {
      c[pair(rand, elo, d, sigma)] += 1;
      const m = S.momentsFromPairs(c);
      const q = S.sprt(m);
      if (q.decision !== "continue") { dec = q.decision; break; }
    }
    if (dec === "H1") h1 += 1; else if (dec === "H0") h0 += 1; else none += 1;
    stopSum += i + 1;
  }
  return { h1: h1 / R, h0: h0 / R, none: none / R, meanPairs: stopSum / R };
}
const fp = runSprt(0, 0.5, 100);
console.log(`true elo 0  (H0 edge): accept H1 = ${(100 * fp.h1).toFixed(1)}% (false positive; target <= 5%), accept H0 = ${(100 * fp.h0).toFixed(1)}%, undecided ${(100 * fp.none).toFixed(1)}%, mean pairs ${fp.meanPairs.toFixed(0)}`);
const neg = runSprt(-15, 0.5, 100);
console.log(`true elo -15         : accept H1 = ${(100 * neg.h1).toFixed(1)}%, accept H0 = ${(100 * neg.h0).toFixed(1)}%, mean pairs ${neg.meanPairs.toFixed(0)}`);
const pw = runSprt(10, 0.5, 100);
console.log(`true elo +10 (H1 edge): accept H1 = ${(100 * pw.h1).toFixed(1)}% (power; target ~95%), accept H0 = ${(100 * pw.h0).toFixed(1)}%, undecided ${(100 * pw.none).toFixed(1)}%, mean pairs ${pw.meanPairs.toFixed(0)}`);
const big = runSprt(40, 0.5, 100);
console.log(`true elo +40         : accept H1 = ${(100 * big.h1).toFixed(1)}%, mean pairs ${big.meanPairs.toFixed(0)}`);
assert(fp.h1 <= 0.08, "false-positive rate too high");
assert(big.h1 >= 0.95, "big improvement should almost always be accepted");
console.log("monte carlo ok");
