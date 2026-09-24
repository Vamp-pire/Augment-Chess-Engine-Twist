// Site game-end rules (3-fold repetition -> tiebreak, 45-turn deathmatch,
// star-total tiebreak), reverse-engineered from the live site's main bundle
// -- see docs/GAME-END-RULES.md for the full writeup this implements.
// Opt-in only (selfplay-worker-merged.js's SELFPLAY_SITE_RULES=1), so
// existing self-play data (which uses a simpler 50-move/3-fold-draw
// approximation) is never silently mixed with data using these rules.
const CARD_CATALOG = require("./card-catalog.json");

// Site's positionKey: turn | repetitionSalt | sorted "row,col:color:type:hp:ammo:frozen".
// Walls excluded, multi-square (2x2) pieces counted once via their shared id.
// Card state, `moved`, castling rights, en passant and captured pieces are
// NOT part of the key (matches the site exactly, per GAME-END-RULES.md #1).
function positionKey(board, turn, repetitionSalt) {
  const seenIds = new Set();
  const pieces = [];
  for (let r = 0; r < board.length; r++) {
    for (let c = 0; c < board[r].length; c++) {
      const p = board[r][c];
      if (!p || p.type === "wall") continue;
      if (p.id) {
        if (seenIds.has(p.id)) continue;
        seenIds.add(p.id);
      }
      const color = p.color ? p.color[0] : "n";
      pieces.push(`${r},${c}:${color}:${p.type}:${p.hp ?? ""}:${p.ammo ?? ""}:${p.frozen ? 1 : 0}`);
    }
  }
  pieces.sort();
  return `${turn}|${repetitionSalt}|${pieces.join(",")}`;
}

function cardStars(effect) {
  return CARD_CATALOG[effect]?.stars ?? 0;
}

// Sum of stars of every card in the deck slot, used or not (matches site's
// deckStarTotal -- it does NOT exclude used cards).
function deckStarTotal(deckSlots, color) {
  const deck = deckSlots?.[color] || [];
  return deck.reduce((sum, card) => sum + (card ? cardStars(card.effect) : 0), 0);
}

// "Progress" for the deathmatch gauge: pawn move, capture/removal effect,
// or an ACTIVE (non-passive) card whose phase isn't RULE. isProgressMove
// covers the first two (same definition as the 50-move heuristic already
// used); this covers the card-use case. 5 of our 184 pool cards have no
// confirmed site activation/phase (see card-catalog.json's `unverified`
// flag) -- treated as ACTIVE/non-RULE (progress-counting) by default,
// which is the majority case (132/184 ACTIVE) and the safer assumption
// (undercounting progress would end games too early via false deathmatch
// timeouts).
function isActiveNonRuleCard(effect) {
  const meta = CARD_CATALOG[effect];
  if (!meta) return true;
  return meta.activation === "ACTIVE" && meta.phase !== "RULE";
}

function hasShotgunKing(board, color) {
  return board.some((row) => row.some((p) => p && p.color === color && p.type === "shotgunKing"));
}

// Returns { winner: "white"|"black"|null (draw), reason }.
function resolveStarTiebreak(state, reason) {
  const whiteShotgun = hasShotgunKing(state.board, "white");
  const blackShotgun = hasShotgunKing(state.board, "black");
  if (whiteShotgun !== blackShotgun) {
    return { winner: whiteShotgun ? "black" : "white", reason: `${reason}:shotgun-king-penalty` };
  }
  const whiteStars = deckStarTotal(state.deckSlots, "white");
  const blackStars = deckStarTotal(state.deckSlots, "black");
  if (whiteStars === blackStars) return { winner: null, reason: `${reason}:star-tie` };
  return { winner: whiteStars < blackStars ? "white" : "black", reason: `${reason}:star-total` };
}

// Deathmatch gauge defaults, matching the site (GAME-END-RULES.md #2).
const STAR_WIN_LIMIT = 45;
const DEATHMATCH_INTERVAL_TURNS = 10; // "10 rounds without progress ends it"
const DEATHMATCH_INTERVAL_HALF_TURNS = DEATHMATCH_INTERVAL_TURNS * 2;

module.exports = {
  positionKey, deckStarTotal, isActiveNonRuleCard, resolveStarTiebreak,
  STAR_WIN_LIMIT, DEATHMATCH_INTERVAL_HALF_TURNS, CARD_CATALOG
};
