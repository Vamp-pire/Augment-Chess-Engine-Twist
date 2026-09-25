# TODO

역할: 남은 일과 사용자 몫만 적는 문서입니다. 계획과 기준은 `PLAN.md`, 실험 결과와 발견은 `ExperimentNote.md`, 프로젝트 지도는 `PROJECT.md`입니다.
마지막 갱신: 2026-09-25.

- [x] WASM PoC (2026-09-22): `positionalScore` 축소판을 AssemblyScript로 포팅해 벤치마크 — 결과 애매(0.94x~1.43x, 오차범위 안), 압도적 이득 없음. 상세는 `docs/WASM-POC-RESULT.md`.
- [x] Texel tuning 도구 (2026-09-22): `tools/tune/texel-tune.js` — `evaluateState`의 8개 손튜닝 계수(material 1.35, *Enemy 0.88/0.72/0.65/0.82/0.82/0.92/0.9)를 자가대국 결과로 재적합. 스트리밍 로딩(RAM 안전), sigmoid(score/K)+MSE, Adam + 기본값으로의 L2 정규화(노이즈로 인한 발산 방지 위해 추가). `selfplay-data.merged-engine-local-depth3.jsonl`(6474국면)로 로컬 검증: MSE 0.1358→0.1106(18.6%↓), 승부 국면 부호 일치율 66.3%→68.0%. 엔진 파일은 건드리지 않음 — `tools/tune/tuned-eval.js`가 `evaluateStateComponents`로 재계산해 `options.evalFn`에 꽂는 방식. 결과는 `tools/tune/weights.json`.
- [x] B3 재검증(2026-09-22, 표본 120개): 노드 수 비율 1.009(+0.9%, 사실상 노이즈 -- 15개 표본의 +2.9%는 노이즈였음). 같은 수 86/120(71.7%). 결론: 속도를 해치진 않지만 확실히 줄이지도 못함, 여전히 unproven.
- [x] B soft label 재시도(2026-09-22, 클라우드): top1 19.0%/MRR 0.357 -- 원래 one-hot 모델(top1 19.9%/MRR 0.364)과 사실상 동일하거나 살짝 낮음. 개선 없음, unproven.
- [x] NNUE 인코딩에 기물 상태 필드 전부 추가(2026-09-23): `selfplay-worker-merged.js`의 `compactBoard()`가 지금까지 `{t, c}`만 남기고 hp/shielded/frozen 등 나머지 상태를 전부 버리고 있던 걸 발견 -- 불리언 41개 + 숫자 23개 + 2값 enum 6개(monoShade/timePhase/windmillMode/spyOwner/poisonStunColor/hiddenFrom, one-hot 12비트)를 보존/인코딩하도록 수정. `tricksterMoveType`은 가능한 값이 ~40개로 너무 많아 one-hot 대신 "설정됐는가" 불리언 1개로 타협(문서화 끝). `INPUT_SIZE` 4281(구) -> 15237(신, ALL_TYPES 40종 + CARD_POOL 184종 반영). 기존 학습된 가중치 파일은 이 변경 후 전부 재학습 필요. 로컬 2워커/25초 자가대국 148국면으로 검증: 새 필드가 실제 기록되고(frozen/frozenByCard/capturesMade 등 확인) `encode.js`가 크래시 없이 15237차원 벡터 생성 확인. 과거 기록된 자가대국 데이터는 이미 `{t,c}`로 손실되어 복구 불가(신경 안 씀, 이번 수정은 앞으로의 데이터부터 적용). 자가대국 재실행은 이번 작업 범위 밖 -- 별도 진행 예정.

## 지금 진행 중 (2026-09-25) — 다음 세션은 여기부터

**세션 규칙(사용자 지시)**: 승격(promote)은 매번 먼저 묻기 / 감시·반복 확인 없이 필요할 때 한 번만 확인 / 시각은 KST로만 말하기 / 단계마다 결과를 빠짐없이 정확히, 하지만 쉬운 말로 보고 / 자가대국 스케줄(`selfplay.yml`)은 2026-09-25에 수동 비활성화됨(다시 켤지는 사용자에게 묻기, `gh workflow enable selfplay.yml`).

**대기 중이던 것(이 문서 갱신 시점)**
- [ ] v3-all 대전 결과 확인: 대 핸드코딩 run 36105118496, 대 v2 run 36105123190 (각 200판). 결과는 `ExperimentNote.md` 9번에 기록.
- [ ] real-worker 최적화(서브에이전트): `tools/site-parity/make-fast-worker.js`(앵커 패치 방식, 원본 미수정)와 `diff-fast-worker.js`. 속도 배수와 원본 대조 차이 0건 여부 확인 필요.
- [ ] 측정 체계(서브에이전트): `tools/league/`(stats, league, run-ladder), `match.yml` 요약에 점수/Elo/SPRT 추가와 `match-result` 아티팩트, `PLAN.md`에 승격 규칙.

**계획(사용자 승인, 2026-09-25)**
1. 사다리 실행(핸드코딩 깊이 2~5 + v1, v2, v3-all, 20샤드, 핸디캡 사용) 후 리그 Elo 산출.
2. v3-all 분기: 확실히 낫다면 승격 여부를 먼저 묻고, 에폭 15~20으로 재학습(희소 저장)과 v3 선생 TD 부트스트랩 검토. 낫다는 증거가 없으면 데이터를 더 늘리기 전에 "정답 점수의 질이 한계인가"를 깊은 탐색 라벨 재학습으로 검증.
3. 최적화 분기: 약 2배 이상 빠르고 원본과 차이 0건이면 자동화(사이트 갱신 확인 -> 원본 받기 -> 패치 -> 동일성 대조 -> 자가대국이 사이트 규칙 사용, 실패 시 원본으로 후퇴 + 알림)를 만들고 취소됐던 사이트 규칙 자가대국 시험(run 35977727355)을 재실행. 아니면 오라클 교체는 접고 동일성 검사만 유지.
(4단계 정리 작업은 사용자가 뺌.)

**상태 요약**
- v1 대 핸드코딩 56.8%(96판), v2는 v1/핸드코딩 대비 낫다는 증거 없음(모두 unproven). 자세한 수치는 `ExperimentNote.md` 7, 9번.
- 15237차원 학습은 이제 `SPARSE_INPUT=1`로 128만 포지션까지 가능(메모리 문제 해소). 다만 5시간 제한 안에서 에폭 상한이 필요.
- 대전 도구: `match.yml`에 `shards`(1~20) 입력 있음. Discord `!ai` 감시 방법은 사용자 메모리 `reference_discord_watch.md` 참조(사용자가 요청할 때만 켬).

**계속 유효한 항목**
- [ ] `fullstate-v1`/v2/v3 실전 검증 통과 전에는 master 승격 안 함, 확장(`extension/nnue.js`) 15237차원 포팅도 보류.
- [ ] NNUE-eval 자가대국 피드백 루프 위험: 무승부율 40.8%→52.7%(4배 표본에서도 재현). 확인 없이는 메인 파이프라인에 안 섞음. `ExperimentNote.md` 8번.
- [ ] 사이트 규칙 반영 자가대국(45수/데스매치/별 합계): 트리거/동점 처리 스펙 확인 전엔 구현 보류.
- [x] Accelerate 팀 저장소: PR #7~#9, #13~#15 머지(#11, #12는 닫힘). GitHub Pages/브랜치보호/머지된 브랜치 자동삭제/Copilot 리뷰는 admin 권한이 필요해서 구독좋아요에게 요청해야 함. Accelerate는 아직 Phase 0만 완료(구현 코드 없음), encoding 위치(O-001)는 미결정.


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
