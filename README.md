# Hybrid Harness

`hybrid-harness`는 Pi extension 전용 hybrid coding harness입니다. 로컬 Qwen 계열 모델이 고토큰 구현/수정/debug 루프를 맡고, frontier 모델은 요구사항/설계/리뷰/final gate처럼 품질 영향이 큰 판단에 집중하도록 설계되어 있습니다.

이 저장소는 이제 **Pi package만** 제공합니다. 이전 Codex/OpenCode용 bridge/plugin 패키지는 제거되었습니다.

## 핵심 구조

```text
Parent Pi session = persistent orchestrator
  └─ spec-kit의 spec.md / plan.md / tasks.md를 보고 다음 batch/package 판단
  └─ hybrid_exec tool에 실행 패키지 전달

Hybrid harness runtime
  └─ 실행 패키지를 .pi-harness/orchestrator-package.md로 기록
  └─ persistent single-writer Pi session으로 구현/repair/debug 실행
  └─ verification, local review, progress/evidence artifact 수집

Parent Pi session
  └─ 결과 artifact를 읽고 다음 package / repair / debug / stop 결정
```

구현/수정/debug는 하나의 writer session이 이어서 수행하고, scout/review/frontier gate는 fresh/read-only 세션으로 유지합니다. 이 방식은 여러 독립 구현 세션이 서로 다른 가정으로 작업을 망가뜨리는 문제를 줄이는 것을 목표로 합니다.

## 저장소 구조

```text
.
├── docs/
│   └── harness-contract.md
├── packages/
│   └── pi-hybrid-harness/
│       ├── bin/
│       ├── extensions/
│       ├── skills/
│       │   └── spec-kit-hybrid-orchestrator/
│       ├── tests/
│       ├── package.json
│       └── README.md
├── scripts/
│   └── update-plugins.sh
├── package.json
└── package-lock.json
```

## Pi package 기능

자세한 명령과 설정은 [packages/pi-hybrid-harness/README.md](packages/pi-hybrid-harness/README.md)를 보세요.

주요 기능:

- `/hybrid-run`, `/hybrid-run-fast`, `/hybrid-run-thorough`
- `hybrid_exec` tool: 부모 Pi 오케스트레이터가 만든 spec-kit/task batch 실행 패키지를 persistent writer loop로 실행
- `spec-kit-hybrid-orchestrator` skill: spec-kit `tasks.md` 완료 후 부모 Pi 세션이 batch를 판단하고 `hybrid_exec`를 반복 호출하는 workflow
- local scout, frontier design, persistent local implementation/repair/debug loop, frontier implementation review, frontier final review
- `.pi-harness/` durable artifact 저장
- background run, live monitor, steering, cancel, retry, resume
- token routing 및 frontier token 절약 추정
- safety guard와 checkpoint 보조 기능

## 설치

### Git source로 Pi에 설치

```sh
pi install git:github.com/Julirsia/hybrid-harness@main
```

프로젝트 로컬 설치:

```sh
pi install -l git:github.com/Julirsia/hybrid-harness@main
```

업데이트:

```sh
pi update git:github.com/Julirsia/hybrid-harness@main
```

설치/업데이트 후 Pi에서 reload합니다.

```text
/reload
```

### 이 checkout에서 설치

```sh
npm run install:pi
```

또는 직접:

```sh
./scripts/update-plugins.sh pi
```

## 개발

의존성 설치:

```sh
npm install
```

테스트:

```sh
npm test
```

Pi package dry-run pack 검증:

```sh
npm run pack:pi
```

## Spec-kit orchestration workflow

1. spec-kit로 `spec.md`, `plan.md`, `tasks.md`를 task 단계까지 완료합니다.
2. Pi에서 `spec-kit-hybrid-orchestrator` skill을 사용합니다.
3. 부모 Pi 세션이 `tasks.md`를 보고 coherent batch를 선택합니다.
4. 부모 세션이 `hybrid_exec` tool에 bounded `executionPackage`를 전달합니다.
5. harness가 persistent writer session으로 구현/repair/debug를 수행합니다.
6. 부모 세션은 다음 artifact를 보고 다음 행동을 결정합니다.

```text
.pi-harness/orchestrator-package.md
.pi-harness/progress.json
.pi-harness/local-log.md
.pi-harness/test-evidence.md
.pi-harness/git-summary.md
.pi-harness/verification-summary.json
.pi-harness/local-review.md
.pi-harness/run-summary.md
```

반복 판단:

```text
PASS      → 다음 batch 위임
FAIL      → repair package 위임
TEST FAIL → debug package 위임
RISK      → 사용자/frontier 판단으로 escalation
DONE      → final gate / 종료
```

## Artifact 계약

공통 artifact 설명은 [docs/harness-contract.md](docs/harness-contract.md)에 정리되어 있습니다. 현재 canonical state directory는 `.pi-harness/`입니다.
