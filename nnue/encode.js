// Feature encoding: one plane per (piece type x color), 64 squares each,
// from the mover's own perspective (their pieces always occupy the first
// half of the planes) so the net doesn't have to separately learn "white to
// move" vs "black to move" versions of the same idea.
//
// Piece list must match selfplay-worker.js's SELFPLAY_SPECIAL_TYPES exactly
// -- self-play only ever places these special types (plus the 6 standard
// ones), so anything else here would just be dead, always-zero input planes.
// If that list changes, update this one too.
//
// Updated 2026-09-06: selfplay-worker.js's list grew from 13 to 16 more
// types; added all of them here EXCEPT coffin/babyBear (owner asked to leave
// those two out for now and fold them in later -- they have no real
// movement of their own, only a self-play-only "hop to a random adjacent
// square" house rule, so how to represent them is still an open question).
// Boards containing coffin/babyBear still train fine meanwhile -- an
// unlisted type's square just stays all-zero, same as any other unknown type.
const STANDARD_TYPES = ["pawn", "knight", "bishop", "rook", "queen", "king"];
const SPECIAL_TYPES = [
  "amazon", "cardinal", "pegasus", "assassin", "dragon",
  "cannon", "grasshopper", "hook", "herald", "camel", "alfil", "ferz", "eagle",
  "berserker", "magicGirl", "windmill", "trickster", "merchant",
  "knightmaster", "standardBearer", "idol", "siren", "reaper", "recruiter",
  "guard", "colossus", "bigRook",
  // Added 2026-09-14 (engine-merged.js graft session): hedgehog/princess/
  // campfire joined SELFPLAY_SPECIAL_TYPES. coffin/babyBear are still
  // deliberately excluded (see the 2026-09-06 note above -- no real
  // movement of their own, only a self-play house rule).
  "hedgehog", "princess", "campfire",
  // Added 2026-09-15 (16-new-card patch graft): paladin/octopus/clockwork/
  // parrot joined SELFPLAY_SPECIAL_TYPES as the 4 PIECE-phase cards from
  // that batch (all single-square, all self-contained -- see
  // selfplay-worker-merged.js's SELFPLAY_SPECIAL_TYPES comment for why).
  "paladin", "octopus", "clockwork", "parrot"
];
const ALL_TYPES = [...STANDARD_TYPES, ...SPECIAL_TYPES];

const PIECE_INDEX = {};
ALL_TYPES.forEach((type, i) => { PIECE_INDEX[type] = i; });

const PLANE_COUNT = ALL_TYPES.length; // 33

// Per-piece STATE fields beyond type/color (added 2026-09-23): the board
// planes above only ever encoded "what piece, what color, what square" --
// every other bit of a piece's state (HP, shields, frozen turns, card-granted
// flags, etc.) was silently discarded before this. Keep this list in sync
// with selfplay-worker-merged.js's COMPACT_BOOL_FIELDS /
// COMPACT_NUMERIC_FIELDS / COMPACT_ENUM_FIELDS -- that's the compaction step
// that has to actually preserve a field for it to ever reach here.
// Each field gets its own pair of 64-square planes (mover-owned / enemy-
// owned), same split as the board type/color planes, so the network doesn't
// have to cross-reference two differently-organized plane groups to tell
// whose piece an attribute belongs to.
//
// Booleans: presence (1) / absence (0) at the piece's square.
const BOOL_FIELDS = [
  "defected", "evasion", "explosive", "fileSurgeSecondMove", "frenzyExtraMove",
  "frozen", "ghost", "ironMonarchExtraMove", "locustUsed", "madHorseSecondMove",
  "noPromotion", "platformExtraMove", "promotedFromPawn", "protected",
  "queensGambitProtection", "queensGambitPreviousProtected",
  "queuedBackwardKnightTurn", "rookLiftSecondMove", "shielded",
  "specialPromotionUsed", "thiefSecondMove", "twinSwapPending",
  "undergroundBunker", "crownBearer", "crownRoyal", "regencyHeir",
  "heraldJumpUnlocked", "bribed", "coolGuyCapturedLast",
  "quantumFirstObservationFails", "checkerChainCapture", "moved",
  // Object-presence-only fields (the object's own shape is either not
  // meaningful beyond "does it exist" -- bloodCurse/callingCard/quantum --
  // or too irregular to encode structurally -- lastResistance):
  "bloodCurse", "callingCard", "quantum", "lastResistance",
  // Derived booleans folded in from richer compact fields:
  "coronationProtection", "frozenByCard", "logDir",
  "repositionSecondMoveUsed",
  // tricksterMoveType has ~40 possible values (see TRICKSTER_MOVEMENT_TYPES
  // in engine-merged.js) -- too many to one-hot cheaply for a piece that's
  // at most one-per-side, so it's folded down to a presence bit here per the
  // task's "too many values -> at least a truthy boolean" fallback rule.
  "tricksterMoveType"
];
const BOOL_FIELD_INDEX = {};
BOOL_FIELDS.forEach((f, i) => { BOOL_FIELD_INDEX[f] = i; });

// Numeric counters/turn-timers, normalized by a generous fixed divisor (real
// values observed in engine-merged.js top out in the single digits -- HP/
// mana/ammo caps are 2-5) and clamped so an unexpectedly large value can't
// blow up the input scale.
const NUMERIC_FIELDS = [
  "hp", "maxHp", "ammo", "maxAmmo", "mana", "maxMana", "poisonStunTurns",
  "bearRetaliationsRemaining", "capturesMade", "reaperCaptures",
  "necromancyRemaining", "bribedRemaining", "cardNoCaptureUntil",
  "freshNoCaptureUntil", "heraldJumpLockTurn", "quantumNoCaptureUntil",
  // Sub-fields of object-valued state, pulled out flat by
  // selfplay-worker-merged.js's compactBoard():
  "coronationProtectionRemaining", "frozenByCardRemaining",
  "logDirDr", "logDirDc",
  // Array fields collapsed to their length by compactBoard():
  "crownTokenCount", "imperialMoveCount", "queuedKnightExtraMoveCount"
];
const NUMERIC_FIELD_INDEX = {};
NUMERIC_FIELDS.forEach((f, i) => { NUMERIC_FIELD_INDEX[f] = i; });
const NUMERIC_NORMALIZER = 20;

// Small-cardinality color/enum fields -- each stored as ONE-HOT over its
// value set (not lossy: absence and each possible value all get distinct
// bit patterns), unlike the >2-valued tricksterMoveType above.
const ENUM_FIELD_VALUES = {
  monoShade: ["light", "dark"],
  timePhase: ["past", "future"],
  windmillMode: ["rook", "bishop"],
  spyOwner: ["white", "black"],
  poisonStunColor: ["white", "black"],
  hiddenFrom: ["white", "black"]
};
const ENUM_FIELDS = Object.keys(ENUM_FIELD_VALUES);
// Flattened (field, value) -> bit index within the enum-bits block.
const ENUM_BIT_INDEX = {};
let enumBitCursor = 0;
ENUM_FIELDS.forEach((field) => {
  ENUM_FIELD_VALUES[field].forEach((value) => {
    ENUM_BIT_INDEX[`${field}:${value}`] = enumBitCursor;
    enumBitCursor += 1;
  });
});
const ENUM_BIT_COUNT = enumBitCursor; // 12 (6 fields x 2 values)

// Total per-square attribute bits (booleans + numerics + enum one-hot bits),
// each duplicated into a mover-owned plane and an enemy-owned plane, same as
// PLANE_COUNT above.
const ATTR_BIT_COUNT = BOOL_FIELDS.length + NUMERIC_FIELDS.length + ENUM_BIT_COUNT;
// Opt-in (2026-09-23), same pattern as PLY_FEATURE_ENABLED below: adding
// these planes changes INPUT_SIZE, which would immediately break the
// extension's NNUE copy (extension/nnue.js) and every currently-shipped
// weights.json -- neither has been retrained/ported yet (nnue-parity.js
// caught this: extension=5509, training=15237 with it always on). Keep it
// off by default so training/CI/the extension all stay at the current 5509
// until a retrain + extension port happens; compactBoard() already preserves
// the raw fields in new self-play records regardless of this flag, so
// turning it on later doesn't require regenerating old data first.
const FULL_PIECE_STATE_ENABLED = process.env.FULL_PIECE_STATE === "1";
const ATTR_BOARD_SIZE = FULL_PIECE_STATE_ENABLED ? ATTR_BIT_COUNT * 2 * 64 : 0;

// Replaced 2026-09-08: previously 3 hand-rolled scalar hints (material,
// king safety, special-piece-count), computed straight from the board with
// no engine dependency. Superseded by feeding the network the SAME ~21
// named sub-scores evaluateState() itself uses (via engine.js's
// evaluateStateComponents), not just a plain output-blend of the two models
// (that ensemble approach was tried and rejected -- see nnue/tune-eval.js
// and project memory, it was strictly worse at every blend weight because
// two models trained on the same noisy data make correlated errors).
// This is a different mechanism: the raw sub-scores go in as EXTRA INPUT
// features alongside the one-hot board planes, so the small 16/16-unit
// network doesn't have to spend its limited capacity re-deriving "count up
// material", "who's ahead on king safety", etc. from scratch before it can
// even start on subtler board patterns -- while still being trained
// end-to-end, so it can learn nonlinear interactions the hand-coded
// weighted sum (evaluateState) can't. tune-eval.js already confirmed on
// this exact data that a plain linear regression over just these 21
// features alone reaches 69.1% (vs the raw-board NNUE's 55.8%), which is
// the direct evidence this feature set carries a lot more signal than the
// tiny network was managing to pull out of the one-hot board on its own.
// Switched from engine.optimized.js 2026-09-14: that file is our hand-ported
// reimplementation and was found (via a card-by-card audit against the real
// site) to have real behavioral bugs in exactly the kind of card/piece logic
// evaluateStateComponents below reads (cardsSelf/cardsEnemy/specialSelf
// etc.). engine-merged.js is the authentic-site-rules + our-own-enhancements
// engine that replaced it for self-play data generation -- using it here too
// keeps encoding consistent with how the training data was actually
// generated. See audit-data/graft-progress.md for the full story.
const engine = require("../engine-merged.js");

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
const EXTRA_FEATURE_COUNT = FEATURE_NAMES.length; // 21

// Card pool one-hot (added 2026-09-12): cardsSelf/cardsEnemy above collapse
// an entire hand into one aggregate threat number -- the network has no way
// to tell "royalShield in hand" from "freeze in hand", only the combined
// level. One-hot presence (own hand / enemy hand) of each self-play
// card-pool effect gives it that per-card signal to actually learn from.
// Scoped to SELFPLAY_CARD_POOL, not the full 224-card catalog: self-play
// (the only data source right now) never draws outside this pool, so a slot
// for any other card would just always be zero and never get trained --
// expand this list only after SELFPLAY_CARD_POOL itself grows. MUST match
// selfplay-worker-merged.js's SELFPLAY_CARD_POOL exactly.
// Expanded 2026-09-14 from 18 -> 173 cards (the pool grew across several
// sessions of card-audit work; this encoding had fallen behind and was
// silently blind to every card added since the 2026-09-12 18-card list --
// INPUT_SIZE changes here, so any existing trained weights file's shape no
// longer matches and must be retrained from scratch, not warm-loaded as-is).
const CARD_POOL_TYPES = [
  "alekhineMachineGun", "amazon", "apprenticeKnights", "armistice", "babyBear",
  "basicTraining", "bigRook", "binaMate", "bishopSnipe", "blackBox",
  "blackMagic", "blueJeans", "breakthroughOrder", "callingCard", "canceling",
  "chain", "chameleonMutation", "charge", "checker", "chimera",
  "cleanupPieces", "cleanupSacrifice", "clonePassive", "conversion",
  "cornerKick", "coronation", "deathSquad", "democracy", "desperado", "dice",
  "disarm", "dutch", "eagle", "emergencyEvacuation", "emptyLunchbox",
  "enPassantBang", "encouragement", "evasion", "exhaustion", "exile",
  "fanaticalRitual", "feudalContract", "fianchetto", "fieldPromotion",
  "fileSurge", "finalWeapon", "fleetingDream", "freeCastling", "freeMove",
  "freeze", "frenzy", "frontlineResponse", "gale", "genevaConvention",
  "ghost", "gomoku", "guard", "hallucination", "holdout", "homecoming",
  "hook", "horde", "horseRiding", "hypocrisy", "icbm", "iceSheet", "idol",
  "imperialStudies", "inertia", "injury", "insight", "ironMonarch", "joker",
  "judgment", "kingOfTheHill", "knightmate", "lastResistance", "lobster",
  "localConscription", "loyalist", "madHorse", "martyrdom", "merchantGuild",
  "missionary", "mistakeCard", "mongolianGambit", "moving", "ordination",
  "othello", "otherworld", "overwhelm", "palace", "panic", "parry",
  "pawnConversion", "pawnStorm", "poisonedPawn", "portalGun", "promotionRush",
  "prophecy", "quantumMechanics", "queenAfterimage", "queenCavalry",
  "queensGambit", "racingKing", "randomRoulette", "reaper", "reformation",
  "relay", "religiousVictory", "replayMove", "reposition", "retreat",
  "reversePawns", "rookLift", "royalCommand", "royalShield", "ruleTicket",
  "sacrifice", "severance", "shotgunKing", "socialism", "spy", "stake",
  "submerge", "substitution", "suicideBomber", "summonColossus",
  "suspiciousPotion", "switcheroo", "taunt", "timeClumsyAttack", "timeIsMine",
  "timePhaseShift", "traitor", "trickster", "trojanHorse", "trolley",
  "twins", "ultimatum", "undergroundBunker", "underpromotion", "vanish",
  "vip", "vortex", "whiteBox", "windmill", "witchTrial", "wizard", "zugzwang",
  "qxe1", "nullification", "recurrence", "outpost", "killerKing", "majesty",
  "overtake", "leap", "vanguard", "infiltration", "reversal", "lastStand",
  "fastGrowth", "earlyPromotion", "bribe", "conscription", "barricade",
  "collapse",
  // 2026-09-15 patch batch: all 16 new cards, matching
  // selfplay-worker-merged.js's SELFPLAY_CARD_POOL addition exactly.
  "highlander", "thief", "disassembly", "falseStart", "proficiency",
  "locustSwarm", "longEnPassant", "extinction", "symmetry", "brutus",
  "clockwork", "mutation", "parrot", "paladin", "octopus", "metal"
];
const CARD_POOL_INDEX = {};
CARD_POOL_TYPES.forEach((effect, i) => { CARD_POOL_INDEX[effect] = i; });
const CARD_ONEHOT_COUNT = CARD_POOL_TYPES.length * 2; // own + enemy

// Layout: [board planes][card one-hot][ply feature, opt-in][the 21 named
// features]. The named features stay LAST (not just appended after the
// board planes like before) specifically so train.js's `featureBase =
// INPUT_SIZE - ORIGINAL_EVAL_WEIGHTS.length` (used to warm-start the wide
// layer at evaluateState()'s own coefficients) keeps working unmodified --
// it assumes those 21 are the final 21 dimensions of the input, and this
// ordering keeps that true regardless of what gets inserted in the middle
// (new dims must go BEFORE this block, never after).
//
// PLY_FEATURE (2026-09-12 experiment, ABLATE_PLY_FEATURE=1 opt-in): none of
// the 21 named features expose game phase directly -- only indirectly via
// piece count. Recorded self-play entries don't carry an actual ply/move
// number field (selfplay-worker.js's `record.push` never wrote one, and
// retrofitting it would only cover NEW data, not the existing 113k-position
// set), so this uses normalized piece count (already available on every
// entry, old and new alike) as a game-phase proxy instead of a real ply
// count. Opt-in via env var so INPUT_SIZE -- and therefore every existing
// weights file's shape -- is unaffected unless explicitly requested.
const PLY_FEATURE_ENABLED = process.env.ABLATE_PLY_FEATURE === "1";
const PLY_FEATURE_COUNT = PLY_FEATURE_ENABLED ? 1 : 0;

// STAR_FEATURE (2026-09-24, STAR_TOTAL_FEATURES=1 opt-in): deck star-cost
// total (mover / enemy), the same quantity the site's star-tiebreak rule
// compares (tools/site-rules/site-rules.js's deckStarTotal). The 184-slot
// card one-hot block already says WHICH cards are in hand but not how much
// they're worth -- this gives the network that scalar directly instead of
// making it infer relative deck strength from 368 presence bits. Opt-in
// like PLY_FEATURE_ENABLED above, same reason (INPUT_SIZE/shape safety).
const STAR_FEATURE_ENABLED = process.env.STAR_TOTAL_FEATURES === "1";
const STAR_FEATURE_COUNT = STAR_FEATURE_ENABLED ? 2 : 0;
const STAR_NORMALIZER = 20; // generous ceiling for a 3-6 card hand at ~5 stars each
// Real per-card star costs (tools/site-rules/card-catalog.json, see that
// file's own header for provenance) -- NOT deckSlots entries' own `.stars`
// field, which is a random 1-5 placeholder by default (see
// selfplay-worker-merged.js's SELFPLAY_REAL_CARD_STARS toggle) and would
// make this feature partly noise on any data recorded with that flag off.
const SITE_CARD_STARS = STAR_FEATURE_ENABLED ? require("../tools/site-rules/card-catalog.json") : null;
function deckStarTotal(deckSlots, color) {
  const deck = deckSlots?.[color] || [];
  return deck.reduce((sum, card) => sum + (card ? (SITE_CARD_STARS[card.effect]?.stars ?? 3) : 0), 0);
}

const BOARD_SIZE = PLANE_COUNT * 2 * 64;
// Per-piece state attribute planes (added 2026-09-23), placed right after
// the type/color board planes and before the card one-hot -- anywhere
// before the final-21 block is fine per the layout note above.
const INPUT_SIZE = BOARD_SIZE + ATTR_BOARD_SIZE + CARD_ONEHOT_COUNT + PLY_FEATURE_COUNT + STAR_FEATURE_COUNT + EXTRA_FEATURE_COUNT;

// A card counts as "present" if it's a live, usable instance (not already
// used/recovering) of a pool effect -- matches how the engine's own
// isWorkerTurnExclusiveCardBlocked-adjacent checks treat a card as "in hand"
// elsewhere. `color` is whichever side's hand to write (mover or opponent);
// caller picks the write offset so mover's own hand and the enemy's land in
// separate blocks.
function writeCardOneHot(input, offset, deckSlots, color) {
  const deck = deckSlots?.[color] || [];
  deck.forEach((card) => {
    if (!card || card.used || card.recovering) return;
    const idx = CARD_POOL_INDEX[card.effect];
    if (idx === undefined) return;
    input[offset + idx] = 1;
  });
}

// deckSlots (added 2026-09-11): pass-through of a real self-play deck when
// the entry has one, so cardsSelf/cardsEnemy (FEATURE_NAMES below) stop
// being permanently-zero dead inputs -- evaluateStateComponents' card
// scoring reads boardState.deckSlots directly, no aiSearchNoCards gating
// involved (that flag only affects move generation, not static eval), so
// nothing else here needs to change. Older callers/cached data with no
// deckSlots field fall back to the previous empty-deck behavior unchanged.
function makeState(board, deckSlots) {
  const state = engine.cloneState({});
  // Spread the compact record's preserved state fields (hp/shielded/frozen/
  // etc, all under their real engine field names already -- only `t`/`c`
  // are aliases) so evaluateStateComponents() sees real piece state instead
  // of a bare type/color/moved skeleton. Added 2026-09-23 alongside
  // compactBoard() preserving these fields in the first place; before that
  // change this function silently fed the evaluator a piece stripped of
  // everything but type/color/moved, so e.g. shielded/hp-based scoring
  // couldn't see the real values even though it was reading real state.
  state.board = board.map((row) => row.map((p) => {
    if (!p) return null;
    const { t, c, ...rest } = p;
    return { ...rest, type: t, color: c, moved: p.moved !== undefined ? p.moved : true };
  }));
  state.mode = "play";
  state.deckSlots = deckSlots ? { white: deckSlots.white || [], black: deckSlots.black || [] } : { white: [], black: [] };
  state.captures = { white: [], black: [] };
  state.aiSearchNoCards = true;
  engine.setWorkerBoardDimensions(state);
  return state;
}

// Returns null for terminal positions (checkmate/no-survival-piece etc.) --
// self-play only ever records positions mid-game, so this should be rare
// (~0.2% in practice, per tune-eval.js's count), but callers must skip
// nulls rather than feed a partial/garbage row into the model.
function encodeBoard(board, mover, deckSlots) {
  const c = engine.evaluateStateComponents(makeState(board, deckSlots), mover);
  if (c.terminal !== null) return null;

  const input = new Float32Array(INPUT_SIZE);
  for (let r = 0; r < 8; r++) {
    for (let col = 0; col < 8; col++) {
      const p = board[r][col];
      if (!p) continue;
      const typeIdx = PIECE_INDEX[p.t];
      const square = r * 8 + col;
      const isMoverPiece = p.c === mover;
      if (typeIdx !== undefined) {
        const colorOffset = isMoverPiece ? 0 : PLANE_COUNT;
        input[(typeIdx + colorOffset) * 64 + square] = 1;
      } // unsupported piece type -> board plane skipped (still 0 there), but
        // attribute planes below still get written regardless of type.

      if (FULL_PIECE_STATE_ENABLED) {
        const attrColorOffset = isMoverPiece ? 0 : ATTR_BIT_COUNT;
        const attrBase = BOARD_SIZE + attrColorOffset * 64;
        BOOL_FIELDS.forEach((field) => {
          if (p[field]) input[attrBase + BOOL_FIELD_INDEX[field] * 64 + square] = 1;
        });
        const numericBase = attrBase + BOOL_FIELDS.length * 64;
        NUMERIC_FIELDS.forEach((field) => {
          const v = p[field];
          if (typeof v === "number" && Number.isFinite(v)) {
            input[numericBase + NUMERIC_FIELD_INDEX[field] * 64 + square] = v / NUMERIC_NORMALIZER;
          }
        });
        const enumBase = numericBase + NUMERIC_FIELDS.length * 64;
        ENUM_FIELDS.forEach((field) => {
          const v = p[field];
          if (v === undefined || v === null) return;
          const bitIdx = ENUM_BIT_INDEX[`${field}:${v}`];
          if (bitIdx !== undefined) input[enumBase + bitIdx * 64 + square] = 1;
        });
      }
    }
  }
  const attrEnd = BOARD_SIZE + ATTR_BOARD_SIZE;
  const enemy = mover === "white" ? "black" : "white";
  writeCardOneHot(input, attrEnd, deckSlots, mover);
  writeCardOneHot(input, attrEnd + CARD_POOL_TYPES.length, deckSlots, enemy);

  if (PLY_FEATURE_ENABLED) {
    let pieceCount = 0;
    for (const row of board) for (const p of row) if (p) pieceCount += 1;
    // Normalized to [0,1], 32 pieces (game start) -> 1.0, fewer -> lower.
    input[attrEnd + CARD_ONEHOT_COUNT] = pieceCount / 32;
  }

  if (STAR_FEATURE_ENABLED) {
    const starBase = attrEnd + CARD_ONEHOT_COUNT + PLY_FEATURE_COUNT;
    input[starBase] = deckStarTotal(deckSlots, mover) / STAR_NORMALIZER;
    input[starBase + 1] = deckStarTotal(deckSlots, enemy) / STAR_NORMALIZER;
  }

  const base = INPUT_SIZE - EXTRA_FEATURE_COUNT;
  FEATURE_NAMES.forEach((name, i) => { input[base + i] = c[name]; });
  return input;
}

module.exports = {
  encodeBoard, INPUT_SIZE, PIECE_INDEX, ALL_TYPES, FEATURE_NAMES, CARD_POOL_TYPES,
  BOOL_FIELDS, NUMERIC_FIELDS, ENUM_FIELD_VALUES
};
