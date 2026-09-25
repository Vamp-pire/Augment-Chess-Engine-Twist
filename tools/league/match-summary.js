// Score/pair based summary of a match.yml run, from the shard logs.
//   node tools/league/match-summary.js [logDir=.] [outJson=match-result.json]
// Reads shard-*.log ("pair <i> game 1|2 (swapped) seed ... -> A WIN|LOSS|DRAW|UNFINISHED"),
// forms colour-swapped pairs, prints markdown (and appends it to $GITHUB_STEP_SUMMARY),
// and writes the machine-readable result consumed by tools/league/league.js.
// Settings come from the MATCH_* / MODEL_* env of the workflow (see match.yml).
// An unfinished game counts as a draw for the score statistics (it is also reported
// separately); a pair with only one finished-parsed game is dropped and counted as incomplete.
"use strict";
const fs = require("fs");
const path = require("path");
const S = require("./stats.js");

// "handcoded" -> depth 3 default; identity of a participant = model spec + depth (+ limits/params when given).
function participantLabel(spec, depth, limits, params) {
  let l = spec + "/d" + depth;
  if (limits) l += "/L" + compact(limits);
  if (params) l += "/P" + compact(params);
  return l;
}
function compact(json) { try { return JSON.stringify(JSON.parse(json)); } catch (e) { return String(json); } }

function parseLogs(dir) {
  const pairs = new Map(); // pair index -> [pointsGame1, pointsGame2]
  let games = 0;
  const pts = { WIN: 1, DRAW: 0.5, UNFINISHED: 0.5, LOSS: 0 };
  let w = 0, d = 0, l = 0, unfinished = 0;
  for (const f of fs.readdirSync(dir).filter((n) => /^shard-\d+\.log$/.test(n))) {
    for (const line of fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/)) {
      const m = /^pair (\d+) game (1|2)\b.*-> A (WIN|LOSS|DRAW|UNFINISHED)\s*$/.exec(line);
      if (!m) continue;
      const idx = Number(m[1]);
      if (!pairs.has(idx)) pairs.set(idx, [null, null]);
      pairs.get(idx)[Number(m[2]) - 1] = pts[m[3]];
      games += 1;
      if (m[3] === "WIN") w += 1; else if (m[3] === "LOSS") l += 1; else if (m[3] === "DRAW") d += 1; else unfinished += 1;
    }
  }
  const hist = [0, 0, 0, 0, 0];
  let incomplete = 0;
  for (const [, g] of pairs) {
    if (g[0] === null || g[1] === null) { incomplete += 1; continue; }
    hist[Math.round((g[0] + g[1]) * 2)] += 1;
  }
  return { hist, incomplete, games, w, d, l, unfinished };
}

function build(dir, env) {
  const p = parseLogs(dir);
  const depth = Number(env.MATCH_SEARCH_DEPTH) || 3;
  const dA = Number(env.MATCH_DEPTH_A) || depth, dB = Number(env.MATCH_DEPTH_B) || depth;
  const settings = {
    depth, depthA: dA, depthB: dB, limitsA: env.MATCH_LIMITS_A || null, limitsB: env.MATCH_LIMITS_B || null,
    paramsA: env.MATCH_PARAMS_A || null, paramsB: env.MATCH_PARAMS_B || null,
    ms: Number(env.MATCH_SEARCH_MS) || 300, handicap: Number(env.MATCH_HANDICAP) || 0,
    seedOffset: Number(env.SEED_OFFSET) || 0, shards: Number(env.SHARDS) || null, pairsPerShard: Number(env.PAIRS) || null,
    fullPieceState: env.FULL_PIECE_STATE === "1"
  };
  const nPairs = p.hist.reduce((a, b) => a + b, 0);
  const opts = { elo0: Number(env.SPRT_ELO0 || 0), elo1: Number(env.SPRT_ELO1 || 10), alpha: 0.05, beta: 0.05 };
  const stats = S.summarize({ pairs: p.hist }, opts);
  const res = {
    modelA: env.MODEL_A, modelB: env.MODEL_B,
    participantA: participantLabel(env.MODEL_A, dA, settings.limitsA, settings.paramsA),
    participantB: participantLabel(env.MODEL_B, dB, settings.limitsB, settings.paramsB),
    // W/D/L are per game from A's point of view (unfinished counted as draws in draws + reported in unfinished)
    wins: p.w, draws: p.d + p.unfinished, losses: p.l, unfinished: p.unfinished, games: p.games,
    pairs: nPairs, pairHistogram: p.hist, incompletePairs: p.incomplete,
    score: stats.score, scoreCi95: stats.scoreCi95, elo: stats.elo, eloCi95: stats.eloCi95, los: stats.los,
    sprt: stats.sprt, settings, run: env.GITHUB_RUN_ID || null, date: new Date().toISOString()
  };
  return { res, stats };
}

const fmtElo = (x) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(1) : x > 0 ? "+inf" : "-inf");
function markdown(res, stats) {
  const s = res.sprt;
  return [
    "## Score / pair statistics",
    "",
    "A = `" + res.participantA + "`, B = `" + res.participantB + "`",
    "",
    "| pairs | W | D | L | unfinished | pair histogram (0, .25, .5, .75, 1) |",
    "|---|---|---|---|---|---|",
    "| " + res.pairs + " | " + res.wins + " | " + (res.draws - res.unfinished) + " | " + res.losses + " | " + res.unfinished + " | " + res.pairHistogram.join(" / ") + " |",
    "",
    "Score of A (draws = half, per-pair variance): **" + (res.score * 100).toFixed(1) + "%** [" + (res.scoreCi95[0] * 100).toFixed(1) + "%, " + (res.scoreCi95[1] * 100).toFixed(1) + "%]",
    "",
    "Elo(A - B): **" + fmtElo(res.elo) + "** (95% CI " + fmtElo(res.eloCi95[0]) + " .. " + fmtElo(res.eloCi95[1]) + "), LOS **" + (res.los * 100).toFixed(1) + "%**",
    "",
    "SPRT H0: elo <= " + s.elo0 + " vs H1: elo >= " + s.elo1 + " (alpha = beta = " + s.alpha + "): LLR " + s.llr.toFixed(2) + " in [" + s.lower.toFixed(2) + ", " + s.upper.toFixed(2) + "] -> **" +
      (s.decision === "H1" ? "accept H1 (A better)" : s.decision === "H0" ? "accept H0 (no gain)" : "continue (undecided)") + "**",
    ...(res.incompletePairs ? ["", "Note: " + res.incompletePairs + " incomplete pair(s) dropped (a shard likely failed)."] : [])
  ].join("\n");
}

module.exports = { parseLogs, build, participantLabel };

if (require.main === module) {
  const dir = process.argv[2] || ".";
  const out = process.argv[3] || "match-result.json";
  const { res, stats } = build(dir, process.env);
  fs.writeFileSync(out, JSON.stringify(res, null, 2));
  const md = markdown(res, stats);
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "\n" + md + "\n");
}
