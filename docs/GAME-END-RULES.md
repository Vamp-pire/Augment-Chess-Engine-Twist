# 게임 종료 규칙 (사이트 메인 번들 기준, 2026-09-19 번들)

출처: 사이트 메인 번들의 게임 로직(`checkRepetitionOrStarLimit`, `recordPosition`, `positionKey`, `noteCardEvent`, `resolveStarTiebreak`, `deckStarTotal`, `isStarLimitReached`, `sharedTurnCount`, `startDeathmatch`, `tickDeathmatchAfterTurn`, `markDeathmatchProgress`). 스냅샷은 `site-oracle/site-bundle-20260919.js`.
이 규칙들은 사이트의 AI 워커가 아니라 메인 번들에 있어서 `tools/site-parity`(워커 대조)로는 검증되지 않습니다. 확인한 것은 번들 코드를 읽은 결과입니다.

## 1. 3회 동형반복
- 매 수 뒤 `recordPosition()`이 위치 키의 등장 횟수를 셉니다. 2번째면 경고, **3번째면 `resolveStarTiebreak("3회 동형반복")`으로 종료**(무승부가 아님, 아래 3번).
- 위치 키 = `차례 | repetitionSalt | 정렬된 기물 목록`. 기물 항목은 `행,열:색:종류:hp:ammo:frozen`이고, 벽(`wall`)은 제외하며 같은 `id`(2x2 기물)는 한 번만 셉니다. **카드 상태, `moved`, 캐슬링 권리, 앙파상, 잡힌 기물은 키에 없습니다.**
- 카드 이벤트(`noteCardEvent`: 카드 획득, 박스 공개, 패시브 발동 등)가 생기면 `repetitionSalt`가 1 늘고 횟수 표가 비워집니다(그 전 국면은 새 국면 취급).
- 샷건 킹 페널티 대상(`shotgunPenaltyColor`)이 있으면 동형반복 검사 자체를 하지 않습니다.

## 2. 45수와 연장전
- `sharedTurnCount() = min(turnsTaken.white, turnsTaken.black)`, `starWinLimit` 기본 45. 이 값이 45 이상이 되면(수 뒤와 카드 사용 뒤에 검사):
  - `deathmatchEnabled`가 켜져 있으면(기본값: `deathmatchEnabled !== false`, 즉 기본 켜짐) **연장전 시작**, 게임은 계속됩니다.
  - 꺼져 있으면 즉시 `resolveStarTiebreak("45수")`로 종료합니다.
- 연장전 상태: `{active, startedAtTurn, halfTurnsSinceProgress, intervalHalfTurns = 제한 턴 수 x 2, progressThisTurn}`, 제한 턴 수 기본 10(`DEATHMATCH_DEFAULT_INTERVAL_TURNS`, 계시 모드는 5).
- `tickDeathmatchAfterTurn(movingColor)`는 **흑이 둔 뒤에만** 동작합니다. 그 턴에 진행(progress)이 있었으면 게이지를 0으로 되돌리고, 없었으면 `halfTurnsSinceProgress += 2`, 값이 `intervalHalfTurns`(기본 20) 이상이 되면 `resolveStarTiebreak("")`로 종료합니다. 즉 **진행 없이 10라운드**가 지나면 종료입니다. 종료 2 하프턴 전부터 경고를 냅니다.
- 진행으로 인정되는 것(`markDeathmatchProgress`, 호출 지점 22곳): **폰 이동**, **기물 포획과 제거 효과**(카드, 정리, 트롤리, 게일 등), **액티브 카드 사용**(패시브가 아니고 phase가 RULE이 아닌 카드).

## 3. 종료 판정 `resolveStarTiebreak`
1. 샷건 킹 페널티 대상(샷건 킹 기물이나 `shotgun-king` 카드를 가진 쪽)이 있으면 **그 쪽이 패배**합니다.
2. 아니면 각 색의 `deckStarTotal`(덱 슬롯에 있는 카드 전부의 별 합계, 사용 여부 무관)을 비교해 **더 적은 쪽이 승리**하고, 같으면 무승부입니다.

## 4. 그 밖의 종료
킹 포획(`king_capture`), 합법 수 없음(`no_legal_move`, 움직일 수 없는 쪽이 패배), 시간패, 기권, 무승부 합의, 예언(`prophecy`), 오목, 하이랜더, 트로이 목마, 왕관 보유, 환경 효과 무승부/패배, 캠페인 목표, 깃발 탈취, 레이싱 킹, 종교 승리, 더블 체크, VIP 포획, 리퍼 처형, 헤럴드 근접, 민주주의 무승부 등이 있고 대부분 카드나 모드에 묶여 있습니다.

## 5. 우리 자가대국 규칙과의 차이 (`selfplay-worker-merged.js`)
우리 자가대국은 3회 동형반복을 **무승부**로, 50수 무진행을 무승부로 처리합니다. 사이트 규칙이 아닙니다. 그래서 자가대국의 무승부(40~57%)에는 규칙 차이가 섞여 있고, 사이트 규칙으로 바꾸면 무승부가 크게 줄고 결과가 별 합계 비교로 갈릴 것입니다. 바꿀 때는 옛 데이터와 라벨이 섞이지 않게 옵션으로 넣고 데이터를 구분해야 합니다.

구현 메모(사이트 규칙을 따를 때): 위치 키와 카드 이벤트 초기화, 진행 판정(폰 이동, 포획, 액티브 카드 사용), 흑 이동 뒤에만 게이지 갱신, 45수 이후 연장전 시작, 별 합계 비교, 샷건 킹 예외.

## 6. 남은 확인
- 각 카드가 "액티브"인지와 phase 구분은 카드 정의를 봐야 합니다(진행 인정 범위).
- `starWinLimit`, `deathmatchLimitTurns`가 모드별로 바뀌는지(계시 모드 5턴 상수의 사용 조건)는 확인하지 않았습니다.
