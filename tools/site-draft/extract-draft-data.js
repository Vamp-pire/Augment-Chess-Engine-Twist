#!/usr/bin/env node
// Reads the site bundle (site-oracle/site-bundle-*.js) and writes
// tools/site-draft/draft-data.json: the DATA the site's card draft depends on
// (card ids/categories/effects, exclusion groups, draft constants, rule-card
// pool). No site source code is copied into the repo, only extracted values.
//
//   node tools/site-draft/extract-draft-data.js [--bundle=<path>] [--out=<path>]
//
// Re-run when the site updates (after tools/site-parity's check-site-update).
// Every value is parsed from the bundle text; if a pattern no longer matches
// the script throws instead of silently writing stale numbers.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const ROOT = path.join(__dirname, "..", "..");
const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => { const [k, v] = a.slice(2).split("="); return [k, v === undefined ? true : v]; }));
let bundlePath = args.bundle ? path.resolve(args.bundle) : null;
if (!bundlePath) {
  const dir = path.join(ROOT, "site-oracle");
  const cands = fs.readdirSync(dir).filter((f) => /^site-bundle-\d+\.js$/.test(f)).sort();
  if (!cands.length) throw new Error("no site-oracle/site-bundle-*.js found");
  bundlePath = path.join(dir, cands[cands.length - 1]);
}
const outPath = args.out ? path.resolve(args.out) : path.join(__dirname, "draft-data.json");
const enginePath = path.join(ROOT, "engine-merged.js");

const raw = fs.readFileSync(bundlePath);
const src = raw.toString("utf8");
const fail = (msg) => { throw new Error("extract-draft-data: " + msg); };

// ---- tiny statement extractor: `const NAME = ...;` / `function NAME(...) {...}` ----
function statementEnd(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch;
      for (i++; i < text.length && text[i] !== q; i++) if (text[i] === "\\") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") { while (i < text.length && text[i] !== "\n") i++; continue; }
    if (ch === "/" && text[i + 1] === "*") { i = text.indexOf("*/", i + 2) + 1; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
    else if (ch === ";" && depth === 0) return i + 1;
  }
  fail("unterminated statement at " + start);
}
function constStatement(name) {
  const esc = name.replace(/\$/g, "\\$");
  const m = new RegExp("^const " + esc + " = ", "m").exec(src);
  if (!m) fail("const not found: " + name);
  return src.slice(m.index, statementEnd(src, m.index));
}
function functionStatement(name) {
  const m = new RegExp("^function " + name.replace(/\$/g, "\\$") + "\\(", "m").exec(src);
  if (!m) fail("function not found: " + name);
  let i = src.indexOf("{", m.index), depth = 0;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") { const q = ch; for (i++; i < src.length && src[i] !== q; i++) if (src[i] === "\\") i++; continue; }
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return src.slice(m.index, i + 1);
  }
  return fail("unterminated function " + name);
}
const numConst = (name) => {
  const m = new RegExp("^const " + name + " = ([0-9.e]+);", "m").exec(src);
  if (!m) fail("numeric const not found: " + name);
  return Number(m[1]);
};

// ---- constants ----
const constants = {
  normalDeckSlots: numConst("NORMAL_DECK_SLOT_COUNT"),
  chaosDeckSlots: numConst("CHAOS_DECK_SLOT_COUNT"),
  chaosBundleCount: numConst("CHAOS_DRAFT_BUNDLE_COUNT"),
  chaosBundleSize: numConst("CHAOS_DRAFT_BUNDLE_SIZE"),
  grandDeckSlots: numConst("GRAND_DECK_SLOT_COUNT"),
  grandPoolSize: numConst("GRAND_DRAFT_POOL_SIZE"),
  grandPickCount: numConst("GRAND_DRAFT_PICK_COUNT"),
  ruleOpeningChance: numConst("RULE_OPENING_CHANCE"),
  firstDraftOpeningWeightMultiplier: numConst("FIRST_DRAFT_OPENING_WEIGHT_MULTIPLIER") // NOT used by self-play (equal weights)
};
{
  const m = /const GRAND_DRAFT_CATEGORY_SIZES = Object\.freeze\((\{[^}]*\})\)/.exec(src);
  if (!m) fail("GRAND_DRAFT_CATEGORY_SIZES");
  constants.grandCategorySizes = vm.runInNewContext("(" + m[1] + ")");
  const sum = Object.values(constants.grandCategorySizes).reduce((a, b) => a + b, 0);
  if (sum !== constants.grandPoolSize) fail("grand category sizes do not sum to pool size");
  const g = /GRAND_DRAFT_CATEGORIES = Object\.freeze\((\[[^\]]*\])\)/.exec(src);
  constants.grandCategories = vm.runInNewContext(g[1]);
  // grand rule probability literal inside maybeApplyOpeningRuleEvent
  const r = /Math\.random\(\) >= \(state\.gameStyle === "grand" && usesSeptember18Balance\(state\) \? ([0-9.]+) : RULE_OPENING_CHANCE\)/.exec(src);
  if (!r) fail("grand rule chance pattern changed");
  constants.ruleOpeningChanceGrand = Number(r[1]);
  // first picker of the grand draft: the default returned by grandDraftFirstPickingColor
  const f = functionStatement("grandDraftFirstPickingColor");
  const fm = /return "(white|black)";\s*}$/.exec(f);
  if (!fm) fail("grandDraftFirstPickingColor default");
  constants.grandFirstPickingColor = fm[1];
  const p = functionStatement("grandDraftPickingColorAtIndex");
  if (!/Number\(pickIndex\) % 2 === 0 \? firstColor : opponent\(firstColor\)/.test(p)) fail("grand pick alternation changed");
  constants.grandAlternates = true;
  // normal-mode per-phase offer size == NORMAL_DECK_SLOT_COUNT (startDraft: choiceCount), chaos == bundleCount*bundleSize
  const sd = /const choiceCount = isChaosGameStyle\(state\) \? CHAOS_DRAFT_BUNDLE_COUNT \* CHAOS_DRAFT_BUNDLE_SIZE : NORMAL_DECK_SLOT_COUNT;/.test(src);
  if (!sd) fail("startDraft choiceCount pattern changed");
  constants.normalOfferSize = constants.normalDeckSlots;
  constants.chaosOfferSize = constants.chaosBundleCount * constants.chaosBundleSize;
  // drawPhaseChoicesRaw structure (categories per phase); asserted so a site change breaks loudly
  const d = functionStatement("drawPhaseChoicesRaw");
  const ok = /drawOpeningChoices\(count, color2\)/.test(d) && /Math\.max\(1, Math\.round\(count \/ 3\)\)/.test(d)
    && /\["MIDDLE", Math\.max\(0, count - pieceCount\)\], \["PIECE", pieceCount\]/.test(d) && /drawWeightedMixedCards\(\["MIDDLE", "END"\], count, color2\)/.test(d);
  if (!ok) fail("drawPhaseChoicesRaw structure changed; update draft.js phase plan");
  if (!/drawWeightedMixedCards\(\["OPENING", "MIDDLE", "PIECE"\]/.test(functionStatement("drawOpeningChoices"))) fail("drawOpeningChoices categories changed");
  constants.phasePlan = {
    OPENING: { mixed: ["OPENING", "MIDDLE", "PIECE"] },
    MIDDLE: { pieceShare: "max(1, round(count/3)) PIECE, rest MIDDLE" },
    END: { mixed: ["MIDDLE", "END"] }
  };
}

// ---- card universe ----
const groupsSrc = constStatement("CARD_CATEGORY_GROUPS").replace(/^const CARD_CATEGORY_GROUPS = Object\.freeze\(/, "(").replace(/\);$/, ")");
const groups = vm.runInNewContext(groupsSrc);
const categoryOrder = Object.keys(groups);

// Cards appended to the groups at load time (SEPTEMBER_* / INTERNAL_* lists).
const ctx = vm.createContext({ Object });
const run = (code) => vm.runInContext(code, ctx);
for (const h of src.match(/^const [A-Z0-9_]*BALANCE_UPDATES = /gm)) {
  const stmt = h.slice(6, -3);
  if (!/^(PREVIOUS_INTERNAL|PRE_[A-Z0-9_]+|INTERNAL)_?BALANCE_UPDATES$/.test(stmt) && stmt !== "INTERNAL_BALANCE_UPDATES") continue;
  run(constStatement(stmt).replace(/^const /, "var "));
}
if (!ctx.INTERNAL_BALANCE_UPDATES) fail("INTERNAL_BALANCE_UPDATES not evaluated");
if (!/return \{ \.\.\.card2, \.\.\.INTERNAL_BALANCE_UPDATES\[card2\.id\] \};/.test(functionStatement("internalBalanceCard"))) fail("internalBalanceCard changed");
for (const n of ["make", "card$l", "card$k", "SEPTEMBER_CARD_DEFINITIONS", "SEPTEMBER_RULE_DEFINITION", "SEPTEMBER_ALL_DEFINITIONS", "INTERNAL_THREE_CARDS", "INTERNAL_EIGHT_CARDS", "INTERNAL_FIVE_CARDS"]) {
  run(constStatement(n).replace(/^const /, "var "));
}
const loopHead = /for \(const card2 of \[\.\.\.SEPTEMBER_ALL_DEFINITIONS, \.\.\.INTERNAL_EIGHT_CARDS, \.\.\.INTERNAL_FIVE_CARDS, \.\.\.INTERNAL_THREE_CARDS\]\.map\(internalBalanceCard\)\) CARD_CATEGORY_GROUPS\[card2\.phase\]\.push\(card2\.id\);/;
if (!loopHead.test(src)) fail("category push loop changed");
const extras = run("[...SEPTEMBER_ALL_DEFINITIONS, ...INTERNAL_EIGHT_CARDS, ...INTERNAL_FIVE_CARDS, ...INTERNAL_THREE_CARDS].map((c) => ({ ...c, ...INTERNAL_BALANCE_UPDATES[c.id] })).map((c) => ({ id: c.id, phase: c.phase, effect: c.effect }))");
for (const c of extras) { if (!groups[c.phase]) fail("extra card with unknown phase " + c.id); groups[c.phase].push(c.id); }

// CARD_CATEGORY_BY_ID: later groups overwrite earlier ones (Object.entries order)
const categoryById = {};
for (const cat of categoryOrder) for (const id of groups[cat]) categoryById[id] = cat;

// CARD_DEFS is the list the draft filters over; a card missing from the category
// groups falls back to its own `phase` (draftPoolForCategories: CARD_CATEGORY_BY_ID[id] || card.phase).
run("function internalBalanceCard(card2) { return { ...card2, ...INTERNAL_BALANCE_UPDATES[card2.id] }; }");
run(constStatement("CARD_DEFS").replace(/^const /, "var "));
const defs = run("CARD_DEFS.map((c) => ({ id: c.id, phase: c.phase, effect: c.effect || null, stars: c.stars === undefined ? null : c.stars }))");
if (defs.length < 150) fail("CARD_DEFS evaluated to only " + defs.length + " cards");
const defById = new Map();
for (const d of defs) if (!defById.has(d.id)) defById.set(d.id, d);

// fallback id -> effect for definitions that carry no explicit effect
const effectById = new Map(extras.map((c) => [c.id, c.effect]));
for (const d of defs) if (d.effect && !effectById.has(d.id)) effectById.set(d.id, d.effect);
{
  const reId = /\bid:\s*"([a-z0-9-]+)"/g; const idx = []; let m;
  while ((m = reId.exec(src))) idx.push([m[1], m.index]);
  for (let k = 0; k < idx.length; k++) {
    const [id, pos] = idx[k];
    if (effectById.has(id)) continue;
    const w = src.slice(pos, Math.min(idx[k + 1] ? idx[k + 1][1] : src.length, pos + 900));
    const e = /\beffect:\s*"(\w+)"/.exec(w);
    if (e) effectById.set(id, e[1]);
  }
  const reBase = /base\$?\d*\("([a-z0-9-]+)",\s*"[^"]*",\s*"[^"]*",\s*"[A-Z]+",\s*\d+,\s*"(\w+)"\)/g;
  while ((m = reBase.exec(src))) if (!effectById.has(m[1])) effectById.set(m[1], m[2]);
}

// ---- exclusions ----
run(constStatement("TEMPORARILY_DISABLED_CARD_IDS").replace(/^const /, "var "));
const deletedCardIds = run("[...TEMPORARILY_DISABLED_CARD_IDS]");
if (!/const DELETED_CARD_IDS = \/\* @__PURE__ \*\/ new Set\(\[\.\.\.TEMPORARILY_DISABLED_CARD_IDS\]\);/.test(src)) fail("DELETED_CARD_IDS definition changed");

run(constStatement("LATEST_MERCHANT_GUILD_EXCLUSIVE_CARD_IDS").replace(/^const /, "var "));
const groupsDecl = constStatement("LATEST_MUTUALLY_EXCLUSIVE_DRAFT_CARD_GROUPS").replace(/^const /, "var ");
const mutuallyExclusiveGroups = run(groupsDecl.replace(/;$/, ";") + "; LATEST_MUTUALLY_EXCLUSIVE_DRAFT_CARD_GROUPS.map((g) => [...g])");
run(constStatement("EXCLUSIVE_OPENING_CARD_IDS").replace(/^const /, "var "));
const exclusiveOpeningIds = run("[...EXCLUSIVE_OPENING_CARD_IDS]");

const pawnFn = functionStatement("hasPawnDirectionConflict");
if (!/id === "reverse-pawns" \? selected\.has\("rule-ticket"\) \|\| selected\.has\("macho-chess"\) : \["rule-ticket", "macho-chess"\]\.includes\(id\) && selected\.has\("reverse-pawns"\)/.test(pawnFn)) fail("hasPawnDirectionConflict changed");
const pawnDirectionConflicts = [["reverse-pawns", "rule-ticket"], ["reverse-pawns", "macho-chess"]];

// chaos bundle constraints (enforceChaosExclusiveOpeningBundleRule)
const chaosFn = functionStatement("enforceChaosExclusiveOpeningBundleRule");
if (!/usesSingleOpeningChaosBundle\(state\) && libraryCardPhase\(first\) === "OPENING" && libraryCardPhase\(second\) === "OPENING"\) return true;/.test(chaosFn)) fail("chaos same-category rule changed");
if (!/ids\.has\("democracy"\) && ids\.has\("queens-gambit"\)/.test(chaosFn)) fail("chaos forbidden pair changed");
// with no catalogHash on the state usesSingleOpeningChaosBundle() returns true (fresh games)
if (!/return hash \? \[[^\]]*\]\.includes\(hash\) : true;/.test(functionStatement("usesSingleOpeningChaosBundle"))) fail("usesSingleOpeningChaosBundle default changed");
const chaos = {
  forbiddenBundlePairs: [["democracy", "queens-gambit"]],
  noTwoSameCategoryInBundle: ["OPENING"], // both cards of one bundle may not be OPENING-category (fresh games)
  exclusiveOpeningPartnerMustNotBeOpening: exclusiveOpeningIds
};

// grand pool-level conflicts
const gp = functionStatement("hasGrandDraftPoolCardConflict");
const grandPoolConflicts = [["london-system", "big-rook"], ["democracy", "queens-gambit"], ["big-rook", "big-bishop"]];
for (const [a, b] of grandPoolConflicts) if (!gp.includes(`"${a}"`) || !gp.includes(`"${b}"`)) fail("grand pool conflict changed: " + a + "," + b);
const grandPoolConflictsBody = gp.replace(/\s+/g, " ");
if ((grandPoolConflictsBody.match(/selected\.has/g) || []).length !== 6) fail("grand pool conflict count changed");

// rule-based draft blocks
const ruleBlocked = {
  monochromeChess: (() => { const m = /["horse-riding", "horde"]/.exec(functionStatement("isMonochromeDraftCardExcluded")); if (!m) fail("monochrome blocked list"); return ["horse-riding", "horde"]; })(),
  machoChess: ["reverse-pawns"],
  diagonalChessBlocksExclusiveOpening: exclusiveOpeningIds,
  largeOpeningCardsBlockedByRules: (() => {
    const f = functionStatement("isLargeOpeningCardExcludedByRule");
    const m = /\["big-rook", "big-bishop"\]\.includes\(cardId\) && (\[[^\]]*\])\.includes\(ruleId\)/.exec(f);
    if (!m) fail("isLargeOpeningCardExcludedByRule changed");
    return { cards: ["big-rook", "big-bishop"], rules: vm.runInNewContext(m[1]) };
  })()
};
if (!/state\?\.machoChess && card2\.id === "reverse-pawns"/.test(src)) fail("macho reverse-pawns block changed");
const aiHumanExcluded = vm.runInNewContext(/const AI_HUMAN_DRAFT_EXCLUDED_CARD_IDS = \/\* @__PURE__ \*\/ new Set\((\[[^\]]*\])\)/.exec(src)[1]); // vs-AI only; NOT applied
const ruleTicketExcluded = vm.runInNewContext(/const RULE_TICKET_EXCLUDED_RULE_IDS = \/\* @__PURE__ \*\/ new Set\((\[[^\]]*\])\)/.exec(src)[1]);

// ---- rule pool (ruleCardPool()) ----
const ruleCardIds = [...defById.keys()].filter((id) => (categoryById[id] || defById.get(id).phase) === "RULE" && !deletedCardIds.includes(id));
const ruleFn = functionStatement("ruleCardPool");
if (!/card2\.id !== "revelation" \|\| isDeathmatchSettingEnabled\(\)/.test(ruleFn)) fail("ruleCardPool changed");

// ---- engine-implemented rule ids (engine-merged.js WORKER_RULE_TICKET_CANDIDATES) ----
const engSrc = fs.readFileSync(enginePath, "utf8");
const em = /const WORKER_RULE_TICKET_CANDIDATES = \[([\s\S]*?)\n  \];/.exec(engSrc);
if (!em) fail("engine WORKER_RULE_TICKET_CANDIDATES not found");
const engineRuleCandidates = [...em[1].matchAll(/\{ id: "([a-z0-9-]+)", effect: "(\w+)"/g)].map((x) => ({ id: x[1], effect: x[2] }));
const exm = /const WORKER_RULE_TICKET_EXCLUDED_RULE_IDS = [^\[]*\[([^\]]*)\]/.exec(engSrc);
const engineRuleExcluded = exm ? [...exm[1].matchAll(/"([a-z0-9-]+)"/g)].map((x) => x[1]) : [];

// ---- assemble cards ----
const cards = [];
const notInDefs = [];
for (const [id, d] of defById) {
  const category = categoryById[id] || d.phase;
  cards.push({
    id,
    category,
    categorySource: categoryById[id] ? "CARD_CATEGORY_GROUPS" : "card.phase",
    effect: effectById.get(id) || null,
    siteStars: d.stars,
    isRule: category === "RULE",
    deleted: deletedCardIds.includes(id),
    excludedFromDraft: id === "shotgun-king" || category === "GUN" || deletedCardIds.includes(id)
  });
}
for (const id of Object.keys(categoryById)) if (!defById.has(id)) notInDefs.push(id);
if (notInDefs.length) console.warn("ids in category groups but not in CARD_DEFS (never drafted):", notInDefs.join(" "));
const noEffect = cards.filter((c) => !c.effect).map((c) => c.id);
if (noEffect.length) console.warn("cards without an effect (kept, will be dropped by the engine intersect):", noEffect.join(" "));

const out = {
  provenance: {
    bundleFile: path.basename(bundlePath),
    bundleSha256: crypto.createHash("sha256").update(raw).digest("hex"),
    bundleBytes: raw.length,
    engineFile: "engine-merged.js",
    engineSha256: crypto.createHash("sha256").update(engSrc).digest("hex"),
    extractedBy: "tools/site-draft/extract-draft-data.js",
    note: "data only; equal-weight draws (site draftCardWeight / opening 1.3x boost / draft balance deliberately NOT extracted)"
  },
  constants,
  deletedCardIds,
  neverDrafted: ["shotgun-king"],
  exclusiveOpeningIds,
  mutuallyExclusiveGroups,
  pawnDirectionConflicts,
  chaos,
  grandPoolConflicts,
  ruleBlocked,
  aiHumanDraftExcludedNotApplied: aiHumanExcluded,
  ruleTicketExcludedRuleIds: ruleTicketExcluded,
  ruleCardIds,
  engineRuleCandidates,
  engineRuleExcluded,
  idsInGroupsButNotInCardDefs: notInDefs,
  cards
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 1) + "\n");
const cnt = {};
for (const c of cards) cnt[c.category] = (cnt[c.category] || 0) + 1;
console.log("wrote", path.relative(ROOT, outPath), "cards:", cards.length, JSON.stringify(cnt), "rules:", ruleCardIds.length, "engineRules:", engineRuleCandidates.length);
