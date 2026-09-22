// Sparse features for a (state, action) pair -- input of the learned move-scoring model (PLAN.md track B2).
//
//   const { actionFeatures, featurizeAll, FEATURE_DIM, FEATURE_VERSION } = require("./features");
//   actionFeatures(state, action, color, ord?) -> { idx: number[], val: number[] }   (sparse, idx may not repeat)
//   featurizeAll(state, actions, color)        -> array of the above, plus position-relative ordering features
//
// Layout (offsets computed below, FEATURE_DIM is the total). Everything is relative to the mover
// (rows flipped for black) so both colours share weights; "black" itself is one more feature.
//   atype[8]     action type (move, card, wizardSpell, fileSurgeSkip, shotgunReload, other)
//   ptype[T]     type of the moving piece (T = ALL_TYPES.length, nnue/encode.js); color[1] = mover is black
//   fromRow fromCol toRow toCol [8 each]   squares (mover-relative rows)
//   dist[8]      chebyshev distance, fwd[15] signed forward step, center[5] centre-distance bucket of destination
//   cap, capKing, victim type[T], victimVal (/10), ownDest
//   cardEffect[E] one-hot over CARD_POOL_TYPES, cardStars (/3), cardTarget[4] enemy/own/empty/none, cardTargetType[T]
//   ord[4]       CURRENT hand-written ordering score actionOrderingScore/500 (clipped), |ord|, sign flags
//   position-relative (featurizeAll only): ordRel = (ord - best ord)/500, ordFrac = ord-rank/n, ordTop[4] = ord-rank 1/<=3/<=5/<=10
// Not included: "destination attacked/defended" (no cheap engine helper; would need a per-action apply).
// The ordering score is included on purpose: the model should refine the hand-written ordering, not replace it.
"use strict";
const path = require("path");
const ROOT = path.resolve(__dirname, "..", "..");
const engine = require(path.join(ROOT, "engine-merged.js"));
const { ALL_TYPES, CARD_POOL_TYPES } = require(path.join(ROOT, "nnue", "encode.js"));

const FEATURE_VERSION = 1;
const T = ALL_TYPES.length, E = CARD_POOL_TYPES.length;
const TYPE_IDX = {}; ALL_TYPES.forEach((t, i) => { TYPE_IDX[t] = i; });
const EFFECT_IDX = {}; CARD_POOL_TYPES.forEach((t, i) => { EFFECT_IDX[t] = i; });
const ACTION_TYPES = ["move", "card", "wizardSpell", "fileSurgeSkip", "shotgunReload"];
const ATYPE_IDX = {}; ACTION_TYPES.forEach((t, i) => { ATYPE_IDX[t] = i; });
const ATYPE_OTHER = ACTION_TYPES.length;

let off = 0;
const O = {};
function block(name, n) { O[name] = off; off += n; }
block("atype", 8); block("ptype", T); block("color", 1);
block("fromRow", 8); block("fromCol", 8); block("toRow", 8); block("toCol", 8);
block("dist", 8); block("fwd", 15); block("center", 5);
block("cap", 1); block("capKing", 1); block("victim", T); block("victimVal", 1); block("ownDest", 1);
block("cardEffect", E); block("cardStars", 1); block("cardTarget", 4); block("cardTargetType", T);
block("ord", 4); block("ordRel", 1); block("ordFrac", 1); block("ordTop", 4);
const FEATURE_DIM = off;

const VAL = { pawn: 1, knight: 3, bishop: 3, rook: 5, queen: 9, king: 20 };
const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);

function findCard(state, action) {
  const d = (state.deckSlots && state.deckSlots[action.color]) || [];
  return d.find((c) => c && c.instanceId === action.cardInstanceId) || d.find((c) => c && c.id === action.cardId) || null;
}

// ord: precomputed engine.actionOrderingScore (pass it to avoid computing twice), else computed here.
function actionFeatures(state, action, color, ord) {
  const idx = [], val = [];
  const add = (i, v = 1) => { idx.push(i); val.push(v); };
  color = action.color || color || state.turn;
  const flip = color === "black";
  const rr = (r) => (flip ? 7 - r : r);
  const board = state.board;
  const at = (r, c) => (r >= 0 && r < 8 && c >= 0 && c < 8 && board[r] ? board[r][c] : null);

  add(O.atype + (ATYPE_IDX[action.type] !== undefined ? ATYPE_IDX[action.type] : ATYPE_OTHER));
  if (flip) add(O.color);

  const from = action.from && Number.isInteger(action.from.row) ? action.from : null;
  const dest = action.move || action.to || (action.type === "move" ? null : action.target) || null;
  const destOk = dest && Number.isInteger(dest.row) && Number.isInteger(dest.col);
  if (from) {
    const p = at(from.row, from.col);
    if (p && TYPE_IDX[p.type] !== undefined) add(O.ptype + TYPE_IDX[p.type]);
    add(O.fromRow + clamp(rr(from.row), 0, 7)); add(O.fromCol + clamp(from.col, 0, 7));
  }
  if (destOk) {
    add(O.toRow + clamp(rr(dest.row), 0, 7)); add(O.toCol + clamp(dest.col, 0, 7));
    const cd = Math.max(Math.abs(dest.row - 3.5), Math.abs(dest.col - 3.5));
    add(O.center + clamp(Math.floor(cd), 0, 3));
    if (from) {
      const dr = dest.row - from.row, dc = dest.col - from.col;
      add(O.dist + clamp(Math.max(Math.abs(dr), Math.abs(dc)), 0, 7));
      add(O.fwd + clamp((flip ? dr : -dr) + 7, 0, 14)); // forward = towards the enemy
    }
    if (action.type === "move") {
      const t = at(dest.row, dest.col);
      if (t) {
        if (t.color !== color) {
          add(O.cap);
          if (t.type === "king") add(O.capKing);
          if (TYPE_IDX[t.type] !== undefined) add(O.victim + TYPE_IDX[t.type]);
          add(O.victimVal, (VAL[t.type] !== undefined ? VAL[t.type] : 3) / 10);
        } else add(O.ownDest);
      }
    }
  }
  if (action.type === "card") {
    const card = findCard(state, action);
    if (card) {
      if (EFFECT_IDX[card.effect] !== undefined) add(O.cardEffect + EFFECT_IDX[card.effect]);
      add(O.cardStars, (Number(card.stars) || 0) / 3);
    }
    const tg = action.target;
    if (tg && Number.isInteger(tg.row)) {
      const t = at(tg.row, tg.col);
      if (!t) add(O.cardTarget + 2);
      else {
        add(O.cardTarget + (t.color === color ? 1 : 0));
        if (TYPE_IDX[t.type] !== undefined) add(O.cardTargetType + TYPE_IDX[t.type]);
      }
    } else add(O.cardTarget + 3);
  }
  if (ord === undefined) ord = engine.actionOrderingScore(action, state, color);
  const o = ord / 500;
  add(O.ord, clamp(o, -4, 4)); add(O.ord + 1, Math.min(Math.abs(o), 4) * 0.5);
  if (ord > 0) add(O.ord + 2); else if (ord < 0) add(O.ord + 3);
  return { idx, val };
}

// Features for all legal actions of one position, incl. features that compare an action with its siblings.
function featurizeAll(state, actions, color) {
  const ords = actions.map((a) => engine.actionOrderingScore(a, state, color));
  const order = ords.map((v, i) => i).sort((a, b) => ords[b] - ords[a]);
  const rank = new Array(actions.length);
  order.forEach((i, r) => { rank[i] = r + 1; });
  const best = ords.length ? Math.max(...ords) : 0;
  const n = actions.length;
  return actions.map((a, i) => {
    const f = actionFeatures(state, a, color, ords[i]);
    f.idx.push(O.ordRel); f.val.push(clamp((ords[i] - best) / 500, -6, 0));
    f.idx.push(O.ordFrac); f.val.push(rank[i] / n);
    f.idx.push(O.ordTop); f.val.push(rank[i] === 1 ? 1 : 0);
    f.idx.push(O.ordTop + 1); f.val.push(rank[i] <= 3 ? 1 : 0);
    f.idx.push(O.ordTop + 2); f.val.push(rank[i] <= 5 ? 1 : 0);
    f.idx.push(O.ordTop + 3); f.val.push(rank[i] <= 10 ? 1 : 0);
    return f;
  });
}

module.exports = { actionFeatures, featurizeAll, FEATURE_DIM, FEATURE_VERSION, OFFSETS: O };
