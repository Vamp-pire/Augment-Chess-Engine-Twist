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
