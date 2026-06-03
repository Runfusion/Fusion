---
title: "Plugin-bundled skills silently fail to load in interactive sessions"
date: 2026-06-03
category: integration-issues
module: packages/engine
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "Bundled `ce-*` skills declared via `PluginSkillContribution.skillFiles` never load into live interactive agent sessions"
  - "No error is raised — the requested skill name silently matches nothing and is dropped"
  - "The `SKILL.md` files are physically bundled in the plugin yet remain undiscoverable to the session"
  - "Interim workaround (set session cwd to the install root + name the skill in the system prompt) does not make the skill discoverable"
root_cause: incomplete_setup
resolution_type: code_fix
related_components:
  - assistant
  - development_workflow
tags:
  - skills
  - plugin
  - skill-resolver
  - additional-skill-paths
  - resource-loader
  - interactive-session
  - compound-engineering
---

# Plugin-bundled skills silently fail to load in interactive sessions

## Problem

Bundled `ce-*` skills declared via `PluginSkillContribution.skillFiles` never loaded into live interactive agent sessions. The engine's skill resolver only *filters* skills it already discovered on disk and never ingests a contribution's `skillFiles`, so a name-only contribution produced no loadable skill — silently.

## Symptoms

- A stage session runs, but the agent behaves as if the `ce-*` skill is absent — its instructions are never applied.
- The resolver returns an empty/unchanged skill set for the requested name; the filter has nothing matching to keep.
- **No error is raised.** A `PluginSkillContribution` is name-only (`{ skillId, name, skillFiles }`), so declaring it is structurally valid; the session just starts without the skill.
- Tests using a scripted/fake session pass, hiding the gap — only a *real* resource loader surfaces it.

## What Didn't Work

**1. Declaring `skills: PluginSkillContribution[]` alone.** The engine resolver (`skill-resolver.ts`) computes an allow/exclude *filter* over skills the loader already discovered on disk. `createSkillsOverrideFromSelection` returns a callback that only ever runs `base.skills.filter(...)` — it never *adds* skills. If the bundled `SKILL.md` was never physically on a discoverable path, it isn't in `base.skills`, so filtering by its name yields `[]`. The contribution's `skillFiles` are never read for live sessions.

**2. Setting the session `cwd` to the install root + naming the skill in the system prompt.** `DefaultResourceLoader` discovers skills by scanning *standard skill roots* (e.g. `<cwd>/.claude/skills/<id>/SKILL.md`), not by treating an arbitrary `cwd` as a skills directory. Pointing `cwd` at `<installRoot>` (which holds `<id>/SKILL.md` directly) does not match the layout the loader scans, so the skill still isn't discovered — and it relocates the session away from the project root where it must read context and write artifacts. A prompt mention cannot inject skill content the loader never loaded.

## Solution

Two parts: **physically install** the bundled skill to a discoverable plugin-local dir, and **forward both the requested name and the install dir** through a new seam option, end to end.

**Physical install** (`skill-installation.ts`) — copy each bundled `<skillId>/SKILL.md` into a plugin-local target, with a hard isolation guard (never a global `~/.claude|.codex|.gemini/skills`), idempotently:

```ts
assertPluginLocalTarget(targetRoot);          // isolation invariant: never a global skills dir
if (!existsSync(join(targetRoot, skillId))) { // skip-if-exists
  mkdirSync(targetRoot, { recursive: true });
  cpSync(join(sourceRoot, skillId), join(targetRoot, skillId), { recursive: true });
}
```

**Layer 1 — engine loader seam (`pi.ts`).** A new `AgentOptions.additionalSkillPaths`, forwarded into `DefaultResourceLoader` as a real *discovery* path (distinct from the filtering `skillsOverride`):

```ts
// AgentOptions
skills?: string[];               // convenience → auto-builds a SkillSelectionContext (requestedSkillNames)
additionalSkillPaths?: string[]; // extra dirs (each holding <id>/SKILL.md) for the loader to SCAN

const resourceLoader = new DefaultResourceLoader({
  cwd: resolvedProjectRoot,
  ...(options.additionalSkillPaths?.length
    ? { additionalSkillPaths: [...options.additionalSkillPaths] } : {}),
  ...(skillsOverrideFn ? { skillsOverride: skillsOverrideFn } : {}),
});
```

**Layer 2 — core seam type (`plugin-types.ts`).** `CreateInteractiveAiSessionOptions` gains the matching fields so a plugin route can request them:

```ts
requestedSkillNames?: string[];  // names the session should load
additionalSkillPaths?: string[]; // dirs to scan so requestedSkillNames are discoverable
```

**Layer 3 — engine adapter (`index.ts`).** Forwards both into `createFnAgent`, mapping `requestedSkillNames` → the convenience `skills` param:

```ts
...(opts.requestedSkillNames?.length ? { skills: opts.requestedSkillNames } : {}),
...(opts.additionalSkillPaths?.length ? { additionalSkillPaths: opts.additionalSkillPaths } : {}),
```

**Caller — orchestrator (`orchestrator.ts`).** Passes the stage's skill id as the requested name AND the plugin-local install root as a discovery path, while keeping `cwd` on the project root:

```ts
private buildSessionOptions(stage: CeStageDefinition) {
  return {
    cwd: this.projectRoot,                          // project root — NOT the skills dir
    requestedSkillNames: [stage.skillId],
    additionalSkillPaths: resolveStageSkillPaths(), // [resolveDefaultInstallTargetRoot()]
    // ...systemPrompt, tools, model
  };
}
```

## Why This Works

- `skillsOverride` (built by `createSkillsOverrideFromSelection`) is purely a **filter** over `base.skills`. To make a new skill *exist* in `base.skills`, **discovery** must be fed the path — exactly what `additionalSkillPaths` does on `DefaultResourceLoader`: it scans those dirs for the `<id>/SKILL.md` layout, so the physically-installed skill now appears in `base.skills`.
- The convenience `skills` / `requestedSkillNames` param auto-builds a `SkillSelectionContext`, which makes the filter *include* that name instead of passing everything or nothing.
- Discovery (add via `additionalSkillPaths`) and selection (keep via `requestedSkillNames`) are now both satisfied, so the skill is loaded **and** retained — with `cwd` still on the project root, so context reads and artifact writes are unaffected.

## Prevention

A plugin author shipping a bundled skill should:

1. **Physically install** the `SKILL.md` to a **plugin-local, discoverable** dir laid out as `<root>/<skillId>/SKILL.md` (use `cpSync` + skip-if-exists). Never install into a global `~/.claude|.codex|.gemini/skills`; keep an explicit `assertPluginLocalTarget()` guard so a global install is never clobbered.
2. **Forward both** seam options when starting the session: `requestedSkillNames: [skillId]` (so the resolver keeps it) **and** `additionalSkillPaths: [installRoot]` (so the loader discovers it). One without the other silently no-ops — a name with no discovered file filters to `[]`; a discovered file with no requested name can be filtered out.
3. Remember `skillsOverride` only filters — declaring a `PluginSkillContribution` is **name-only** and never injects skill content into a live session.
4. **Prove it with a real `DefaultResourceLoader`** (see `packages/engine/src/__tests__/compound-engineering-skill-resolution.test.ts`) that asserts the skill actually appears in the resolved session skills — a scripted/fake session cannot catch a discovery gap.

## Related Issues

- `docs/PLUGIN_AUTHORING.md` (§skills) presents `skillFiles` as sufficient for surfacing bundled skills in sessions — now misleading; warrants a note that plugins must physically install + forward `additionalSkillPaths`.
- `docs/plans/2026-06-02-001-feat-compound-engineering-plugin-plan.md` assumed "`PluginSkillContribution.skillFiles` covers bundled skills" (KTD5) — corrected by this learning.
- `docs/brainstorms/2026-06-02-compound-engineering-plugin-requirements.md` (R11–R13) defines the plugin-local, never-global install rules this fix implements.
- No related GitHub issue exists (searched `plugin skill discovery`, `compound engineering skill` — zero matches).
