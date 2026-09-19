# site-oracle: 사이트 진짜 로직을 Node에서 직접 실행하는 오라클

2026-09-13, 실측 카드 검증 신뢰도 문제 때문에 만듦. `site-engine.mjs`는
augmentchess.org의 실제 프로덕션 번들(`main-CCLgAXZJ.js`, 난독화 안 됨)을
그대로 가져와서, Node에서 로드 가능하도록 두 가지만 패치한 것:
1. 끝부분의 자동 부트 시퀀스(`resetGame()`, 렌더링 호출 등)를 `try/catch`로
   감쌈 — DOM/캔버스가 없어서 렌더링은 실패하지만 게임 상태 초기화는
   그 전에 이미 끝나 있어서 문제 없음.
2. 파일 맨 끝에 `export { state, resetGame, renderAll, pawnMoves,
   canCaptureTarget };` 추가 — ESM의 라이브 바인딩 덕분에 `state`를
   import한 뒤에도 내부에서 재할당될 때마다 최신값을 볼 수 있음.

## 사용법

```bash
cd D:/증강체스엔진/site-oracle
node --import ./init.mjs --input-type=module -e '
import("./site-engine.mjs").then((mod) => {
  const { state, pawnMoves, canCaptureTarget } = mod;
  // state.board를 원하는 대로 조작 후 실제 사이트 함수 호출
  console.log(pawnMoves(6, 4, "white"));
});
'
```

또는 스크립트 파일로 만들어서 `node --import ./init.mjs script.mjs` 형태로
실행 (반드시 `--import ./init.mjs`로 브라우저 전역 스텁을 먼저 로드해야
함, 안 그러면 `window is not defined` 등으로 즉시 죽음).

`init.mjs`는 `window`/`document`/`localStorage`/`Image`/타이머 등을
최소한으로 흉내낸 것 — 렌더링/네트워크는 전혀 진짜로 동작 안 하고,
게임 로직(보드/기물/카드 상태 계산)만 진짜로 동작함. 렌더링 관련 잔여
에러는 `process.on("uncaughtException"...)`로 무시하도록 처리해둠(진짜
게임로직과 무관).

## state 구조 참고
- `state.board[row][col]` — row 0 = 8랭크(흑 기본 진영), row 7 = 1랭크(백)
- `state.turn` — "white"/"black"
- `state.pawnLeap`, `state.pawnConversion` 등 카드별 boolean 플래그는
  `{white, black}` 형태

## 지금까지 확인된 주요 내보내기 가능 함수 (필요하면 export 목록에 추가)
- `pawnMoves(row, col, color)` — 폰 이동 생성 (마지막 인자로 movementPiece
  넘기는 우리 엔진과 시그니처가 약간 다를 수 있음, 실제 시그니처는
  `site-engine.mjs`에서 `function pawnMoves(` grep해서 확인)
- `canCaptureTarget(color, target, attackerType, attacker, options)` —
  포획 가능 여부 판정 (site-engine.mjs:80652 부근)
- `applyCard(card2, target)` / `applyCardEffect(card2, target)` —
  카드 효과 적용 진입점 (site-engine.mjs:82205/82218 부근) — **아직
  직접 호출 테스트는 안 해봄, 카드 검증에 쓰려면 먼저 시그니처/부작용
  확인 필요**
- `resetGame(false)` — 새 게임으로 `state` 리셋 (렌더링 호출 부분은
  이미 try/catch로 감싸져 있어서 안전)

새 함수를 export하고 싶으면 `site-engine.mjs` 맨 끝의 `export { ... };`
줄에 이름 추가하면 됨(재배포판이라 원본 `main-CCLgAXZJ.js`와는 이제
다름 — 원본은 스크래치패드의 예전 위치나 `curl`로 재다운로드해서 새로
패치할 것, 이 폴더의 site-engine.mjs를 직접 두 번째로 patched하는 건
괜찮음).

## 카드 227개 / 기물 61종 전수조사에 쓰는 법 (권장 워크플로)
1. 검증하려는 카드/기물 하나마다: 우리 엔진(`engine.optimized.js`)과
   오라클 양쪽에 **동일한 보드 상태**를 손으로 구성.
2. 오라클에서 해당 기능(이동생성/포획판정/카드효과) 호출 → 결과 캡처.
2. 우리 엔진의 동일 함수(또는 `generateActions`로 감싸서) 호출 → 결과 비교.
3. 다르면 실제 버그 — 오라클 쪽이 정답이므로 우리 엔진을 그에 맞춰 수정.
4. 가능하면 수동으로 한 시나리오씩 하지 말고, 무작위 보드+카드 상태를
   여러 개 생성해서 자동으로 반복 비교하는 스크립트로 확장할 것
   (지금은 이 README를 쓴 시점 기준 수동 시나리오 1건만 검증됨: leap
   카드의 직선 케이스, 완전 일치 확인됨).

## 2026-09-19 갱신: 번들 통째로 교체
사이트 최신 업데이트(2026.09.19 03:50 "balance-remakes-v1")에 맞춰 옛 스냅샷을 지우고 새로 받음.
- 원본 보관: `site-bundle-20260919.js`(= `main-DYyN_QDn.js`), `aiWorker-fresh-20260919.js`(= `aiWorker.js`),
  청크 `zugzwang-C0ejyPig.js`, `betaSupabaseAuth-BM9hgzr_.js`, `modulepreload-polyfill-COaX8i6R.js`
- `site-engine.mjs`는 `site-bundle-20260919.js` 끝에 `export { ... };` 한 줄만 붙인 것. 예전처럼 부팅 구간을
  `try {}`로 감싸지 않음 — 새 번들은 부팅 뒤에도 함수 선언이 2,800줄 섞여 있어서, 블록으로 감싸면 함수가
  블록 스코프에 갇혀 `addInternalPawnMoves is not defined`가 남. 대신 `init.mjs`의 DOM 흉내를 보강함
  (`querySelector`/`parentElement`/`HTMLElement` 등).
- 다시 받을 때: 위 5개 파일을 `https://augmentchess.org/assets/`에서 받고, 옛 `export { ... };` 줄을 끝에 붙임.
- `verify1`/`verify2`의 실패 6건은 오라클 오류가 아니라 9/13 기준 기대값이 새 판정과 달라진 것(상인 왕 판정 등).

## 2026-09-19: 자동 패리티 도구
`tools/site-parity/`에 사이트 실제 AI 워커(`aiWorker.js`)와 `engine-merged.js`를 차분 비교하는 스크립트가 있음
(generateActions / 단일 액션 적용 / 다중 수 플레이아웃, 사이트 업데이트 감지 `check-site-update.js`).
사용법은 `tools/site-parity/README.md`, 발견된 차이의 분류와 수정 제안은 `tools/site-parity/TRIAGE.md`.
