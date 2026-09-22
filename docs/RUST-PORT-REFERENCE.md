# 참고: 팀원의 러스트 룰 엔진 포팅 (sungjeahyun100/augment-chess-bot)

출처: https://github.com/sungjeahyun100/augment-chess-bot (공개, 팀원 개인 저장소, 2026-09-22 확인 기준 Phase 3 진행 중)
이 문서는 원본을 그대로 복사하지 않고 요약과 링크만 담는다. 원본이 갱신되면 이 요약은 낡을 수 있다.

## 무엇인가
사이트 JS 번들(해시 고정, `main-DsoigPgV.js`, 103,874줄)을 정적 분석해서 Rust로 룰 엔진을 새로 만드는 프로젝트. 우리 PLAN.md의 F(이식성) 트랙과 목표가 겹치지만, 훨씬 크고 이미 진행된 작업이다.

## 진행 상태 (저장소 문서 기준, 2026-09-18 최신 갱신)
- Phase 0: 번들 정적 분석 완료 — 상태 필드 292개, 카드 241개, RULE 27개 목록화.
- Phase 1: JS oracle/canonical schema 기반 작업 완료.
- Phase 2: 카드 없는 기본 규칙(이동/캐슬링/앙파상/승격/턴/왕 포획/행동불가패배/반복·별·데스매치) 완료. Rust 테스트 27개 + JS와 고정 68개 시나리오 + 100시드 무작위 대국(전이 10,560개) 통과.
- Phase 3: 변형 기물(거신병, 빅룩/빅숍, 상인, 마법사, 체커 연속잡기 등) 진행 중.
- Phase 4~9(효과/카드/드래프트/RULE/differential 대규모화/벤치마크)는 계획만 있고 미착수.

## 핵심 문서 (원본 저장소)
- `ENGINE_ANALYSIS.md` — 번들 구조, 상태 필드 292개 매핑, 위험 지점(clone 두 경로의 차이 등).
- `RULE_INVENTORY.md` — 카드/기물/RULE 전체 목록.
- `PORTING_PLAN.md` — Phase 0~9 단계별 계획과 통과 기준.
- `SITE-REFERENCE.md` — **사이트 내부 state를 직접 읽거나 수정하지 않는다**(과거 화면 멈춤 경험). DOM 관찰 + UI 이벤트만 쓰는 어댑터 구조 권장. 우리 크롬 확장(`extension/content.js`)에도 적용 가능한 원칙.
- `engine/` — 실제 Rust 크레이트 소스(`state.rs`, `movement.rs`, `victory.rs`, `castling.rs` 등)와 테스트/fixture.
- `tools/phase2_differential.cjs`, `tools/phase3_differential.cjs` — JS와 Rust를 무작위 시드로 비교하는 differential 테스트 도구.

## 우리 작업과의 관계
- 이 저장소가 완성되면 우리가 지금 하려던 "루트 안전 검사 함수만 좁게 Rust로 포팅" 실험보다 훨씬 포괄적인 기반이 된다. **중복 작업을 피하려면 팀 채널에서 먼저 조율하는 게 낫다.**
- `SITE-REFERENCE.md`의 원칙(내부 state 직접 조작 금지)은 우리 확장에도 바로 적용 가능 — `content.js`가 DOM/이벤트 기반인지 점검할 가치 있음.
- `RULE_INVENTORY.md`/`ENGINE_ANALYSIS.md`는 우리 `docs/GAME-END-RULES.md`(3회 동형반복, 45수, 데스매치, 별 합계 비교)와 겹치는 부분이 있어 교차 검증에 쓸 수 있다.

## 다음에 할 일 (사람 판단 필요)
- 팀(Accelerate)에게 이 저장소가 team `rust-engine/` 트랙과 같은 것인지, 병합·조율 계획이 있는지 확인.
- 우리 쪽에서 별도로 Rust 포팅을 진행하기보다, 이 엔진의 differential 통과 여부를 지켜보며 우리 JS 규칙 문서(GAME-END-RULES.md 등)와 대조하는 역할로 좁히는 게 효율적일 수 있음.
