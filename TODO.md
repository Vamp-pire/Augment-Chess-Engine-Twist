# TODO

Last updated: 2026-09-19. Background and findings: `D:\HANDOFF-모음\증강체스엔진-HANDOFF.md` (section "2026-09-14~19").

## Now / next

- [ ] Check that depth actually helps: handcoded depth 2 vs depth 4, color-swapped, ~10 pairs. Decides whether speed work is worth it
- [ ] Speed up `evaluateStateComponents` (~11ms/call; `tacticalSafetyScore` is 57.8%, engine-merged.js:15286)
  - Needs go-ahead before touching; output must stay identical (diff old vs new on sampled positions)
  - Why it matters: self-play depth 5 was nominal, ~90% of moves finished only depth 1 in 200ms
  - Ideas: cache per-piece threat info, avoid the O(N^2) capture-threat scan; then `positionalScore` (12%), `cardThreatScore` (9%)
- [ ] Build a frozen external benchmark (`nnue/eval-benchmark-fixed.json`)
  - Positions labelled by objective material balance (`PIECE_VALUES`, engine-merged.js:3339), only large imbalances
  - Plus the 38 real-game ACG positions; commit once, never regenerate
- [ ] Decide default model in extension: Squall (default now) vs Tornado. Both selectable; no significant difference in deep matches

## Training ideas (from the ceiling analysis)

- [ ] Blend labels by position: early plies trust search score, late plies trust game outcome (cheap, uses existing data)
- [ ] Smaller model / stronger regularization to stop memorizing (Squall: ~90% on train, ~56-70% on val)
- [ ] Collect more games, not more positions (effective sample size = number of games, 960-2042)
- [ ] After the speed-up: re-collect self-play with real depth 3+ and use search score as the main target
- [ ] Warm-start ablation on the cloud: `ablateWarmStart: "0"` in `nnue/pipeline-config.json`, push, click Run workflow (local run is too heavy for this PC)

## Evaluation

- [ ] Round robin Typhoon/Tornado/Squall/handcoded with more games (5+ pairs each) once the benchmark exists
- [ ] Never trust a match with fewer than ~10 games (2-game result flipped at 10 games)

## Open questions

- [ ] Root cause of the "regression": moving validation split, label ceiling, game-count-limited samples, warm-start scale (see handoff)
- [ ] Self-play is idle since the round-2 cutoff (2026-09-18T05:30Z). Start round 3 only after the speed-up; then update `CUTOFF_ISO` and depth in selfplay.yml (do not forget the cutoff this time)

## Feedback / distribution

- [ ] Collect friends' feedback via KakaoTalk/Discord: NNUE toggle on vs off feel, odd moves, difficulty, draw/dragging games, card usage

## Cleanup

- [ ] Commit: `TODO.md`, `nnue/eval-round2-val.js`, `nnue/analyze-ceiling.js`; decide on untracked weight backups (`baseline-current`, `round1-candidate`, `round2-full-112981`)
- [ ] Prune 9/6-9/12 experiment weight files in `nnue/model/` if no longer needed
- [ ] Delete the earlier project-overview Artifact if not wanted (https://claude.ai/artifact/JdBrU2SBPTp5hr4AUc5nFe)
- [ ] Scratch copies in the session scratchpad (`engine-profile.js`, `profile-driver.js`) are not in the repo; recreate from the handoff if needed

## Model lineup

| Name | File | Notes |
|---|---|---|
| Typhoon | `weights.before-run-35324266296.json` (= `baseline-current`) | Round 1 baseline, 68.2% on its own val split |
| Tornado | `weights.round1-candidate.json` | Round 1 retrain, 63.4% own split / 72.0% on round-2 split, not deployed |
| Squall | `weights.round2-full-112981.json` (= deployed `weights.json`) | Round 2, 67.1% on round-2 split |

## Done (recent)

- [x] 2026-09-19: engine-merged.js synced to site 9/19 patch (generateActions identical on 600 random boards vs live worker); site-oracle bundle refreshed
- [x] 2026-09-19: extension now ships engine-merged.js + 184-card/40-plane NNUE encoder; Tornado/Squall selectable in the review box (Node-vs-extension score diff 0 on 300 positions)

- [x] Round-2 dataset assembled (112,981 positions) and cloud retrain merged (4d2a1c9)
- [x] Cloud encode cache reused locally (skip re-encode)
- [x] Deep matches (depth 6): no significant difference between the three models
- [x] Profiled `evaluateStateComponents` sub-functions
- [x] Ceiling analysis: overfitting, label noise, effective sample size, nominal depth 5
- [x] HANDOFF and TODO updated
