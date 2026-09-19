// Fits new weights for evaluateState()'s ~13 named sub-scores against real
// self-play outcome data, instead of the hand-picked constants currently in
// engine.js (0.88, 0.72, 0.65, etc. -- no documented basis for any of them).
// Far fewer parameters than the full NNUE (13ish vs ~69,000), so much less
// prone to overfitting on the same amount of data. Uses the exact same
// game-boundary train/val split as nnue/train.js so results are directly
// comparable to everything measured there.
const fs = require("fs");
const path = require("path");
const tf = require("@tensorflow/tfjs");
const engine = require("../legacy/engine.optimized.js");

const DATA_FILE = path.join(__dirname, "..", "selfplay-data.jsonl");

function countPieces(board) {
  let n = 0;
  for (const row of board) for (const p of row) if (p) n++;
  return n;
}
function assignGameIds(pieceCounts) {
  const gameIds = new Array(pieceCounts.length);
  let gameId = 0, sawCapture = false;
  pieceCounts.forEach((count, i) => {
    if (i > 0 && count === 32 && sawCapture) { gameId += 1; sawCapture = false; }
    gameIds[i] = gameId;
    if (count < 32) sawCapture = true;
  });
  return gameIds;
}

function makeState(board) {
  const state = engine.cloneState({});
  state.board = board.map((row) => row.map((p) => (p ? { type: p.t, color: p.c, moved: true } : null)));
  state.mode = "play";
  state.deckSlots = { white: [], black: [] };
  state.captures = { white: [], black: [] };
  state.aiSearchNoCards = true;
  engine.setWorkerBoardDimensions(state);
  return state;
}

// evaluateState()'s formula weights "self" and "enemy" sides of most terms
// DIFFERENTLY (e.g. positionSelf * 1 - positionEnemy * 0.88) -- a single
// differenced (self - enemy) feature per term can't represent that
// asymmetry with one learnable weight, so self/enemy stay as separate raw
// features here instead (21 total). Still far fewer params than the full
// NNUE's ~69,000.
const FEATURE_NAMES = [
  "material", "exchange",
  "positionSelf", "positionEnemy",
  "kingSafetySelf", "kingSafetyEnemy",
  "pressureSelf", "pressureEnemy",
  "specialSelf", "specialEnemy",
  "bloodMoonSelf", "bloodMoonEnemy",
  "cardsSelf", "cardsEnemy",
  "campaignSelf", "campaignEnemy",
  "ultimatum",
  "persistentObjectivesSelf", "persistentObjectivesEnemy",
  "bonus", "tacticalSafety"
];
function featuresFor(board, turn) {
  const state = makeState(board);
  const c = engine.evaluateStateComponents(state, turn);
  if (c.terminal !== null) return null; // terminal positions aren't in self-play data anyway, but be safe
  return [
    c.material, c.exchange,
    c.positionSelf, c.positionEnemy,
    c.kingSafetySelf, c.kingSafetyEnemy,
    c.pressureSelf, c.pressureEnemy,
    c.specialSelf, c.specialEnemy,
    c.bloodMoonSelf, c.bloodMoonEnemy,
    c.cardsSelf, c.cardsEnemy,
    c.campaignSelf, c.campaignEnemy,
    c.ultimatum,
    c.persistentObjectivesSelf, c.persistentObjectivesEnemy,
    c.bonus, c.tacticalSafety
  ];
}
// Original hand-picked weights, for the "before" comparison -- exactly
// evaluateState()'s own formula: material*1.35 + exchange*1 +
// (positionSelf*1 - positionEnemy*0.88) + ... , ultimatum/bonus/
// tacticalSafety/persistentObjectivesSelf all at their own coefficient of 1
// (persistentObjectivesEnemy at -1, i.e. weight -1 here since these are raw
// features now, not pre-differenced).
const ORIGINAL_WEIGHTS = [
  1.35, 1,
  1, -0.88,
  1, -0.72,
  1, -0.65,
  1, -0.82,
  1, -0.82,
  1, -0.92,
  1, -0.9,
  1,
  1, -1,
  1, 1
];

(async () => {
  const lines = fs.readFileSync(DATA_FILE, "utf8").split("\n").filter(Boolean);
  const kept = [];
  const pieceCounts = [];
  for (const line of lines) {
    const e = JSON.parse(line);
    if (e.explorationTainted || e.unfinished) continue;
    kept.push(e);
    pieceCounts.push(countPieces(e.board));
  }
  const gameIds = assignGameIds(pieceCounts);
  const totalGames = gameIds[gameIds.length - 1] + 1;
  const valGameStart = Math.floor(totalGames * 0.9);
  const splitAt = gameIds.findIndex((id) => id >= valGameStart);

  console.log("total usable:", kept.length, "games:", totalGames, "split at position", splitAt);
  console.log("extracting features (this calls evaluateStateComponents per position, may take a bit)...");

  const allFeatures = kept.map((e) => featuresFor(e.board, e.turn));
  const allLabels = kept.map((e) => e.outcome);
  const nullCount = allFeatures.filter((f) => f === null).length;
  if (nullCount > 0) console.log("skipping", nullCount, "positions where evaluateStateComponents reported terminal");

  const trainIdx = [], valIdx = [];
  gameIds.forEach((id, i) => { if (allFeatures[i] === null) return; (id < valGameStart ? trainIdx : valIdx).push(i); });
  // Only decisive positions matter for the accuracy metric, but train the
  // regression on ALL (including draws, label 0) -- draws are still a
  // meaningful, informative example of "roughly balanced".
  const xTrain = tf.tensor2d(trainIdx.map((i) => allFeatures[i]));
  const yTrain = tf.tensor2d(trainIdx.map((i) => allLabels[i]), [trainIdx.length, 1]);

  const model = tf.sequential();
  model.add(tf.layers.dense({
    units: 1,
    activation: "tanh",
    inputShape: [FEATURE_NAMES.length],
    useBias: false, // evaluateState's formula has no additive constant term
    kernelRegularizer: tf.regularizers.l2({ l2: 0.001 })
  }));
  model.compile({ optimizer: tf.train.adam(0.01), loss: "meanSquaredError" });
  await model.fit(xTrain, yTrain, { epochs: 60, batchSize: 64, verbose: 0 });

  const fittedWeights = Array.from((await model.getWeights()[0].data()));
  console.log("\nfitted weights:");
  FEATURE_NAMES.forEach((name, i) => console.log(" ", name, ":", fittedWeights[i].toFixed(4), " (original:", ORIGINAL_WEIGHTS[i], ")"));

  // Compare accuracy: original hand-picked weights vs fitted weights, both
  // just a plain weighted sum (no tanh squashing needed for sign-agreement
  // -- sign of a weighted sum is what matters, tanh doesn't flip sign).
  const valDecisive = valIdx.filter((i) => allLabels[i] !== 0);
  function accuracyFor(weights) {
    let correct = 0;
    for (const i of valDecisive) {
      const f = allFeatures[i];
      const score = f.reduce((sum, v, j) => sum + v * weights[j], 0);
      if (Math.sign(score) === allLabels[i]) correct++;
    }
    return correct / valDecisive.length;
  }
  const n = valDecisive.length;
  console.log("\ndecisive validation positions:", n);
  console.log("original hand-picked weights accuracy:", (100 * accuracyFor(ORIGINAL_WEIGHTS)).toFixed(1) + "%");
  console.log("data-fitted weights accuracy:          ", (100 * accuracyFor(fittedWeights)).toFixed(1) + "%");
})();
