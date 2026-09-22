# WASM PoC 결과 (2026-09-22)

## 무엇을 했는가
`engine-merged.js`의 `evaluateState` 하위 함수 중 `positionalScore()` /
`pieceSquareBonus()` / `centerControlBonus()`(약 16093~16158줄)를 참고해,
**보드 8x8을 순회하며 기물별 위치 점수 + 센터 컨트롤 점수를 더하는 계산 핵심부**를
AssemblyScript로 재구현했습니다.

- AssemblyScript 툴체인: `npm install --save-dev assemblyscript` (루트 `package.json`에
  devDependency로 추가). 컴파일러는 `node_modules/.bin/asc`.
- 소스: `wasm-poc/assembly/index.ts` → `wasm-poc/build/index.wasm` (752 bytes,
  `--runtime stub --optimize -O3`로 빌드, GC/allocator 없음).
- JS 대조군: `wasm-poc/js-reference.js`의 `positionalScoreCoreJS` — AssemblyScript
  버전과 라인 단위로 동일한 로직을 손으로 맞춰 작성(같은 PR 안에서 나란히 관리).
- 벤치마크: `wasm-poc/bench.js`.

**이번 범위에서 뺀 것 (정직하게 명시):**
- 카드/캠페인/레이싱킹/critical-piece 분기 없음 (`isWorkerKingRole`,
  `workerHasRacingKingObjective`, `isCritical`, `isSquareAttacked` 등 —
  boardState 전체를 참조하는 무거운 헬퍼라 이번 PoC 범위 밖).
- `isEndgame()` 플래그 없음 (자체적으로 보드를 한 번 더 순회하고 캡처/무브카운트
  상태에 의존).
- 표준 기물 종류(pawn/knight/bishop/rook/queen)만 채점, 나머지는 `positionalScore`의
  fallback 분기(`center * 16`)로 처리.
- `centerControlBonus`의 `attacksSquare`는 차단(blocker)/핀 없는 단순화된
  reach 모델로 대체(직선/대각선 여부만 체크).

즉 **실제 엔진의 `positionalScore()`와 100% 동일한 출력을 내지는 않습니다.**
계산 패턴(보드 순회 + 기물별 숫자 연산 반복)은 그대로 옮겼지만, 엔진 전체 포팅
난이도를 가늠하기 위한 "핵심 계산부 축소판"입니다.

## 보드 인코딩
JS→WASM 경계에서 JSON 파싱은 하지 않고, JS 쪽에서 미리 `Int32Array`(길이
rows*cols, row-major)로 인코딩:
- `0` = 빈 칸
- `+typeId` = 흰색 기물, `-typeId` = 검은색 기물
- typeId: 1=pawn, 2=knight, 3=bishop, 4=rook, 5=queen, 6=기타/wall(스킵)

WASM 쪽은 `--runtime stub`(GC/allocator 없음)이라 관리형 `Int32Array`를 직접
파라미터로 받을 수 없어서, 함수가 **raw 메모리 포인터(usize)** 를 받고
`load<i32>()`로 읽습니다. 호출자는 매 호출마다 `Int32Array` 뷰로 wasm 선형
메모리에 보드를 `.set()`으로 써넣습니다 — `@assemblyscript/loader` 불필요.

## 벤치마크 방법
`wasm-poc/bench.js`: 동일한 랜덤 보드(결정론적 PRNG로 고정 시드) 하나를
`ITERATIONS`번(1만~10만) 반복 호출. **JS↔WASM 경계 비용 포함** — 매 호출마다
보드를 wasm 메모리에 다시 write한 뒤 export 함수를 호출(루프 밖에서 한 번만
쓰고 wasm만 반복 호출하는 식의 "치팅"은 하지 않음). `process.hrtime.bigint()`로
측정.

## 실제 수치
4회 실행 (Windows, Node v24.19.0):

| iterations | JS time | WASM time | JS us/call | WASM us/call | ratio (JS/WASM) |
|---|---|---|---|---|---|
| 50,000  | 53.54ms | 45.81ms | 1.0708 | 0.9163 | **1.169x** (WASM 승) |
| 20,000  | 27.48ms | 19.25ms | 1.3738 | 0.9626 | **1.427x** (WASM 승) |
| 100,000 | 99.85ms | 86.19ms | 0.9985 | 0.8619 | **1.158x** (WASM 승) |
| 100,000 | 84.07ms | 89.50ms | 0.8407 | 0.8950 | **0.939x** (JS 승) |

모든 실행에서 `results match: true` (JS와 WASM 결과값 완전 일치, 부동소수
오차 없음 — 정수 연산 위주라 당연한 결과).

## 결론 (솔직하게)
- **속도 이득이 크지 않습니다.** 4회 중 3회는 WASM이 근소하게(1.16~1.43배)
  빨랐고, 1회는 오히려 JS가 더 빨랐습니다(0.94배). V8 JIT이 이 정도로 단순한
  정수/부동소수 루프는 이미 상당히 최적화하고, 매 호출마다 `Int32Array.set()`으로
  64개 셀을 wasm 메모리에 복사하는 경계 비용이 WASM 쪽 이득을 상당 부분 상쇄합니다.
- 즉 **"WASM이 순수 속도만으로 압도적 이득을 준다"는 가설은 이 PoC 규모(8x8,
  64칸, 함수 하나)에서는 기각**에 가깝습니다. 오차범위 안에서 왔다갔다 하는
  수준(±40%)이라 "명백히 빠르다"고 주장하기 어렵습니다.
- 이 결과가 시사하는 것: WASM 이득은 (a) 함수 호출당 계산량이 충분히 크거나
  (b) JS↔WASM 경계를 한 번만 넘고 여러 턴을 WASM 내부에서 처리(예: 탐색 전체를
  WASM에 넣고 최종 결과만 받기)할 때 나타날 가능성이 높습니다. 지금처럼
  "평가함수 한 조각만 WASM, 나머지는 JS"인 구조로는 매 호출 경계비용 때문에
  기대만큼의 이득이 안 나올 수 있습니다.

## 전체 엔진 포팅으로 확장한다면 뭐가 어려울지
- **카드/특수기물/캠페인 상태 의존성**: `evaluateState`의 실제 분기 대부분이
  `boardState`(카드, 캡처 풀, 캠페인 플래그, staked/frozen 상태 등)를 참조합니다.
  이걸 AssemblyScript로 옮기려면 JS 객체 그래프를 통째로 숫자 배열/구조체로
  재인코딩하는 설계가 선행되어야 하는데, 이번 PoC에서 손댄 `positionalScore`
  서브셋보다 훨씬 큰 작업입니다.
- **`isSquareAttacked`**: 코드 주석에도 있듯("Grafted from engine.optimized.js...
  isSquareAttacked was measured as evaluateState's dominant cost") 이게 진짜
  병목인데, 슬라이딩 기물 이동 로직 전체(레이 캐스팅, 장애물 처리, 카드로 인한
  이동 규칙 변경)를 포팅해야 해서 이번 축소판보다 난이도가 훨씬 높습니다.
- **경계 비용**: 이번 벤치마크처럼 평가함수 하나만 WASM으로 옮기고 매 노드마다
  JS↔WASM 경계를 넘나드는 구조라면, 탐색 트리가 깊어질수록(초당 수만~수십만
  노드) 경계비용 누적이 이득을 깎아먹을 가능성이 큽니다. 의미 있는 이득을
  보려면 탐색(alpha-beta) 자체를 WASM 안으로 넣어 보드 상태를 유지한 채
  여러 수를 평가하고 최종 결과만 JS로 반환하는 구조가 필요해 보이는데, 이건
  이번 PoC보다 훨씬 큰 재설계입니다.
- **결론**: 이번 좁은 PoC 결과만 보면, "평가함수 일부만 WASM으로 뽑아내는"
  방식으로는 투자 대비 속도 이득이 불확실합니다. 팀원이 진행 중인 러스트 포팅
  (전체 엔진 재작성) 쪽이 더 근본적인 해법일 가능성이 높고, WASM PoC는 현재
  규모로는 추가 투자를 권하기 애매한 결과입니다.
