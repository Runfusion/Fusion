import { vi } from "vitest";

/*
FNXC:SkillSync 2026-07-01-20:05:
`src/extension.ts` registers the workflow-authoring + trait tools at module load, pulling their TypeBox param schemas and `createWorkflowAuthoringTools` from `@fusion/engine`. Any test that replaces `@fusion/engine` with a bare `vi.mock` factory must therefore still expose these named exports, or importing `../extension.js` throws `No "workflowListParams" export is defined on the "@fusion/engine" mock`. Centralize the passthrough stubs here so a future engine workflow-tool addition only updates one place instead of drifting each extension test's factory.

FNXC:TestInfrastructure 2026-07-13-10:20:
extension.ts also named-imports defaultGitOps, ExperimentFinalize* error classes/service, assertNoSecretPlaintext, emitGoalRetrievalAudit, and isInReviewMissingWorktreeSessionStartFailure from @fusion/engine. All of these trigger the vitest "No export defined" error if absent from a hardcoded mock. Add them here so the centralized helper covers the full module-load contract.
*/

/** Stub TypeBox param schema — only ever forwarded as a tool `.parameters` value. */
const emptyParams = {} as const;

export const workflowAuthoringEngineMock = {
  workflowListParams: emptyParams,
  workflowGetParams: emptyParams,
  workflowSelectParams: emptyParams,
  workflowCreateParams: emptyParams,
  workflowUpdateParams: emptyParams,
  workflowDeleteParams: emptyParams,
  workflowValidateParams: emptyParams,
  workflowSettingsParams: emptyParams,
  traitListParams: emptyParams,
  createWorkflowAuthoringTools: () => [] as unknown[],
  // Remaining named imports from extension.ts — stubs satisfy module-load only.
  defaultGitOps: {},
  ExperimentFinalizeBranchExistsError: class MockError extends Error {},
  ExperimentFinalizeCherryPickConflictError: class MockError extends Error {},
  ExperimentFinalizeMergeBaseError: class MockError extends Error {},
  ExperimentFinalizeNoKeptRunsError: class MockError extends Error {},
  ExperimentFinalizePlanError: class MockError extends Error {},
  ExperimentFinalizeService: vi.fn(),
  ExperimentFinalizeStateError: class MockError extends Error {},
  assertNoSecretPlaintext: vi.fn(),
  emitGoalRetrievalAudit: vi.fn(),
  isInReviewMissingWorktreeSessionStartFailure: vi.fn(),
};
