# 증강체스 엔진 — 프로젝트 지도

작업을 시작할 때 이 파일을 먼저 읽으세요. 상태와 할 일은 `TODO.md`, 지난 경과는 `HANDOFF.md`입니다.

## 한 줄 요약
augmentchess.org(증강체스: 카드와 특수 기물이 있는 체스)의 AI를 그대로 흉내 내는 엔진(`engine-merged.js`)과,
그 위에서 자기대국으로 데이터를 모아 학습하는 NNUE 평가 모델, 그리고 이를 쓰는 크롬 확장(`extension/`)입니다.

## 폴더 구조

| 경로 | 내용 |
|---|---|
| `engine-merged.js` | **엔진 본체**(사이트 규칙 + 자체 개선). 학습·자기대국·확장이 모두 이걸 씁니다 |
| `extension/` | 크롬 확장. `engine.js`는 `engine-merged.js`의 사본(아래 "확장 동기화") |
| `extension/model/` | 확장에 실리는 모델 `nnue-squall.json`(기본), `nnue-tornado.json` |
| `nnue/` | 학습 코드: `encode.js`(입력 인코더), `train.js`, `forward.js`, `match-two-models.js`, `match-depth.js`, 분석 스크립트 |
| `nnue/model/` | 가중치. **저장소에는 라인업 4개만** 추적하고 실험 모델·백업은 로컬에만 둡니다(`.gitignore`). 클라우드 대전(`match.yml`)에 실험 모델을 쓰려면 `git add -f`로 잠깐 올려야 합니다. `pipeline-config.json`은 클라우드 학습 기본 설정 |
| `selfplay-run-merged.js`, `selfplay-worker-merged.js` | 자기대국 실행기/워커 (클라우드 워크플로가 이걸 실행) |
| `selfplay-data.jsonl` | 로컬 작업용 현재 데이터(하나만 루트에 둠, `train.js` 기본 경로) |
| `smoke-merged.js` | 엔진 스모크 테스트 |
| `tools/ci/` | CI 검사: `golden-eval.js`(평가값 회귀), `nnue-parity.js`(확장 == 학습 점수) |
| `tools/site-parity/` | 실제 사이트 워커와 엔진 대조(수 목록/적용/여러 수 진행), 사이트 업데이트 확인 |
| `tools/perf/` | 속도 개선 검증(원본과 출력 동일 확인), 프로파일러 |
| `site-oracle/` | 사이트 원본 번들 스냅샷과 Node 실행용 오라클 |
| `audit-data/` | 카드/기물 감사 자료 |
| `legacy/` | 더 이상 쓰지 않는 옛 엔진·자기대국 스크립트(유지보수 안 함) |
| `data/` (git 제외) | 옛 데이터: `backups/`, `experiments/`, `archive/` |
| `logs/` | 로컬 대전 로그 |
| `.github/workflows/` | `ci.yml`, `selfplay.yml`, `nnue-train.yml`, `match.yml`, `dataset-build.yml` |

## 자주 쓰는 명령

```bash
node smoke-merged.js                       # 엔진 스모크
node tools/ci/golden-eval.js               # 평가값 회귀 검사 (의도한 변경이면 --update)
node tools/ci/nnue-parity.js               # 확장 NNUE == 학습 NNUE
node tools/site-parity/parity-actions.js - 400   # 사이트 워커와 수 목록 대조 (네트워크 필요)
node tools/site-parity/check-site-update.js      # 사이트가 업데이트됐는지
NOSAVE=1 node tools/perf/eval-equiv.js 600 # 속도 개선 후 평가 출력 동일 확인
node nnue/match-two-models.js <A> <B> 10   # 모델 대전 (A/B는 가중치 경로 또는 handcoded)
```

## 워크플로 (GitHub Actions, 저장소는 공개 → 무료)

| 워크플로 | 용도 | 기본 사용법 |
|---|---|---|
| `ci.yml` | 푸시마다 문법·스모크·평가 회귀·NNUE 일치 검사 | 자동 |
| `selfplay.yml` | 자기대국, 6시간마다 자동, 병렬 샤드 | 설정은 **저장소 변수** `SELFPLAY_SHARDS/DEPTH/MS/CUTOFF_ISO` (`gh variable set ...`). 멈추려면 CUTOFF를 과거로 |
| `dataset-build.yml` | 자기대국 조각 → `datasets/<이름>.jsonl.gz` | 시작 시각 창(since/until)으로 라운드 지정, `push=false`로 먼저 개수 확인 |
| `nnue-train.yml` | (필요하면 인코딩) + 학습 + 선택적 승격 | `overrides`로 실험 설정, 기본은 master에 안 올림(`promote=false`) |
| `match.yml` | 모델 대 모델 대결, 4샤드 병렬 | 결과는 실행 요약에 표시 |

`gh`는 `C:\Program Files\GitHub CLI\gh.exe`(로그인 완료). 워크플로 입력이 JSON이면 PowerShell이 따옴표를 깨뜨리므로
**Bash에서 표준입력으로**: `printf '{"overrides":"{\"ablateBlend\":\"0.7\"}"}' | gh workflow run nnue-train.yml --json`.

## 반드시 지킬 규칙

- **엔진 출력은 학습 모델과 맞물려 있습니다.** `evaluateStateComponents`가 NNUE 입력 21개 특징을 만들기 때문에, 의도치 않게
  바뀌면 모든 모델이 무효가 됩니다 → `golden-eval`로 막습니다. 의도한 규칙 변경이면 `--update` 후 재인코딩/재학습을 검토하세요.
- **확장 동기화**: `extension/engine.js` = `engine-merged.js` + 마지막에 `globalThis.AugmentEngine = globalThis.__engineMerged;` 한 줄.
  엔진을 고치면 이 사본도 갱신하고 `node tools/ci/nnue-parity.js`를 돌립니다.
- 확장의 `nnue.js` 인코더(기물 40종, 카드 184장, 입력 5509)는 `nnue/encode.js`와 **항상 같아야** 합니다(CI가 검사).
- 사이트가 업데이트되면 `tools/site-parity/`로 엔진과 대조하고, `site-oracle/README.md` 절차로 번들을 갱신합니다.
- 브랜치를 만들지 않고 master에 바로 커밋/푸시합니다. 인코딩 캐시 키에는 엔진 해시(salt)가 들어갑니다(`nnue-train.yml`의 `cache=auto`).

## 모델 라인업

| 이름 | 파일 | 비고 |
|---|---|---|
| Typhoon | `nnue/model/weights.baseline-current.json` | 라운드1 기준 |
| Tornado | `nnue/model/weights.round1-candidate.json` | 확장에서 선택 가능 |
| Squall | `nnue/model/weights.round2-full-112981.json` (= `weights.json`) | 확장 기본값 |
| Blend0.8 | `nnue/model/weights.blend0.8-round2.json` (로컬 전용) | 검색 점수 비중 0.8 실험 모델, 실전에서 Squall보다 낫지 않음 |
