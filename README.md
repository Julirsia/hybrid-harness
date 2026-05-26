# Hybrid Harness

`hybrid-harness`는 로컬 Qwen 계열 모델과 frontier 모델을 함께 쓰기 위한 harness 도구 모음입니다. 이 저장소는 Pi용 패키지, Codex용 CLI/MCP bridge, OpenCode용 플러그인을 하나의 monorepo에서 관리합니다.

핵심 목표는 세 가지입니다.

- Pi에서는 local Qwen worker/reviewer와 frontier final gate를 조합한 실행 루프를 제공합니다.
- Codex에서는 `.qwen-harness/` 상태를 기준으로 Pi/local Qwen에 scout/implementation/evidence loop를 위임하고, Codex가 frontier orchestration과 final gate를 맡습니다.
- OpenCode에서는 같은 harness 진행 상태를 읽고, Qwen-first 작업 흐름과 TUI sidebar 상태 패널을 제공합니다.

두 패키지는 각각 독립적으로 설치하고 사용할 수 있지만, 상태 파일 구조, 토큰 사용량 기록, 진행률 표현 같은 공통 계약은 이 저장소에서 함께 관리합니다. 한쪽을 개선할 때 다른 쪽이 깨지지 않도록 `docs/harness-contract.md`를 기준으로 맞춰 갑니다.

## 저장소 구조

```text
.
├── docs/
│   └── harness-contract.md
├── packages/
│   ├── pi-hybrid-harness/
│   │   ├── bin/
│   │   ├── extensions/
│   │   ├── tests/
│   │   ├── package.json
│   │   └── README.md
│   ├── qwen-harness-codex/
│   │   ├── bin/
│   │   ├── mcp/
│   │   ├── skills/
│   │   ├── src/
│   │   ├── test/
│   │   ├── package.json
│   │   └── README.md
│   └── qwen-harness-opencode/
│       ├── .claude-plugin/
│       ├── bin/
│       ├── plugins/
│       ├── skills/
│       ├── src/
│       ├── test/
│       ├── install.sh
│       ├── uninstall.sh
│       ├── package.json
│       └── README.md
├── package.json
└── package-lock.json
```

## 패키지 개요

### `packages/pi-hybrid-harness`

Pi용 package/extension입니다. local Qwen 모델을 worker와 reviewer로 쓰고, frontier 모델을 설계와 final gate에 집중시키는 hybrid 실행 흐름을 제공합니다.

주요 기능:

- `/hybrid-run`, `/hybrid-run-fast`, `/hybrid-run-thorough`
- local scout, frontier design, local implementation loop, local review, frontier final review
- `.pi-harness/` 기반 durable artifact 저장
- background run, live monitor, steering, cancel, retry, resume
- token routing 및 frontier token 절약 추정
- safety guard와 checkpoint/rollback 보조 기능

자세한 Pi 명령 목록은 [packages/pi-hybrid-harness/README.md](packages/pi-hybrid-harness/README.md)를 보세요.

### `packages/qwen-harness-codex`

Codex용 CLI/MCP bridge입니다. Codex가 요구사항, 설계, plan gate, final review를 소유하고, Pi/local Qwen이 repo scout, bounded implementation, test/repair loop, evidence 생성을 맡도록 `.qwen-harness/` artifact를 작성합니다.

주요 기능:

- `qwen-harness-codex` CLI
- `codex_harness_scout`, `codex_harness_delegate`, `codex_harness_status`, `codex_harness_collect_evidence`, `codex_harness_review_bundle` MCP tools
- `qwen-first-codex-orchestration` Codex skill
- `.qwen-harness/` canonical state writer

자세한 설치 방식은 [packages/qwen-harness-codex/README.md](packages/qwen-harness-codex/README.md)를 보세요.

### `packages/qwen-harness-opencode`

OpenCode용 skill과 TUI plugin입니다. Qwen-first delegation workflow를 문서화하고, harness 상태를 sidebar에 표시합니다.

주요 기능:

- `qwen-first-delegation-workflow` skill
- `qwen-harness-status.tsx` TUI sidebar plugin
- `.qwen-harness/` 상태 읽기
- `.pi-harness/` fallback 읽기
- current phase, current slice, blockers, token usage, local/frontier efficiency 표시

자세한 설치 방식은 [packages/qwen-harness-opencode/README.md](packages/qwen-harness-opencode/README.md)를 보세요.

## 공통 Harness 계약

공통 상태 계약은 [docs/harness-contract.md](docs/harness-contract.md)에 정리되어 있습니다.

현재 host 패키지들이 맞춰야 하는 핵심 개념은 다음과 같습니다.

- 작업 요청 요약
- 현재 phase
- 현재 slice/checkpoint
- acceptance criteria
- blockers
- verification evidence
- local vs frontier token usage
- parent/orchestrator 모델이 읽기 좋은 compact progress

OpenCode package는 `.qwen-harness/`를 먼저 읽고, 없으면 `.pi-harness/`를 fallback으로 읽습니다. 따라서 Pi harness를 쓰는 프로젝트에서도 OpenCode sidebar가 기존 `.pi-harness/` 상태를 볼 수 있습니다.

Codex package도 `.qwen-harness/`를 canonical state directory로 사용하며 별도 Codex 전용 harness directory를 만들지 않습니다.

## 설치 및 개발 준비

저장소 루트에서 의존성을 설치합니다.

```sh
npm install
```

workspace 전체 테스트를 실행합니다.

```sh
npm test --workspaces --if-present
```

Pi package dry-run pack 검증:

```sh
npm run pack:pi
```

OpenCode package dry-run pack 검증:

```sh
npm pack --dry-run -w qwen-harness-opencode
```

Codex package dry-run pack 검증:

```sh
npm pack --dry-run -w qwen-harness-codex
```

## 로컬 설치

### Pi package를 이 checkout에서 설치

저장소 루트에서:

```sh
npx ./packages/pi-hybrid-harness install -l --source ./packages/pi-hybrid-harness
```

설치 후 Pi에서 reload합니다.

```text
/reload
```

### OpenCode plugin 사용자 설치

다른 기기에서는 clone 없이 npm package에서 설치합니다.

```sh
npx qwen-harness-opencode install
```

업데이트:

```sh
npx qwen-harness-opencode update
```

제거:

```sh
npx qwen-harness-opencode uninstall
```

설치 후 OpenCode TUI를 재시작해야 sidebar plugin이 로드됩니다.

### OpenCode plugin을 이 checkout에서 개발 설치

저장소 루트에서:

```sh
npm run install:opencode
```

직접 실행할 수도 있습니다.

```sh
./packages/qwen-harness-opencode/install.sh
```

제거:

```sh
npm run uninstall:opencode
```

## 자주 쓰는 명령

```sh
# 전체 workspace 테스트
npm test --workspaces --if-present

# Qwen/OpenCode package 테스트만 실행
npm run test:qwen

# Pi package dry-run pack
npm run pack:pi

# OpenCode plugin 사용자 설치
npx qwen-harness-opencode install

# OpenCode plugin 개발 checkout 설치
npm run install:opencode

# OpenCode plugin 제거
npx qwen-harness-opencode uninstall
```

## 변경할 때 지켜야 할 규칙

Harness 상태 계약을 바꾸는 변경은 두 패키지에 같이 반영해야 합니다.

예를 들어 다음을 바꾸는 경우:

- artifact 파일 이름
- phase/status 값
- `progress.json` 구조
- `implementation-plan.json` slice 구조
- token usage 기록 형식
- blocker/verification evidence 표현

다음 파일을 함께 확인하세요.

- [docs/harness-contract.md](docs/harness-contract.md)
- [packages/pi-hybrid-harness/README.md](packages/pi-hybrid-harness/README.md)
- [packages/pi-hybrid-harness/extensions/hybrid-harness.ts](packages/pi-hybrid-harness/extensions/hybrid-harness.ts)
- [packages/qwen-harness-opencode/skills/qwen-first-delegation-workflow/SKILL.md](packages/qwen-harness-opencode/skills/qwen-first-delegation-workflow/SKILL.md)
- [packages/qwen-harness-opencode/src/status-summary.mjs](packages/qwen-harness-opencode/src/status-summary.mjs)
- [packages/qwen-harness-opencode/README.md](packages/qwen-harness-opencode/README.md)
- 관련 테스트 파일

변경 후 최소 검증:

```sh
npm test --workspaces --if-present
npm run pack:pi
npm pack --dry-run -w qwen-harness-opencode
```

## Git에 넣지 않는 파일

이 저장소는 source와 package metadata만 관리합니다. 아래 runtime/generated 파일은 commit하지 않습니다.

- `node_modules/`
- `.pi/`
- `.pi-harness/`
- `.pi-lens/`
- `.playwright-mcp/`
- `.qwen-harness/`
- `.agent-harness/`
- `agent-handoffs/`
- log, build, coverage 산출물

반대로 source template은 추적할 수 있게 열어 둡니다.

- `.env.example`
- `.env.*.example`
- `.env.template`
- `.env.*.template`

## Lockfile 정책

루트 `package-lock.json`은 monorepo workspace 개발과 검증을 위한 lockfile입니다.

`packages/qwen-harness-opencode/package-lock.json`도 유지합니다. 이 패키지는 standalone으로 개발/검증될 수 있고, installer가 사용자 OpenCode config directory 안에서 필요한 TUI runtime dependency를 설치할 수 있기 때문입니다.

OpenCode package 의존성을 바꿀 때는 다음을 함께 확인하세요.

```sh
npm install
cd packages/qwen-harness-opencode
npm install
```

이후 루트에서 다시 검증합니다.

```sh
npm test --workspaces --if-present
```

## 현재 검증 상태

이 저장소를 만들 때 확인한 기준:

- Pi package 테스트: 28개 통과
- Qwen/OpenCode package 테스트: 9개 통과
- OpenCode npm installer copy/update/uninstall 테스트 통과
- 주요 JS/MJS entrypoint `node --check` 통과
- Pi package `npm pack --dry-run` 통과
- OpenCode package `npm pack --dry-run` 통과
- `.qwen-harness/`와 `.pi-harness/` fallback parser 테스트 포함

OpenCode installer를 실제 사용자 설정에 적용하거나 live TUI를 띄우는 검증은 의도적으로 자동 검증 범위에서 제외합니다. 이 작업은 `~/.config/opencode`를 수정할 수 있으므로 필요할 때 명시적으로 실행합니다.
