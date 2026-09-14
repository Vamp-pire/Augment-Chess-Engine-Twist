# Graft progress log — engine-merged.js

One entry per function from `audit-data/our_only_functions.txt` (45 total).
Real ground truth = `site-oracle/aiWorker-raw.js`, fetched live from
`https://augmentchess.org/assets/aiWorker.js` and never modified.

## GRAFTED

- **rootCandidateHangsFreeMaterial** — new branch in `rootCandidateHardSafetyIssue`'s
  issue chain ("hangs-material"), between decisive-reply and early-king-advance.
- **singleCardThreatValue** — factored out of `cardThreatScore`'s existing
  per-card scoring (left untouched) so other grafted callers can reuse it.
- **workerBestEnemyCardThreat** — new helper, used by rootCandidateIgnoresEnemyCardThreat.
- **rootCandidateIgnoresEnemyCardThreat** — new branch in `rootCandidateSoftSafetyIssue`'s
  issue chain ("ignored-card-threat").
- **rootCardComboFollowupBonus** — new helper feeding isRootCardUseBeneficial.
- **namedCardComboBonus** (+ `CARD_COMBO_DETECTORS`) — new helper feeding
  isRootCardUseBeneficial; `isRootCardUseBeneficial` extended with 3 optional
  params (card, afterState, action) and a bounded contextual discount; its
  one call site (inside searchAtDepth) updated to pass them.
- **nullMoveOk, isCaptureAction, isTacticallyRelevantCardAction, quiescence,
  recordKillerMove, reorderWithKillers, positionKey** — search-layer helpers,
  added standalone, wired in when minimax/searchBestAction were replaced
  wholesale (see below).
- **allPiecesList, forEachPieceCached** — shared piece-list cache; `set()`
  now invalidates it on every square mutation. Wired into `piecesMatching`
  (the ~156-call-site chokepoint) plus 4 direct call sites
  (moveWorkerRuleMonsters, clearWorkerIdolEncoreRepeatBlocks,
  markWorkerIdolEncoreRepeatBlock, tickWorkerPoisonStunnedPieces).
- **hasAdjacentEnemyPiece** — **real bug fix, not a behavior change**:
  aiWorker-raw.js itself calls this (from the "submerge" card) but never
  defines it anywhere — a genuine ReferenceError in the live site's own
  engine. No wiring needed, both real call sites already reference it.
- **kingZoneThreatApprox** — wired into `kingSafetyScore`/`royalPressureScore`,
  replacing their 8-per-critical-piece exact isSquareAttacked neighbor scans
  with an O(pieces) distance-based approximation (deliberate search-speed
  tradeoff; the one exact "is the king in check" call is untouched).
- **standardBearerRanksByColor** — pure perf cache, wired into
  `hasSameRankStandardBearer` and `hasWorkerCaptureReadySameRankStandardBearer`.
- **tickWorkerBribedPieces** (+ the "bribe" card's targeting/apply branches) —
  "bribe" is genuinely absent from aiWorker-raw.js entirely. Grafted the
  targeting branch (generateWorkerCardTargetsV2), the apply branch
  (applyCardActionUnchecked, after "outpost"), and the tick function wired
  into finishWorkerMove.
- **resolveWorkerOneShotCollapse** (+ "collapse" card plumbing) — "collapse"
  (one-shot, distinct from the existing RULE card periodicCollapse) is
  genuinely absent. Grafted the eligibility branch
  (workerCanResolveUntargetedCard), the apply branch (reuses real's own
  workerCollapseOneRing), and the tick function wired into finishWorkerMove.
- **applyWorkerWinterFreezeCycle** — **real bug fix, not a behavior change**:
  aiWorker-raw.js's own normalizeWinterKingdom already tracks
  lastCycle/frozenIds, but nothing in the real file ever writes to them —
  the "winterKingdom" RULE card's periodic freeze mechanic was entirely
  inert. Wired unconditionally into finishWorkerMove.
- **evaluateStateComponents** — behavior-preserving refactor of
  `evaluateState`'s weighted-sum formula into named sub-scores. Every
  sub-score computation and weight confirmed line-by-line identical to
  aiWorker-raw.js's own evaluateState before the change.

Plus, as the final step: **minimax** and **searchBestAction**/**searchAtDepth**
(not in the 45-list themselves, since they already existed in both files —
but they are what wires nullMoveOk/quiescence/recordKillerMove/
reorderWithKillers/positionKey/isCaptureAction/isTacticallyRelevantCardAction
together) were replaced wholesale with the enhanced versions: transposition
table, null-move pruning, LMR, killer-move heuristic, path-based repetition
detection, quiescence at the horizon (minimax); options bag
(flexibleBudget/evalFn/skipOpeningBook), killers/tt-carrying context, and a
degenerate-fallback path for sparse positions (searchBestAction/searchAtDepth).
Every real-file line in all three was diffed line-by-line first — nothing
real-only was found in any of them.

## NOT-NEEDED (real file already equivalent — ground truth trusted)

- **applyWorkerBigBishopOpening** — real already has a dedicated
  `septemberBigBishopOpening(color, minorType)` helper, called from
  `applyWorkerBigRookOpening`'s own `bigBishop` branch. Anchor/placements
  confirmed byte-identical to what we'd hardcoded.
- **bigBishopMoves, workerBigBishopAttacksSquare** — real treats "bigBishop"
  as a bigRook-like 2x2 piece everywhere (movement via `bigRookMoves`,
  socialism/basicTraining/witchTrial exclusion lists, HP, capture limits),
  NOT with diagonal bishop-style movement as our reimplementation assumed.
  Trusted as ground truth over our version.
- **campfireMoves, princessMoves** — `generateMovesForPiece` already has
  inline campfire/princess branches (`wizardPieceMoves(...).filter(...)`
  and `septemberPrincessHasQueenMovement(...)`), the latter additionally
  correctly excluding regencyHeir queens from the "no queen present" count
  — a nuance our version lacked.
- **hasInsightPieceEffect, hasTruthyPieceKey** — their only real call site
  would have been inside `workerHasInsightTarget`, which is itself
  NOT-NEEDED (see below): real's "insight" eligibility is unconditionally
  `true`. Grafting these two with no reachable caller would just be dead
  code, so left out.
- **isWorkerCampfireProtected** — `canWorkerCaptureTarget`'s
  `isWorkerEncouragedTarget` already folds in
  `septemberBoardCampfireProtects`.
- **workerCardinalStopMove** — real's `workerCardinalTerminalMove` already
  tracks the terminal landing square inline via its own `terminalMove`
  variable, with portal-rule support ours lacks entirely.
- **pieceHasCounterAbility** — all 5 call sites in engine.optimized.js
  already have the exact equivalent inline in real
  (`Boolean(septemberCounterLimit(pieceAbilityType(item)))`).
- **isWorkerDefeatRoyalPiece, isWorkerNarrowRoyalIdentityPiece,
  isWorkerRoyalLikePiece** — every call site in engine.optimized.js already
  has a real equivalent using `isCritical`/`isWorkerRoyalIdentityPiece`,
  which intentionally include vip/merchant/timeTraveler/vampireLord as
  decisive/royal-like. Our narrower helpers were based on evidence from a
  *different* file (the core rules bundle, site-engine.mjs), not this
  aiWorker.js search file — grafting them here would be a regression, not a
  fix. Explicitly re-verified for the regencyHeir scenario (see final report)
  — real's `workerCriticalCaptureScore` already has the
  `captured.regencyHeir && kingDead && regency` branch, so this was never
  actually broken in aiWorker.js.
- **isWorkerPiecePendingPanic** — real's `workerIsPanicTargetCandidate`
  doesn't gate on pending-panic state either; consistent real behavior.
- **isWorkerSocialismSuppressingRoyalCommand** — already present as
  `workerSocialismSuppressesRoyalCommand` (plus a
  `legacySeptember12RulesStates` guard ours lacks).
- **heraldVictoryPiecesByColor** — real's `workerHeraldHasVictory` already
  uses `piecesMatching`, which (after the forEachPieceCached graft) is
  already cached — the perf problem this was meant to solve is already
  addressed.
- **resolveWorkerInfiltrationSubmerge** — real's
  `septemberBeginBoardAction`/`septemberResolveBoardInfiltration`, already
  wired around move application, fully implements infiltration-to-submerge
  (and outpostProtected-clearing-on-move) via a different but complete
  mechanism.
- **tickWorkerOutpostGuardedPieces** — real's "outpost" already sets a
  permanent `outpostProtected` flag, cleared on move via
  `septemberResolveBoardInfiltration` — a different but complete mechanic
  vs. our 1-turn countdown.
- **tickWorkerWitchTrialPieces** — real's `resolveWorkerWitchTrials`,
  already wired into finishWorkerMove, is more complete (reaper death
  chain, decisive-capture handling, democracy-defeat resolution).
- **resolveWorkerPendingRecurrence** — real's
  `resolveWorkerRecurrences`/`septemberResolveBoardRecurrences`, wired into
  both `resolveWorkerSubmergedPieces` and `finishWorkerMove` already, is a
  more complete respawn-on-capture implementation (handles 2x2 large
  pieces, removes from captures list) using a richer `pendingRecurrences`
  structure.
- **workerHasInsightTarget** — real's "insight" eligibility is
  unconditionally `true`, with a safe no-op apply path via the
  already-present `applyWorkerInsight` — by design, not a gap.
- **workerIsForemostFilePawn** — **initially grafted, then reverted**: real
  already has the exact same check under `isWorkerVanguardPawn`/
  `septemberVanguardPawn`, and the entire "vanguard" card (catalog entry,
  generic SEPTEMBER_PASSIVE_EFFECTS targeting/apply, and the pawnMoves
  grant) already exists in aiWorker-raw.js. This was caught before
  committing — see the session notes for how (a fuller grep of the real
  file surfaced the different naming convention).
- **workerPiecePower** — its two call sites already have adequate/different
  real implementations: `workerTrolleyPieceRef` uses plain
  `pieceCombatValue`, and `merchantCost` is already a differently-structured
  real function delegating to `merchantPurchasePrice`.

## Notable discovery

Several of the 45 functions turned out to be solving problems the *live*
aiWorker.js had already independently solved (often more completely) by the
time it was re-fetched for this project — presumably because our
engine.optimized.js was extracted from an older snapshot before the site's
own engine picked up a generic card-catalog/passive-effect system
(SEPTEMBER_CARD_DEFINITIONS / SEPTEMBER_PASSIVE_EFFECTS, absent from
engine.optimized.js entirely) and several individual fixes. Only "bribe" and
"collapse" turned out to be genuinely new cards missing from the real file
entirely; everything else in the "royal identity" / "royal-like" family was
a case of trusting real's already-correct (and differently structured)
handling over our own narrower reimplementation.
