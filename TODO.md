# TODO

Last updated: 2026-09-19. Project map: `PROJECT.md`. Background: `HANDOFF.md`, `D:\HANDOFF-모음\증강체스엔진-HANDOFF.md`.

## Now / next

- [ ] **Round 3 self-play is RUNNING** (8 parallel shards, depth 6, 1500ms/move, started 2026-09-19T03:54Z)
  - Settings are repository variables (`gh variable set NAME --body VALUE`): `SELFPLAY_SHARDS`, `SELFPLAY_DEPTH`, `SELFPLAY_MS`, `SELFPLAY_CUTOFF_ISO`, `SELFPLAY_ROUND_START`, `SELFPLAY_TARGET`
  - It **stops itself at 150,000 positions** (`SELFPLAY_TARGET`; checked every 15 min by the runs that started after the guard was added: 2026-09-19 ~04:40Z). Backstop cutoff **2026-09-22T04:00:00Z**. Stop manually: `gh variable set SELFPLAY_CUTOFF_ISO --body 2000-01-01T00:00:00Z`
  - Early rate (4 shards) was ~1.4k positions/h, so 8 shards ~3k/h -> 150k in ~2 days
  - When done: `dataset-build.yml` (since `20260919T035300Z`, push=false first to check the count, then push=true) -> `nnue-train.yml` on the new dataset (encodes with the current engine automatically)
- [ ] Verify the extension in Chrome (reload the unpacked extension): model dropdown + load status, review, live-bot NNUE inside the worker, perf panel evaluator label
- [ ] Depth 2 vs 4 (handcoded) running in the cloud (`match.yml`, run 35421988904): decides whether more speed work is worth it
- [ ] After round 3: train with blend ~0.5-0.8 on the new dataset, then `match.yml` against Squall (10+ pairs per shard); only ship a model that wins in play, not just on val accuracy
- [ ] Remaining engine parity: F5 parrot memory guard (may change self-play behaviour; needs a decision) -- `tools/site-parity/TRIAGE.md`
- [ ] Build a frozen external benchmark (`nnue/eval-benchmark-fixed.json`) and round-robin models once it exists

## Findings (2026-09-19)

| Experiment (round-2 val, 3,159 decisive positions, noise ~ +-1 pt) | Val accuracy |
|---|---|
| Squall baseline (blend 0.15) | 67.1% |
| no warm start | 67.2% |
| blend 0.3 / 0.5 / 0.7 / 0.8 / 0.9 / 1.0 | 69.1 / 69.2 / 71.1 / 70.6, 69.5, 70.8 (3 runs) / 69.8 / 67.8 |
| deep units 4 / 8 / 8 + blend 0.5 / 8 + blend 0.8 | 67.4 / 68.7 / 68.9 / 69.5 |
| blend 0.8 re-encoded with the NEW engine features | 70.6% (same as old features -> the 9/19 rule changes do not force a retrain) |

- More search-score weight helps val accuracy (+2-4 pts), but **in play blend-0.8 did not beat Squall** (local match, 42 games: 5 wins / 9 losses / 27 draws / 1 unfinished; 5 of 14 decisive = 36%, within noise but not better) -> accuracy != strength
- Cloud matches (`match.yml`, depth 3, 300ms; A vs B, decisive games only; all within noise, |z| < 1):
  - Tornado vs Squall: 13 - 17 (30 draws) | Typhoon vs Squall: 20 - 15 (23 draws) | handcoded eval vs Squall: 19 - 15 (29 draws)
  - handcoded depth 2 vs depth 4 (1500ms): 6 - 8 (16 draws) -> no measurable gain from depth 4 at this budget
  - So no NNUE model is measurably stronger than the hand-coded evaluator yet; the evaluator is not the bottleneck at these budgets (search speed / label quality are the open questions)
- Draws dominate model-vs-model matches; judge by decisive games and never trust fewer than ~10 of them
- The engine evaluation is ~3.4x and search ~1.5x faster with identical output (`tools/perf`)

## Training ideas

- [ ] Blend labels by position: early plies trust search score, late plies trust game outcome (needs a train.js change; the global blend knob already exists)
- [ ] Smaller model / stronger regularization (deep units 8 helped slightly)
- [ ] Collect more games, not more positions (effective sample size = number of games)

## Evaluation

- [ ] Round robin Typhoon/Tornado/Squall/handcoded with more games once the benchmark exists (use `match.yml`)
- [ ] Never trust a match with fewer than ~10 decisive games

## Open questions

- [ ] Root cause of the round-1 "regression": moving validation split, label ceiling, game-count-limited samples (see handoff)
- [ ] Why does higher val accuracy not translate into play strength? (label noise, draws, evaluation vs search interaction)

## Feedback / distribution

- [ ] Collect friends' feedback (KakaoTalk/Discord): NNUE toggle on vs off feel, odd moves, difficulty, draw/dragging games, card usage

## Cleanup

- [ ] `data/` (git-ignored, ~1.9 GB of archived local self-play data), `nnue/snapshots/` (9.4 GB) and `nnue/cache/` (6.1 GB) are regenerable/archival: delete when disk space matters
- [ ] Prune 9/6-9/12 experiment weight files in `nnue/model/` if no longer needed
- [ ] Delete the earlier project-overview Artifact if not wanted (https://claude.ai/artifact/JdBrU2SBPTp5hr4AUc5nFe)

## Model lineup

| Name | File | Notes |
|---|---|---|
| Typhoon | `weights.baseline-current.json` | Round 1 baseline |
| Tornado | `weights.round1-candidate.json` | selectable in the extension |
| Squall | `weights.round2-full-112981.json` (= `weights.json`) | extension default |
| Blend0.8 | `weights.blend0.8-round2.json` (local only, not tracked) | experiment; not better in play |

## Done (recent)

- [x] 2026-09-19: workflows reorganized: `ci.yml`, `selfplay.yml` (variables, self-stop, concurrency), `nnue-train.yml` (replaces encode/pipeline/train-only), `match.yml`, `dataset-build.yml` (reproduced the round-2 dataset exactly: 112,981 positions)
- [x] 2026-09-19: CI: syntax, manifest, smoke, golden evaluation (`tools/ci/golden-eval.js`), extension NNUE == training NNUE (`tools/ci/nnue-parity.js`), site parity
- [x] 2026-09-19: engine synced to the site 9/19 patch and parity-fixed (portalGun, thief second move + swap paths, six-fixes gate, cache invalidation); site-worker move lists identical on 600 random boards
- [x] 2026-09-19: evaluation/search speed-ups, extension engine + 184-card/40-plane NNUE encoder, model picker with load status, evaluator label in the perf panel
- [x] 2026-09-19: folder reorganized (`legacy/`, `data/`, `PROJECT.md`), gh CLI installed and logged in
- [x] Round-2 dataset (112,981 positions), deep matches (no significant difference between the three models), ceiling analysis
