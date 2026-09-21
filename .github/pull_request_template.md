## Notion task

<!-- Link the task from the "Virtual Office Tasks" database and set it to "In review". -->

## What changed

<!-- One paragraph. What behaviour is new or different, and why. -->

## TDD evidence

- [ ] I wrote a failing test first and watched it fail (red) before writing production code.
- [ ] The implementation is the minimum that makes the test pass (green), then refactored.
- [ ] Every changed production file has a test change in the same package (`pnpm tdd-guard` passes).
- [ ] No LLM call runs in tests; fixtures or the fake provider are used.
- [ ] The DoD tests listed on the Notion task exist and pass.

## Checks

- [ ] `pnpm check` passes locally (typecheck, lint, tests).
- [ ] Coverage on `packages/core` stays at or above 90%.
- [ ] No SQL outside `packages/storage/adapters`.
