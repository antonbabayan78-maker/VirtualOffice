# Virtual Office

Drag-and-drop virtual office where every employee is an LLM agent. Plan and task backlog live in Notion:
https://app.notion.com/p/3e2be6acb4cf8162a89ade8a0d48085c (database "Virtual Office Tasks" under that page).

## Non-negotiable rules

1. **TDD only.** No production code without a failing test first. Order: write the test, run it and see it fail (red), implement the minimum to pass (green), refactor. Commit the test before or together with the implementation, never after.
2. **One task per session**, taken from the Notion database. Set it to "In progress" when starting and "Done" when the DoD tests pass.
3. **Plan mode first** for anything touching more than one package.
4. **No SQL outside `packages/storage/adapters`.** Domain and orchestrator code only talk to repository interfaces.
5. **No LLM call in tests.** Use the fake provider and recorded fixtures.
6. **Pre-commit runs lint-staged, typecheck and the full test suite.** Do not bypass it with `--no-verify`.

## Layout

- `packages/core` pure domain model, no IO. Highest coverage bar.
- `packages/orchestrator` scheduler, run loop, workflow engine, watchdog.
- `packages/llm` provider interface, adapters, model registry, routing.
- `packages/connectors` MCP client, REST, webhook, plugin SDK, secrets vault.
- `packages/memory` scoped memory, retrieval, compaction.
- `packages/skills` skill format, registry, Skill Builder.
- `packages/storage` repository interfaces and database adapters.
- `packages/telemetry` usage events, rollups, budgets.
- `packages/notifications` notification channels.
- `apps/server` Fastify API + WebSocket. `apps/cli` the `vo` command. `apps/web` arrives in P2.
- `tooling` repo-level conformance tests (workspace shape, portability lint).

## Commands

```bash
pnpm test          # all vitest projects
pnpm typecheck     # tsc per package via turbo
pnpm lint          # eslint, type-aware
pnpm check         # typecheck + lint + test
```

## Conventions

- TypeScript strict with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`; ESM only; import local files with the `.js` suffix.
- Tests live next to code as `*.test.ts` inside `src/`.
- Package names are `@vo/<name>`; all private until v1.0.
