# site-parity: differential tests against the site's real AI worker

```
node fetch-real-worker.js [--force]          # download live aiWorker.js -> .cache/real-worker.js (exports generateActions/applyAction/...)
node parity-actions.js  [engine|-] [N=400] [seed=12345]          # generateActions parity on random sparse boards (want: differing=0)
node parity-apply.js    [engine|-] [N=300] [seed=777]            # same random action applied in both, resulting state compared
node parity-playout.js  [engine|-] [GAMES=30] [seed=4242] [PLIES=40]   # multi-ply playouts, stops at first divergence per game
node update-site.js [--force-network] [--save]  # ONE command for a site update: detect -> fetch -> fast-worker patch + diff -> parity vs new AND previous worker -> report (see below)
node check-site-update.js [--save]           # CHANGED/UNCHANGED vs last-seen.json (bundle name + worker SHA-256); exit 0, or 2 on network error
node make-fast-worker.js [--skip=a,b|--only=a,b]   # .cache/real-worker.js + anchored perf patches -> .cache/real-worker-fast.js (fails if an anchor isn't matched exactly once)
node diff-fast-worker.js [GAMES=300] [seed=1] [PLIES=120]   # fast vs original worker: byte-identical actions/states/results required (want: TOTAL divergences=0)
node gen-reference-fixtures.js --out=<dir> [--seed=..] [--worker=orig|fast]   # reference fixtures from the site worker (oracle-v1 superset, deterministic); --verify=<dir> replays them, --serve = run-differential.js candidate
```

`real-worker-fast.js` is the site's own rules code with behaviour-preserving speedups (~3.7x plies/s on random playouts), for use as
a self-play rules layer. After every `fetch-real-worker.js --force`, rebuild it and re-run `diff-fast-worker.js`; if a patch anchor no
longer matches, re-anchor it only after re-checking that the reasoning in its comment still holds for the new site code.

`engine` defaults to `../../engine-merged.js` (`-` = default). Actions are matched between engines by normalized content
(random ids stripped), never by list index. Run `fetch-real-worker.js --force` first whenever `check-site-update.js` says CHANGED.

Automation: `.github/workflows/site-watch.yml` runs daily (and on demand). It runs `check-site-update.js`; on CHANGED it runs
`fetch-real-worker.js --force` and the three parity scripts (200/150/15), writing a report to the step summary and a 30-day artifact
`site-watch-report`. Read-only: it never commits, opens issues, or updates `last-seen.json` (do `check-site-update.js --save` yourself after
reviewing). Network errors only produce a warning.

Env switches: `REAL_WORKER_PATH=<file>` (all parity scripts) runs against another worker copy, e.g. `.cache/real-worker.prev.js` (the version before the last
`fetch-real-worker.js --force`) to get a baseline of old counts; `SEED_RANDOM=1` (parity-playout) re-seeds Math.random identically before each side applies an action.

Caveats when reading multi-ply diffs:
- The site's worker does NOT model some cards. Example: `locustSwarm` is an OPENING card; the worker only honours it via its
  opening-setup path, so playing it as an in-game card has no effect there, while our engine applies it. Diffs after such cards are expected.
- Card effects that pick random targets (brutus rook, freeze, ...) are not RNG-aligned between the two code bases; `Math.random` is
  not seeded by these scripts. Treat isolated one-piece differences after such cards as noise.
- The worker only tracks parrot memory (`state.parrotMovement`) if the state already carries it; see TRIAGE.md.
- Test against a clean copy when the engine is mid-edit: `git show HEAD:engine-merged.js > .cache/engine-head.js`.

See TRIAGE.md for the 2026-09-19 classification of every divergence found.

## 사이트 업데이트 때 하는 일 (`update-site.js`)

```
node tools/site-parity/update-site.js                 # 평소: 6시간 안이면 네트워크 없이 캐시로, 아니면 메인 페이지 1회만 확인
node tools/site-parity/update-site.js --force-network # 6시간 잠금과 "번들 같음" 지름길 무시(직접 눌렀을 때만)
node tools/site-parity/update-site.js --save          # 결과가 정상이면 last-seen.json 갱신(새로 받은 값이 있을 때만)
```

1. **감지와 다운로드**: 메인 페이지만 받아 번들 이름이 `last-seen.json`과 다를 때만 aiWorker.js와 번들을 받습니다(총 3요청). 이전 워커는 `.cache/real-worker.prev.js`로 보관됩니다.
2. **속도 패치 검증**: `make-fast-worker.js` + `diff-fast-worker.js 80 4242 120`(차이 0이어야 함).
3. **대조**: `parity-actions 400/12345`, `parity-apply 300/777`, `parity-playout 100/4242/40`(`SEED_RANDOM=1`)을 새 워커와 이전 워커에 각각 돌려(동시 2개) 카드별 "새/이전" 개수와, `known-mismatches.json`(알려진 불일치 목록, 데이터 파일)에 없거나 늘어난 것을 보여 줍니다. 약 2분 30초.

종료 코드: 0 정상(기록만), 1 패치 레이어 실패(어느 앵커인지 출력), 2 새 불일치, 3 네트워크/실행 오류. `engine-merged.js`는 건드리지 않고, `--save` 없이는 `last-seen.json`도 바꾸지 않으며, git/GitHub/다른 저장소에도 손대지 않습니다.

사람이 나서야 할 때: 패치 앵커가 안 맞을 때, 또는 새 불일치가 `humanThreshold`(기본 3, `known-mismatches.json`에서 조정)개 이상일 때. 엔진 이식은 모아서 나중에 해도 됩니다.
옛 규칙으로 만든 자가대국 데이터는 새 규칙으로 작게 돌린 데이터로 보충하면 됩니다. 이식한 불일치나 받아들인 불일치는 `known-mismatches.json`에 추가하세요.

**사이트를 괴롭히지 않는 장치**(전부 `net-guard.js`): 실행당 요청 상한 5회(초과 시 예외, `check-site-update.js`/`fetch-real-worker.js`도 같은 도우미 사용), 재시도와 반복 없음(오류가 나면 멈추고 보고, 리다이렉트는 최대 1번만 따라감), 식별 가능한 User-Agent(`TwistParityCheck (personal research; contact via GitHub Vamp-pire)`), 60초 타임아웃, `.cache/network-lock.json`에 마지막 요청 시각을 기록해 6시간 안에는 `update-site.js`가 요청을 보내지 않음(요청이 실패했어도 기록됨; 잠금 파일이 없으면 `last-seen.json`의 `checkedAt`과 `aiWorker.raw.js` 수정 시각 중 늦은 쪽을 사용). 자기 자신을 실행하는 장치나 워크플로 호출은 없습니다. 시험: `node tools/site-parity/update-site.test.js`(가짜 fetch, 네트워크 없음).
빠른 확인은 번들 이름만 보므로, 번들은 그대로인데 `aiWorker.js`만 바뀐 경우는 놓칩니다(매일 도는 `site-watch.yml`이 전체 비교를 하고, 로컬에선 `--force-network`).
