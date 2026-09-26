# TODO

역할: 남은 일과 사용자 몫만 적는 문서입니다. 계획과 기준은 `PLAN.md`, 실험 결과와 발견은 `ExperimentNote.md`, 프로젝트 지도는 `PROJECT.md`입니다.
마지막 갱신: 2026-09-26.

- [x] WASM PoC (2026-09-22): `positionalScore` 축소판을 AssemblyScript로 포팅해 벤치마크 — 결과 애매(0.94x~1.43x, 오차범위 안), 압도적 이득 없음. 상세는 `docs/WASM-POC-RESULT.md`.
- [x] Texel tuning 도구 (2026-09-22): `tools/tune/texel-tune.js` — `evaluateState`의 8개 손튜닝 계수(material 1.35, *Enemy 0.88/0.72/0.65/0.82/0.82/0.92/0.9)를 자가대국 결과로 재적합. 스트리밍 로딩(RAM 안전), sigmoid(score/K)+MSE, Adam + 기본값으로의 L2 정규화(노이즈로 인한 발산 방지 위해 추가). `selfplay-data.merged-engine-local-depth3.jsonl`(6474국면)로 로컬 검증: MSE 0.1358→0.1106(18.6%↓), 승부 국면 부호 일치율 66.3%→68.0%. 엔진 파일은 건드리지 않음 — `tools/tune/tuned-eval.js`가 `evaluateStateComponents`로 재계산해 `options.evalFn`에 꽂는 방식. 결과는 `tools/tune/weights.json`.
- [x] B3 재검증(2026-09-22, 표본 120개): 노드 수 비율 1.009(+0.9%, 사실상 노이즈 -- 15개 표본의 +2.9%는 노이즈였음). 같은 수 86/120(71.7%). 결론: 속도를 해치진 않지만 확실히 줄이지도 못함, 여전히 unproven.
- [x] B soft label 재시도(2026-09-22, 클라우드): top1 19.0%/MRR 0.357 -- 원래 one-hot 모델(top1 19.9%/MRR 0.364)과 사실상 동일하거나 살짝 낮음. 개선 없음, unproven.
- [x] NNUE 인코딩에 기물 상태 필드 전부 추가(2026-09-23): `selfplay-worker-merged.js`의 `compactBoard()`가 지금까지 `{t, c}`만 남기고 hp/shielded/frozen 등 나머지 상태를 전부 버리고 있던 걸 발견 -- 불리언 41개 + 숫자 23개 + 2값 enum 6개(monoShade/timePhase/windmillMode/spyOwner/poisonStunColor/hiddenFrom, one-hot 12비트)를 보존/인코딩하도록 수정. `tricksterMoveType`은 가능한 값이 ~40개로 너무 많아 one-hot 대신 "설정됐는가" 불리언 1개로 타협(문서화 끝). `INPUT_SIZE` 4281(구) -> 15237(신, ALL_TYPES 40종 + CARD_POOL 184종 반영). 기존 학습된 가중치 파일은 이 변경 후 전부 재학습 필요. 로컬 2워커/25초 자가대국 148국면으로 검증: 새 필드가 실제 기록되고(frozen/frozenByCard/capturesMade 등 확인) `encode.js`가 크래시 없이 15237차원 벡터 생성 확인. 과거 기록된 자가대국 데이터는 이미 `{t,c}`로 손실되어 복구 불가(신경 안 씀, 이번 수정은 앞으로의 데이터부터 적용). 자가대국 재실행은 이번 작업 범위 밖 -- 별도 진행 예정.

## 지금 진행 중 (2026-09-26) — 다음 세션은 여기부터

**세션 규칙(사용자 지시)**: 승격(promote)은 매번 먼저 묻기(단, 아래 "확실히 나은 모델" 사전 승인 예외) / 감시·반복 확인 없이 필요할 때 한 번만 확인 / 시각은 KST로만 말하고 Z/UTC 표기 금지 / 단계마다 결과를 빠짐없이 정확히, 하지만 쉬운 말로 보고(비유 환영) / 애매하면 먼저 묻고 제안 후 실행 / 자가대국 스케줄(`selfplay.yml`)은 2026-09-25에 수동 비활성화됨(`gh workflow enable selfplay.yml`로 다시 켬, 켤지는 사용자에게 묻기) / 서브에이전트는 저비용 모델(Sonnet)로, PR마다 별도 clone 폴더 사용.

**사전 승인된 예외**: 어떤 모델이 핸드코딩 깊이 3을 SPRT로 "확실히" 이기면 확장 모델 드롭다운에 기본 모델로 추가(이름은 알아서). 그 전에 `extension/nnue.js`를 15,239차원으로 포팅해야 함.

**돌아가고 있던 작업(결과 미확인) — 확인 방법: 이슈 #5 댓글(실행별 진행 로그) 또는 `gh run view <id> --log | grep -E "epoch|stopped early|sign-agreement"`**
- 폭 64(L2 0.00025) 모델 대 핸드코딩 200판 대전: run 36220701270. 끝나면 `gh run download <id> -n match-result`로 받아 `node tools/league/league.js <폴더>`. 이기면 사전 승인 예외 절차 진행.
- 폭 16 + L2 0.00025 대조군(L2 효과와 폭 효과 분리): run 36220723586.
- 폭 128(L2 0.000125): run 36220748105. 폭이 커질수록 계속 좋아지는지 추세.
- 부스트랩 재학습(선생 = fullstate-w64-l2s, 블렌드 0.15, 학생 폭 64, L2 0.00025, 같은 데이터/검증): run 36221955928, 저장 이름 `fullstate-w64-boot`. 비교 기준은 폭 64 대조군(검증 손실 0.1955, 방향 일치율 94.5%). 좋아졌으면 대국으로 확인(`match.yml`, `full_piece_state=1`, 20샤드 x 5쌍).
- 결과 해석 규칙: 검증 지표만으로 승격/추가하지 않는다(과거에 검증이 올라도 실력이 안 오른 사례 다수). 항상 대국(Elo/SPRT)으로 판정.

**남은 할 일(추정 순위와 검증 방법은 `ExperimentNote.md` 10번 참고)**
- [ ] 깊이 확인 대전: 시간 무제한에 가깝게 주고 깊이만 고정(예: `limits_a {"depth":1,"movetimeMs":60000}` 대 `{"depth":3,"movetimeMs":60000}`), 약 40판. 깊이 3이 확실히 이기면 탐색 정상(병목은 눈/정답), 아니면 탐색이나 게임 특성 문제. 배경: 기본 설정(0.3초)은 중반 국면에서 완료 깊이 0, 노드 7~12개.
- [ ] 미러 대국 분산 측정(같은 엔진끼리): 운(카드/무작위) 비중 확인.
- [ ] 무승부 국면 가중 축소/제외 재학습(무승부 40~50%가 정답값을 0으로 몰아 신호 약화).
- [ ] 폭 256 학습 실패 원인: 학습 손실이 12에폭 내내 0.945에서 안 움직임(방향 일치율 77.9%). 가설: tanh 포화로 기울기 소실. 시도 후보: 학습률 낮춤/출력 스케일 조정/초기화. 참고: L2는 파라미터 수에 비례하므로 폭에 반비례해서 줄여야 함(`ABLATE_L2` 옵션, 폭 16 기준 0.001).
- [ ] 새 정보원 확보: 정답이 핸드코딩의 복사본이라 새 정보가 없다는 것이 1순위 가설. 사이트의 실제 기보나 사이트 AI와의 대국 데이터 활용. 사이트 운영자 동의 증빙(NOTICE.md 인용, Discord 2026-09-19) 저장이 선행되어야 함.
- [ ] 사이트 규칙 자가대국 자동화: 사이트 감시 → 원본 받기 → 패치(`make-fast-worker.js`) → 동일성 대조(`diff-fast-worker.js`) → 자가대국이 사이트 규칙 사용, 실패 시 원본으로 후퇴 + 알림. 취소됐던 사이트 규칙 시험(run 35977727355) 재실행. 빠른 버전은 원본 대비 3.7배(초당 98 → 362수, 차이 0건), 목표 2.5배 달성.
- [ ] 더 빠른 사이트 규칙: 허수아비 강제 포획 O(n²) 계산(전체의 약 14%)은 동등성을 증명하지 못해 미적용.
- [ ] 엔진 vs 사이트 규칙 불일치(이번 사이트 업데이트와 무관하게 이전부터): `recurrence` 카드 대상 좌표, `randomRoulette`, `symmetry` 포획 수, 게임 시작 시 `blackMagic` 카드 노출, 그 밖에 falseStart/binaMate/zugzwang 후보. 목록은 Accelerate PR #23의 known-differences.json 참고.
- [ ] 확장 15,239차원 포팅(`extension/nnue.js`): 대전을 통과하는 모델이 나온 뒤.
- [ ] 사용자 확인 필요: `.claude/settings.json`(브라우저 읽기 도구 6개 허용, 미커밋) 커밋 여부, 자가대국 스케줄 재개 여부.

**Twist 측 새 도구(2026-09-26 기준 master에 있음)**
- 측정: `tools/league/`(stats.js, league.js, run-ladder.js, match-summary.js), `match.yml`에 `shards`(1~20)와 점수/Elo/SPRT 요약과 `match-result` 아티팩트. 승격 규칙은 `PLAN.md`(SPRT + 핸드코딩 대비 점수).
- 학습: `SPARSE_INPUT=1`(희소 저장, 128만 포지션까지), `EPOCHS_CAP`/`PATIENCE`/`CHUNK_SIZE`/`ABLATE_L2` 환경 변수를 `nnue-train.yml` overrides(`sparseInput`, `epochsCap`, `patience`, `chunkSize`, `ablateL2`)로 전달, Node 힙 12GB, 실행별 진행 로그를 이슈 #5 댓글로 5분마다 갱신.
- 사이트 규칙: `tools/site-parity/make-fast-worker.js`, `diff-fast-worker.js`(원본과 바이트 단위 대조), `gen-reference-fixtures.js`(사이트 원본으로 정답지 생성).
- 사이트 감시: `last-seen.json`은 2026-09-26 갱신(번들 main-saUeM6OL, aiWorker 5f7328296457). 이번 번들 변경은 규칙 동작을 바꾸지 않음(80판 + 320 국면 대조 차이 0).

**Accelerate 팀 저장소(가속) 상태**
- 열린 PR: #17(cpp 스케치 Phase A~G, 판단 코드 주석 처리), #23(정답 축 통합: 오라클 동기화 + 정답지 + 정답 기준 문서, 기존 #18 #19 #20 대체), #24(대화 양식 축 통합: encoding 근거 + bridge 프로토콜 초안, 기존 #21 #22 대체). 모두 리뷰 대기, 병합하지 않음. 본문에 `@sungjeahyun100`(구독좋아요님) 멘션.
- 닫힘: #16(Rust 초안, #17 이후 다시 옮기기로 보류), #18~#22(통합됨). 병합됨: #7~#9, #13~#15.
- 결정 대기: O-001(encoding 위치), O-002(정답 기준을 사이트 원본으로). 로드맵은 Phase 0만 완료.
- 규칙: 사이트 코드는 Accelerate에 넣지 않음(운영자 동의 증빙 미저장). 관리자 권한이 필요한 요청(머지된 브랜치 자동 삭제, 브랜치 보호, Pages, Copilot 리뷰)은 구독좋아요에게 요청해야 함.

**상태 요약(핵심 결론)**
- v1, v2, v3-all, v3-e10 모두 핸드코딩 깊이 3과 통계적으로 구분 안 됨(-17 ~ +9 Elo). 탐색 16배 시간(깊이 2~3)도 +4 Elo(±29). 데이터 10배, 에폭 2배도 검증 지표 변화 없음.
- 폭 16 → 64(L2 조정)에서 검증 방향 일치율 92.4% → 94.5%: 눈의 용량이 병목일 수 있으나 L2 혼합 요인, 실전 미확인.
- 사이트 규칙 코드는 최적화 후 3.7배 빠름. 규칙 계층 속도는 병목이 아닌 것으로 보임(탐색 시간을 늘려도 승률 불변).

**계속 유효한 항목**
- [ ] 확장 15,239차원 포팅은 실전 검증 통과 전에는 보류. master 승격도 통과 전에는 안 함.
- [ ] NNUE-eval 자가대국 피드백 루프 위험: 무승부율 40.8% → 52.7% (4배 표본에서도 재현). 확인 없이는 메인 파이프라인에 안 섞음. `ExperimentNote.md` 8번.
- [ ] 사이트 규칙 반영 자가대국(45수/데스매치/별 합계): 트리거/동점 처리 스펙 확인 전엔 구현 보류.


## 사라진 이전 인수인계 블록 (2026-09-23) 정리 메모

- Texel-tuned 실전 대전, C2 대전, 팀 저장소 PR #6은 모두 완료/병합됨 — 개별 상태 추적 불필요해짐.
- 디스코드 "인코딩 위치" 논쟁은 팀 저장소 `docs/DECISIONS.md`에 "미결정"으로 정직하게 기록 완료.

## 팀 프로젝트 (Accelerate) 관련 참고 — 지금도 유효
- 사용자(Ian)는 디스코드에서 **"Vamp"/"vampire_nickname"**입니다. 디스코드 메시지에서 이 이름이 하는 말은 전부 사용자 본인 발언으로 취급 ([memory: user_discord_identity.md] 참고).
- 팀 저장소: `sungjeahyun100/Accelerate-alpha-zero-style-Augment-Chess-bot-` (upstream), `Vamp-pire/Accelerate-alpha-zero-style-Augment-Chess-bot-` (사용자 포크). GitFlow 사용 — `develop`에서 `feature/*` 브랜치 따서 PR (Twist 저장소와 달리 여기는 브랜치+PR 방식임, master 직커밋 아님).
- **디스코드 읽기/쓰기 도구를 이번 세션에서 직접 만들었음** — 단, **로컬 전용**이라 클라우드 세션에서는 못 씀:
  - 스크립트 위치: 이 세션의 로컬 스크래치패드 `discord-tool/{read-thread.js, post-message.js}` (클라우드에선 접근 불가한 경로)
  - 봇 토큰: `D:\변형체스들\discord-report-bot\.env`의 `DISCORD_TOKEN` (로컬 PC에만 있음, 절대 이 리포에 커밋하지 말 것)
  - 대상 스레드 ID: `1551147030099791873`
  - 클라우드 세션이 디스코드 내용이 필요하면: 로컬 세션에 물어보거나, 사용자에게 직접 요청할 것. 토큰을 리포로 옮기거나 클라우드에 복사하지 말 것(자격증명, 로컬에만 두기로 함).
- **논의 중 나온 우리 쪽 정보 제공**: NNUE 입력 인코딩 전체 fidelity 작업(아래) 결과를 15,237차원이라고 스레드에 공유함(사용자 본인이 직접 올림). 팀의 "20배 필요하지 않냐"는 추측과 비교 가능한 실측치.
- **팀 논의 중 우리가 검증해줄 수 있는 것**: `isTurnUsed` 단일 플래그 설계(팀원 subscribe_like_ 제안)가 실제로 한계 있다는 걸 Twist 엔진 코드로 확인함(`fileSurgeSecondMove` 등 10개 개별 플래그 + 아이돌은 별도 대기/기록 시스템 필요) — 아직 팀에 공유 안 함, 필요하면 정리해서 전달.

## 세션 작업 루프 (2026-09-22 확정, 매 세션 이 순서로)
1. 상태 확인: 이 문서의 미체크 항목 + 돌고 있는 클라우드/백그라운드 작업부터 확인
2. `PLAN.md` 우선순위 순서대로 다음 항목 하나 선택
3. 작은 단위로 구현(한 번에 함수/기능 하나)
4. 바로 검증(동일성 도구 또는 실측 비교, 감으로 넘어가지 않음)
5. 검증 통과한 것만 즉시 커밋 **+ 푸시**(로컬에 묵히지 않기)
6. 이 문서에 체크 + 결과 한 줄 기록(성공/실패 모두 정직하게, unproven도 기록)
7. 큰 방향 전환 판단만 짧게 보고하고 답 기다림, 나머진 중단 없이 다음 항목으로
8. 세션 마무리 전: 아래 "이어받기" 섹션 갱신

## 사용자 몫 (제가 대신할 수 없거나 승인이 필요한 것)

- [x] `nnue/snapshots/` 정리 — 확인해보니(2026-09-24) 이미 382MB, 파일 1개(`selfplay-data.2026-09-17T06-03-48-630Z.jsonl`)만 남아있었음(9.6GB 기록은 예전 상태). 사용자가 그대로 두기로 결정, 추가 조치 없음
- [ ] 크롬에서 확장 확인(압축 해제된 확장 새로고침): 모델 드롭다운과 로드 상태, 새 아이콘, 리뷰, 실시간 봇, 설정("우리 엔진" 블록), 성능 패널 평가기 표시
- [ ] 사이트 운영자 동의 증빙 저장(스크린샷/메시지 링크): NOTICE.md가 인용함(Discord, 2026-09-19)

## 아직 열린 항목 (여러 세션에 걸쳐 안 끝난 것)

- [ ] 전술 세트 재구축(완전한 상태로, 약 240문제) 후 모델들 평가 — 오래 밀린 항목
- [ ] `site-watch.yml` 첫 실행 확인(매일 자동, 수동 실행도 가능)
- [ ] 무승부 원인 확인(자가대국의 반복/50수 규칙), 고정 오프닝 세트, 조기 종료
- [ ] 속도: `cloneState` 공유, 나머지 루트 안전 검사 필터 (`PLAN.md` A)
- [ ] 규칙 차이 남은 것: `promotionRush`, 브루터스 상태, 평범한 수 1건 (`tools/site-parity/TRIAGE.md`), 패럿 안전장치는 넣지 않기로 함
- [ ] 리뷰 개선(맥락, 깊이 기반 신뢰도, 아이콘 활용)은 엔진이 강해질 때까지 보류 (`tools/review-calibration/README.md`)
- [ ] 마지막 단계: 코드 리팩터링, 삭제, 푸시, 최종 보고 (후보 목록은 `docs/refactor-candidates.md`)
- [ ] B3(정책 기반 수 순서, `options.orderScoreFn`) 표본 확대 재확인 여부 — 15위치 unproven에서 안 넘어감
- [ ] C2(같은 시간 알파-베타 vs MCTS 실험실 대전) — JS MCTS가 느려서(초당 ~7시뮬레이션) 참고용으로만, 아직 결과 미확인
- [ ] 러스트 포팅: `evaluateState`가 `isSquareAttacked`/`delayedHazards`와 얽혀 있어 독립 포팅 불가 확인됨(2026-09-22) — 지금은 손대지 않음, 참고는 `docs/RUST-PORT-REFERENCE.md`

## 열린 질문

- [ ] 1라운드 "퇴보"의 원인: 검증 분할 이동, 라벨 상한, 게임 수 제한 표본
- [ ] 검증 정확도가 실전 강도로 이어지지 않는 이유(라벨 노이즈, 무승부, 평가와 검색의 상호작용)

## 정리 기록

- [x] 2026-09-19: `nnue/cache/*`(6.0GB)와 `data/backups/*`(1.2GB) 삭제, `data/experiments`와 `data/archive`는 유지, 옛 개요 Artifact 삭제, Dependabot PR 3개 시험 후 병합
- [x] 2026-09-24: 죽은 스크립트(`tools/perf/safety-report-check.js`, `rootSafetyReport` 미존재), Accelerate로 이미 포팅된 중복 fixture(`tools/fixtures/`), 오래된 로그 파일들 삭제
- 결정: 로컬 실험 가중치(`nnue/model/`, 추적 안 함)는 유지

## 완료 (최근)

- [x] 2026-09-23/24: CI 수정(확장 5509차원 vs 학습 15237차원 불일치 -> `FULL_PIECE_STATE` opt-in), 자가대국 라운드4(45,438 포지션, 기물상태 포함), 15237차원 학습(정확도 78.5%, `fullstate-v1`, master 미승격), NNUE-eval 피드백루프 실험(19샤드, `ExperimentNote.md` 8번, inconclusive), Texel-tuned 실전대전 80게임(unproven), `attacksSquare` 캐싱 확장(1.05배)
- [x] 2026-09-22: AlphaZero L1 A-F 트랙 전부 시도 — A1(정책 기록)/B1(정렬 기준선)/B2(정책망 학습, top1 19.9%/MRR 0.364)/C1(MCTS 시제품)/D1(소프트맥스 샘플링) 완료, B3(정책 기반 정렬)는 15위치 unproven, soft label/WASM PoC는 개선 없음, `blenddepth` 3회 재확인 전부 unproven(합산 56.2%)
- [x] 2026-09-23: NNUE 입력에 기물 상태(HP/보호막/빙결 등 70개+ 필드) 전부 보존하도록 `compactBoard()` 수정
- [x] 2026-09-20: 속도 약 2.2배(결과 동일), 실험실(판정기 `verdict.json`, `tools/lab/lab.js`, `docs/results/`), 핸디캡/시드 오프셋/검색 파라미터 옵션, 3라운드 자가대국 종료(150,415)와 `round3-full` 데이터셋, 재학습 7종, 사이트 패치 감시 워크플로, 정리 후보 감사, 확장 엔진 동기화 CI 검사
- [x] 2026-09-19: 워크플로 재정비(`ci.yml`, `selfplay.yml`, `nnue-train.yml`, `match.yml`, `dataset-build.yml`), CI 검사 세트, 사이트 9/19 패치 반영과 규칙 일치 수정, 평가/검색 속도 개선, 확장 엔진과 인코더와 모델 선택기, 폴더 재정리
- [x] 2라운드 데이터셋(112,981), 깊이 대전, 상한 분석
