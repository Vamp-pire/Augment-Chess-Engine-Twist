# TODO

Last updated: 2026-09-19. Background and findings: `D:\HANDOFF-모음\증강체스엔진-HANDOFF.md` (section "2026-09-14~19").

## Now / next

- [ ] **Round 3 self-play is RUNNING**: depth 6, 1500ms/move, 4 parallel shards, started 2026-09-19T03:54Z. **Target ~150k positions** (count lines in `segments/` on branch gha-segments-16cards; ~5k/h per job at the old 200ms setting, expect far less per job now). Stop early once enough (cancel the runs and set `CUTOFF_ISO` in selfplay.yml to now, otherwise the 6-hourly cron keeps going). Backstop cutoff **2026-09-22T04:00:00Z**
- [ ] Real-play check of blend-0.8 model (weights.blend0.8-round2.json, 70.6% on round-2 val) vs Squall: `logs/match-b08-vs-squall-*.log`. Accuracy != strength
- [ ] Blend fine-tuning around 0.8 (0.7/0.9/0.8+units8/0.8 repeat for noise) via `nnue-train-only.yml` with `overrides` + `merge=false`
- [ ] Depth 2 vs 4 (handcoded): `logs/depth-2v4-part*.log` (slow, ~10 min/game)
- [ ] Verify the extension in Chrome (reload unpacked): model dropdown, review, live-bot NNUE inside the worker
- [ ] Decide whether PIECE_VALUES change (paladin/octopus/brutus/clockwork/parrot/thief, missionary 200) needs a re-encode: retrain from round-3 data will use the new engine features anyway
- [ ] Remaining engine parity: F3 (noteThiefMove in swap paths) and F5 (parrot memory guard; may change self-play behaviour) -- see tools/site-parity/TRIAGE.md
- [ ] Extension UX/UI: show active model / evaluator in the perf panel, model loading/failure state
- [ ] Build a frozen external benchmark (`nnue/eval-benchmark-fixed.json`) and round-robin models once it exists

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

- [x] 2026-09-19: evaluateStateComponents ~3.4x faster, search ~1.5x, output identical (tools/perf harness); cache-staleness bug found+fixed
- [x] 2026-09-19: tools/site-parity (parity vs live site worker, site-update checker); engine fixes: portalGun, thief second move, six-fixes gate, board-cache invalidation
- [x] 2026-09-19: warm-start ablation: 67.2% vs Squall 67.1% -> no effect
- [x] 2026-09-19: label blend sweep on round-2 cache (val acc): 0.3=69.1, 0.5=69.2, 0.8=70.6, 1.0=67.8 (baseline 0.15=67.1); units 8=68.7, units 4=67.4

- [x] 2026-09-19: engine-merged.js synced to site 9/19 patch (generateActions identical on 600 random boards vs live worker); site-oracle bundle refreshed
- [x] 2026-09-19: extension now ships engine-merged.js + 184-card/40-plane NNUE encoder; Tornado/Squall selectable in the review box (Node-vs-extension score diff 0 on 300 positions)

- [x] Round-2 dataset assembled (112,981 positions) and cloud retrain merged (4d2a1c9)
- [x] Cloud encode cache reused locally (skip re-encode)
- [x] Deep matches (depth 6): no significant difference between the three models
- [x] Profiled `evaluateStateComponents` sub-functions
- [x] Ceiling analysis: overfitting, label noise, effective sample size, nominal depth 5
- [x] HANDOFF and TODO updated
