# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 세션을 시작할 때 먼저 읽을 문서 (두 프로젝트)

이 저장소(Twist)와 팀 프로젝트 "가속"(Accelerate)을 함께 다룹니다. 작업 전에 아래를 읽고 현재 상태를 파악하세요. 이 표의 문서가 최신 상태의 기준이고, 대화 기억이나 오래된 핸드오프(`HANDOFF.md`가 가리키는 `D:\HANDOFF-모음\증강체스엔진-HANDOFF.md` 본문은 2026-09-19 기준)보다 우선합니다.

**Twist (이 저장소, `D:\증강체스엔진`)** — 순서대로:
1. `PROJECT.md`: 폴더 지도, 명령, 워크플로, 반드시 지킬 규칙, 모델 라인업
2. `TODO.md`: 맨 위 "지금 진행 중 … 다음 세션은 여기부터" 블록(돌고 있는 실행 번호, 남은 일, 세션 규칙, 사전 승인 예외)
3. `ExperimentNote.md`: 실험 설정과 결과(가장 최근은 9, 10번), `PLAN.md`: 계획과 승격 기준(SPRT)
4. 사용자 메모리 `C:\Users\Ian\.claude\projects\D--------\memory\MEMORY.md`

**가속 (Accelerate, 팀 저장소 `sungjeahyun100/Accelerate-alpha-zero-style-Augment-Chess-bot-`)** — 로컬 clone이 없으면 `gh api "repos/<repo>/contents/<경로>?ref=develop" --jq .content | base64 -d`로 읽거나 스크래치패드에 clone:
1. `README.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`(Phase 0~10 상태), `docs/DECISIONS.md`(확정 D-XXX와 열린 질문 O-XXX 구분), `docs/GAME-RULES.md`, `CHANGELOG.md`
2. `gh pr list --repo <repo> --state open`으로 열린 PR 확인(2026-09-26 기준 #17, #23, #24)

## 명령 (`PROJECT.md`의 "자주 쓰는 명령"에 없는 것 위주)

```bash
node smoke-merged.js && node tools/ci/golden-eval.js && node tools/ci/nnue-parity.js   # CI와 같은 로컬 검사
node tools/league/stats.test.js; node tools/league/league.test.js                        # 측정 통계 단위 시험
node tools/league/run-ladder.js <참가자...> --mode gauntlet --gauntlet handcoded@d3 --go # 사다리 대전 발사(기본은 dry run)
node tools/league/league.js <match-result 폴더>                                          # 여러 대전 결과 -> Elo
# 사이트 규칙 코드(.cache는 gitignore, 사이트 코드라 저장소에 올리지 않음)
node tools/site-parity/fetch-real-worker.js --force   # 새로 받기
node tools/site-parity/make-fast-worker.js            # 앵커 패치로 빠른 버전 생성(앵커 불일치 시 실패, 원본은 안 건드림)
node tools/site-parity/diff-fast-worker.js 80 4242 120  # 원본과 바이트 단위 대조, 차이 0이어야 함
node tools/site-parity/gen-reference-fixtures.js --out=<dir> --verify=<dir>  # Accelerate용 정답지 생성/재생
```

워크플로는 bash에서 `gh workflow run <파일> -f 입력=값`으로 실행합니다(JSON 입력은 `-f overrides='{...}'`, PowerShell은 따옴표가 깨짐). 실행 확인은 `gh run view <id> --json status,conclusion`. `gh` 로그는 **작업이 끝나야** 나오므로 학습 중간 상태는 이슈 #5의 실행별 댓글(5분마다 갱신)로 봅니다.

## 큰 그림 (여러 파일을 읽어야 보이는 구조)

- **`engine-merged.js` 하나가 규칙 + 탐색 + 평가를 모두 가집니다.** 자기대국(`selfplay-worker-merged.js`), 학습 인코더(`nnue/encode.js`), 대전(`nnue/match-two-models.js`), 크롬 확장(`extension/engine.js` 사본)이 전부 이걸 씁니다. 엔진의 평가 하위 점수(`evaluateStateComponents`)가 NNUE 입력 일부라서 함부로 바꾸면 기존 모델이 무효가 됩니다(`golden-eval`).
- **데이터 흐름**: 클라우드 자가대국 → 데이터 브랜치 `gha-segments-16cards`(`segments/` 조각, `datasets/`, `models/`, `nnue-cache/`) → `dataset-build.yml`(since/until 시각 창, 키 형식 `YYYYMMDDTHHMMSSZ`) → `nnue-train.yml`(`overrides` JSON으로 실험 설정, `save_model=<이름>`이면 `models/<이름>.json`에 저장) → `match.yml`(모델 스펙 `<경로|handcoded|data:models/x.json>[@출력맵]`, `shards` 1~20, `match-result` 아티팩트) → `tools/league`로 Elo. master 모델 승격은 `promote=true`이며 반드시 사용자에게 먼저 묻습니다(예외는 `TODO.md`의 사전 승인 항목).
- **입력 차원은 환경 변수로 갈립니다**: 기본 5,509(확장 `nnue.js`와 항상 같아야 함), `FULL_PIECE_STATE=1`이면 15,237, `STAR_TOTAL_FEATURES=1`이면 +2. 대전의 `full_piece_state`도 같은 값이어야 하고, 어긋나면 오류 없이 NaN이 나옵니다. 큰 데이터는 `SPARSE_INPUT=1`(희소 저장)로 학습해야 메모리에 들어갑니다.
- **사이트 규칙 코드가 정답입니다.** `tools/site-parity`가 사이트의 실제 워커(`real-worker.js`)와 우리 엔진을 대조하고, `make-fast-worker.js`가 그 워커를 동일 동작으로 3.7배 빠르게 만든 변형을 낳습니다. 사이트가 바뀌면 `check-site-update.js` → fetch → 대조 → `--save` 순서입니다. 우리 엔진과 사이트의 알려진 불일치는 Accelerate `known-differences.json`에 있습니다.

## 실험에서 배운 함정 (다시 밟지 않도록)

- **L2 정규화는 파라미터 수에 비례**하므로 은닉 폭을 바꾸면 `ablateL2`도 폭에 반비례로 조정해야 손실을 비교할 수 있습니다(폭 16 기준 0.001).
- **검증 방향 일치율이 오르는 것과 실전 승률은 다릅니다.** 학습 결과는 항상 대국(Elo/SPRT)으로 판정합니다. 대국 96판으로는 ±11%p 미만을 못 가리고 무승부가 40~50%라, 판수를 크게 잡고 무승부를 0.5로 세는 `tools/league` 통계를 씁니다.
- **기본 설정(수당 0.3초)에서는 탐색이 거의 안 돕니다**(중반 국면 완료 깊이 0, 노드 7~12개). 이 시간 제한에서 `depth`만 바꾸는 대전은 서로 다른 깊이를 비교하지 못합니다.
- Node 한계: 한 번에 읽는 파일 2GiB, 문자열 약 512MB. 큰 데이터셋은 청크로 읽습니다(`nnue/train.js`의 `readJsonLines`).
- Actions 실행은 동시에 20개까지만 돌고, 자가대국 스케줄(`selfplay.yml`)은 2026-09-25부터 수동 비활성화 상태입니다.

## 작업 규칙

- **Twist는 브랜치 없이 master에 바로 커밋/푸시**합니다. 커밋 메시지 끝에 `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. **Accelerate는 반대로** 팀 저장소에 `feature/*` 브랜치를 만들어 `develop` 대상 PR을 열고(병합은 하지 않음), 본문에 `@sungjeahyun100`을 멘션하되 글에서는 "구독좋아요"라고 부릅니다. PR마다 **별도 clone 폴더**를 씁니다. git 신원은 Twist의 `git config user.name/email`을 clone에 로컬 설정합니다.
- **사이트 코드(`real-worker.js` 등)를 Accelerate 저장소에 넣지 않습니다**(운영자 동의 증빙이 NOTICE.md에 아직 없음). 데이터(JSON)만 올립니다.
- 시각은 **KST로만** 말하고 Z/UTC 표기를 쓰지 않습니다. 보고는 단계마다 수치와 실패, 확인하지 못한 부분까지 빠짐없이, 하지만 비유를 섞어 쉽게 합니다. 범위가 애매하면 실행 전에 제안하고 묻습니다.
- 로컬 부하는 8코어 중 4개 이하(자가대국 워커 2개)로 제한하고, 서브에이전트는 저비용 모델(Sonnet)을 씁니다. 감시나 반복 확인 루프는 만들지 않고 필요할 때 한 번만 확인합니다.
