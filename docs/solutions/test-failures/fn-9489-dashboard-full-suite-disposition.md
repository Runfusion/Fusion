# FN-9489 dashboard Full Suite disposition

## Hosted evidence

- Run: [Full Suite 37242457367](https://github.com/Runfusion/Fusion/actions/runs/37242457367), completed `failure` on 2026-10-04; source SHA [`789e72ea801adf37434ecd343310719961455d62`](https://github.com/Runfusion/Fusion/commit/789e72ea801adf37434ecd343310719961455d62).
- Deterministic shard command: `pnpm test:ci:shard --shard <N> --total 4`. The current mapping may be inspected with `node scripts/ci-test-shard.mjs --dry-run --total 4`.
- Failed jobs: [shard 2/4](https://github.com/Runfusion/Fusion/actions/runs/37242457367/job/111553714699), [shard 3/4](https://github.com/Runfusion/Fusion/actions/runs/37242457367/job/111553714667), and [shard 4/4](https://github.com/Runfusion/Fusion/actions/runs/37242457367/job/111553714750). All three completed their timing-artifact upload.
- The required evidence artifact [11318377903](https://github.com/Runfusion/Fusion/actions/runs/37242457367/artifacts/11318377903) is unexpired. Its API digest is `sha256:e04bf6a4f9895aba60f661caa403b586edcb940f99b5a8fe1b2f9d4a6abed8ff`; the downloaded archive SHA-256 matched.
- The relevant unexpired timing artifacts also matched their API digests: [shard 2, 11318316351](https://github.com/Runfusion/Fusion/actions/runs/37242457367/artifacts/11318316351), `sha256:1ddd15d6ceb36f8300c4707fc90ef62cd56a8855730412d439a480150c9dee28`; [shard 3, 11318616665](https://github.com/Runfusion/Fusion/actions/runs/37242457367/artifacts/11318616665), `sha256:31711cd6c7f1489d163fd3a5b7378daf30ecf123c91035f51c5149055b9b7afb`; and [shard 4, 11318866438](https://github.com/Runfusion/Fusion/actions/runs/37242457367/artifacts/11318866438), `sha256:ac888a7cd3413bca6d1360fb8fefb6e8a8703262a402ae1fac77e2eacc086612`.

## Reporter ledger

| Reporter | Hosted timing evidence | Source-SHA and current-HEAD reproduction | Classification and repair |
| --- | --- | --- | --- |
| `task-move-affordance-removed.test.tsx` — `FN-198 dashboard task relocation removal removes board card destination choices while leaving manual-intake Start operational` | Shard 3 (`timings-shard3-3.json`), 262.5 ms. The reporter expected the last move call to be `("FN-198", "implementation")`. | The source test and its `TaskCard` production seam are unchanged at current HEAD. Focused dashboard Vitest reproduction initially failed with the same missing third call argument. | **Stale test/fixture.** `TaskCard` correctly derives the first eligible working column and calls `onMoveTask(task.id, target, { expectedColumn: task.column })`. The test now asserts the complete fenced move: `("FN-198", "implementation", { expectedColumn: "ideas" })`. |
| `ChatView.autosize.test.tsx` — `ChatView composer autosize recomputes rooms composer height on room switch` | Shard 4 (`timings-shard4-6.json`), 1067.6 ms. It expected `this is a much longer room draft` and received an empty textarea. | The source and current `ChatView` are direct-session only: no Rooms selector invokes `selectRoom`, and no Room thread is reachable from its rendered UI. The focused reproduction failed at the initial room-draft expectation. | **Stale test/fixture.** Removed the unreachable Rooms fixtures. The replacement exercises the reachable direct-session path: a long persisted draft switches to a short persisted draft on the same retained textarea, which recalculates height and clears overflow. |
| `navigation-history.test.tsx` — `Navigation history integration returns desktop board-detail Back to board to the board without breaking history` | Shard 4 (`timings-shard4-6.json`), 1085.6 ms. It expected the Board node to be absent after detail opened. | The source and current `MainContent` use `MainViewKeepAlive`, so opening detail correctly hides rather than unmounts Board. The focused reproduction failed at the obsolete absence assertion before exercising Back-to-board. | **Stale test/fixture.** The regression now proves the retained Board is hidden while detail is active, Back-to-board returns it to visible state, and the delayed self-popstate does not push another entry. |

## Causal boundary

The implicated production paths were compared at the landed SHA, its parent, and current HEAD. The reporter failures are not regressions in task relocation, composer measurement, or history ownership: each reporter asserted a contract removed or superseded by already-landed production behavior. The Room reporter was additionally unreachable in the retained direct-only UI, so repairing it as production Room behavior would create an unowned navigation and history surface. No production source change is required.

The focused reproduction command before repair was:

```text
pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/task-move-affordance-removed.test.tsx app/components/__tests__/ChatView.autosize.test.tsx app/components/__tests__/navigation-history.test.tsx --silent=passed-only --reporter=dot
```

It failed all three reporters in 10.2 seconds. The same command after the test-contract corrections passed in 9.0 seconds. This is a targeted replacement for reporter diagnosis only; it is not a shard-wide completion claim.

## Final verification

- `pnpm --filter @fusion/dashboard exec vitest run app/components/__tests__/task-move-affordance-removed.test.tsx app/components/__tests__/TaskCard.start-precondition.test.tsx app/components/__tests__/TaskCard.test.tsx app/components/__tests__/Board.test.tsx app/components/__tests__/ChatView.autosize.test.tsx app/components/__tests__/ChatView.core-contracts.test.tsx app/utils/__tests__/chatInputAutosize.test.ts app/components/__tests__/navigation-history.test.tsx app/hooks/__tests__/useNavigationHistory.test.ts --silent=passed-only --reporter=dot` — passed in 16.6 seconds, covering every named reporter plus affected board, autosize, and history host/helper contracts. The direct-session draft switch and rendered direct-only UI contracts both passed.
- `pnpm lint` — passed in 28.4 seconds.
- `pnpm typecheck` — passed in 26.9 seconds.
- `pnpm verify:fast` — passed in 44.5 seconds.
- `pnpm build` — passed in 21.6 seconds.

## Final disposition

All three named failures are resolved as stale test/fixture corrections. No retry, timeout, skip, exclusion, quarantine, source-text assertion, or weakened production expectation was introduced. The required broader verification is recorded with the task delivery after the focused test set, lint, typecheck, `pnpm verify:fast`, and build complete.
