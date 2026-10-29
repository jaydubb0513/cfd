# Stirred-tank CFD

교반조(agitated vessel)의 설계값과 물성을 넣으면 유동장을 계산해 보여 주는 standalone HTML 생성기입니다. 그림은 [Anatomy](../.claude/skills/anatomy/) 스킬의 isometric kit로 그렸습니다. 탱크 앞쪽을 90° 쐐기 모양으로 잘라냈고, 잘린 두 액체 단면에 계산된 속도장과 입자 궤적을 표시합니다. 임펠러는 실제로 회전합니다.

## 사용법

```bash
node stirred-tank/build.mjs                                          # 기본 설정 → stirred-tank/out/stirred-tank.html
node stirred-tank/build.mjs --config stirred-tank/configs/dual-pbt.json
node stirred-tank/build.mjs --config my-tank.json --out report.html --light
```

만든 HTML은 외부 파일 없이 혼자 동작합니다. 브라우저에서 열고 왼쪽 패널에서 값을 바꾸면 바로 다시 계산합니다. **HTML 저장** 버튼을 누르면 지금 입력값이 들어간 새 standalone HTML이 저장되고, **설정 JSON 복사**를 누르면 `--config`에 그대로 넣을 수 있는 JSON이 복사됩니다.

키: `Space` 정지/재생 · `T` 트레이서 주입(시뮬레이션 혼합시간 측정) · `R` 유동 초기화

## 입력

| 구분 | 항목 |
|---|---|
| 용기 | 직경 T, 액 높이 H, 직동부 높이, 벽 두께, 바닥 헤드(flat / 2:1 ellipsoidal / torispherical F&D / hemispherical / conical + 꼭지각), 배플 수, 배플 폭 B/T |
| 임펠러 (최대 4개, 한 축) | 종류(Rushton, 45° pitched blade, hydrofoil, marine propeller, flat paddle, anchor), 직경 D, 바닥에서의 높이 C, 날개 수, 날개 폭 W/D, 피치 각(PBT), 토출 방향(축류형) |
| 구동 | 회전수 N [rpm] |
| 유체 | 프리셋 또는 밀도 ρ, 유변 모델: Newtonian(μ), power-law(K, n), Herschel–Bulkley(τy, K, n) |
| 표시 | 속도 크기, 단면 속도, 축/반경/선회 속도, 전단률, 겉보기 점도, 트레이서 · 컬러맵 · 테마 · 시뮬 속도 |

config JSON 형식은 [`configs/`](configs/)의 예제를 보세요. 빠진 값은 기본값으로 채우고, 범위를 벗어난 값은 잘라냅니다(`model.mjs`의 `normalize`).

## 출력

- **유동장**: 잘린 두 단면과 남은 액면 위의 색 지도, 입자 궤적, 회전하는 임펠러
- **상관식**: Re(Metzner–Otto 겉보기 점도), Np(날개 수·폭·피치·배플 보정), P, P/V, 토크, tip speed, Fr, Nq·Q, 순환시간, Grenville 혼합시간 θ95, Kolmogorov 길이, Elson 캐번 직경(항복응력 유체)
- **시뮬레이션**: 시뮬 토출량(Nq와 비교), 트레이서 혼합시간, 선회로 생긴 표면 와류 깊이
- **경고**: 날개와 바닥/액면/배플의 간섭, 얕은 잠김 깊이, 무배플 난류, 높은 tip speed 등

## 계산 방법

`solver.mjs`는 축대칭(r–z) 비압축성 Navier–Stokes를 선회 속도와 함께 MAC 격자(약 44 × 90)에서 풉니다.

- 이류: semi-Lagrangian(midpoint back-trace). 선회는 각운동량 r·v로 옮겨서 보존합니다.
- 점성: 국부 겉보기 점도 μ(γ̇)와 난류 와점성 ν<sub>t</sub> = 0.09 ε<sup>1/3</sup>(0.07T)<sup>4/3</sup>을 implicit(red-black Gauss–Seidel)으로 처리합니다. 벽은 층류에서 no-slip, 난류에서는 c<sub>f</sub>/2 ≈ 0.0015 벽함수입니다.
- 압력: 속도를 직접 고치는 red-black SOR 투영입니다.
- 임펠러: 날개를 격자로 표현하지 않고 스윕 영역에 운동량 source를 둡니다. 날개 속도의 일정 비율로 선회를 주고, 반경류·축류형은 토출 속도를 줍니다. 토출 세기는 시뮬 유량이 Q = Nq·N·D³가 되도록 실시간으로 보정합니다(actuator 모델).
- 배플: 벽 근처 선회에 대한 이차 항력입니다. 선회의 원심력 v²/r 때문에 Rushton 이중 루프와 무배플 와류가 생깁니다.

`model.mjs`에 있는 상관식 상수는 표준 형상 기준의 문헌값입니다. Rushton Np = 5, Kp = 70, Nq = 0.72, PBT Np = 1.27, Nq = 0.79 등을 썼습니다.

**한계**: 축대칭 모델이라 날개 후류 와류, 배플 뒤 박리, 자유표면 변형, 기포·고체 현탁은 다루지 않습니다. 설계 검토, 비교, 교육용 도구로 쓰고, 설계를 확정할 때는 3D RANS/LES나 실험으로 검증하세요.

## 파일

| 파일 | 내용 |
|---|---|
| `model.mjs` | 형상(헤드 profile, 액량), 유변학, 상관식, 입력 정규화 |
| `solver.mjs` | 축대칭 CFD solver, 트레이서, 토출량·와류 측정 |
| `figure.mjs` | Anatomy kit로 그린 cutaway 그림(부분 회전체 `revolve`, 임펠러 6종, 배플, 다리, 구동부) |
| `app.mjs`, `app.css`, `colormap.mjs` | 페이지: 입력 패널, 픽셀 매핑 유동 canvas, 입자, 결과, HTML 저장 |
| `bundle.mjs` | 모듈을 한 스크립트로 묶는 작은 번들러 |
| `build.mjs` | config → standalone HTML |
| `test.mjs` | 물리 sanity 테스트: `node stirred-tank/test.mjs` |
| `configs/*.json` | 예제: Rushton/물, 2단 PBT, 무배플 paddle, anchor/시럽, hydrofoil/원추 바닥, Carbopol 캐번 |
| `out/*.html` | 예제 config로 만든 페이지 |
