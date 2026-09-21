# Contributing

Virtual Office is built test-first, without exception. This document is the practical version of that rule.

## The loop

1. **Red.** Pick one task from the Notion database and set it to "In progress". Write the smallest test that describes the next piece of behaviour. Run it. It must fail for the right reason.
2. **Green.** Write the minimum production code that makes the test pass. Nothing speculative.
3. **Refactor.** Clean up with the tests green. Commit.

Repeat until the task's Definition-of-Done tests all pass, then set the task to "In review" and open a PR.

## What the tooling enforces

- **Pre-commit hook** (`.husky/pre-commit`): lint-staged, typecheck, the full test suite, and `tdd-guard` on staged files. Do not bypass it with `--no-verify`.
- **`tdd-guard`** (`tooling/scripts/tdd-guard.ts`): any changed file under `packages/*/src` or `apps/*/src` that is not a test must be accompanied by a `*.test.ts` change in the same package. Declaration files and config files are exempt. Run it yourself with `pnpm tdd-guard` (staged files) or `pnpm tdd-guard --base origin/main` (branch diff).
- **CI** (`.github/workflows/ci.yml`): typecheck, lint, format check, tests with a 90% coverage gate on `packages/core`, and `tdd-guard` against the PR base branch. Nightly Stryker mutation testing on `core` and `orchestrator` publishes a report artifact.

## Conventions

- Tests live next to the code as `*.test.ts` inside `src/`.
- Use the fake LLM provider and recorded fixtures. A test that talks to a real model is a bug.
- Repository interfaces only. SQL lives in `packages/storage/adapters` and nowhere else.
- Package names are `@vo/<name>`. ESM only, `.js` suffix on relative imports.
- Commit messages: imperative summary line, body explains the why. Reference the Notion task where useful.

## Commands

```bash
pnpm check            # typecheck + lint + test
pnpm test:coverage    # with the coverage gate
pnpm tdd-guard        # TDD rule on staged files
pnpm mutation         # Stryker, slow, normally nightly
```
