// Speed patches for the game's AI worker: same behavior, less repeated work.
// Applied at runtime to whatever worker the site serves (like patches.js),
// so site updates are followed automatically. Unlike patches.js, a patch
// whose anchor is missing or not unique is SKIPPED (that part just runs at
// the original speed); the result lists applied and skipped patches.
//
// Rule for every patch: memoize only by identity of FROZEN objects (the
// game freezes its states), call the original otherwise, never cache throws.
// Checked by tools/parity-speed.cjs (same actions and same resulting states
// as the original worker on a corpus of real-rule positions).
(function (root) {
  "use strict";

  const SPEED_PATCHES = [
    [
      // Rule-version marker: scans effects.global on every call (~47k calls
      // to list 41 actions). Depends only on that array.
      "memo-november03RulesMarker",
      "function november03RulesMarker(value2) {\n",
      `const __acbN03 = new WeakMap();
  function november03RulesMarker(value2) {
    const st = value2?.cardState ?? value2, g = st?.effects?.global;
    if (!g || !Object.isFrozen(g)) return __acbN03Orig(value2);
    let r = __acbN03.get(g);
    if (r === undefined) { r = __acbN03Orig(value2); __acbN03.set(g, r); }
    else if (globalThis.__acbSpeedShadow) { const o = __acbN03Orig(value2); const sh = globalThis.__acbSpeedShadow; sh.n03 = (sh.n03 || 0) + 1; if (JSON.stringify(o) !== JSON.stringify(r)) sh.n03Bad = (sh.n03Bad || 0) + 1; }
    return r;
  }
  function __acbN03Orig(value2) {
`
    ],
    [
      // "Does this color hold an applied card X?" Depends on the color's
      // inventory, its color effects and the card profile.
      "memo-cardStateHasAppliedCard",
      "function cardStateHasAppliedCard(cardState, color, cardId) {\n",
      `const __acbApplied = new WeakMap();
  function cardStateHasAppliedCard(cardState, color, cardId) {
    if (!cardState || !Object.isFrozen(cardState) || !Object.isFrozen(cardState.inventories?.[color]) || !Object.isFrozen(cardState.effects?.colors?.[color])) return __acbAppliedOrig(cardState, color, cardId);
    let m = __acbApplied.get(cardState);
    if (!m) { m = { white: new Map(), black: new Map() }; __acbApplied.set(cardState, m); }
    const mc = m[color];
    if (!mc) return __acbAppliedOrig(cardState, color, cardId);
    let r = mc.get(cardId);
    if (r === undefined) { r = __acbAppliedOrig(cardState, color, cardId); mc.set(cardId, r); }
    else if (globalThis.__acbSpeedShadow) { const sh = globalThis.__acbSpeedShadow; sh.applied = (sh.applied || 0) + 1; if (__acbAppliedOrig(cardState, color, cardId) !== r) sh.appliedBad = (sh.appliedBad || 0) + 1; }
    return r;
  }
  function __acbAppliedOrig(cardState, color, cardId) {
`
    ],
    // ---- candidates drafted with the agy CLI (Gemini), checked with
    // tools/parity-speed.cjs --shadow before use; comments are agy's ----
    /*
     * 1. memo-democracyKingMissing
     * - What it caches: Boolean result of democracyKingMissing(state) (whether a
     *   player with an applied "democracy" card is missing their king on an active
     *   board). Eliminates repeated state.position.board.flat() allocations
     *   (~3,068 calls and ~7.6%-9.7% inclusive/self CPU time on mid.jsonl;
     *   ~48,990 calls across 15 corpus-1 positions; ~97.4% cache hit rate).
     * - Frozen objects checked:
     *   - Fast path (every call): state.
     *   - On miss (before WeakMap.set): state.position, state.position.board, and
     *     every row array state.position.board[i]; state.cardState,
     *     state.cardState.profile, state.cardState.inventories (plus white/black
     *     arrays and element objects), and state.cardState.effects.colors (plus
     *     white/black arrays, element objects, e.attributes, and
     *     e.attributes.grantedCardIds).
     *   - Mutable globals read: none.
     * - Call sites checked for mutation: Returns a primitive boolean (immutable).
     *   All 8 call sites checked (lines 252662, 253697, 253762, 253771, 255304,
     *   265369, 266467, 266799): all consume it as a boolean condition.
     * - Expected gain: ~8% CPU reduction on midgame move listing (~100-120 ms/listing
     *   on mid.jsonl; ~1.4 s CPU across 9 positions).
     */
    [
      "memo-democracyKingMissing",
      "function democracyKingMissing(state) {\n",
      `const __acbDkm = new WeakMap();
    function __acbDkmFrozen(state) {
      const pos = state.position, cs = state.cardState;
      if (!pos || !Object.isFrozen(pos) || !Array.isArray(pos.board) || !Object.isFrozen(pos.board)) return false;
      for (let i = 0; i < pos.board.length; i++) if (!Object.isFrozen(pos.board[i])) return false;
      if (!cs || !Object.isFrozen(cs) || !cs.profile || !Object.isFrozen(cs.profile) || !cs.inventories || !Object.isFrozen(cs.inventories) || !cs.effects?.colors || !Object.isFrozen(cs.effects.colors)) return false;
      for (const c of ["white", "black"]) {
        const inv = cs.inventories[c], eff = cs.effects.colors[c];
        if (!Array.isArray(inv) || !Object.isFrozen(inv) || !Array.isArray(eff) || !Object.isFrozen(eff)) return false;
        for (let i = 0; i < inv.length; i++) if (inv[i] && typeof inv[i] === "object" && !Object.isFrozen(inv[i])) return false;
        for (let i = 0; i < eff.length; i++) {
          const e = eff[i];
          if (e && typeof e === "object") {
            if (!Object.isFrozen(e)) return false;
            if (e.attributes && (!Object.isFrozen(e.attributes) || (e.attributes.grantedCardIds && !Object.isFrozen(e.attributes.grantedCardIds)))) return false;
          }
        }
      }
      return true;
    }
    function democracyKingMissing(state) {
      if (!state || !Object.isFrozen(state)) return __acbDkmOrig(state);
      let r = __acbDkm.get(state);
      if (r === undefined) {
        if (!__acbDkmFrozen(state)) return __acbDkmOrig(state);
        r = __acbDkmOrig(state);
        __acbDkm.set(state, r);
      } else if (globalThis.__acbSpeedShadow) {
        const sh = globalThis.__acbSpeedShadow;
        sh.dkm = (sh.dkm || 0) + 1;
        if (__acbDkmOrig(state) !== r) sh.dkmBad = (sh.dkmBad || 0) + 1;
      }
      return r;
    }
    function __acbDkmOrig(state) {
  `
    ],

    /*
     * 2. memo-highwayTerrainFromEffects
     * - What it caches: Parsed { highway, highwayCells } descriptor derived from
     *   cardState.effects.global (~4,071 calls and ~3.1% inclusive / 2.0% self
     *   CPU time on mid.jsonl; ~72,103 calls across 15 corpus-1 positions; ~100%
     *   cache hit rate). Keyed by cardState.effects.global.
     * - Frozen objects checked:
     *   - Fast path (every call): g = cardState?.effects?.global (isArray & isFrozen).
     *   - On miss (before WeakMap.set): every element e in g is frozen, and if
     *     e.kind === "highway-trail", e.attributes and e.attributes.cells are
     *     frozen.
     *   - Mutable globals read: none.
     * - Call sites checked for mutation: All 2 call sites in cw.js checked:
     *   - line 216209 (september26AuthorityFlags): reads .highwayCells and exposes
     *     it via projection (lines 268608, 304981).
     *   - line 241611 (v26HighwayRay): passes directly to continuousHighwayRay,
     *     which only reads .highway and .highwayCells.some(...).
     *   To be safe against any external mutation of projected highwayCells, the
     *   wrapper also returns a fresh shallow copy per call.
     * - Expected gain: ~2-10% CPU reduction (~1.8 s CPU across 9 positions).
     */
    [
      "memo-highwayTerrainFromEffects",
      "function highwayTerrainFromEffects(cardState) {\n",
      `const __acbHwy = new WeakMap();
    function highwayTerrainFromEffects(cardState) {
      const g = cardState?.effects?.global;
      if (!Array.isArray(g) || !Object.isFrozen(g)) return __acbHwyOrig(cardState);
      let r = __acbHwy.get(g);
      if (r === undefined) {
        for (let i = 0; i < g.length; i++) {
          const e = g[i];
          if (!e || typeof e !== "object" || !Object.isFrozen(e)) return __acbHwyOrig(cardState);
          if (e.kind === "highway-trail" && e.attributes && (!Object.isFrozen(e.attributes) || (e.attributes.cells && !Object.isFrozen(e.attributes.cells)))) return __acbHwyOrig(cardState);
        }
        r = __acbHwyOrig(cardState);
        __acbHwy.set(g, r);
      } else if (globalThis.__acbSpeedShadow) {
        const o = __acbHwyOrig(cardState);
        const sh = globalThis.__acbSpeedShadow;
        sh.hwy = (sh.hwy || 0) + 1;
        if (JSON.stringify(o) !== JSON.stringify(r)) sh.hwyBad = (sh.hwyBad || 0) + 1;
      }
      return { highway: r.highway, highwayCells: r.highwayCells.length ? r.highwayCells.map((c) => ({ row: c.row, col: c.col })) : [] };
    }
    function __acbHwyOrig(cardState) {
  `
    ],

    /*
     * 3. memo-omegaInteractionMarker
     * - What it caches: Validated "omega-interactions" effect entry (or null)
     *   from st.effects.global (~2,202 calls and ~2.4% self CPU time on
     *   mid.jsonl; ~38,528 calls across 15 corpus-1 positions; ~99.9% hit rate).
     *   Keyed by st.effects.global (same normalization as the original).
     * - Frozen objects checked:
     *   - Fast path (every call): g = st?.effects?.global (isArray & isFrozen).
     *   - On miss (before WeakMap.set): every element e in g is frozen, and if
     *     e.kind === KIND$9, e.attributes (if present) is frozen.
     *   - Mutable globals read: none. Invalid markers throw before WeakMap.set,
     *     so thrown errors are never cached.
     * - Call sites checked for mutation: All 4 call sites checked:
     *   - line 216001 (omegaInteractionVersion): reads ?.attributes.version.
     *   - line 216033 (withOmegaInteractions): truthiness check only.
     *   - line 265611 (plainStealthProbeDestinations): reference comparison only.
     *   - line 307420 (hasPlainCanonicalAiBoard): reference comparison only.
     *   Moreover, the returned non-null marker e is a frozen element of g.
     * - Expected gain: ~2-10% CPU reduction (~1.9 s CPU across 9 positions).
     */
    [
      "memo-omegaInteractionMarker",
      "function omegaInteractionMarker(value2) {\n",
      `const __acbOmega = new WeakMap();
    function omegaInteractionMarker(value2) {
      const st = value2?.cardState?.effects?.global ? value2.cardState : value2;
      const g = st?.effects?.global;
      if (!Array.isArray(g) || !Object.isFrozen(g)) return __acbOmegaOrig(value2);
      let r = __acbOmega.get(g);
      if (r === undefined) {
        for (let i = 0; i < g.length; i++) {
          const e = g[i];
          if (!e || typeof e !== "object" || !Object.isFrozen(e)) return __acbOmegaOrig(value2);
          if (e.kind === KIND$9 && e.attributes && !Object.isFrozen(e.attributes)) return __acbOmegaOrig(value2);
        }
        r = __acbOmegaOrig(value2);
        __acbOmega.set(g, r);
      } else if (globalThis.__acbSpeedShadow) {
        const sh = globalThis.__acbSpeedShadow;
        sh.omega = (sh.omega || 0) + 1;
        if (__acbOmegaOrig(value2) !== r) sh.omegaBad = (sh.omegaBad || 0) + 1;
      }
      return r;
    }
    function __acbOmegaOrig(value2) {
  `
    ],

    /*
     * 4. memo-october27RoyalMovementReplaced
     * - What it caches: Boolean result of october27RoyalMovementReplaced(state,
     *   actor, metadata) (~5,513 calls on mid.jsonl, ~91.9% hit rate; ~91,423
     *   calls across 15 corpus-1 positions). Avoids repeated catalog-hash scans,
     *   november03RulesVersion checks, socialism suppression checks, and
     *   colorEffect$1 scans on every candidate move check.
     * - Frozen objects checked:
     *   - Fast path (every call): state, metadata; also skips caching whenever
     *     legacySeptember12RulesDepth !== 0 or actor is not "white"/"black".
     *   - On per-state cache init: state.cardState, cs.profile, cs.effects,
     *     cs.effects.global (and element objects + .attributes), cs.effects.colors,
     *     cs.effects.colors.white/black (and element objects + .attributes), and
     *     cs.pieces (and if !usesOctober27Balance(state), all piece objects in
     *     cs.pieces, since v19SocialismSuppressesRoyalCommand scans cs.pieces).
     *   - On per-metadata cache insert: metadata.attributes (if object).
     *   - Mutable globals read: legacySeptember12RulesDepth (guarded === 0).
     * - Call sites checked for mutation: Returns a primitive boolean (immutable).
     *   Checked callers (lines 250555, 252207, 252534): all boolean checks.
     * - Expected gain: ~15-21% standalone CPU reduction on corpus-1; brings the
     *   5-patch bundle to ~27-28% CPU reduction overall.
     */
    [
      "memo-october27RoyalMovementReplaced",
      "function october27RoyalMovementReplaced(state, actor, metadata) {\n",
      `const __acbOct27Roy = new WeakMap();
    function __acbOct27RoyEffectsFrozen(arr) {
      if (!Array.isArray(arr) || !Object.isFrozen(arr)) return false;
      for (let i = 0; i < arr.length; i++) {
        const e = arr[i];
        if (!e || typeof e !== "object" || !Object.isFrozen(e)) return false;
        if (e.attributes && !Object.isFrozen(e.attributes)) return false;
      }
      return true;
    }
    function october27RoyalMovementReplaced(state, actor, metadata) {
      if (legacySeptember12RulesDepth !== 0 || !state || !Object.isFrozen(state) || !metadata || !Object.isFrozen(metadata)) return __acbOct27RoyOrig(state, actor, metadata);
      let m = __acbOct27Roy.get(state);
      if (!m) {
        const cs = state.cardState;
        if (!cs || !Object.isFrozen(cs) || !cs.profile || !Object.isFrozen(cs.profile) || !cs.effects || !Object.isFrozen(cs.effects) || !__acbOct27RoyEffectsFrozen(cs.effects.global) || !cs.effects.colors || !Object.isFrozen(cs.effects.colors) || !__acbOct27RoyEffectsFrozen(cs.effects.colors.white) || !__acbOct27RoyEffectsFrozen(cs.effects.colors.black) || !cs.pieces || !Object.isFrozen(cs.pieces)) {
          return __acbOct27RoyOrig(state, actor, metadata);
        }
        if (!usesOctober27Balance(state)) {
          for (const p of Object.values(cs.pieces)) if (p && typeof p === "object" && !Object.isFrozen(p)) return __acbOct27RoyOrig(state, actor, metadata);
        }
        m = { w: new WeakMap(), b: new WeakMap() };
        __acbOct27Roy.set(state, m);
      }
      const mw = actor === "white" ? m.w : actor === "black" ? m.b : null;
      if (!mw) return __acbOct27RoyOrig(state, actor, metadata);
      let r = mw.get(metadata);
      if (r === undefined) {
        if (metadata.attributes && !Object.isFrozen(metadata.attributes)) return __acbOct27RoyOrig(state, actor, metadata);
        r = __acbOct27RoyOrig(state, actor, metadata);
        mw.set(metadata, r);
      } else if (globalThis.__acbSpeedShadow) {
        const sh = globalThis.__acbSpeedShadow;
        sh.oct27Roy = (sh.oct27Roy || 0) + 1;
        if (__acbOct27RoyOrig(state, actor, metadata) !== r) sh.oct27RoyBad = (sh.oct27RoyBad || 0) + 1;
      }
      return r;
    }
    function __acbOct27RoyOrig(state, actor, metadata) {
  `
    ],

    /*
     * 5. memo-cardProfileConfig
     * - What it caches: Profile config object { rulesetVersion, definition } (or
     *   null) returned by cardProfileConfig(profile, cardState) (~1,172 calls on
     *   mid.jsonl, ~99.2% hit rate; ~15,863 calls across 15 corpus-1 positions).
     *   Avoids scanning 18 version branches, allocating the V19 catalog-hash
     *   arrays inside usesRoyalRecurrence, and creating a fresh closure per call.
     *   Skips V12 profiles because V12's definition closure captures cardState.
     * - Frozen objects checked:
     *   - Fast path (every call): profile (must be frozen; V12 skipped).
     *   - Mutable globals read: none.
     * - Call sites checked for mutation: Checked all 13 call sites in cw.js
     *   (lines 239450, 240597, 240598, 240635, 240894, 241428, 242241, 246580,
     *   246584, 249726, 255327, 261169, 265858). Every caller only reads
     *   .rulesetVersion or calls .definition(...); none mutate the returned
     *   object. Cached non-null return objects are also Object.freeze()d.
     * - Expected gain: ~19% standalone CPU reduction on corpus-1; together with
     *   the other 4 patches, ~26.5-28.4% total CPU reduction (~1.36x speedup).
     */
    [
      "memo-cardProfileConfig",
      "function cardProfileConfig(profile, cardState = null) {\n",
      `const __acbProf = new WeakMap();
    function cardProfileConfig(profile, cardState = null) {
      if (!profile || !Object.isFrozen(profile) || profile.engineVersion === CARD_AUTHORITY_ENGINE_V12_VERSION) return __acbProfOrig(profile, cardState);
      let r = __acbProf.get(profile);
      if (r === undefined) {
        r = __acbProfOrig(profile, cardState);
        if (r) r = Object.freeze(r);
        __acbProf.set(profile, r);
      } else if (globalThis.__acbSpeedShadow) {
        const o = __acbProfOrig(profile, cardState);
        const sh = globalThis.__acbSpeedShadow;
        sh.prof = (sh.prof || 0) + 1;
        if (Boolean(o) !== Boolean(r) || (o && (o.rulesetVersion !== r.rulesetVersion || typeof o.definition !== typeof r.definition || o.definition("armistice")?.description !== r.definition("armistice")?.description))) sh.profBad = (sh.profBad || 0) + 1;
      }
      return r;
    }
    function __acbProfOrig(profile, cardState = null) {
  `
    ]
  ];

  function applySpeedPatches(text, list = SPEED_PATCHES) {
    let out = text;
    const applied = [], skipped = [];
    for (const [name, find, replacement] of list) {
      const first = out.indexOf(find);
      if (first < 0 || out.indexOf(find, first + find.length) >= 0) { skipped.push(name); continue; }
      out = out.slice(0, first) + replacement + out.slice(first + find.length);
      applied.push(name);
    }
    return { code: out, applied, skipped };
  }

  const api = { SPEED_PATCHES, applySpeedPatches };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.__acbSpeedPatches = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
