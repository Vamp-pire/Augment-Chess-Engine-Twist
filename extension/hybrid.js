// A small toolkit for splitting a position's candidate moves ("lines") into
// two groups: lines Stockfish can be trusted to judge, and lines it can't.
//
// Stockfish only ever sees a projection of the board with every non-standard
// piece erased to an empty square (it has no idea those rules exist). That
// projection is fine for a given candidate LINE as long as that line has
// nothing to do with any special piece: the piece moving isn't special, the
// square it lands on isn't occupied by a special piece, and no special piece
// (either color) could immediately capture on either square involved. Lines
// that fail any of that -- plus any special-piece ability action
// (fileSurgeSkip/shotgunReload/wizardSpell) -- go to our own engine instead
// (real rules, weaker search). The actual per-position routing and search
// calls live in analysis.js (classifyPly); this file only answers "is this
// specific line safe for Stockfish" and "what FEN does Stockfish see".
//
// NOTE (2026-09-06): a "draw the piece as the closest standard piece it's a
// safe superset of" approximation (e.g. amazon -> queen) was tried and then
// explicitly rejected by the user ("완전 다르잖아" -- it's just not the same
// piece). A Fairy-Stockfish-based exact implementation was investigated as
// the alternative and found to be blocked (augmentchess.org isn't
// cross-origin isolated, so the SharedArrayBuffer-based engine build can't
// run there at all -- see HANDOFF.md). Don't reintroduce approximation here.
(function () {
  "use strict";

  // Only entries confirmed identical to the classic piece's movement. Do NOT
  // add more without confirming the actual rule first -- several early
  // guesses here (protestant/cardinal/pegasus/vip) turned out wrong.
  const STANDARD_EQUIVALENT = {
    pawn: "p",
    knight: "n",
    bishop: "b",
    rook: "r",
    queen: "q",
    king: "k"
  };

  function isStandardPiece(piece) {
    return !piece || Boolean(STANDARD_EQUIVALENT[piece.type]);
  }

  // Castling rights field for the FEN below -- previously always "-" (no
  // rights for anyone, ever), found live 2026-09-12 after a board-editor
  // standard-piece game had Stockfish play a completely unforced Kd1 (and,
  // in an earlier such game, shuffled both rooks off their home squares for
  // no reason): with "-" hardcoded, Stockfish's own STATIC EVALUATION has no
  // way to know keeping the king/rooks put has any value, so it happily
  // trades that safety away on any line that looks even slightly better by
  // material/position alone -- this isn't about generating actual castling
  // moves (this variant's castling is a bespoke house rule -- see
  // workerImmediateCastlingPlans in engine.js -- and any actual castling
  // action is already special-routed to our own engine by isSpecialInvolved,
  // never handed to Stockfish to execute), it's purely about giving
  // Stockfish's evaluation an accurate signal for ordinary king/rook moves.
  // Standard chess castling-rights logic (king and the relevant rook both
  // still on their home square, neither ever having moved) is a good enough
  // approximation for that purpose even though it doesn't capture this
  // variant's looser "any rook 3+ squares away" rule -- this was affecting
  // EVERY hybrid-AI game, not just board-editor ones; board-editor games
  // just happened to be what surfaced it since a plain zero-special-piece
  // game routes literally everything through this path.
  function castlingRightsField(board, castlingCanceled) {
    function homeRook(row, col, color) {
      const p = board[row]?.[col];
      return p && p.color === color && p.type === "rook" && !p.moved;
    }
    function homeKing(row, col, color) {
      const p = board[row]?.[col];
      return p && p.color === color && p.type === "king" && !p.moved;
    }
    let rights = "";
    if (!castlingCanceled?.white && homeKing(7, 4, "white")) {
      if (homeRook(7, 7, "white")) rights += "K";
      if (homeRook(7, 0, "white")) rights += "Q";
    }
    if (!castlingCanceled?.black && homeKing(0, 4, "black")) {
      if (homeRook(0, 7, "black")) rights += "k";
      if (homeRook(0, 0, "black")) rights += "q";
    }
    return rights || "-";
  }

  // Builds a FEN for ANY board -- non-standard pieces are simply omitted
  // (treated as empty squares) instead of gating the whole conversion on
  // full-board eligibility. Always succeeds. `castlingCanceled` is optional
  // (defaults to neither side canceled) so existing callers that haven't
  // been updated yet still get a real castling-rights guess instead of "-".
  function boardToFenStripSpecials(board, turn, castlingCanceled) {
    const rows = board.map((row) => {
      let fen = "";
      let empties = 0;
      row.forEach((piece) => {
        const code = piece && STANDARD_EQUIVALENT[piece.type];
        if (!code) {
          empties += 1;
          return;
        }
        if (empties) {
          fen += empties;
          empties = 0;
        }
        fen += piece.color === "white" ? code.toUpperCase() : code;
      });
      if (empties) fen += empties;
      return fen;
    });
    return rows.join("/") + " " + (turn === "white" ? "w" : "b") + " " + castlingRightsField(board, castlingCanceled) + " - 0 1";
  }

  const FILES = "abcdefgh";
  function algebraicToSquare(alg) {
    return { row: 8 - Number(alg[1]), col: FILES.indexOf(alg[0]) };
  }
  function squareToAlgebraic(row, col) {
    return FILES[col] + (8 - row);
  }

  // NOTE (2026-09-05): a couple of special pieces don't just have unusual
  // moves of their own -- they change how a STANDARD piece next to them
  // moves. Confirmed by reading engine.js's pawnMoves() this session:
  //   - knightmaster: an allied pawn anywhere in its 8 adjacent squares
  //     moves like a knight instead of a normal pawn.
  //   - standardBearer: an allied pawn anywhere on the SAME RANK gets an
  //     extra sideways (left/right) move/capture option.
  // A pawn under either effect is still "isStandardPiece" by type, so
  // without this check its moves would slip past isSpecialInvolved and get
  // handed to Stockfish, which has no idea the pawn just moved like a
  // knight or sideways -- it would be judging a move that makes no sense
  // under real chess rules. Mark such pawns' own squares as special so any
  // line starting there is routed to the own engine instead.
  function addAuraAffectedPawnSquares(state, set) {
    const board = state.board;
    if (!Array.isArray(board)) return;
    const knightmastersByColor = { white: [], black: [] };
    const standardBearerRanksByColor = { white: new Set(), black: new Set() };
    board.forEach((row, r) => {
      (row || []).forEach((piece, c) => {
        if (!piece || (piece.color !== "white" && piece.color !== "black")) return;
        if (piece.type === "knightmaster") knightmastersByColor[piece.color].push({ row: r, col: c });
        else if (piece.type === "standardBearer") standardBearerRanksByColor[piece.color].add(r);
      });
    });
    board.forEach((row, r) => {
      (row || []).forEach((piece, c) => {
        if (!piece || piece.type !== "pawn") return;
        const nearKnightmaster = knightmastersByColor[piece.color].some(
          (km) => Math.abs(km.row - r) <= 1 && Math.abs(km.col - c) <= 1 && (km.row !== r || km.col !== c)
        );
        const onStandardBearerRank = standardBearerRanksByColor[piece.color].has(r);
        if (nearKnightmaster || onStandardBearerRank) set.add(r + "," + c);
      });
    });
  }
  // All squares any special piece (either color) can move to right now, as
  // "row,col" keys. Computed once per position and reused for every
  // candidate line, instead of re-running generateActions per candidate.
  // `moverActions` is optional -- pass the caller's already-computed
  // generateActions(state, moverColor) result to skip recomputing it here
  // (classifyPlyMixedLines always has it as `beforeActions` already).
  function buildSpecialAttackSquares(engine, state, moverColor, moverActions) {
    const set = new Set();
    const opponentColor = moverColor === "white" ? "black" : "white";
    for (const color of [moverColor, opponentColor]) {
      let actions;
      if (color === moverColor && moverActions) {
        actions = moverActions;
      } else {
        try {
          actions = engine.generateActions(state, color);
        } catch (err) {
          continue;
        }
      }
      for (const action of actions) {
        if (action.type !== "move" && action.type !== "promotion") continue;
        const actorSquare = action.from;
        const actorPiece = actorSquare ? state.board[actorSquare.row]?.[actorSquare.col] : null;
        if (isStandardPiece(actorPiece)) continue; // only special-piece reach matters here
        const dest = action.move;
        if (dest) set.add(dest.row + "," + dest.col);
      }
    }
    addAuraAffectedPawnSquares(state, set);
    return set;
  }

  // Is this one candidate line (from -> to) safe to let Stockfish judge?
  // `attackSquares` should come from buildSpecialAttackSquares for the same
  // position (pass it in -- this is called once per candidate line, so
  // rebuilding it every time would be O(candidates x pieces)).
  function isSpecialInvolved(state, from, to, attackSquares) {
    const movingPiece = state.board[from.row]?.[from.col];
    const capturedPiece = state.board[to.row]?.[to.col];
    if (!isStandardPiece(movingPiece) || !isStandardPiece(capturedPiece)) return true;
    return attackSquares.has(to.row + "," + to.col) || attackSquares.has(from.row + "," + from.col);
  }

  window.__augHybrid = {
    boardToFenStripSpecials,
    buildSpecialAttackSquares,
    isSpecialInvolved,
    algebraicToSquare,
    squareToAlgebraic,
    STANDARD_EQUIVALENT
  };
})();
