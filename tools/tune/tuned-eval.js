// Recomputes evaluateState()'s weighted sum with a caller-supplied set of
// coefficients, WITHOUT touching engine-merged.js. Reuses
// evaluateStateComponents() (already exported by the engine, see the "Grafted
// from engine.optimized.js" comment above it in engine-merged.js) for every
// sub-score, and only replaces the final weighted-sum step. Meant to be
// plugged into searchBestAction() via options.evalFn -- see
// engine-merged.js's `context.evalFn || evaluateState` call sites (~L4777,
// L4778, L4880, L4881, L4914) for the extension point this targets.
"use strict";
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const engine = require(path.join(ROOT, "engine-merged.js"));

// Same 8 tunable coefficients texel-tune.js fits, in the same order weights.json
// stores them. `component` names the evaluateStateComponents() field the
// coefficient multiplies; `sign` matches evaluateState()'s own formula
// (material is added, every *Enemy term is subtracted).
const TUNABLE = [
  { key: "material", component: "material", sign: 1, default: 1.35 },
  { key: "positionEnemy", component: "positionEnemy", sign: -1, default: 0.88 },
  { key: "kingSafetyEnemy", component: "kingSafetyEnemy", sign: -1, default: 0.72 },
  { key: "pressureEnemy", component: "pressureEnemy", sign: -1, default: 0.65 },
  { key: "specialEnemy", component: "specialEnemy", sign: -1, default: 0.82 },
  { key: "bloodMoonEnemy", component: "bloodMoonEnemy", sign: -1, default: 0.82 },
  { key: "cardsEnemy", component: "cardsEnemy", sign: -1, default: 0.92 },
  { key: "campaignEnemy", component: "campaignEnemy", sign: -1, default: 0.9 }
];
const DEFAULT_WEIGHTS = Object.fromEntries(TUNABLE.map((t) => [t.key, t.default]));

// Recomputes evaluateState()'s formula from already-extracted components,
// substituting `weights` (a subset of TUNABLE's keys is fine -- anything
// missing falls back to the engine's own default) for the 8 tunable
// coefficients. Everything else (exchange, *Self terms, ultimatum,
// persistentObjectives, bonus, tacticalSafety) keeps its fixed coefficient
// of 1 (or -1 for persistentObjectivesEnemy), exactly as evaluateState()
// itself hard-codes them.
function scoreFromComponents(c, weights) {
  if (c.terminal !== null && c.terminal !== undefined) return c.terminal;
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  return c.material * w.material + c.exchange
    + (c.positionSelf - c.positionEnemy * w.positionEnemy)
    + (c.kingSafetySelf - c.kingSafetyEnemy * w.kingSafetyEnemy)
    + (c.pressureSelf - c.pressureEnemy * w.pressureEnemy)
    + (c.specialSelf - c.specialEnemy * w.specialEnemy)
    + (c.bloodMoonSelf - c.bloodMoonEnemy * w.bloodMoonEnemy)
    + (c.cardsSelf - c.cardsEnemy * w.cardsEnemy)
    + (c.campaignSelf - c.campaignEnemy * w.campaignEnemy)
    + c.ultimatum
    + (c.persistentObjectivesSelf - c.persistentObjectivesEnemy)
    + c.bonus + c.tacticalSafety;
}

// Builds an evalFn(boardState, aiColor) suitable for options.evalFn in
// searchBestAction(), using `weights` (e.g. loaded from tools/tune/weights.json)
// instead of evaluateState()'s hand-picked constants.
function makeTunedEvalFn(weights) {
  const w = { ...DEFAULT_WEIGHTS, ...weights };
  return function tunedEvalFn(boardState, aiColor) {
    const c = engine.evaluateStateComponents(boardState, aiColor);
    return scoreFromComponents(c, w);
  };
}

module.exports = { TUNABLE, DEFAULT_WEIGHTS, scoreFromComponents, makeTunedEvalFn };
