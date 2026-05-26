# Harness Contract

This repo contains two packages that serve the same local-Qwen workflow from different host apps. The packages may use different runtime directories, but changes to durable state shape should be reflected in both packages.

## Packages

| Package | Host | Main responsibility | Current state directory |
| --- | --- | --- | --- |
| `pi-hybrid-harness` | Pi | orchestrates local/frontier runs and writes durable run artifacts | `.pi-harness/` |
| `qwen-harness-opencode` | OpenCode | provides a Qwen-first workflow skill and sidebar summary | `.qwen-harness/` |

The OpenCode package reads `.qwen-harness/` first and falls back to `.pi-harness/` when a project already uses the Pi harness directory. Avoid creating both directories in one target project unless the user explicitly asks.

## Shared Concepts

Both packages should keep these concepts compatible:

- task/request summary
- current phase
- current slice/checkpoint
- acceptance criteria
- blockers
- verification evidence
- local vs frontier token usage
- compact progress suitable for a parent/orchestrator model

## Token Usage Shape

Prefer this shape wherever token usage is recorded:

```json
{
  "tokenUsage": {
    "frontier": {
      "input": 0,
      "output": 0,
      "total": 0
    },
    "local": {
      "input": 0,
      "output": 0,
      "total": 0
    },
    "unknown": {
      "input": 0,
      "output": 0,
      "total": 0
    }
  }
}
```

Aliases currently accepted by the OpenCode sidebar parser include `usage` and `tokens`, plus OpenAI-style fields such as `input_tokens`, `output_tokens`, and `total_tokens`.

## Change Checklist

Before changing artifact names, statuses, phase values, token accounting, or progress JSON structure:

1. Update this document with the new contract.
2. Update the Pi package docs and writer/reader code.
3. Update the OpenCode skill docs and sidebar parser.
4. Add or update tests for the package that parses the changed shape.
5. Run root verification with `npm test --workspaces --if-present`.

Do not add a shared runtime package until both host packages need the same executable logic. A documented contract is the preferred shared layer for now.
