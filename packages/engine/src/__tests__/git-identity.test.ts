import { describe, expect, it } from "vitest";
import {
  commitIdentityArgs,
  commitIdentityEnv,
  FUSION_FALLBACK_IDENTITY,
  resolveCommitIdentity,
} from "../git-identity.js";

/*
FNXC:GitIdentity 2026-08-18-07:55:
Fusion-authored commits must carry an identity Fusion chose. Relying on ambient `user.name`/
`user.email` meant that on a host with none — container, CI, fresh machine — git refused with
"Author identity unknown" and an auto-merge stalled at `status:merging` with nothing surfaced.
*/
describe("resolveCommitIdentity", () => {
  it("attributes a commit to the acting agent", () => {
    const identity = resolveCommitIdentity({ agent: { name: "QA Engineer", id: "agent_1" } });
    expect(identity).toEqual({ name: "QA Engineer (Fusion)", email: "qa-engineer@agents.fusion.local" });
  });

  it("falls back to the agent id when it has no name", () => {
    expect(resolveCommitIdentity({ agent: { id: "agent_42" } })?.email).toBe("agent-42@agents.fusion.local");
  });

  it("prefers explicit operator settings over the agent", () => {
    const identity = resolveCommitIdentity({
      agent: { name: "QA Engineer" },
      settings: { commitAuthorName: "Release Bot", commitAuthorEmail: "release@example.com" },
    });
    expect(identity).toEqual({ name: "Release Bot", email: "release@example.com" });
  });

  it("still yields an identity when no agent is known", () => {
    // The important half: never return undefined just because the caller lacks agent context.
    expect(resolveCommitIdentity()).toEqual(FUSION_FALLBACK_IDENTITY);
  });

  it("opts out entirely when the operator disables Fusion authorship", () => {
    // undefined means "leave git alone" — the escape hatch for commits authored as the operator.
    expect(resolveCommitIdentity({ settings: { commitAuthorEnabled: false }, agent: { name: "QA" } })).toBeUndefined();
  });

  it("does not emit an unusable email for a name with no alphanumerics", () => {
    expect(resolveCommitIdentity({ agent: { name: "***" } })).toEqual(FUSION_FALLBACK_IDENTITY);
  });
});

describe("commit identity plumbing", () => {
  it("pins committer as well as author", () => {
    // Author alone is not enough: git fails on a missing COMMITTER identity just as hard.
    expect(commitIdentityEnv({ name: "N", email: "e@x" })).toEqual({
      GIT_AUTHOR_NAME: "N",
      GIT_AUTHOR_EMAIL: "e@x",
      GIT_COMMITTER_NAME: "N",
      GIT_COMMITTER_EMAIL: "e@x",
    });
  });

  it("emits nothing when authorship is opted out", () => {
    expect(commitIdentityEnv(undefined)).toEqual({});
    expect(commitIdentityArgs(undefined)).toEqual([]);
  });

  it("builds -c overrides for argv callers", () => {
    expect(commitIdentityArgs({ name: "N", email: "e@x" })).toEqual(["-c", "user.name=N", "-c", "user.email=e@x"]);
  });
});
