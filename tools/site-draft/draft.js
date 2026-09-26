// Site-style deck dealing for self-play (opt-in via SELFPLAY_SITE_DRAFT).
//
// Simulates what the site's draft produces, with two deliberate deviations
// ordered by the project owner (2026-09-26):
//   * NO star weighting: every eligible card has equal probability (the site's
//     draftCardWeight / opening 1.3x boost / draft balance are not modeled).
//   * The human pick is replaced by a UNIFORM RANDOM pick among the offers.
//
// All structure (categories per phase, offer sizes, bundles, exclusions, grand
// pool + pick order, rule-card chance) comes from draft-data.json, which is
// extracted from the site bundle by extract-draft-data.js (data only).
//
// Pure functions of (rng, options): deterministic for a given rng stream.
"use strict";
const DATA = require("./draft-data.json");

const C = DATA.constants;
const CARD_BY_ID = new Map(DATA.cards.map((c) => [c.id, c]));
const DRAFT_CATEGORIES = ["OPENING", "MIDDLE", "END", "PIECE"]; // draftable (RULE and GUN are not drafted)
const EXCLUSIVE_OPENING = new Set(DATA.exclusiveOpeningIds);
const DELETED = new Set(DATA.deletedCardIds);

// ---- exclusion helpers (mirror hasLatestMutuallyExclusiveDraftCard etc.) ----
const EXCL_PARTNERS = new Map(); // id -> Set(partner ids)
function addPair(a, b) {
  if (a === b) return;
  if (!EXCL_PARTNERS.has(a)) EXCL_PARTNERS.set(a, new Set());
  if (!EXCL_PARTNERS.has(b)) EXCL_PARTNERS.set(b, new Set());
  EXCL_PARTNERS.get(a).add(b);
  EXCL_PARTNERS.get(b).add(a);
}
for (const g of DATA.mutuallyExclusiveGroups) for (const a of g) for (const b of g) addPair(a, b);
for (const [a, b] of DATA.pawnDirectionConflicts) addPair(a, b);

function mutuallyExclusive(cardId, selected) {
  const partners = EXCL_PARTNERS.get(cardId);
  if (!partners) return false;
  for (const p of partners) if (selected.has(p)) return true;
  return false;
}
const GRAND_CONFLICT = new Map();
for (const [a, b] of DATA.grandPoolConflicts) {
  if (!GRAND_CONFLICT.has(a)) GRAND_CONFLICT.set(a, new Set());
  if (!GRAND_CONFLICT.has(b)) GRAND_CONFLICT.set(b, new Set());
  GRAND_CONFLICT.get(a).add(b);
  GRAND_CONFLICT.get(b).add(a);
}
function grandPoolConflict(cardId, selected) {
  const p = GRAND_CONFLICT.get(cardId);
  if (!p) return false;
  for (const x of p) if (selected.has(x)) return true;
  return false;
}
// Cards a currently active board rule keeps out of every draft (isRuleBlockedDraftCard).
function ruleBlocks(cardId, activeRuleIds) {
  if (!activeRuleIds.size) return false;
  const rb = DATA.ruleBlocked;
  if (activeRuleIds.has("monochrome-chess") && rb.monochromeChess.includes(cardId)) return true;
  if (activeRuleIds.has("macho-chess") && rb.machoChess.includes(cardId)) return true;
  if (activeRuleIds.has("diagonal-chess") && rb.diagonalChessBlocksExclusiveOpening.includes(cardId)) return true;
  if (rb.largeOpeningCardsBlockedByRules.cards.includes(cardId) && rb.largeOpeningCardsBlockedByRules.rules.some((r) => activeRuleIds.has(r))) return true;
  return false;
}

// Site effect names that differ from the engine's card-effect names (verified by
// id + star value: site "leap" = pawnLeap, 4 stars; engine/catalog effect "leap", 4 stars).
const EFFECT_ALIASES = { pawnLeap: "leap" };
const engineEffectOf = (card) => EFFECT_ALIASES[card.effect] || card.effect;

// ---- eligible universe ----
// enginePool: iterable of engine effect names the engine can really play
// (selfplay SELFPLAY_CARD_POOL). Returns { cards, dropped } where cards are the
// draftable site cards the engine implements, dropped the rest (with reason).
function buildUniverse(enginePool) {
  const eff = new Set(enginePool);
  const cards = [];
  const dropped = [];
  for (const c of DATA.cards) {
    if (c.isRule || c.category === "GUN") continue;
    if (!DRAFT_CATEGORIES.includes(c.category)) continue;
    if (c.excludedFromDraft || DELETED.has(c.id)) { dropped.push({ id: c.id, reason: "site: excluded/deleted" }); continue; }
    if (!c.effect || !eff.has(engineEffectOf(c))) { dropped.push({ id: c.id, effect: c.effect, category: c.category, reason: "engine has no implementation in the self-play pool" }); continue; }
    cards.push(c);
  }
  return { cards, dropped };
}
function implementedRules(engineRuleIds) {
  const ok = new Set(engineRuleIds || DATA.engineRuleCandidates.map((r) => r.id));
  const excluded = new Set(DATA.engineRuleExcluded);
  const usable = [];
  const dropped = [];
  for (const id of DATA.ruleCardIds) {
    if (ok.has(id) && !excluded.has(id)) usable.push(id);
    else dropped.push(id);
  }
  return { usable, dropped };
}

// ---- weights / mode ----
const MODES = ["normal", "chaos", "grand"];
function parseModeWeights(str) {
  if (!str) return { normal: 1, chaos: 1, grand: 1 };
  const w = { normal: 0, chaos: 0, grand: 0 };
  for (const part of String(str).split(",")) {
    const [k, v] = part.split(":").map((s) => s.trim());
    if (!MODES.includes(k) || !(Number(v) >= 0)) throw new Error("SELFPLAY_DRAFT_MODE_WEIGHTS: bad entry '" + part + "' (want normal:1,chaos:1,grand:1)");
    w[k] = Number(v);
  }
  if (w.normal + w.chaos + w.grand <= 0) throw new Error("SELFPLAY_DRAFT_MODE_WEIGHTS: all zero");
  return w;
}
function pickMode(mode, rng, weights) {
  if (mode !== "mix") return mode;
  const w = weights || parseModeWeights("");
  const total = w.normal + w.chaos + w.grand;
  let r = rng() * total;
  for (const m of MODES) { r -= w[m]; if (r < 0) return m; }
  return "grand";
}
// SELFPLAY_GRAND_POOL: "site" (default; the site's 28-card composition) or a number.
function grandCategorySizes(spec) {
  const site = C.grandCategorySizes;
  if (!spec || spec === "site") return { ...site };
  const n = Math.floor(Number(spec));
  if (!(n >= 12)) throw new Error("SELFPLAY_GRAND_POOL must be 'site' or a number >= 12");
  const cats = Object.keys(site);
  const exact = cats.map((k) => (site[k] * n) / C.grandPoolSize);
  const sizes = exact.map(Math.floor);
  let rest = n - sizes.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) sizes[order[k][1]]++;
  return Object.fromEntries(cats.map((k, i) => [k, sizes[i]]));
}

const pickIdx = (rng, n) => Math.floor(rng() * n);

// ---- the drafter ----
function createDrafter(opts = {}) {
  const universe = buildUniverse(opts.enginePool || []);
  const rules = implementedRules(opts.engineRuleIds);
  const byCat = Object.fromEntries(DRAFT_CATEGORIES.map((k) => [k, universe.cards.filter((c) => c.category === k)]));
  const ruleProb = opts.ruleProb; // {normal, chaos, grand} overrides or undefined
  const grandSizes = grandCategorySizes(opts.grandPool);

  // Equal-weight draw of `count` cards from the given categories (drawWeightedMixedCards without weights).
  function drawMixed(categories, count, selected, excluded, active, rng) {
    const picked = [];
    const local = new Set(excluded);
    const unavailableBase = selected;
    const cats = new Set(categories);
    while (picked.length < count) {
      const unavailable = new Set([...unavailableBase, ...local]);
      const pool = [];
      for (const k of DRAFT_CATEGORIES) {
        if (!cats.has(k)) continue;
        for (const c of byCat[k]) {
          if (selected.has(c.id) || local.has(c.id)) continue;
          if (mutuallyExclusive(c.id, unavailable)) continue;
          if (mutuallyExclusive(c.id, active)) continue; // active rules count as "selected" for pawn-direction conflicts
          if (ruleBlocks(c.id, active)) continue;
          pool.push(c);
        }
      }
      if (!pool.length) break;
      const card = pool[pickIdx(rng, pool.length)];
      picked.push(card);
      local.add(card.id);
    }
    return picked;
  }

  function drawPhase(phase, count, selected, active, rng) {
    if (phase === "OPENING") return drawMixed(["OPENING", "MIDDLE", "PIECE"], count, selected, new Set(), active, rng);
    if (phase === "END") return drawMixed(["MIDDLE", "END"], count, selected, new Set(), active, rng);
    // MIDDLE: pieceCount = max(1, round(count/3)) PIECE cards, the rest MIDDLE (fallback MIDDLE+PIECE)
    const pieceCount = Math.max(1, Math.round(count / 3));
    const plan = [["MIDDLE", Math.max(0, count - pieceCount)], ["PIECE", pieceCount]];
    const excluded = new Set();
    const choices = [];
    for (const [cat, n] of plan) {
      for (const card of drawMixed([cat], n, selected, excluded, active, rng)) { choices.push(card); excluded.add(card.id); }
    }
    if (choices.length < count) {
      for (const card of drawMixed(["MIDDLE", "PIECE"], count - choices.length, selected, excluded, active, rng)) { choices.push(card); excluded.add(card.id); }
    }
    return choices.slice(0, count);
  }

  // enforceChaosExclusiveOpeningBundleRule (fresh games: single-opening-bundle rule active)
  function enforceChaosBundles(choices, selected, active, rng) {
    if (choices.length !== C.chaosOfferSize) return choices;
    const B = C.chaosBundleSize;
    const arranged = choices.slice();
    const isOpening = (c) => c && c.category === "OPENING";
    const forbidden = (a, b) => {
      if (isOpening(a) && isOpening(b)) return true;
      const ids = new Set([a && a.id, b && b.id]);
      return DATA.chaos.forbiddenBundlePairs.some(([x, y]) => ids.has(x) && ids.has(y));
    };
    for (let bs = 0; bs < arranged.length; bs += B) {
      const first = arranged[bs];
      const second = arranged[bs + 1];
      if (!forbidden(first, second)) continue;
      const swapIndex = arranged.findIndex((cand, index) => {
        if (index >= bs && index < bs + B) return false;
        const sbs = Math.floor(index / B) * B;
        const sp = sbs + (index === sbs ? 1 : 0);
        return !forbidden(first, cand) && !forbidden(second, arranged[sp]);
      });
      if (swapIndex >= 0) { [arranged[bs + 1], arranged[swapIndex]] = [arranged[swapIndex], arranged[bs + 1]]; continue; }
      const excluded = new Set(arranged.map((c) => c && c.id).filter(Boolean));
      const rep = drawMixed(["MIDDLE", "PIECE"], 1, selected, excluded, active, rng)[0];
      if (rep) arranged[bs + 1] = rep;
    }
    for (let bs = 0; bs < arranged.length; bs += B) {
      const be = bs + B;
      const exclusiveIndex = arranged.findIndex((c, i) => i >= bs && i < be && c && EXCLUSIVE_OPENING.has(c.id));
      if (exclusiveIndex < 0) continue;
      const partnerIndex = bs + (exclusiveIndex === bs ? 1 : 0);
      if (!isOpening(arranged[partnerIndex])) continue;
      const partnerIsExclusive = EXCLUSIVE_OPENING.has(arranged[partnerIndex].id);
      const swapIndex = arranged.findIndex((c, i) => {
        if ((i >= bs && i < be) || isOpening(c)) return false;
        const sbs = Math.floor(i / B) * B;
        const sbe = sbs + B;
        if (arranged.some((e, ei) => ei >= sbs && ei < sbe && e && EXCLUSIVE_OPENING.has(e.id))) return false;
        if (!partnerIsExclusive) return true;
        const sp = sbs + (i === sbs ? 1 : 0);
        return !isOpening(arranged[sp]);
      });
      if (swapIndex >= 0) { [arranged[partnerIndex], arranged[swapIndex]] = [arranged[swapIndex], arranged[partnerIndex]]; continue; }
      const excluded = new Set(arranged.map((c) => c && c.id).filter(Boolean));
      const rep = drawMixed(["MIDDLE", "PIECE"], 1, selected, excluded, active, rng)[0];
      if (rep) arranged[partnerIndex] = rep;
    }
    return arranged;
  }

  function rollRule(mode, rng) {
    const p = (ruleProb && ruleProb[mode] !== undefined) ? ruleProb[mode] : (mode === "grand" ? C.ruleOpeningChanceGrand : C.ruleOpeningChance);
    const hit = rng() < p;
    if (!hit || !rules.usable.length) return null;
    return rules.usable[pickIdx(rng, rules.usable.length)];
  }

  // Normal (3 phases x offer of 3, pick 1) and chaos (3 phases x 3 bundles of 2, pick 1 bundle).
  function dealPhased(mode, rng, active) {
    const decks = { white: [], black: [] };
    const selected = new Set(); // both colors (site's selectedCardIds())
    const offers = [];
    const size = mode === "chaos" ? C.chaosOfferSize : C.normalOfferSize;
    for (const phase of ["OPENING", "MIDDLE", "END"]) {
      for (const color of ["white", "black"]) {
        let choices = drawPhase(phase, size, selected, active, rng);
        if (mode === "chaos") choices = enforceChaosBundles(choices, selected, active, rng);
        let taken = [];
        let bundles = null;
        if (mode === "chaos") {
          bundles = [];
          for (let i = 0; i < C.chaosBundleCount; i++) {
            const b = choices.slice(i * C.chaosBundleSize, (i + 1) * C.chaosBundleSize);
            if (b.length === C.chaosBundleSize) bundles.push(b);
          }
          if (bundles.length) taken = bundles[pickIdx(rng, bundles.length)];
        } else if (choices.length) {
          taken = [choices[pickIdx(rng, choices.length)]];
        }
        for (const c of taken) { decks[color].push(c.id); selected.add(c.id); }
        offers.push({ phase, color, choices: choices.map((c) => c.id), bundles: bundles && bundles.map((b) => b.map((c) => c.id)), taken: taken.map((c) => c.id) });
      }
    }
    return { decks, offers };
  }

  // Grand: shared pool, black picks first, alternating; 6 cards each.
  function dealGrand(rng, active) {
    const eligible = (cat) => byCat[cat].filter((c) => !ruleBlocks(c.id, active) && !mutuallyExclusive(c.id, active));
    const poolCards = [];
    const unavailable = new Set();
    for (const cat of C.grandCategories) {
      const local = new Set(unavailable);
      const cands = eligible(cat);
      const picked = [];
      while (picked.length < (grandSizes[cat] || 0)) {
        const pool = cands.filter((c) => !local.has(c.id) && !mutuallyExclusive(c.id, local) && !grandPoolConflict(c.id, local));
        if (!pool.length) break;
        const card = pool[pickIdx(rng, pool.length)];
        picked.push(card);
        local.add(card.id);
      }
      for (const c of picked) { poolCards.push(c); unavailable.add(c.id); }
    }
    const decks = { white: [], black: [] };
    const own = { white: new Set(), black: new Set() };
    const exclusiveTaken = { white: false, black: false };
    const taken = new Set();
    const picks = [];
    const first = C.grandFirstPickingColor;
    const other = first === "black" ? "white" : "black";
    for (let i = 0; i < C.grandPickCount; i++) {
      const color = i % 2 === 0 ? first : other;
      const avail = poolCards.filter((c) => !taken.has(c.id)
        && !mutuallyExclusive(c.id, own[color])
        && !(EXCLUSIVE_OPENING.has(c.id) && exclusiveTaken[color])
        && decks[color].length < C.grandDeckSlots);
      if (!avail.length) break; // site: draft ends, game starts with the decks built so far
      const card = avail[pickIdx(rng, avail.length)];
      taken.add(card.id);
      own[color].add(card.id);
      if (EXCLUSIVE_OPENING.has(card.id)) exclusiveTaken[color] = true;
      decks[color].push(card.id);
      picks.push({ order: i + 1, color, cardId: card.id });
    }
    return { decks, pool: poolCards.map((c) => c.id), picks };
  }

  // Full deal for one game. Returns site card ids per color plus metadata.
  function deal(rng, mode) {
    const ruleId = rollRule(mode, rng);
    const active = new Set(ruleId ? [ruleId] : []);
    const body = mode === "grand" ? dealGrand(rng, active) : dealPhased(mode, rng, active);
    return { mode, ruleId, decks: body.decks, pool: body.pool, picks: body.picks, offers: body.offers };
  }

  return { deal, universe, rules, byCat, grandSizes, drawPhase, enforceChaosBundles };
}

// Env parsing shared by the worker and tests.
function readEnv(env = process.env) {
  const mode = env.SELFPLAY_SITE_DRAFT;
  if (!mode) return null;
  if (![...MODES, "mix"].includes(mode)) throw new Error("SELFPLAY_SITE_DRAFT must be normal|chaos|grand|mix, got '" + mode + "'");
  let ruleProb;
  if (env.SELFPLAY_RULE_PROB !== undefined && env.SELFPLAY_RULE_PROB !== "") {
    // single number = all modes; or "normal:0.4,chaos:0.4,grand:0.2"
    if (/^[0-9.]+$/.test(env.SELFPLAY_RULE_PROB)) { const p = Number(env.SELFPLAY_RULE_PROB); ruleProb = { normal: p, chaos: p, grand: p }; }
    else { ruleProb = {}; for (const part of env.SELFPLAY_RULE_PROB.split(",")) { const [k, v] = part.split(":"); if (!MODES.includes(k.trim()) || !(Number(v) >= 0 && Number(v) <= 1)) throw new Error("SELFPLAY_RULE_PROB bad entry '" + part + "'"); ruleProb[k.trim()] = Number(v); } }
  }
  return { mode, weights: parseModeWeights(env.SELFPLAY_DRAFT_MODE_WEIGHTS), ruleProb, grandPool: env.SELFPLAY_GRAND_POOL || "site" };
}

module.exports = { engineEffectOf, createDrafter, readEnv, pickMode, parseModeWeights, grandCategorySizes, buildUniverse, implementedRules, mutuallyExclusive, DATA, MODES };
