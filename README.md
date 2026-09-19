# 증강체스 엔진 (Augment Chess Engine Twist)

[![CI](https://github.com/Vamp-pire/Augment-Chess-Engine-Twist/actions/workflows/ci.yml/badge.svg)](https://github.com/Vamp-pire/Augment-Chess-Engine-Twist/actions/workflows/ci.yml)

[augmentchess.org](https://augmentchess.org)의 **증강체스**(카드와 특수 기물이 있는 체스)를 위한 비공식 AI 엔진과 크롬 확장입니다.
사이트의 AI 규칙을 그대로 따라 하는 엔진 위에, 자기대국으로 학습한 신경망 평가 모델(NNUE)을 얹었습니다.

> 이 프로젝트는 augmentchess.org와 무관한 개인 프로젝트입니다.
> An unofficial AI engine and Chrome extension for the card-and-special-piece chess variant on augmentchess.org, with a self-play-trained NNUE evaluator.

## 크롬 확장으로 쓰기

1. 이 저장소를 내려받습니다(`Code` → `Download ZIP`, 또는 `git clone`).
2. 크롬에서 `chrome://extensions`를 열고 오른쪽 위 **개발자 모드**를 켭니다.
3. **압축해제된 확장 프로그램을 로드합니다**를 눌러 저장소의 `extension` 폴더를 선택합니다.
4. [augmentchess.org](https://augmentchess.org)에 접속하면 확장이 자동으로 동작합니다.

확장이 하는 일:

- **리뷰(분석)**: 진행한 판을 분석합니다. 기보(ACG) 파일을 끌어다 놓아도 됩니다.
- **NNUE 평가**: 리뷰와 봇 대전에서 학습된 신경망 평가를 쓸 수 있습니다. "NNUE 모델" 드롭다운에서 **Squall**(기본)과 **Tornado** 중에서 고를 수 있고, 선택은 저장됩니다.
- **봇 대전**: 일반 기물 위주의 수는 Stockfish에, 특수 기물·카드·능력이 얽힌 수는 이 프로젝트의 엔진에 맡깁니다(Stockfish는 이 게임의 특수 규칙을 모르기 때문입니다).
- **성능 패널**: 깊이별 소요 시간, 탐색 노드 수, 평가값 추이, 사용한 평가기를 보여 줍니다.

> 알려진 한계: 실제 크롬에서 전체 흐름을 자동으로 시험하지는 못했습니다. 문제가 보이면 이슈로 알려 주세요.

## 어떻게 동작하나요

```
사이트 규칙 ──▶ engine-merged.js (엔진) ──▶ 자기대국 ──▶ 학습 데이터 ──▶ NNUE 학습 ──▶ 확장의 모델
                     ▲                                                       │
                     └───────────── 확장(extension/)이 같은 엔진과 모델을 사용 ◀┘
```

- **엔진**(`engine-merged.js`): 사이트의 AI 코드를 기준으로 카드·기물 규칙을 맞춘 검색 엔진입니다. 사이트가 업데이트되면 `tools/site-parity`로 사이트 AI와 같은 판에서 같은 수를 내는지 대조합니다.
- **NNUE**: 엔진이 뽑는 21개 평가 특징에 기물 위치와 보유 카드를 더한 5,509개 입력을 받는 작은 신경망입니다. 자기대국 데이터로 학습합니다.
- **자기대국·학습**은 GitHub Actions에서 돌아갑니다(공개 저장소라 무료). 진행 상황과 실험 기록은 [`TODO.md`](TODO.md)에 있습니다.

## 저장소 안내

| 경로 | 내용 |
|---|---|
| `engine-merged.js` | 엔진 본체 |
| `extension/` | 크롬 확장(엔진 사본과 학습된 모델 포함) |
| `nnue/` | 학습·평가 코드와 모델 가중치 |
| `selfplay-*-merged.js` | 자기대국 실행기 |
| `tools/` | CI 검사, 사이트 대조, 속도 검증 도구 |
| `.github/workflows/` | CI, 자기대국, 학습, 모델 대전, 데이터셋 조립 |

자세한 구조와 명령은 [`PROJECT.md`](PROJECT.md), 지난 경과는 [`HANDOFF.md`](HANDOFF.md)를 보세요.

## 개발

Node.js 22 이상이 필요합니다. 엔진 검사는 외부 패키지 없이 돌아갑니다.

```bash
node smoke-merged.js               # 엔진 스모크 테스트
node tools/ci/golden-eval.js       # 평가값이 바뀌지 않았는지
node tools/ci/nnue-parity.js       # 확장의 NNUE 점수 == 학습 코드의 점수
npm install                        # 학습(nnue/train.js)을 돌릴 때만 필요
```

푸시할 때마다 CI가 위 검사를 자동으로 실행합니다. 엔진을 고쳤다면 `extension/engine.js`도 함께 갱신해야 합니다(방법은 `PROJECT.md`).

## 피드백

이상한 수, 너무 오래 걸리는 판, 카드 처리 오류 같은 것은 이슈로 남겨 주세요. 어느 판인지 기보(ACG)를 함께 주시면 가장 도움이 됩니다.

## 라이선스

직접 작성한 부분은 **CC BY-NC-ND 4.0**입니다. 출처를 밝히면 **비영리 목적으로, 수정하지 않은 상태 그대로** 공유할 수 있습니다.
사이트에서 파생된 엔진·자료, 확장에 포함된 Stockfish(GPL-3.0), 외부 아이콘은 이 라이선스의 대상이 아니며 각자의 권리자와 조건을 따릅니다.
자세한 범위는 [`NOTICE.md`](NOTICE.md), 전문은 [`LICENSE`](LICENSE)를 보세요.
