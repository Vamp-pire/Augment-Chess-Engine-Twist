// Sign-agreement + McNemar comparison of two evaluators against a REAL
// recorded game's actual outcome (not self-play noise) -- positions come
// from site-oracle/acg-to-positions.mjs's exact before/after event deltas,
// not a re-parsed/guessed replay.
//
// Usage: node eval-acg-positions.js <positions.json> <weightsPathOrHandcoded> <weightsPathOrHandcoded>
globalThis.self = globalThis;
globalThis.addEventListener = () => {};
const fs = require("fs");
const path = require("path");
const engine = require("../engine-merged.js");
const { encodeBoard } = require("./encode.js");
const { loadWeights, forward } = require("./forward.js");

const [, , positionsPath, aArg, bArg] = process.argv;
if (!positionsPath || !aArg || !bArg) {
  console.error("Usage: node eval-acg-positions.js <positions.json> <weightsA|handcoded> <weightsB|handcoded>");
  process.exit(1);
}
const SCORE_SCALE = 100;
function makeEvaluator(arg) {
  if (arg === "handcoded") {
    return (entry) => {
      const state = engine.cloneState({});
      state.board = entry.board.map((row) => row.map((p) => (p ? { type: p.t, color: p.c, moved: true } : null)));
      state.deckSlots = entry.deckSlots;
      state.mode = "play";
      state.aiSearchNoCards = true;
      engine.setWorkerBoardDimensions(state);
      return engine.evaluateState(state, entry.turn);
    };
  }
  const weights = loadWeights(arg);
  return (entry) => {
    const input = encodeBoard(entry.board, entry.turn, entry.deckSlots);
    if (input === null) return 0;
    return forward(weights, input) * SCORE_SCALE;
  };
}

const positions = JSON.parse(fs.readFileSync(positionsPath, "utf8"));
const decisive = positions.filter((p) => p.outcome !== 0);
console.log(`positions: ${positions.length} total, ${decisive.length} decisive (non-draw/unknown)`);

const evalA = makeEvaluator(aArg);
const evalB = makeEvaluator(bArg);

let aCorrect = 0, bCorrect = 0;
let bothCorrect = 0, bothWrong = 0, onlyA = 0, onlyB = 0;
for (const entry of decisive) {
  const scoreA = evalA(entry);
  const scoreB = evalB(entry);
  const correctA = Math.sign(scoreA) === Math.sign(entry.outcome);
  const correctB = Math.sign(scoreB) === Math.sign(entry.outcome);
  if (correctA) aCorrect += 1;
  if (correctB) bCorrect += 1;
  if (correctA && correctB) bothCorrect += 1;
  else if (!correctA && !correctB) bothWrong += 1;
  else if (correctA) onlyA += 1;
  else onlyB += 1;
}

console.log(`\nA (${aArg}): ${(100 * aCorrect / decisive.length).toFixed(1)}% (${aCorrect}/${decisive.length})`);
console.log(`B (${bArg}): ${(100 * bCorrect / decisive.length).toFixed(1)}% (${bCorrect}/${decisive.length})`);
console.log(`\nboth correct: ${bothCorrect}, both wrong: ${bothWrong}, only A: ${onlyA}, only B: ${onlyB}`);

const b = onlyA, c = onlyB;
if (b + c > 0) {
  const chiSq = Math.pow(Math.abs(b - c) - 1, 2) / (b + c);
  console.log(`McNemar chi-sq=${chiSq.toFixed(3)} (b=${b}, c=${c}) -- small sample, treat as directional signal only`);
} else {
  console.log("No disagreements -- A and B always agreed on this sample.");
}
