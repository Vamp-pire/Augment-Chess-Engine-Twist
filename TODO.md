# TODO

역할: 남은 일과 사용자 몫만 적는 문서입니다. 계획과 기준은 `PLAN.md`, 실험 결과와 발견은 `ExperimentNote.md`, 프로젝트 지도는 `PROJECT.md`입니다.
마지막 갱신: 2026-09-22.

- [x] WASM PoC (2026-09-22): `positionalScore` 축소판을 AssemblyScript로 포팅해 벤치마크 — 결과 애매(0.94x~1.43x, 오차범위 안), 압도적 이득 없음. 상세는 `docs/WASM-POC-RESULT.md`.

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

- [ ] `nnue/snapshots/` 정리(9.6GB, 내용은 10종뿐): 아래 명령을 직접 실행하면 1라운드 복사본 1개만 남습니다 (자동 모드가 삭제를 막음)
  PowerShell(Windows 기본)에서는 `&&`와 `/d/...` 경로가 안 되므로 이 명령을 씁니다:
  `Get-ChildItem 'D:증강체스엔진
nuesnapshots' -File | Where-Object { $_.Name -ne 'selfplay-data.2026-09-17T06-03-48-630Z.jsonl' } | Remove-Item`
- [ ] 크롬에서 확장 확인(압축 해제된 확장 새로고침): 모델 드롭다운과 로드 상태, 새 아이콘, 리뷰, 실시간 봇, 설정("우리 엔진" 블록), 성능 패널 평가기 표시
- [ ] 사이트 운영자 동의 증빙 저장(스크린샷/메시지 링크): NOTICE.md가 인용함(Discord, 2026-09-19)

## 지금 진행 중

- [x] `blenddepth` 독립 재확인 완료: 재현 안 됨(50.8%, 53.7%, 합산 56.2% unproven). 재학습 3종도 전부 unproven
- [ ] 전술 세트 재구축(완전한 상태로, 약 240문제) 후 모델 5종 평가
- [ ] `site-watch.yml` 첫 실행 확인(매일 자동, 수동 실행도 가능)

## 다음

- [ ] 무승부 원인 확인(자가대국의 반복/50수 규칙), 고정 오프닝 세트, 조기 종료
- [ ] 속도: `cloneState` 공유, 나머지 루트 안전 검사 필터 (`PLAN.md` A)
- [x] 확장 드롭다운에 실험 모델 추가(Hurricane, Gale, Cyclone, 통과 여부와 무관), 기본값은 Squall 그대로. 이름을 바꾸고 싶으면 `extension/nnue.js`의 `MODELS` 라벨만 수정 (후보: Gale, Cyclone, Squall급 폭풍 이름들)
- [ ] 전술 세트 재구축, 수 품질 점수
- [ ] 규칙 차이 남은 것: `promotionRush`, 브루터스 상태, 평범한 수 1건 (`tools/site-parity/TRIAGE.md`), 패럿 안전장치는 넣지 않기로 함
- [ ] 리뷰 개선(맥락, 깊이 기반 신뢰도, 아이콘 활용)은 엔진이 강해질 때까지 보류 (`tools/review-calibration/README.md`)
- [ ] 마지막 단계: 코드 리팩터링, 삭제, 푸시, 최종 보고 (후보 목록은 `docs/refactor-candidates.md`)

## 열린 질문

- [ ] 1라운드 "퇴보"의 원인: 검증 분할 이동, 라벨 상한, 게임 수 제한 표본
- [ ] 검증 정확도가 실전 강도로 이어지지 않는 이유(라벨 노이즈, 무승부, 평가와 검색의 상호작용)

## 정리 기록

- [x] 2026-09-19: `nnue/cache/*`(6.0GB)와 `data/backups/*`(1.2GB) 삭제, `data/experiments`와 `data/archive`는 유지, 옛 개요 Artifact 삭제, Dependabot PR 3개 시험 후 병합
- 결정: 로컬 실험 가중치(`nnue/model/`, 추적 안 함)는 유지

## 완료 (최근)

- [x] 2026-09-20: 속도 약 2.2배(결과 동일), 실험실(판정기 `verdict.json`, `tools/lab/lab.js`, `docs/results/`), 핸디캡/시드 오프셋/검색 파라미터 옵션, 3라운드 자가대국 종료(150,415)와 `round3-full` 데이터셋, 재학습 7종, 사이트 패치 감시 워크플로, 정리 후보 감사, 확장 엔진 동기화 CI 검사
- [x] 2026-09-19: 워크플로 재정비(`ci.yml`, `selfplay.yml`, `nnue-train.yml`, `match.yml`, `dataset-build.yml`), CI 검사 세트, 사이트 9/19 패치 반영과 규칙 일치 수정, 평가/검색 속도 개선, 확장 엔진과 인코더와 모델 선택기, 폴더 재정리
- [x] 2라운드 데이터셋(112,981), 깊이 대전, 상한 분석

## 진행 중 / 이어받기 (2026-09-20 저녁, 세션 마무리 시점)
- 클라우드 자가대국(정책 + 국면 기록, 목표 2만 국면, 라운드 시작 (재시작, 아래 변수 참고))이 돌고 있다. 끝나면: 저장소 변수 `SELFPLAY_TARGET`=150000, `SELFPLAY_RECORD_POLICY`=0, `SELFPLAY_RECORD_STATE`=0으로 되돌리고, `tools/policy/ordering-eval.js`로 현재 정렬의 기준선을 잰다.
- 서브에이전트 3개가 로컬에서 작업 중(코어 1개씩): 수 점수 학습 도구(`tools/policy/`), 카드 9종 정답지(`tools/fixtures/special-cards.js`), 안전 검사 정답지(`rootSafetyReport`와 `generate-fixtures.js --safety`). 각자 master에 커밋하므로 결과와 `git log`를 확인하고, 안전 검사 쪽은 엔진 파일을 바꾸므로 CI(동기화, 골든)가 통과했는지 본다.
- 팀 저장소 PR #5(정답지)는 열려 있고 리뷰 대기. 안전 검사 정답지와 카드 9종 정답지가 끝나면 팀 저장소에도 별도 PR로 올릴지 정한다.
- 사이트 종료 규칙 대조 결과는 `docs/GAME-END-RULES.md`. 자가대국의 사이트 규칙 옵션은 아직 미구현.
- 규칙 차이 미확인 2건(평범한 수 1건, 브루투스 상태 차이), MCTS는 러스트가 생긴 뒤 평가(자바스크립트 시제품은 초당 약 7회 시뮬레이션).
- 로컬 부하 규칙: 코어 4개 이내(서브에이전트 포함), 무거운 작업은 클라우드, 프로세스는 `taskkill`로 종료.

## 지금 진행 중 (2026-09-22)

### 러스트 (보류)
평가함수(`evaluateState`)가 `isSquareAttacked`(전체 기물 공격 판정)와 카드 상태(`delayedHazards`)에 얽혀 있어 독립 포팅 불가로 확인(2026-09-22). 기물 11종 포팅도 카드 없이는 완전하지 않음. **지금은 손대지 않는다** — 참고는 `docs/RUST-PORT-REFERENCE.md`.

### AlphaZero L1 다섯 트랙 전부 진행 (2026-09-22, 사용자 지시: A-F 전부, 가능한 범위는 JS 안에서)
- [x] A1 정책 기록 구현/검증 (기존 완료)
- [ ] A2 클라우드 데이터 확정: cutoff(08:00 UTC) 넘긴 지 40분+인데 아직 in_progress, 계속 확인 중 -> 끝나면 변수 원복(SHARDS=[1..8], TARGET=150000, RECORD_POLICY=0, RECORD_STATE=0) -> `dataset-build.yml`로 20260920T124334Z 이후 데이터 묶기
- [x] B1 도구(`ordering-eval.js`) 로컬 소량 데이터로 재확인(MRR 0.30 vs 무작위 0.126)
- [ ] B1 클라우드 대량 데이터로 기준선 재측정
- [x] B2 파이프라인(`tools/policy/*`) 검증 및 커밋 완료
- [ ] B2 본 학습(클라우드 데이터로 `train-policy.js` 실행, 모델 저장)
- [x] B3 엔진에 `options.orderScoreFn` 옵션 연결(기본 꺼짐). `search-equiv.js` 100위치 diffs 0으로 기본 동작 무변화 확인, 커밋 완료.
- [x] B2 본 학습(클라우드, `policy-train.yml`): 검증 top1 19.9%/MRR 0.364 vs 기존 16.2%/MRR 0.313, 독립검증(score-actions.js) 일치. **B3 실측(15위치)은 unproven**: 노드 수 오히려 +2.9%, 고른 수 15개 중 3개 다름 -- "1등 맞히기"는 좋아졌지만 알파-베타 노드 절감으로는 아직 안 이어짐. 기본값 안 바꿈. 표본 늘려 재확인 여부 결정 필요
- [x] C1 기존 MCTS 시제품(`tools/mcts/mcts.js`) 재점검: `cfg.policyModel`로 학습된 정책을 사전 확률로 연결. 커밋 완료, 실제 모델 강도 평가는 B2 이후
- [ ] C2 같은 시간 알파-베타 vs MCTS 실험실 대전(핸디캡 1, 독립 재확인) — JS 한계 인지하고 참고용으로만 기록
- [x] D1 자가대국 루트 소프트맥스 샘플링 옵션 구현(`SELFPLAY_SAMPLE_TAU`). 로컬 검증(tau=150, 246개 중 72개 샘플링됨). 커밋 완료. 무승부율/다양성 오프라인 비교는 클라우드 데이터로 나중에
- [x] F 이식성 — 데이터 형식은 브리지 상태 JSON과 호환(이미 충족), `docs/RUST-PORT-REFERENCE.md`로 팀 러스트 작업과 연결 문서화 완료

## 클라우드 자가대국 대량 실행 (2026-09-20 밤 설정)
- 16샤드, 깊이 6/1500ms, `SELFPLAY_CUTOFF_ISO=2026-09-22T08:00:00Z`(화요일 17:00 KST), `SELFPLAY_TARGET=600000`, `SELFPLAY_RECORD_POLICY=1`, `SELFPLAY_RECORD_STATE=5`(5수마다 국면 저장), 라운드 시작 `20260920T124334Z`.
- 화요일 17시 이후 원복: `gh variable set SELFPLAY_SHARDS --body "[1,2,3,4,5,6,7,8]"`, `SELFPLAY_TARGET`=150000, `SELFPLAY_RECORD_POLICY`=0, `SELFPLAY_RECORD_STATE`=0. 그다음 `dataset-build.yml`(since `20260920T124334Z`)로 데이터셋을 만들고 `tools/policy/ordering-eval.js`로 기준선을 잰다.
- 데이터 브랜치(`gha-segments-16cards`) 용량이 크게 늘 수 있으니 저장소 크기를 확인한다.
