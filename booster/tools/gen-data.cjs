// Training data for an NNUE evaluation: fast-engine self-play on boards that
// mix standard pieces with randomly placed card pieces the engine knows.
// Each searched position is written with the engine's root score (side to
// move, centipawns) and, after the game, the result from the same side.
//
//   node tools/gen-data.cjs --out data.jsonl --minutes 40 --ms 50 --seed 7 [--nnue w.json]
//
// Line format: {"p":[kind,color,sq,...],"s":side,"v":score,"r":result}
// kind = index in Object.keys(BUILTIN); color 0 = white; sq 0 = a8.
"use strict";
const fs = require("fs");
const path = require("path");
const engineModule = require(path.join(__dirname, "..", "fast-engine.js"));

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = opt("out", "data.jsonl"), minutes = Number(opt("minutes", 10)), ms = Number(opt("ms", 50));
let seed = Number(opt("seed", 1)) >>> 0;
const rand = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const nnue = opt("nnue", null) ? JSON.parse(fs.readFileSync(opt("nnue"), "utf8")) : null;

const engine = engineModule();
const KINDS = Object.keys(engine.BUILTIN);
const KIND = Object.fromEntries(KINDS.map((k, i) => [k, i]));
const EXCLUDE = new Set(["pawn", "berolina-pawn", "king", "vip", "jester-royal", "brutus", "immobile"]);
const CARD_KINDS = KINDS.filter((k) => !EXCLUDE.has(k));
const BACK = ["rook", "knight", "bishop", "queen", "king", "bishop", "knight", "rook"];

function startBoard() {
  const b = new Array(64).fill(null);
  for (let c = 0; c < 8; c++) {
    b[c] = { kind: BACK[c], color: 1, moved: false };
    b[8 + c] = { kind: "pawn", color: 1, moved: false };
    b[48 + c] = { kind: "pawn", color: 0, moved: false };
    b[56 + c] = { kind: BACK[c], color: 0, moved: false };
  }
  // Card pieces: replace 0-3 back-rank pieces (not the king) and sometimes a pawn.
  for (const color of [0, 1]) {
    if (rand() < 0.2) continue;
    const n = 1 + Math.floor(rand() * 3), row = color === 0 ? 56 : 0;
    for (let i = 0; i < n; i++) {
      const c = [0, 1, 2, 3, 5, 6, 7][Math.floor(rand() * 7)];
      b[row + c] = { kind: CARD_KINDS[Math.floor(rand() * CARD_KINDS.length)], color, moved: false };
    }
    if (rand() < 0.3) {
      const c = Math.floor(rand() * 8), sq = color === 0 ? 48 + c : 8 + c;
      b[sq] = { kind: CARD_KINDS[Math.floor(rand() * CARD_KINDS.length)], color, moved: false };
    }
  }
  return b;
}

const clone = (b) => b.map((p) => (p ? { ...p } : null));
const listMoves = (board, side) => {
  const r = engine.search({ board: clone(board), turn: side, rootMoves: null, listOnly: true });
  return r.ok ? r.moves : [];
};

function playGame(fd) {
  const board = startBoard();
  let side = 0, quiet = 0;
  const seen = new Map(), rows = [];
  const apply = (m) => {
    const p = board[m.from], cap = board[m.to];
    board[m.to] = { ...p, kind: m.promo || p.kind, moved: true };
    board[m.from] = null;
    quiet = cap || p.kind === "pawn" ? 0 : quiet + 1;
    side ^= 1;
    return cap;
  };
  // random opening, quiet moves only
  const openN = 2 + Math.floor(rand() * 6);
  for (let i = 0; i < openN; i++) {
    const moves = listMoves(board, side).filter((m) => !board[m.to]);
    if (!moves.length) break;
    apply(moves[Math.floor(rand() * moves.length)]);
  }
  let result = 0.5; // white's view
  for (let ply = 0; ply < 300; ply++) {
    const moves = listMoves(board, side);
    if (!moves.length) { result = side === 0 ? 0 : 1; break; }
    const r = engine.search({ board: clone(board), turn: side, rootMoves: moves, timeMs: ms, nnue });
    if (!r.ok) { result = side === 0 ? 0 : 1; break; }
    const p = [];
    for (let sq = 0; sq < 64; sq++) if (board[sq] && KIND[board[sq].kind] != null) p.push(KIND[board[sq].kind], board[sq].color, sq);
    rows.push({ p, s: side, v: Math.max(-3000, Math.min(3000, r.score)) });
    const m = moves.find((x) => x.from === r.move.from && x.to === r.move.to && (x.promo ?? null) === (r.move.promo ?? null)) || r.move;
    const cap = apply(m);
    if (cap && engine.BUILTIN[cap.kind]?.royal) { result = side === 1 ? 1 : 0; break; }
    if (quiet >= 60) break;
    const k = side + board.map((q) => (q ? q.kind + q.color : ".")).join(",");
    const n = (seen.get(k) || 0) + 1; seen.set(k, n);
    if (n >= 3) break;
  }
  let text = "";
  for (const row of rows) text += JSON.stringify({ ...row, r: row.s === 0 ? result : 1 - result }) + "\n";
  fs.writeSync(fd, text);
  return rows.length;
}

const fd = fs.openSync(out, "a");
const end = Date.now() + minutes * 60000;
let games = 0, positions = 0;
while (Date.now() < end) {
  try { positions += playGame(fd); games++; } catch (e) { console.error("game error:", e.message); }
}
fs.closeSync(fd);
console.log(`games=${games} positions=${positions}`);
