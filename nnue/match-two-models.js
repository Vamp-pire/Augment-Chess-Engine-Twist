// Head-to-head match between two NNUE weight files, using the REAL self-play
// game-setup/turn-loop logic (selfplay-worker-merged.js's playOneGame,
// required directly rather than through worker_threads -- see that file's
// own guard) instead of a second hand-written game loop that could drift
// from the real rules.
//
// Games run in PAIRS sharing the same RNG seed: game 1 has model A as white/
// model B as black, game 2 re-runs the SAME seed with colors swapped. Since
// the seed drives deck draft + special-piece placement (makeInitialState),
// both games in a pair start with the identical hand/pieces -- this cancels
// out card-draw luck and color advantage, which a naive average-over-many-
// random-games comparison wouldn't.
//
// Usage:
//   node match-two-models.js <weightsA.json|handcoded> <weightsB.json|handcoded> [pairCount]
// Pass the literal string "handcoded" for either side (2026-09-18) to use
// engine-merged.js's own evaluateState() directly instead of an NNUE
// forward pass -- e.g. to check whether the trained NNUE actually plays
// better than the hand-picked-coefficient evaluator it was warm-started
// from, not just whether one NNUE checkpoint beats another.
const path = require("path");
const { loadWeights, forward } = require("./forward.js");
const { encodeBoard } = require("./encode.js");

const [, , weightsAPath, weightsBPath, pairCountArg] = process.argv;
if (!weightsAPath || !weightsBPath) {
  console.error("Usage: node match-two-models.js <weightsA.json|handcoded> <weightsB.json|handcoded> [pairCount]");
  process.exit(1);
}
const PAIR_COUNT = Number(pairCountArg) || 20;
// MATCH_PAIR_START lets several processes play disjoint seed ranges in parallel.
const PAIR_START = Number(process.env.MATCH_PAIR_START) || 0;
const SEARCH_DEPTH = Number(process.env.MATCH_SEARCH_DEPTH) || 3;
const SEARCH_TIME_MS = Number(process.env.MATCH_SEARCH_MS) || 80;
const MAX_PLIES = Number(process.env.MATCH_MAX_PLIES) || 300;

// Requiring this (rather than spawning it as a worker_threads Worker) picks
// up its non-worker export branch -- see its own bottom-of-file guard.
const { playOneGame } = require(path.join(__dirname, "..", "selfplay-worker-merged.js"));

const engine = require(path.join(__dirname, "..", "engine-merged.js"));
const SCORE_SCALE = 100; // matches extension/nnue.js's evaluateForSearch / selfplay-worker-merged.js

function makeEvalFn(weightsPathOrHandcoded) {
  if (weightsPathOrHandcoded === "handcoded") {
    return function (boardState, aiColor) {
      return engine.evaluateState(boardState, aiColor);
    };
  }
  const weights = loadWeights(weightsPathOrHandcoded);
  return function (boardState, aiColor) {
    const input = encodeBoard(boardState.board, aiColor, boardState.deckSlots);
    if (input === null) return engine.evaluateState(boardState, aiColor); // terminal position
    return forward(weights, input) * SCORE_SCALE;
  };
}
const evalA = makeEvalFn(weightsAPath);
const evalB = makeEvalFn(weightsBPath);

let aWins = 0;
let bWins = 0;
let draws = 0;
let unfinished = 0;

function playAndScore(seed, evalFnByColor, label) {
  const result = playOneGame({
    searchDepth: SEARCH_DEPTH,
    searchTimeMs: SEARCH_TIME_MS,
    maxPlies: MAX_PLIES,
    seed,
    flexibleBudget: true,
    evalFnByColor
  });
  const whoIsA = evalFnByColor.white === evalA ? "white" : "black";
  let outcomeForA;
  if (result.outcome === "draw") outcomeForA = "draw";
  else if (result.outcome === "unfinished") outcomeForA = "unfinished";
  else outcomeForA = result.outcome === whoIsA ? "A" : "B";
  if (outcomeForA === "A") aWins += 1;
  else if (outcomeForA === "B") bWins += 1;
  else if (outcomeForA === "draw") draws += 1;
  else unfinished += 1;
  console.log(label, "seed", seed, "A=" + whoIsA, "plies", result.plies, "outcome", result.outcome, "-> A", outcomeForA === "A" ? "WIN" : outcomeForA === "B" ? "LOSS" : outcomeForA.toUpperCase());
}

console.log(`Match: ${path.basename(weightsAPath)} (A) vs ${path.basename(weightsBPath)} (B), ${PAIR_COUNT} pairs (${PAIR_COUNT * 2} games), depth=${SEARCH_DEPTH} time=${SEARCH_TIME_MS}ms maxPlies=${MAX_PLIES}`);
for (let i = PAIR_START; i < PAIR_START + PAIR_COUNT; i += 1) {
  const seed = 1000000 + i * 7919; // arbitrary but deterministic/reproducible spacing
  playAndScore(seed, { white: evalA, black: evalB }, `pair ${i} game 1`);
  playAndScore(seed, { white: evalB, black: evalA }, `pair ${i} game 2 (swapped)`);
}

const decisive = aWins + bWins;
console.log("\n=== RESULT ===");
console.log("A wins:", aWins, "B wins:", bWins, "draws:", draws, "unfinished:", unfinished);
if (decisive > 0) {
  const aRate = aWins / decisive;
  console.log("A win rate (decisive games only):", (aRate * 100).toFixed(1) + "%", `(${aWins}/${decisive})`);
  // Simple two-sided binomial-ish z-test against 50/50, normal approximation
  // -- good enough for a quick "is this within noise" read at this sample size.
  const se = Math.sqrt(0.25 / decisive);
  const z = (aRate - 0.5) / se;
  console.log("z-score vs 50/50:", z.toFixed(2), Math.abs(z) >= 1.96 ? "(|z|>=1.96, likely NOT just noise)" : "(within typical noise range)");
}
