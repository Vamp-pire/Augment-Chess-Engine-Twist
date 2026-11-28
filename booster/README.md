# booster (AI 부스터 엔진 실험)

> **원작자: siho4690 (디스코드).** 부스터 확장과 `fast-engine.js`는 원작자가 만든 것이고, 여기 있는 것은 실험용으로 고친 사본입니다. 원작자의 조건(배포 금지)에 따라 확장 본체(페이지 스크립트, 설치용 파일)는 이 저장소에 올리지 않습니다.

증강 체스 AI 부스터(크롬 확장)의 빠른 탐색 엔진 `fast-engine.js`와 NNUE 실험 도구입니다. 확장 본체와 사이트 코드는 여기에 두지 않습니다(작업 사본: `D:\augmentchess-ai-booster`).

- `tools/gen-data.cjs`: 엔진 자가대국(카드 기물 무작위 배치)으로 학습 데이터 생성
- `tools/train-nnue.cjs`: NNUE 학습(두 관점 누산기, 은닉 H, clipped ReLU)
- `tools/engine-match.cjs`: 엔진 대 엔진 대국(`--nnue-a/--nnue-b`)
- 워크플로: `.github/workflows/booster-nnue.yml` (생성 20작업 → 학습 → 대국)
