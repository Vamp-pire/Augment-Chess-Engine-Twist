# ExprimentNote (실험 세팅과 비율 기록)

마지막 갱신: 2026-09-20. 결과 원본은 `docs/results/results.jsonl`, 계획은 `PLAN.md`.

## 1. 데이터

| 이름 | 국면 수 | 수집 설정 | 비고 |
|---|---|---|---|
| Round 1 | 218,007 | 깊이 3 이하, 90%가 깊이 1 | 옛 규칙 |
| Round 2 | 112,981 | 깊이 5(명목), 91%가 깊이 1 | Squall 학습 데이터 |
| Round 3 (`round3-full`) | 150,415 (목표 150,000) | 깊이 6, 수당 1500ms, 8샤드, 시작 2026-09-19T03:53Z | 깊이 2~6 라벨, `since=20260919T035300Z` |
| 검증 세트 `val-mix1` | - | R2 꼬리 + R3 꼬리 | R3 일부가 학습과 겹칠 수 있음(정확도는 참고용) |

- 자가대국 변수(저장소 변수): `SELFPLAY_SHARDS`(8), `SELFPLAY_DEPTH`(6), `SELFPLAY_MS`(1500), `SELFPLAY_TARGET`(150000), `SELFPLAY_ROUND_START`, `SELFPLAY_CUTOFF_ISO`(백스톱 2026-09-22T04:00Z).

## 2. 학습 세팅 (`nnue/train.js`, `nnue-train.yml`의 overrides)

| 항목 | 값 / 의미 |
|---|---|
| 입력 | 5509 = 말 평면 40x128 + 카드 184x2 + 특징 21 |
| 구조 | wide & deep, deep 유닛 기본 16 (`ablateDeepUnits`, 8도 시험) |
| 라벨 | `(1-w) * 승패 + w * tanh(검색점수/400)` |
| 기본 검색 비중 w (`ablateBlend`) | 0.15 (실험: 0.3~1.0) |
| 깊이별 비중 (`blendByDepth=1`) | 깊이 1,2,3,>=4 -> 0.25, 0.45, 0.65, 0.8 (`blendDepthMap`) |
| 잔차 (`residual=1`) | 라벨 = tanh((검색점수 - evalBefore) / `residScale`); 검색 점수 없는 국면은 0 |
| 잔차 계수 | 150 / 300 / 600 (사용 시 `@hybrid<계수>`) |
| 종료 시점 가중 | 게임 끝까지 남은 수 `pliesFromEnd` 기준 0.98^n 감쇠 |
| 웜스타트 스케일 | 0.001 (`ablateWarmStart`) |
| 오버샘플 | 1.5 (`ablateOversample`) |
| 저장 | `save_model=<이름>` -> 데이터 브랜치 `models/<이름>.json` |

## 3. 출력 매핑 (대전 사양 `<모델>@<맵>`)

- `atanh<K>`: K * atanh(출력), 학습 압축 tanh(점수/400)의 역, 보통 `atanh400`
- `hybrid<K>`: 수제 평가 + K * 출력 (잔차 모델용)
- `lin<K>`: K * 출력, 기본(맵 없음)은 x100(`SCORE_SCALE`)

## 4. 대전 세팅 (`match.yml`, `tools/lab/lab.js`)

- 색 교환 짝(같은 시드에서 색만 바꿈), 4샤드, 총 게임 = 4 x pairs_per_shard x 2
- 기본: `ms=300`, `depth=3`; 실험실 기본 후보 대전은 `pairs_per_shard=12`, `handicap=1`
- `handicap=N`: 시드로 고른 한쪽에서 비퀸 말 N개 제거(짝은 같은 쪽이 손해라 공정). 무승부: 핸디캡 0 약 57%, 1 약 41~45%, 2 약 39%
- `seed_offset`: 짝 번호에 더해 독립 재실행. `params_a/b`: 검색 파라미터 (`nullMoveMinDepth`=3, `nullMoveReduction`=2, `lmrMinDepth`=3, `lmrMoveThreshold`=4, `quiescenceMaxPlies`=6이 기본)
- 판정(`verdict.json`): win = 95% 구간(Wilson) 하한 > 50%, lose = 상한 < 50%, 그 외 unproven
- 구분 가능한 차이(80% 검정력): 결정 45판 약 +-21p, 결정 100판 약 +-14p, +-5p에는 약 784판

## 5. 엔진 시간/깊이 세팅

- 확장 "우리 엔진": `augEngineOwnMaxDepth`, `ThinkTimeMs`, `MinDepth`, `Extend`(시간 연장)
- 시간 연장 옵션(`limits`): softMs, hardMs(상한 1.5x), extendOn, minDepth, extendMinProgress, predictiveStop, maxNodes
- 속도 개선 누계: 이전 엔진 대비 약 2.2배 (카드 국면 포함, 노드/컷오프 동일)

## 6. 결과 요약 (수제 평가 상대, 후보 = A)

| 후보 | 승률(결정판) | 95% 구간 | 판정 |
|---|---|---|---|
| resid150-r3f @hybrid150 | 44.4% (54) | 32.0-57.6 | unproven |
| resid300-r3f @hybrid300 | 53.1% (49) | 39.4-66.3 | unproven |
| resid600-r3f @hybrid600 | 45.6% (57) | 33.4-58.4 | unproven |
| **blenddepth-r3f @atanh400** | **66.0% (53)** | 52.6-77.3 | **win (재확인 진행 중)** |

- 그 외 참고: 시간 연장 40승 31패(56%, 합계), 깊이 3 대 2 약 57%(61판), 옛 Squall 대비 등은 모두 오차 범위 안.
- 진행 중: 재학습 3종(resid300-du8, blend08, blenddepth-du8) 대전, blenddepth 독립 재확인(offset 1000, 핸디캡 0/1)

## 7. 통과 기준 (수정본)

- 출시(확장 기본 모델 등)는 95% 구간 하한이 50% 위이고, 독립 재실행에서도 같은 방향일 때만.
- 속도/무회귀 변경은 결과 동일(고른 수, 점수, 노드, 컷오프)로 판정, 기계가 한가할 때 검증.
- 후보를 여러 개 시험하면 우연 통과 가능성(4개 중 약 19%)이 있으므로 반드시 재확인한다.
