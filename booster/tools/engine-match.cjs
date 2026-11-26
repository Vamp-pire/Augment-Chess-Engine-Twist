// Engine-vs-engine match on plain chess under Augment Chess rules (king
// capture wins, no legal move loses, moving into check is legal).
// Compares two fast-engine.js versions without the game, so evaluation and
// search changes can be judged by games.
//
//   node tools/engine-match.cjs <engineA.js> <engineB.js> [--pairs 100] [--ms 50] [--workers 3] [--seed 1] [--nnue-a w.json] [--nnue-b w.json]
//
// Each pair plays one random opening (4-8 random plies) twice with colors
// swapped. Draws: 3-fold repetition, 60 plies without capture or pawn move,
// 300 plies total. Result is from engine A's view.
"use strict";
const path = require("path");
const { fork } = require("child_process");

const NAMES = { p: "pawn", n: "knight", b: "bishop", r: "rook", q: "queen", k: "king" };
const START = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR";

function boardFromFen(fen) {
  const board = new Array(64).fill(null);
  fen.split("/").forEach((row, r) => {
    let c = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) { c += Number(ch); continue; }
      board[r * 8 + c] = { kind: NAMES[ch.toLowerCase()], color: ch === ch.toUpperCase() ? 0 : 1, moved: false };
      c++;
    }
  });
  return board;
}

function genMoves(board, side) {
  const out = [];
  const add = (f, t, promo) => out.push({ from: f, to: t, promo });
  for (let f = 0; f < 64; f++) {
    const p = board[f]; if (!p || p.color !== side) continue;
    const r = f >> 3, c = f & 7;
    const own = (t) => board[t] && board[t].color === side;
    const ray = (dirs, slide) => {
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (rr >= 0 && rr < 8 && cc >= 0 && cc < 8) {
          const t = rr * 8 + cc;
          if (own(t)) break;
          add(f, t);
          if (board[t] || !slide) break;
          rr += dr; cc += dc;
        }
      }
    };
    const O = [[1, 0], [-1, 0], [0, 1], [0, -1]], D = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    if (p.kind === "pawn") {
      const d = side === 0 ? -1 : 1, rr = r + d, last = side === 0 ? 0 : 7;
      if (rr < 0 || rr > 7) continue;
      const one = rr * 8 + c, promo = rr === last ? "queen" : undefined;
      if (!board[one]) {
        add(f, one, promo);
        const start = side === 0 ? 6 : 1;
        if (r === start && !board[one + d * 8]) add(f, one + d * 8);
      }
      for (const dc of [-1, 1]) {
        const cc = c + dc; if (cc < 0 || cc > 7) continue;
        const t = rr * 8 + cc;
        if (board[t] && board[t].color !== side) add(f, t, promo);
      }
    } else if (p.kind === "knight") ray([[2, 1], [2, -1], [-2, 1], [-2, -1], [1, 2], [1, -2], [-1, 2], [-1, -2]], false);
    else if (p.kind === "bishop") ray(D, true);
    else if (p.kind === "rook") ray(O, true);
    else if (p.kind === "queen") ray([...O, ...D], true);
    else if (p.kind === "king") ray([...O, ...D], false);
  }
  return out;
}

const key = (board, side) => side + board.map((p) => (p ? p.kind[0] + p.color : ".")).join("");

// Plays one game. Returns 1 (white wins), 0 (black wins) or 0.5.
function playGame(engines, opening, ms) {
  const board = boardFromFen(START);
  let side = 0, quiet = 0;
  const seen = new Map();
  const apply = (m) => {
    const p = board[m.from], cap = board[m.to];
    board[m.to] = { ...p, kind: m.promo || p.kind, moved: true };
    board[m.from] = null;
    quiet = cap || p.kind === "pawn" ? 0 : quiet + 1;
    side ^= 1;
    return cap;
  };
  for (const m of opening) apply(m);
  for (let ply = 0; ply < 300; ply++) {
    const moves = genMoves(board, side);
    if (!moves.length) return side === 0 ? 0 : 1;
    const r = engines[side].e.search({ board: board.map((p) => (p ? { ...p } : null)), turn: side, rootMoves: moves, timeMs: ms, nnue: engines[side].nnue, ...engines[side].opt });
    const m = r.ok ? moves.find((x) => x.from === r.move.from && x.to === r.move.to && (x.promo ?? null) === (r.move.promo ?? x.promo ?? null)) || moves[0] : moves[0];
    const cap = apply(m);
    if (cap && cap.kind === "king") return side === 1 ? 1 : 0; // side already flipped
    if (quiet >= 60) return 0.5;
    const k = key(board, side), n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    if (n >= 3) return 0.5;
  }
  return 0.5;
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

function randomOpening(rand) {
  const board = boardFromFen(START);
  let side = 0;
  const n = 4 + Math.floor(rand() * 5), out = [];
  for (let i = 0; i < n; i++) {
    const moves = genMoves(board, side).filter((m) => !board[m.to]);
    const m = moves[Math.floor(rand() * moves.length)];
    board[m.to] = { ...board[m.from], moved: true }; board[m.from] = null;
    out.push(m); side ^= 1;
  }
  return out;
}

function worker() {
  process.on("message", ({ a, b, na, nb, oa, ob, openings, ms }) => {
    const load = (f) => (f ? JSON.parse(require("fs").readFileSync(f, "utf8")) : null);
    const A = { e: require(path.resolve(a))(), nnue: load(na), opt: oa }, B = { e: require(path.resolve(b))(), nnue: load(nb), opt: ob };
    const scores = [];
    for (const op of openings) {
      scores.push(playGame([A, B], op, ms));          // A white
      scores.push(1 - playGame([B, A], op, ms));      // A black
    }
    process.send(scores);
    process.exit(0);
  });
}

function summarize(scores) {
  const n = scores.length, w = scores.filter((s) => s === 1).length, d = scores.filter((s) => s === 0.5).length, l = n - w - d;
  const p = (w + d / 2) / n;
  const elo = (x) => -400 * Math.log10(1 / Math.min(Math.max(x, 1e-3), 1 - 1e-3) - 1);
  // variance from pair scores (pairs are correlated through the opening)
  const pairs = []; for (let i = 0; i < n; i += 2) pairs.push((scores[i] + scores[i + 1]) / 2);
  const mean = pairs.reduce((s, x) => s + x, 0) / pairs.length;
  const sd = Math.sqrt(pairs.reduce((s, x) => s + (x - mean) ** 2, 0) / Math.max(1, pairs.length - 1));
  const se = sd / Math.sqrt(pairs.length);
  return `A: ${w}W ${d}D ${l}L of ${n}, ${(p * 100).toFixed(1)}%, Elo ${elo(p).toFixed(0)} [${elo(p - 1.96 * se).toFixed(0)}, ${elo(p + 1.96 * se).toFixed(0)}]`;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? Number(args[i + 1]) : d; };
  const sopt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : null; };
  const na = sopt("nnue-a"), nb = sopt("nnue-b");
  // extra search input per side, e.g. --opt-a '{"evalExtra":1}'
  const oa = JSON.parse(sopt("opt-a") || "{}"), ob = JSON.parse(sopt("opt-b") || "{}");
  const [a, b] = args.filter((x, i) => !x.startsWith("--") && !args[i - 1]?.startsWith("--"));
  const pairs = opt("pairs", 100), ms = opt("ms", 50), workers = opt("workers", 3), rand = rng(opt("seed", 1));
  const openings = Array.from({ length: pairs }, () => randomOpening(rand));
  const t0 = Date.now();
  const parts = await Promise.all(Array.from({ length: workers }, (_, w) => new Promise((res, rej) => {
    const child = fork(__filename, ["--child"]);
    child.on("message", res); child.on("error", rej);
    child.send({ a, b, na, nb, oa, ob, openings: openings.filter((_, i) => i % workers === w), ms });
  })));
  const scores = parts.flat();
  console.log(`${path.basename(a)}${na ? "+" + path.basename(na) : ""}${Object.keys(oa).length ? JSON.stringify(oa) : ""} vs ${path.basename(b)}${nb ? "+" + path.basename(nb) : ""}${Object.keys(ob).length ? JSON.stringify(ob) : ""}, ${ms} ms/move, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(summarize(scores));
}

if (process.argv.includes("--child")) worker(); else main();
