// Score-based match statistics for colour-swapped pair matches (no draw discarding).
//
// The independent unit is the colour-swapped PAIR (both games share one seed / one
// deal), so variance is computed over pair scores, not over games. A pair score is
// (game1 + game2) / 2 with game points 1 / 0.5 / 0, i.e. one of 0, .25, .5, .75, 1.
// `pairs` below is the 5-bin histogram [n(0), n(.25), n(.5), n(.75), n(1)]
// (the "pentanomial" counts). When only W/D/L per game is known ({w,d,l}) the games
// are treated as independent (wider or narrower than truth, flagged by unit: "games").
//
// Elo here is the logistic score->Elo map: elo = -400 * log10(1/score - 1), positive
// means A is stronger. Unfinished games should be scored as draws by the caller.
//
// CLI:  node tools/league/stats.js --pairs 3,10,40,12,5 [--elo0 0 --elo1 10]
//       node tools/league/stats.js --w 30 --d 50 --l 20
"use strict";

const Z95 = 1.959963984540054;

function eloFromScore(s) {
  const c = Math.min(1 - 1e-12, Math.max(1e-12, s));
  return -400 * Math.log10(1 / c - 1);
}
function scoreFromElo(e) { return 1 / (1 + Math.pow(10, -e / 400)); }

// Standard normal CDF (Abramowitz & Stegun 7.1.26 via erf, |error| < 1.5e-7).
function normalCdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2);
  return x >= 0 ? 0.5 * (1 + y) : 0.5 * (1 - y);
}

const PAIR_POINTS = [0, 0.25, 0.5, 0.75, 1];

// pairs histogram -> {n, mean, variance} over pair scores (unbiased variance).
function momentsFromPairs(pairs) {
  let n = 0, sum = 0;
  for (let k = 0; k < 5; k += 1) { n += pairs[k]; sum += pairs[k] * PAIR_POINTS[k]; }
  const mean = n ? sum / n : 0.5;
  let ss = 0;
  for (let k = 0; k < 5; k += 1) ss += pairs[k] * (PAIR_POINTS[k] - mean) * (PAIR_POINTS[k] - mean);
  return { n, mean, variance: n > 1 ? ss / (n - 1) : 0.0625 };
}
function momentsFromWDL(w, d, l) {
  const n = w + d + l;
  const mean = n ? (w + 0.5 * d) / n : 0.5;
  const ss = w * (1 - mean) * (1 - mean) + d * (0.5 - mean) * (0.5 - mean) + l * mean * mean;
  return { n, mean, variance: n > 1 ? ss / (n - 1) : 0.25 };
}

// Sequential probability ratio test on the pair-score mean (normal approximation,
// generalised SPRT as used by chess-engine testing frameworks):
//   H0: elo <= elo0   vs   H1: elo >= elo1
//   LLR = n (s1 - s0) (2 mean - s0 - s1) / (2 variance)
// Accept H1 when LLR >= ln((1-beta)/alpha), accept H0 when LLR <= ln(beta/(1-alpha)).
// Deciding needs minUnits units (default 10) so a tiny sample with a degenerate
// variance cannot stop the test.
function sprt(m, opts) {
  const o = Object.assign({ elo0: 0, elo1: 10, alpha: 0.05, beta: 0.05, minUnits: 10 }, opts || {});
  const s0 = scoreFromElo(o.elo0), s1 = scoreFromElo(o.elo1);
  const lower = Math.log(o.beta / (1 - o.alpha));
  const upper = Math.log((1 - o.beta) / o.alpha);
  const variance = Math.max(m.variance, 0.0625 / Math.max(1, m.n)); // floor: never divide by ~0
  const llr = m.n ? m.n * (s1 - s0) * (2 * m.mean - s0 - s1) / (2 * variance) : 0;
  let decision = "continue";
  if (m.n >= o.minUnits) {
    if (llr >= upper) decision = "H1";
    else if (llr <= lower) decision = "H0";
  }
  return { llr, lower, upper, decision, elo0: o.elo0, elo1: o.elo1, alpha: o.alpha, beta: o.beta };
}

// input: {pairs:[5 counts]} (preferred) or {w,d,l}. opts: sprt options.
function summarize(input, opts) {
  let m, unit;
  if (input.pairs) { m = momentsFromPairs(input.pairs); unit = "pairs"; }
  else { m = momentsFromWDL(input.w || 0, input.d || 0, input.l || 0); unit = "games"; }
  const variance = Math.max(m.variance, 0.0625 / Math.max(1, m.n));
  const se = m.n ? Math.sqrt(variance / m.n) : 0.5;
  const lo = Math.max(0, m.mean - Z95 * se), hi = Math.min(1, m.mean + Z95 * se); // score CI clipped to [0, 1]; an Elo bound of +-Infinity (null in JSON) = unbounded
  const los = m.n ? normalCdf((m.mean - 0.5) / se) : 0.5;
  const elo = eloFromScore(m.mean);
  return {
    unit, n: m.n, score: m.mean, scoreSe: se, scoreCi95: [lo, hi],
    elo, eloCi95: [lo <= 0 ? -Infinity : eloFromScore(lo), hi >= 1 ? Infinity : eloFromScore(hi)],
    eloSe: se * 400 / Math.LN10 / (m.mean * (1 - m.mean) || 0.25),
    los, sprt: sprt(m, opts)
  };
}

module.exports = { eloFromScore, scoreFromElo, normalCdf, momentsFromPairs, momentsFromWDL, sprt, summarize, PAIR_POINTS, Z95 };

if (require.main === module) {
  const a = process.argv.slice(2);
  const get = (k) => { const i = a.indexOf("--" + k); return i >= 0 ? a[i + 1] : undefined; };
  const so = { elo0: get("elo0") !== undefined ? Number(get("elo0")) : 0, elo1: get("elo1") !== undefined ? Number(get("elo1")) : 10 };
  const input = get("pairs") ? { pairs: get("pairs").split(",").map(Number) } : { w: Number(get("w") || 0), d: Number(get("d") || 0), l: Number(get("l") || 0) };
  console.log(JSON.stringify(summarize(input, so), null, 2));
}
