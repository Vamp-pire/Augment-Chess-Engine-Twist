// Draft points from playouts, shared by the extension (inject.js) and the
// match tool (tools/draft-match.cjs) so both score drafts the same way.
//
// runs: { cardId: [value, value, ...] } - one value per completed playout
// (drafter's view, centipawns). Repeated playouts of one card use different
// node budgets that are the same for every card, so cards are compared
// under the same conditions.
//
// points = advantage over the offer's mean, shrunk by its uncertainty
// (confidence), / scale (centipawns per point; one star = 2 points), only
// if the shrunk advantage reaches `threshold`, clamped to +-maxPoints.
(function (root) {
  "use strict";
  const DEFAULTS = Object.freeze({ scale: 100, threshold: 75, maxPoints: 3, noiseCp: 150 });

  function draftPoints(runs, opts = {}) {
    const { scale, threshold, maxPoints, noiseCp } = { ...DEFAULTS, ...opts };
    const cards = Object.entries(runs).filter(([, v]) => Array.isArray(v) && v.length > 0);
    if (cards.length < 2) return { points: {}, detail: {} };
    const stat = cards.map(([id, v]) => {
      const n = v.length, mean = v.reduce((a, b) => a + b, 0) / n;
      // one playout: assume the typical spread; more: measured (not below a floor)
      const sd = n > 1 ? Math.max(40, Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))) : noiseCp;
      return { id, n, mean, se: sd / Math.sqrt(n) };
    });
    const offerMean = stat.reduce((a, s) => a + s.mean, 0) / stat.length;
    const points = {}, detail = {};
    for (const s of stat) {
      const adv = s.mean - offerMean;
      const weight = adv === 0 ? 0 : 1 / (1 + (s.se / Math.abs(adv)) ** 2); // confidence
      const shrunk = adv * weight;
      const p = Math.abs(shrunk) >= threshold ? Math.max(-maxPoints, Math.min(maxPoints, shrunk / scale)) : 0;
      if (p) points[s.id] = +p.toFixed(2);
      detail[s.id] = { n: s.n, mean: Math.round(s.mean), adv: Math.round(adv), se: Math.round(s.se), weight: +weight.toFixed(2), points: +p.toFixed(2) };
    }
    return { points, detail };
  }

  // Node budgets for repeated playouts (repeat r uses budget * NODE_STEPS[r]).
  const NODE_STEPS = Object.freeze([1, 0.7, 1.4, 0.85, 1.2, 0.6]);

  const api = { draftPoints, NODE_STEPS, DEFAULTS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.__acbDraftScore = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
