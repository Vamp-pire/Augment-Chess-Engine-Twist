# Parity triage, 2026-09-19 (site worker aiWorker.js sha256 368fedba03dd..., main-DYyN_QDn.js)

Method: `parity-actions` (400 boards) and `parity-apply` (300 single actions) show 0 differences. `parity-playout` (8 seeds x 60 games x 40 plies,
~2700 plies, every ply deep-compared: board, captures, turn, pending effects) stops at the first divergence per game: 224 divergences.
Line numbers below refer to `git show HEAD:engine-merged.js` as of the run (a copy is in `.cache/engine-head.js`); the working copy was being
edited by the perf agent, so re-locate by the quoted anchors. Nothing has been applied.

## Counts by cause (working-copy run, 224 divergences)

| # | cause | class | count |
|---|-------|-------|-------|
| 1 | promotionRush: engine marks `cardNoCaptureUntil`, site does not when `usesInternalSixFixes` (missing "six fixes" gate) | b | 61 |
| 2 | portalGun: pending portals block movement in engine, not in site (nonblocking reservations) | b | 51 (+9 of the 35 "after plain move") |
| 3 | "after plain move" action-list diffs: 9 = cause 2, 12 = cause 5, rest cause 4 | mixed | 35 |
| 4 | locustSwarm played as in-game card: worker has no effect, engine applies it | a (expected) | 27 |
| 5 | substitution swap does not `noteThiefMove` (thiefVisited/thiefLastDirection missing on swapped thief) | b (minor) | 25 |
| 6 | parrot memory: engine auto-creates `state.parrotMovement`, site only updates it when already present | b/needs confirm | 11 (+12 "after move", + 1 thiefQuietJump extra) |
| 7 | thief jump does not grant the second move (`keepsTurnByThief`/`thiefSecondMove` never ported) | b | 4 (+1 trickster-as-thief), incl. the turn-order mismatch |
| 8 | stale per-board caches (THREE_CACHE / PRINCESS_QUEEN_MOVEMENT_CACHE) after in-place card mutation | b (latent) | 3 substitution + 4 card:thief |
| 9 | unresolved: 3-4 cases of mass-capture event after a plain move (deck had clockwork/campfire/gale; random victims, RNG not aligned) | ? | 3 |
| - | brutus / freeze "which piece" differences seen in the earlier unseeded runs | a (random target) | 0 after seeding Math.random per ply |

Answers to the three earlier suspects:
- extra `substitutionSwap` moves: cause 8. Engine paladin radiance cache (`THREE_CACHE.hasPaladin/radiance`) was filled before `card:paladin` created a paladin in place, so cells around the new paladin were not blocked. With THREE_CACHE disabled the cases vanish.
- extra `thiefQuietJump` move: cause 6 (a parrot piece that remembered "thief" in the engine only).
- turn-order mismatch after a "plain move" (game 4): the move carried `thiefQuietJump:true`; site keeps the turn (thiefSecondMove), engine ends it: cause 7.

## Fix proposals (not applied)

### F1 portalGun pending portals must not block movement (cause 2)
Site: `main` `usesNonblockingPortalReservations` -> `blocksMovement` only on legacy portals; worker `isWorkerPortalMovementReservedSquare` checks `entry.blocksMovement === true`.
1. `normalizePendingPortals` (HEAD ~1988), inside the returned object after `id: String(entry?.id || ...),` add:
   `...entry?.blocksMovement === true ? { blocksMovement: true } : {},`
2. After `isWorkerPendingPortalReservedSquare` (HEAD 4995) add:
```js
function isWorkerPortalMovementReservedSquare(boardState, row, col) {
  return normalizePendingPortals(boardState.pendingPortals, boardRowCount(boardState), boardColCount(boardState)).some((entry) => entry.blocksMovement === true && entry.cells.some((cell) => cell.row === row && cell.col === col));
}
```
3. `generateMovesForPiece` (HEAD 5343): in `moves.filter((move) => !workerMoveLandingCellsForQuantum(move).some((cell) => isWorkerPendingPortalReservedSquare(boardState, cell.row, cell.col) || isWorkerPendingSpawnReservedSquare(...)))` replace `isWorkerPendingPortalReservedSquare` with `isWorkerPortalMovementReservedSquare`.
4. HEAD 9248 (`!legacySeptember12RulesStates.has(boardState) && (isWorkerPendingSpawnReservedSquare(...) || isWorkerPendingPortalReservedSquare(boardState, nextRow, nextCol))`): same replacement.
5. `resolveWorkerPendingPortalsForTurn` (HEAD 10660): old `selected.cells.some((cell) => get(boardState, cell.row, cell.col) || workerSeptember12PlacementCrownBlocked(...) || isWorkerCollapsedSquare(...))`
   new `selected.cells.some((cell) => selected.blocksMovement && get(boardState, cell.row, cell.col) || !inBounds(cell.row, cell.col, boardState) || isBlackHoleCell(boardState, cell.row, cell.col) || workerSeptember12PlacementCrownBlocked(boardState, cell.row, cell.col) || isWorkerCollapsedSquare(boardState, cell.row, cell.col))`.
Keep `isWorkerPendingPortalReservedSquare` for card placement (site does the same in `workerOpenPlacementSquare`).
(The engine also lacks `workerOpenRelocationSquare`; site uses it for the relocation card, not exercised here.)

### F2 thief second move (cause 7)
Whole feature is absent (`thiefSecondMove` has 0 hits in the engine, ~13 in worker). Port, using worker line refs (real-worker.js from `fetch-real-worker.js`):
1. `applyMove`, right after `const movedPieceType = piece.type;` (HEAD 12085), add (worker 11690):
```js
const internalThiefJump = pieceHasAbility(piece, "thief") && thiefJumpedPiece(from, usesThiefRemake(boardState) && portalEntry ? portalEntry : move, (row, col) => get(boardState, row, col));
delete piece.thiefSecondMove;
```
2. In `clearPieceExtraMoveFlags` add `delete piece.thiefSecondMove;`.
3. Before `const constrainedExtraMoveActive` (HEAD 12746) add (worker 12359-12361):
```js
if (internalThiefJump && captured.length === 0) resolveWorkerSubmergedPieces(boardState);
const keepsTurnByThief = internalThiefJump && captured.length === 0 && get(boardState, move.row, move.col) === piece && generateMovesForPiece(boardState, piece, move.row, move.col).some((candidate) => isWorkerMoveAllowed(boardState, piece, move.row, move.col, candidate));
if (keepsTurnByThief) piece.thiefSecondMove = true;
```
   and prepend `keepsTurnByThief ||` to both the `constrainedExtraMoveActive` expression and the `if ((keepsTurnByBackwardKnight || ...) && boardState.mode !== "gameover")` condition (retainWorkerTurn).
4. `applyFileSurgeSkipAction` (HEAD 11690): first line add `if (piece?.thiefSecondMove && usesThiefRemake(boardState)) return { ok: false, score: 0 };`, add `!piece.thiefSecondMove &&` to the eligibility test and `delete piece.thiefSecondMove;` (worker 11292-11294).
5. `generateActions` forced-extra-move filter (HEAD 4941): old `if (forcedExtraMove?.piece?.fileSurgeSecondMove || ...)` new `if (!(forcedExtraMove?.piece?.thiefSecondMove && usesThiefRemake(boardState)) && (forcedExtraMove?.piece?.thiefSecondMove || forcedExtraMove?.piece?.fileSurgeSecondMove || ...))` (worker 4597).
6. HEAD 5848 list: prepend `piece.thiefSecondMove ||` (worker 5526). HEAD 15282 heuristic: prepend `piece?.thiefSecondMove ||` (worker 14850).

### F3 noteThiefMove in swap paths (cause 5)
Worker calls `noteThiefMove` in `applyWorkerSubstitutionMoveAction` (11386) and the dragonSwap branch (11484); engine only calls it in the plain-move path (HEAD 12556).
- After `disassembleMovedQueen(boardState, piece, from, move, piece.type, internalWorkerCallbacks(boardState));` in `applyWorkerSubstitutionMoveAction` (HEAD 11756) and in the `if (move.dragonSwap)` branch of applyMove (HEAD 11999) add:
```js
noteThiefMove(piece, from, move, boardState);
if (usesThiefRemake(boardState)) noteThiefMove(target, move, from, boardState);   // `target2` in the dragonSwap branch; pass [portalEntry, portalExit] as 5th arg there
```
- Plain path HEAD 12556: `noteThiefMove(piece, from, move, boardState)` -> `noteThiefMove(piece, from, move, boardState, [portalEntry, portalExit])` (worker 12167).

### F4 "internal six fixes" gate missing (cause 1, plus latent)
Site default (`usesInternalSixFixes`: hash in catalog list, or `state.internalSixFixes !== false`) is ON; engine has no such function, so it behaves like the pre-fix rules.
1. After `usesThiefRequiredJump` (HEAD ~84) add `function usesInternalSixFixes(state) { return state?.internalSixFixes !== false; }` (also emit `internalSixFixes` in cloneState if desired).
2. promotionRush apply (HEAD 13992): old `markWorkerCardNoCaptureThisTurn(boardState, target);` new `if (!usesInternalSixFixes(boardState)) markWorkerCardNoCaptureThisTurn(boardState, target);`
3. Twin movement (HEAD 9758, 9777): `noteWorkerTwinMovement(restoredPiece);` -> `if (!usesInternalSixFixes(boardState)) noteWorkerTwinMovement(restoredPiece);`, same for `(bear)`.
4. `applyMove` after `noteWorkerUltimatumMovement(boardState, piece);` following `clearPieceExtraMoveFlags();` (HEAD ~12492) add `if (usesInternalSixFixes(boardState) && wasFileSurgeSecondMove && piece.twinBondId) piece.twinSwapPending = 1;` (worker 12100) and, before the chameleon block (HEAD 12500), `if (usesInternalSixFixes(boardState)) delete piece.promotionRushUntil;`.
5. Chameleon (HEAD 12500): replace victim selection by worker 12109:
   `const chameleonVictim = usesInternalSixFixes(boardState) ? captured.find((victim) => !isWorkerRoyalIdentityPiece(boardState, victim) && !["wall","colossus","bigRook","bigBishop"].includes(victim.type)) : target && captured.includes(target) ? target : null; const chameleonTransformed = Boolean(piece.chameleon && chameleonVictim && ...same guards...);` then use `chameleonTransformed`; and at HEAD 12720 use `if (!(usesInternalSixFixes(boardState) && chameleonTransformed) && checkerJumpedAttack && ...)` (worker 12333). Items 3-5 were not hit by these playouts but are the same gate; verify with targeted tests (twin, chameleon, checker).

### F5 parrot memory guard (cause 6, confirm first)
Site `rememberLocalMovement` (worker 2954, main bundle 4351) returns early when `state.parrotMovement` is absent. Engine HEAD 372-374:
old `if (!item || !["white","black"].includes(item.color)) return;` new `if (!state.parrotMovement || !item || !["white","black"].includes(item.color)) return;`
Also HEAD 11809-11815 (`boardState.parrotMovement ||= {...}` in applyMove) should only assign when `boardState.parrotMovement` already exists (worker 11413/11417 pattern). Confirm the extension's state extraction passes `parrotMovement` when a parrot is in play; otherwise this change would make parrots memoryless in the engine (site behaves that way for states without the field). Engine `cloneState` also drops `parrotMovement` (site copies it, worker 2920): add `parrotMovement` to the copied keys.

### F6 board-keyed caches are stale after in-place mutation (cause 8)
Comments at `THREE_CACHE` (HEAD 578), `PRINCESS_QUEEN_MOVEMENT_CACHE` (~991), `STANDARD_BEARER_RANK_CACHE` (~7402) assume a board is never mutated in place, but `applyAction` mutates in place (card:paladin converts a piece, card:thief converts the queen; `set()` only invalidates ALL_PIECES_LIST_CACHE). Symptoms: generateActions after applyAction on the same state returns wrong moves (paladin radiance missing, princess queen-movement missing). Search is safe only while every node is cloned before use and nothing queries the cache before the in-place change inside the same apply.
Minimal fix: define `function invalidateBoardCaches(boardState) { THREE_CACHE.delete(boardState.board); PRINCESS_QUEEN_MOVEMENT_CACHE.delete(boardState.board); ALL_PIECES_LIST_CACHE.delete(boardState); STANDARD_BEARER_RANK_CACHE.delete(boardState); }` and call it at the start and end of `applyAction` (HEAD 9388; wrap body in try/finally) and at the top of `generateActions`. Reproduce with `parity-playout.js - 60 5 40` (game 3) against the working copy vs `.cache/engine-nocache.js` (caches disabled).

## Expected / not bugs
- locustSwarm (27): OPENING card, worker only handles it in the opening path; engine applies it in-game and then allows grasshopper moves for unmoved pieces.
- brutus / freeze target selection, octopus/clockwork random effects: random target, not comparable unless RNG sequences match.

## Unresolved
3 playouts diverge after a plain white move where a mass capture event hits corner/back-rank pieces (decks: brutus/royalShield/freeze vs clockwork/gale/campfire). Not reproduced deterministically; likely RNG or a timed effect. Repro: `G=26 node` (scratch) seed 1 game 26; re-run `parity-playout.js - 60 1 40` and look for `state-differs after move` with `.board.5.6 ... submerged`.

## Status (2026-09-19, end of day)
Applied: F1 portalGun non-blocking, F2 thief second move, F4 six-fixes gate, F6 board-cache invalidation (invalidateBoardCaches around applyAction).
Applied later: F3 (noteThiefMove + disassembleMovedQueen in swap paths, 2026-09-19).
F5 (parrot memory guard) is NOT a bug: the site's real game state always starts with `parrotMovement: { white: null, black: null }` (main bundle), so real games record from the first move exactly like the engine. The divergence came from test states that lacked the field; `common.js` now adds it and the parrot divergences disappear. Do NOT add the guard: self-play states are built without the field and parrots would never move.
Original note: F5 (parrot memory guard — could change self-play behaviour; needs a decision).
Playout (seed 4242, 60x40): 27 divergences before -> 11 after; the rest are locustSwarm (expected), random-target brutus/freeze, parrot (F5).

## 2026-09-27 site update (cards-factory-v1; aiWorker sha256 5fb657416d6e..., main-BrJfQMgo.js)

The site added the "September 26 catalog" (SEPTEMBER26_CATALOG_HASH). `usesSeptember26Rebalance(state)` is true when the hash is
absent, so new games use the new rules; the engine now does the same by default (`state.september26Rebalance === false` = old rules).
Method: `diff -u real-worker.prev.js real-worker.js` (2389 lines, 131 hunks) read in full; counts below are engine vs site worker.
`REAL_WORKER_PATH=tools/site-parity/.cache/real-worker.prev.js` runs the same scripts against the previous worker (baseline);
`SEED_RANDOM=1 parity-playout.js` makes playouts deterministic (Math.random re-seeded per side and ply).

Ported (all in `engine-merged.js`, copied to `extension/engine.js`): minor-piece reclassification (knight, bishop, camel + clockwork, parrot, wizard,
recruiter, trickster: extinction/grasshopper/campfire/reversal/scarecrow targets, clockwork+parrot cards, `clearFormerMinorAbilityState`), randomRoulette/
majesty/blueJeans major list, witchTrial 2 (card + suspiciousPotion), checker card (four checkers on files a, b, g, h of the third rank), socialism
(scarecrow/babyBear move like pawns, slime-locked stays locked, paladin/campfire/recruiter/guard/idol capture like pawns), pawnLeap over any enemy
piece, resolve credit rest turn, checkerKing values (3 -> 2 table, 300 -> 200 AI value), thief card marks the queen `wanted` and arrests use
`resolveWantedArrests` (tickThiefArrests skips thieves), lastStand and elephantEscape (no effect in the old worker, implemented now).
Also fixed because they were old, trivial and unambiguous: overtake ends with the turn, vanguard diagonal-only + unique-front-pawn, trickster ability list
order, encyclopedia values (paladin 4, octopus 5, brutus 10, clockwork 5, parrot 5, thief 9, missionary 2), locustSwarm not for slime-locked pieces.
Not ported (no such card/piece/mode in the engine): d4, e4, solidarity, bishop-infiltration, synchronization, assembly, vigilance, roller, greek gift, wanted card,
brainwash, taboo, grappler, revolving door, don quixote, medium, potionEffects bookkeeping, campaign conveyorFactory, catalogHash gating,
`nonCapture` flags on sacrifice-like removals (only feed medium/vigilance).

Counts (old = HEAD engine vs previous worker; before = HEAD engine vs new worker; after = final engine vs new worker):

| test | old | before | after |
|---|---|---|---|
| parity-actions 400 (differing boards) | 12 (recurrence 13, traitor 2, sacrifice 2, randomRoulette 4) | 16 (new: checker 4, extinction 1; randomRoulette now 3) | 5 (recurrence 13 only) |
| parity-apply 300 (differing actions) | 6 (zugzwang, blackMagic 3, randomRoulette 2) | 13 (+move 4, lastStand, elephantEscape, falseStart) | 7 (zugzwang 1, blackMagic 3, randomRoulette 2, falseStart 1) |
| parity-apply 800, seed 4711 | 28 | 32 | 20 (randomRoulette 8, zugzwang 4, falseStart 4, blackMagic 3, brutus-betrayal move 1) |
| parity-playout 100x40 seed 4242, SEED_RANDOM | 29 | 41 | 17 |
| parity-playout 100x40 seed 777, SEED_RANDOM | 33 | 47 | 36 |

Remaining playout divergences are the known old classes: recurrence target, blackMagic exposure at start, symmetry, randomRoulette outcome, missionary,
falseStart, zugzwang (engine allows the card more often), collapse/king timing, locustSwarm as an in-game card, and the brutus-betrayal restriction filter.
"after" is not strictly comparable to "old": a playout stops at its first divergence, so fixing an early class exposes later ones.

golden-eval: 80 of 800 hashes changed on purpose. Cause (checked by forcing `minorPieceTypesForCatalog` back to knight/bishop/camel: 0 of 800 differ):
cardsSelf/cardsEnemy count more legal reversal/campfire/clockwork card targets when the board has clockwork/parrot/wizard/recruiter/trickster pieces.
`tools/perf/eq-exotic.js` (4000 exotic states) shows 330 diffs and 0 with the reclassification off; `tools/perf/eval-equiv.js` (selfplay positions) shows 12 diffs,
all in positions whose hand holds the checker card (new checker rules). `tools/perf/engine-orig.js` (git-ignored local reference) was refreshed to the new engine so
those two checks are green again; it is not a rule reference.
Fast worker: only `move-allowed-memo` needed a re-anchor (the site added `grapplerBindingAllowsMove`, a read-only per-move predicate, as the first check of
`isWorkerMoveAllowed`); the other six anchors matched and their reasoning was re-checked against the changed callees. `diff-fast-worker.js 80 4242 120`: 0 divergences.
