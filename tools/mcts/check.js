// Unit-check of tools/mcts/mcts.js on positions from the local self-play data: node tools/mcts/check.js [N] [sims]
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..", "..");
const e = require(path.join(root, "engine-merged.js"));
const { createMctsSearch } = require("./mcts.js");
const N = +process.argv[2] || 5, SIMS = +process.argv[3] || 100;
const lines = fs.readFileSync(path.join(root, "data", "experiments", "selfplay-data.merged-engine-16cards-local-2026-09-15.jsonl"), "utf8").split("\n").filter(Boolean);
function mk(rec) { const s = e.cloneState({}); s.board = rec.board.map(r => r.map(p => p ? { type: p.t, color: p.c, moved: true } : null)); s.mode = "play"; s.turn = rec.turn; s.deckSlots = { white: rec.deckSlots?.white || [], black: rec.deckSlots?.black || [] }; s.captures = { white: [], black: [] }; s.aiSearchNoCards = false; s.turnsTaken = { white: 10, black: 10 }; s.actionsRemaining = 1; s.moveCount = 20; s.castlingCanceled = { white: true, black: true }; e.setWorkerBoardDimensions(s); return s; }
const m = createMctsSearch({ sims: SIMS });
const step = Math.floor(lines.length / N);
let tot = 0, ms = 0;
for (let k = 0; k < N; k++) {
  const rec = JSON.parse(lines[k * step + 3]); const s = mk(rec); const a = e.generateActions(s, rec.turn);
  const r = m.search(s, a, rec.turn, {});
  const legal = a.some(x => JSON.stringify(x) === JSON.stringify(r.action));
  const unsafe = a.filter(x => { const n = e.cloneState(s); const ap = e.applyAction(n, JSON.parse(JSON.stringify(x)), rec.turn); return ap.ok && e.rootCandidateAllowsImmediateDecisiveReply(n, rec.turn); }).length;
  const n2 = e.cloneState(s); e.applyAction(n2, JSON.parse(JSON.stringify(r.action)), rec.turn);
  const chosenUnsafe = e.rootCandidateAllowsImmediateDecisiveReply(n2, rec.turn);
  const wins = a.filter(x => e.actionDecisivelyWins(s, x, rec.turn)).length;
  console.log(`pos ${k}: actions ${a.length} legal=${legal} decisiveWins=${wins} unsafeCands=${unsafe} chosenUnsafe=${chosenUnsafe} score=${Math.round(r.score)} sims=${r.nodes} ms=${r.ms}`);
  tot += r.nodes; ms += r.ms || 0;
}
console.log(`sims/s ~ ${(tot / (ms / 1000)).toFixed(1)}`);
