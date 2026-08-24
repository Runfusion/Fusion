/*
FNXC:GitIdentity 2026-08-18-07:55:
FUSION SUPPLIES THE GIT IDENTITY FOR ITS OWN COMMITS; IT DOES NOT BORROW THE ENVIRONMENT'S.

Every Fusion-authored commit (merge commits, the merger's `--amend`, experiment git-ops) used to run
with whatever `user.name`/`user.email` happened to be configured on the host. On a machine with no
git identity — a container, CI, a fresh laptop — git refuses outright with "Author identity unknown
... Please tell me who you are", so an auto-merge reached `status:merging` and stopped dead with
nothing in the UI explaining why (operator report). The only place that ever passed an explicit
identity was workspace-fence-ref.ts.

Identity is per-agent where the caller knows which agent did the work, so history attributes a change
to the agent that made it rather than to one anonymous bot. The operator's `commitAuthor*` settings
still win when set, and setting `commitAuthorEnabled: false` opts out entirely and restores ambient
git config — that is the escape hatch for anyone who wants commits authored as themselves.
*/

/** Identity applied to a git commit Fusion creates. */
export interface CommitIdentity {
  name: string;
  email: string;
}

export const FUSION_FALLBACK_IDENTITY: CommitIdentity = {
  name: "Fusion",
  email: "noreply@runfusion.ai",
};

/** Local-part safe slug for an agent-derived email; empty when nothing usable remains. */
export function slugifyAgentEmailLocalPart(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

export interface CommitIdentityInput {
  /** The agent performing the work, when the call site knows it. */
  agent?: { name?: string | null; id?: string | null } | null;
  settings?: {
    commitAuthorEnabled?: boolean;
    commitAuthorName?: string;
    commitAuthorEmail?: string;
  } | null;
}

/**
 * Resolve the identity for a Fusion-authored commit.
 *
 * Precedence: explicit operator settings > the acting agent > the Fusion fallback. Returns
 * `undefined` when the operator disabled Fusion's authorship, which means "leave git alone and use
 * whatever the environment provides".
 */
export function resolveCommitIdentity(input: CommitIdentityInput = {}): CommitIdentity | undefined {
  const { agent, settings } = input;
  if (settings?.commitAuthorEnabled === false) {
    return undefined;
  }

  const configuredName = settings?.commitAuthorName?.trim();
  const configuredEmail = settings?.commitAuthorEmail?.trim();
  if (configuredName && configuredEmail) {
    return { name: configuredName, email: configuredEmail };
  }

  const agentName = agent?.name?.trim() || agent?.id?.trim() || "";
  if (agentName) {
    const localPart = slugifyAgentEmailLocalPart(agentName);
    if (localPart) {
      return {
        name: configuredName || `${agentName} (Fusion)`,
        email: configuredEmail || `${localPart}@agents.fusion.local`,
      };
    }
  }

  return {
    name: configuredName || FUSION_FALLBACK_IDENTITY.name,
    email: configuredEmail || FUSION_FALLBACK_IDENTITY.email,
  };
}

/**
 * Environment overrides that pin author AND committer.
 *
 * Both halves matter: setting only the author still leaves the COMMITTER to ambient config, and git
 * fails on a missing committer identity just as hard as on a missing author.
 */
export function commitIdentityEnv(identity: CommitIdentity | undefined): NodeJS.ProcessEnv {
  if (!identity) {
    return {};
  }
  return {
    GIT_AUTHOR_NAME: identity.name,
    GIT_AUTHOR_EMAIL: identity.email,
    GIT_COMMITTER_NAME: identity.name,
    GIT_COMMITTER_EMAIL: identity.email,
  };
}

/** `-c user.name=… -c user.email=…` for callers that build an argv rather than an env. */
export function commitIdentityArgs(identity: CommitIdentity | undefined): string[] {
  if (!identity) {
    return [];
  }
  return ["-c", `user.name=${identity.name}`, "-c", `user.email=${identity.email}`];
}
