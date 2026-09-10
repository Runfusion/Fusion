/**
 * FNXC:Identity 2026-08-09-03:04:
 * U5: the `identityEnabled` master switch — its SCOPE and its PERMISSION PARTITION.
 *
 * Both properties are the kind that hold by construction until someone innocently changes a list,
 * and then fail silently rather than loudly:
 *
 *   - Scope (KTD20). If `identityEnabled` ever becomes a project key, an actor denied in project A
 *     operates freely in project B, because every caller there resolves to the bootstrap actor with
 *     full authority. Nothing throws; authorization just stops applying in one project.
 *   - Partition (KTD20/AE16). If writing it were covered by `settings:update`, anyone who can edit
 *     settings could switch authorization off from inside — the one permission that must not be
 *     reachable from ordinary configuration authority.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_SETTINGS,
  GLOBAL_SETTINGS_KEYS,
  PROJECT_SETTINGS_KEYS,
  isGlobalSettingsKey,
  isProjectSettingsKey,
} from "../config/settings-schema.js";
import { authorize } from "../identity/authorize.js";
import {
  __resetIdentityEnabledForTests,
  isIdentityEnabled,
  setIdentityEnabled,
} from "../identity/identity-enabled.js";
import type { ActorContext } from "../identity/actor.js";
import type { CatalogPermission, ResolvedGrantSet } from "../identity/permissions.js";

const ADMIN: ActorContext = { actor: { id: "actor-admin", kind: "human" } };

afterEach(() => {
  __resetIdentityEnabledForTests();
});

describe("identityEnabled: scope", () => {
  it("is a global settings key and NOT a project settings key", () => {
    expect(isGlobalSettingsKey("identityEnabled")).toBe(true);
    expect(isProjectSettingsKey("identityEnabled")).toBe(false);
  });

  /*
  Asserted against the exported registries rather than only the predicates: the predicates read from
  these arrays, so a key added to both lists would satisfy `isGlobalSettingsKey` while still being
  accepted on a project patch. This is the assertion that actually pins "no project can disable it".
  */
  it("appears in exactly one scope registry", () => {
    expect(GLOBAL_SETTINGS_KEYS).toContain("identityEnabled");
    expect(PROJECT_SETTINGS_KEYS).not.toContain("identityEnabled");
  });

  it("ships disabled so existing installs are unaffected until identity is turned on", () => {
    expect(DEFAULT_GLOBAL_SETTINGS.identityEnabled).toBe(false);
    expect(isIdentityEnabled()).toBe(false);
  });
});

describe("identityEnabled: the permission partition (AE16)", () => {
  const grantsFor = (held: readonly CatalogPermission[]) => (): ResolvedGrantSet => ({
    permissions: Object.fromEntries(held.map((p) => [p, "allow" as const])),
  });

  it("denies an actor holding settings:update but not identity:configure", () => {
    setIdentityEnabled(true);
    const decision = authorize({
      context: ADMIN,
      permission: "identity:configure",
      resolveGrants: grantsFor(["settings:update"]),
    });

    expect(decision.disposition).toBe("block");
    expect(decision.source).toBe("deny-by-default");
  });

  // Positive twin: the same actor CAN still edit ordinary settings, so the denial above is about
  // the partition and not about a fixture that denies everything.
  it("still allows that actor to update ordinary settings", () => {
    setIdentityEnabled(true);
    expect(
      authorize({
        context: ADMIN,
        permission: "settings:update",
        resolveGrants: grantsFor(["settings:update"]),
      }).disposition,
    ).toBe("allow");
  });

  it("allows an actor that actually holds identity:configure", () => {
    setIdentityEnabled(true);
    expect(
      authorize({
        context: ADMIN,
        permission: "identity:configure",
        resolveGrants: grantsFor(["identity:configure"]),
      }).disposition,
    ).toBe("allow");
  });
});

describe("identityEnabled: the in-process gate", () => {
  /*
  The switch must be observable in both directions from one input. A gate stuck in either position
  passes half the suite: stuck-on hides every "disabled behaves as today" test, stuck-off hides
  every enforcement test in the whole identity suite.
  */
  it("flips the authorization outcome for one identical input", () => {
    const input = {
      context: ADMIN,
      permission: "identity:configure" as CatalogPermission,
      resolveGrants: (): ResolvedGrantSet => ({ permissions: {} }),
    };

    __resetIdentityEnabledForTests();
    expect(authorize(input)).toMatchObject({ disposition: "allow", source: "identity-disabled" });

    setIdentityEnabled(true);
    expect(authorize(input)).toMatchObject({ disposition: "block", source: "deny-by-default" });
  });
});
