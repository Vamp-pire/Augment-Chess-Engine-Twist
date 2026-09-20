# TODO

역할: 남은 일과 사용자 몫만 적는 문서입니다. 계획과 기준은 `PLAN.md`, 실험 결과와 발견은 `ExperimentNote.md`, 프로젝트 지도는 `PROJECT.md`입니다.
마지막 갱신: 2026-09-20.

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
