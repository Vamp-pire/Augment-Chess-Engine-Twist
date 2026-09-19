// Compares generateActions/isWorkerDefeatRoyalPiece-style decisive-capture
// behavior between the OLD buggy engine.optimized.js and the new
// engine-merged.js for the regencyHeir scenario from this session's
// bug-fix history: a piece with regencyHeir:true, under active regency
// and kingDead for its color, should be capturable and end the game when
// captured (this was a real regression found and fixed this session:
// the first port of isWorkerDefeatRoyalPiece omitted the
// isWorkerRegencyRoyalHeir OR-branch entirely).
globalThis.self = globalThis;
globalThis.addEventListener = () => {};

const merged = require("../engine-merged.js");
const old = require("./engine.optimized.js");

function makeState(engine) {
  const state = engine.cloneState({});
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  board[7][4] = { type: "king", color: "white", moved: false };
  // Black's king is dead; black is under regency with a queen designated
  // as the regencyHeir. That queen should be a legitimate, game-ending
  // capture target for white.
  board[0][3] = { type: "queen", color: "black", moved: false, regencyHeir: true };
  board[3][3] = { type: "rook", color: "white", moved: false };
  state.board = board;
  state.mode = "play";
  state.turn = "white";
  state.actionsRemaining = 1;
  state.deckSlots = { white: [], black: [] };
  state.captures = { white: [], black: [] };
  state.kingDead = { black: true };
  state.regency = { black: true };
  engine.setWorkerBoardDimensions(state);
  return state;
}

function checkEngine(name, engine) {
  const state = makeState(engine);
  const actions = engine.generateActions(state, "white");
  const captureMove = actions.find(
    (a) => a.type === "move" && a.from?.row === 3 && a.from?.col === 3 && a.move?.row === 0 && a.move?.col === 3
  );
  console.log(`[${name}] rook-captures-regencyHeir-queen action found:`, Boolean(captureMove));
  if (!captureMove) {
    console.log(`[${name}] SKIP: no direct capture action generated (cannot test applyAction outcome)`);
    return;
  }
  const after = engine.cloneState(state);
  const applied = engine.applyAction(after, captureMove, "white");
  console.log(`[${name}] applyAction ok=${applied.ok}, resulting mode=${after.mode}, winner=${after.winner}`);
  console.log(`[${name}] CORRECT (game-ending capture): ${applied.ok && after.mode === "gameover" && after.winner === "white"}`);
}

checkEngine("engine.optimized.js (OLD)", old);
checkEngine("engine-merged.js (NEW)", merged);
