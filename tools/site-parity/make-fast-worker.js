#!/usr/bin/env node
// Builds .cache/real-worker-fast.js from .cache/real-worker.js (the site's own rules code) by
// applying anchored, behaviour-preserving perf patches, so the site's exact rules can serve as the
// self-play rules layer. The original cache file is never modified. Every patch asserts that its
// anchor text occurs exactly once and fails loudly otherwise (the site code changes over time --
// re-check equivalence with diff-fast-worker.js after any failure/re-anchor).
// Usage: node make-fast-worker.js [--skip=name1,name2] [--only=name1,...] [--out=path]
// Verify: node diff-fast-worker.js [GAMES=300] [seed] [PLIES=120]
const fs = require("fs"), path = require("path");
const CACHE = path.join(__dirname, ".cache");
const SRC = path.join(CACHE, "real-worker.js");
const argv = process.argv.slice(2);
const opt = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || "").slice(k.length + 3);
const OUT = opt("out") ? path.resolve(opt("out")) : path.join(CACHE, "real-worker-fast.js");
const skip = new Set(opt("skip").split(",").filter(Boolean)), only = new Set(opt("only").split(",").filter(Boolean));

const PATCHES = [
  {
    // Math.max(1, ...board.map(...)) allocated two arrays per call and ran on every get()/inBounds().
    // Same result incl. the sparse-row edge case (map keeps holes, spread turns them into undefined -> NaN).
    name: "boardColCount-loop",
    find: `  function boardColCount(boardState) {
    if (!Array.isArray(boardState?.board) || !boardState.board.length) return workerBoardCols;
    return Math.max(1, ...boardState.board.map((row) => Array.isArray(row) ? row.length : 0));
  }`,
    replace: `  function boardColCount(boardState) {
    if (!Array.isArray(boardState?.board) || !boardState.board.length) return workerBoardCols;
    const rows = boardState.board;
    let max = 1;
    for (let i = 0; i < rows.length; i += 1) {
      const r = rows[i];
      if (r === void 0 && !(i in rows)) return NaN;
      const n = Array.isArray(r) ? r.length : 0;
      if (n > max) max = n;
    }
    return max;
  }`,
  },
  {
    // Board dimensions can only change inside the callback, so they are re-read after each
    // callback instead of on every cell; get()'s bounds check is inlined against those same
    // values; "row:col" dedupe keys come from an interned table (same string values).
    // (Superseded by forEachPiece-dedupe when both are enabled; kept separately measurable.)
    name: "forEachPiece-hoist",
    find: `  function forEachPiece(boardState, callback) {
    const seen = /* @__PURE__ */ new Set();
    for (let row = 0; row < boardRowCount(boardState); row += 1) {
      for (let col = 0; col < boardColCount(boardState); col += 1) {
        const piece = get(boardState, row, col);
        if (!piece) continue;
        const id = piece.id || \`\${row}:\${col}\`;
        if (seen.has(id)) continue;
        seen.add(id);
        if (Number.isInteger(piece.anchorRow) && Number.isInteger(piece.anchorCol) && (piece.anchorRow !== row || piece.anchorCol !== col)) continue;
        callback(piece, row, col);
      }
    }
  }`,
    replace: `  const FAST_CELL_KEYS = Array.from({ length: 32 }, (_, r) => Array.from({ length: 32 }, (_2, c) => \`\${r}:\${c}\`));
  function forEachPiece(boardState, callback) {
    const seen = /* @__PURE__ */ new Set();
    let rows = boardRowCount(boardState);
    let cols = boardColCount(boardState);
    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const piece = row < rows ? boardState.board[row]?.[col] || null : null;
        if (!piece) continue;
        const id = piece.id || (row < 32 && col < 32 ? FAST_CELL_KEYS[row][col] : \`\${row}:\${col}\`);
        if (seen.has(id)) continue;
        seen.add(id);
        if (Number.isInteger(piece.anchorRow) && Number.isInteger(piece.anchorCol) && (piece.anchorRow !== row || piece.anchorCol !== col)) continue;
        callback(piece, row, col);
        rows = boardRowCount(boardState);
        cols = boardColCount(boardState);
      }
    }
  }`,
  },
  {
    // (applies on top of forEachPiece-hoist) The dedupe Set held every piece's key, including a
    // fresh "row:col" key per id-less piece. Id-less pieces sit on distinct cells, so their key can
    // only collide with a real id that looks like "row:col": ids go in a lazily-made Set, id-less
    // cells in a number list, and the cross-check runs only when an id contains ":" -- the skip
    // decisions are exactly those of the original single Set.
    name: "forEachPiece-dedupe",
    find: `        const id = piece.id || (row < 32 && col < 32 ? FAST_CELL_KEYS[row][col] : \`\${row}:\${col}\`);
        if (seen.has(id)) continue;
        seen.add(id);
`,
    replace: `        const id = piece.id;
        if (id) {
          if (seen === null) seen = /* @__PURE__ */ new Set();
          else if (seen.has(id)) continue;
          if (typeof id === "string" && id.indexOf(":") !== -1) {
            if (idlessCells !== null) {
              const m = FAST_CELL_KEY_RE.exec(id);
              if (m && m[1].length < 5 && m[2].length < 5 && idlessCells.includes(Number(m[1]) * 65536 + Number(m[2]))) continue;
            }
            colonIds = true;
          }
          seen.add(id);
        } else {
          if (colonIds && seen.has(row < 32 && col < 32 ? FAST_CELL_KEYS[row][col] : \`\${row}:\${col}\`)) continue;
          (idlessCells ??= []).push(row * 65536 + col);
        }
`,
    also: [[`  function forEachPiece(boardState, callback) {
    const seen = /* @__PURE__ */ new Set();
    let rows`, `  const FAST_CELL_KEY_RE = /^(0|[1-9]\\d*):(0|[1-9]\\d*)$/;
  function forEachPiece(boardState, callback) {
    let seen = null;
    let colonIds = false;
    let idlessCells = null;
    let rows`]],
  },
  {
    // The reserved-scarecrow list was rebuilt (incl. a full piecesMatching board scan) once per
    // candidate move inside the filter. crossesReservedScarecrow and the predicate only read, and
    // nothing else runs between filter iterations, so building it once gives the same list.
    // Built only when there is at least one move, like the original.
    name: "scarecrow-list-hoist",
    find: `    moves = moves.filter((move) => !crossesReservedScarecrow({ row, col }, move, [...boardState.pendingScarecrows || [], ...usesSeptember18Balance(boardState) ? piecesMatching(boardState, (p) => p.type === "scarecrow" && !p.scarecrowReserved).map(({ row: row2, col: col2 }) => ({ row: row2, col: col2, solid: true })) : []]));`,
    replace: `    if (moves.length) {
      const reservedScarecrows = [...boardState.pendingScarecrows || [], ...usesSeptember18Balance(boardState) ? piecesMatching(boardState, (p) => p.type === "scarecrow" && !p.scarecrowReserved).map(({ row: row2, col: col2 }) => ({ row: row2, col: col2, solid: true })) : []];
      moves = moves.filter((move) => !crossesReservedScarecrow({ row, col }, move, reservedScarecrows));
    }`,
  },
  {
    // threeType ran a regex replace per call (per piece per candidate move via the paladin scan in
    // threeMoveAllowed). Pure string -> string, so memoized by its String() input (bounded).
    name: "threeType-memo",
    find: `  const threeType = (type) => String(type || "").replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());`,
    replace: `  const FAST_THREE_TYPE_CACHE = /* @__PURE__ */ new Map();
  const threeType = (type) => {
    const text = String(type || "");
    let value = FAST_THREE_TYPE_CACHE.get(text);
    if (value === void 0) {
      value = text.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());
      if (FAST_THREE_TYPE_CACHE.size < 4096) FAST_THREE_TYPE_CACHE.set(text, value);
    }
    return value;
  };`,
  },
  {
    // isGhostTransparentFor$1 is Boolean(attacker && target?.ghost && ...), i.e. exactly false
    // without a ghost target -- but its options argument (workerRangedPieceOptions: a full-board
    // allied-piece count + usesGhostCannonScreen) was built first, for every occupied square a ray
    // meets. Those option builders only read, and cannot throw when the board is an array (or the
    // state is null), so skipping them in that case returns the same value.
    name: "ghost-options-shortcircuit",
    find: `  function isGhostTransparentFor(attacker, target, attackerType = attacker?.type, boardState = null) {
    return isStealthTransparentFor(attacker, target, boardState) || isGhostTransparentFor$1(`,
    replace: `  function isGhostTransparentFor(attacker, target, attackerType = attacker?.type, boardState = null) {
    return isStealthTransparentFor(attacker, target, boardState) || (!(attacker && target?.ghost) && (boardState == null || Array.isArray(boardState.board)) ? false : isGhostTransparentFor$1(`,
    also: [[`      { ...workerRangedPieceOptions(boardState, attacker), cannonGhostScreen: usesGhostCannonScreen(boardState) }
    );
  }`, `      { ...workerRangedPieceOptions(boardState, attacker), cannonGhostScreen: usesGhostCannonScreen(boardState) }
    ));
  }`]],
  },
  {
    // generateActions filters each piece's candidate moves with isWorkerMoveAllowed, which re-ran
    // per move the same whole-board scans (activeWorkerForcedExtraMove, workerHasForcedEnPassant,
    // workerHasForcedCheckerCapture) plus the idol/checker checks for the same piece. Within one
    // filter pass only isWorkerMoveAllowed runs, and its call closure (audited) writes nothing
    // those read (its only shared write is piece.monoShade = shade-of-own-square, idempotent and
    // never read there), so each value is computed lazily once per piece -- in the original order
    // and only on the paths where the original evaluates it.
    name: "move-allowed-memo",
    find: `      generateMovesForPiece(boardState, piece, row, col).filter((move) => isWorkerMoveAllowed(boardState, piece, row, col, move)).forEach((move) => {`,
    replace: `      const moveAllowedMemo = {};
      generateMovesForPiece(boardState, piece, row, col).filter((move) => isWorkerMoveAllowedMemo(moveAllowedMemo, boardState, piece, row, col, move)).forEach((move) => {`,
    also: [[`  function isWorkerMoveAllowed(boardState, piece, row, col, move) {
    if (!move) return false;
    if (workerIdolEncoreRepeatBlocked(boardState, piece)) return false;
    const forcedExtraMove = piece?.color ? activeWorkerForcedExtraMove(boardState, piece.color) : null;
    if (forcedExtraMove && forcedExtraMove.piece !== piece) return false;
    const forcedEnPassant = piece?.color ? workerHasForcedEnPassant(boardState, piece.color) : false;
    if (forcedEnPassant && !move.enPassant) return false;
    if (isWorkerCheckerPiece(piece)) {
      const hasCapture = workerLegalCheckerCaptureMoves(boardState, piece, row, col).length > 0;
      if ((piece.checkerChainCapture || hasCapture) && !move.checkerCapture) return false;
    } else if (!forcedEnPassant && piece?.color && workerHasForcedCheckerCapture(boardState, piece.color)) {
      return false;
    }
    return isWorkerBaseMoveAllowed(boardState, piece, row, col, move);
  }
`, `  function isWorkerMoveAllowed(boardState, piece, row, col, move) {
    if (!move) return false;
    if (workerIdolEncoreRepeatBlocked(boardState, piece)) return false;
    const forcedExtraMove = piece?.color ? activeWorkerForcedExtraMove(boardState, piece.color) : null;
    if (forcedExtraMove && forcedExtraMove.piece !== piece) return false;
    const forcedEnPassant = piece?.color ? workerHasForcedEnPassant(boardState, piece.color) : false;
    if (forcedEnPassant && !move.enPassant) return false;
    if (isWorkerCheckerPiece(piece)) {
      const hasCapture = workerLegalCheckerCaptureMoves(boardState, piece, row, col).length > 0;
      if ((piece.checkerChainCapture || hasCapture) && !move.checkerCapture) return false;
    } else if (!forcedEnPassant && piece?.color && workerHasForcedCheckerCapture(boardState, piece.color)) {
      return false;
    }
    return isWorkerBaseMoveAllowed(boardState, piece, row, col, move);
  }
  function isWorkerMoveAllowedMemo(memo, boardState, piece, row, col, move) {
    if (!move) return false;
    if (memo.idolBlocked === void 0) memo.idolBlocked = workerIdolEncoreRepeatBlocked(boardState, piece);
    if (memo.idolBlocked) return false;
    if (memo.forcedExtraMove === void 0) memo.forcedExtraMove = piece?.color ? activeWorkerForcedExtraMove(boardState, piece.color) : null;
    const forcedExtraMove = memo.forcedExtraMove;
    if (forcedExtraMove && forcedExtraMove.piece !== piece) return false;
    if (memo.forcedEnPassant === void 0) memo.forcedEnPassant = piece?.color ? workerHasForcedEnPassant(boardState, piece.color) : false;
    const forcedEnPassant = memo.forcedEnPassant;
    if (forcedEnPassant && !move.enPassant) return false;
    if (isWorkerCheckerPiece(piece)) {
      if (memo.hasCapture === void 0) memo.hasCapture = workerLegalCheckerCaptureMoves(boardState, piece, row, col).length > 0;
      if ((piece.checkerChainCapture || memo.hasCapture) && !move.checkerCapture) return false;
    } else if (!forcedEnPassant && piece?.color) {
      if (memo.forcedChecker === void 0) memo.forcedChecker = workerHasForcedCheckerCapture(boardState, piece.color);
      if (memo.forcedChecker) return false;
    }
    return isWorkerBaseMoveAllowed(boardState, piece, row, col, move);
  }
`]],
  },
];

function countOf(hay, needle) { let n = 0, i = 0; while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; } return n; }
function build() {
  if (!fs.existsSync(SRC)) throw new Error("Missing " + SRC + " -- run: node fetch-real-worker.js");
  let src = fs.readFileSync(SRC, "utf8");
  if (src.includes("\r")) throw new Error("real-worker.js has CR line endings; patch anchors assume LF");
  const applied = [];
  for (const p of PATCHES) {
    if (skip.has(p.name) || (only.size && !only.has(p.name))) continue;
    for (const [find, replace] of [[p.find, p.replace], ...(p.also || [])]) {
      const n = countOf(src, find);
      if (n !== 1) throw new Error(`patch "${p.name}": anchor matched ${n} times (expected exactly 1) -- site code changed; re-anchor and re-verify`);
      src = src.replace(find, () => replace);
    }
    applied.push(p.name);
  }
  fs.writeFileSync(OUT, `// GENERATED by tools/site-parity/make-fast-worker.js from real-worker.js -- do not edit.\n// patches: ${applied.join(", ")}\n` + src);
  console.log(`wrote ${OUT} (${applied.length}/${PATCHES.length} patches: ${applied.join(", ")})`);
}
if (require.main === module) {
  try { build(); } catch (e) { console.error("make-fast-worker failed:", e.message); process.exit(1); }
}
module.exports = { PATCHES, build };
