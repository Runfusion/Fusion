import { describe, expect, it } from "vitest";
import { detectExternalIntegrationEvidenceGaps } from "../spec-validation/external-integration-evidence.js";

const fn6349EvidenceBlock = `## Mission
Validate released third-party external integration.

## External Integration Evidence
This task installs and runs the released third-party-distributed Fusion CLI (\`@runfusion/fusion\`) from the public npm registry. Provenance (verified via \`npm view @runfusion/fusion\` on 2026-06-13):

- Canonical upstream repo URL: https://github.com/Runfusion/Fusion
- Docs / homepage URL: https://github.com/Runfusion/Fusion#readme (npm package page: https://www.npmjs.com/package/@runfusion/fusion); in-repo author guide \`docs/plugins/external-authoring.md\`
- Release / download URL: https://registry.npmjs.org/@runfusion/fusion/-/fusion-0.41.0.tgz
- Binary / CLI name: \`fn\` (provided by the published \`@runfusion/fusion\` package; also invokable via \`npx @runfusion/fusion@latest\`)
- Checksum (dist.integrity for 0.41.0): \`sha512-y8BSeK3XUgcE7ceTrz6F/zWQidaiADVgHSHHWKRzwjyR40xeUc8i5ZSolGd1zL/K9AxrBSkRErimkW1xqb/EBw==\` (marker: \`upstream-pending-verification\` if a newer release ships before validation)

## Steps
- Install and run the released third-party external integration.
`;

describe("detectExternalIntegrationEvidenceGaps", () => {
  it("returns empty findings when prompt has no external integration signals", () => {
    const prompt = `# Task\n## Mission\nRefactor retry budget counters in scheduler.\n## Steps\n- Update store logic.`;
    expect(detectExternalIntegrationEvidenceGaps({ promptContent: prompt })).toEqual([]);
  });

  it("flags FN-5320 style hallucination signals", () => {
    const fabricatedRepo = ["worktrunk", "worktrunk"].join("/");
    const prompt = `## Mission\nAdd external integration for worktrunk install flow.\n\n## Steps\n- Install and probe \`worktrunk\` binary.\n- Download from https://github.com/${fabricatedRepo}/releases/latest/download/worktrunk.tar.gz`;

    const findings = detectExternalIntegrationEvidenceGaps({ promptContent: prompt });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.missing).toEqual(
      expect.arrayContaining(["canonical-upstream-repo-url", "checksum-or-source-of-truth-evidence"]),
    );
  });

  it("accepts a canonical worktrunk evidence set", () => {
    const prompt = `## Mission\nHarden external binary integration.\n\n## Context to Read First\n- https://github.com/max-sixty/worktrunk\n- https://worktrunk.dev/\n- WORKTRUNK_PINNED_RELEASE\n\n## Steps\n- Probe and run \`wt\` from PATH.\n- Reference releases at https://github.com/max-sixty/worktrunk/releases/latest/download/wt-linux-x64.tar.gz\n- Keep source as upstream-pending-verification until checksums are pinned.`;

    expect(detectExternalIntegrationEvidenceGaps({ promptContent: prompt })).toEqual([]);
  });

  it("accepts FN-6349 labeled evidence in a dedicated external integration evidence section", () => {
    expect(detectExternalIntegrationEvidenceGaps({ promptContent: fn6349EvidenceBlock })).toEqual([]);
  });

  it("accepts concrete labeled markdown evidence with backtick-wrapped URLs and sha256 digest", () => {
    const prompt = `## Mission\nInstall third-party external CLI from an upstream release.\n\n## External-Integration Evidence\n- Canonical upstream repo: \`https://github.com/acme/tooling\`\n- Docs/homepage: \`https://docs.acme.test/tooling\`\n- Release/download: \`https://downloads.acme.test/tooling/tooling-1.2.3.tar.gz\`\n- Binary/CLI name: \`ac\`\n- Checksum: sha256-deadbeef\n\n## Steps\n- Download, probe, and run the external binary.`;

    expect(detectExternalIntegrationEvidenceGaps({ promptContent: prompt })).toEqual([]);
  });

  it("accepts inline labeled evidence in pre-existing scanned sections", () => {
    const prompt = `## Mission\nAdd third-party external tool install flow.\n\n## Context to Read First\n- Canonical upstream repo URL: https://github.com/acme/tooling\n- Docs URL: https://docs.acme.test/tooling\n- Release URL: https://github.com/acme/tooling/releases/download/v1.0.0/tooling.tgz\n- CLI name: \`ac\`\n- Checksum: upstream-pending-verification\n\n## Steps\n- Install, probe, and run the external binary.`;

    expect(detectExternalIntegrationEvidenceGaps({ promptContent: prompt })).toEqual([]);
  });

  it("still requires checksum evidence when the FN-6349 block omits checksum and source markers", () => {
    const prompt = fn6349EvidenceBlock.replace(
      /- Checksum \(dist\.integrity for 0\.41\.0\):.*\n/,
      "- Checksum (dist.integrity for 0.41.0):\n",
    );

    const findings = detectExternalIntegrationEvidenceGaps({ promptContent: prompt });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.missing).toContain("checksum-or-source-of-truth-evidence");
  });

  it("still requires an artifact URL and a backticked CLI name", () => {
    const prompt = `## Mission\nAdd third-party external CLI install flow.\n\n## External Integration Evidence\n- Canonical upstream repo URL: https://github.com/acme/tooling\n- Docs / homepage URL: https://docs.acme.test/tooling\n- Release / download URL:\n- Binary / CLI name: ac\n- Checksum: sha512-deadbeef\n\n## Steps\n- Download and probe the external binary.`;

    const findings = detectExternalIntegrationEvidenceGaps({ promptContent: prompt });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.missing).toEqual(expect.arrayContaining(["release-or-download-url", "binary-or-cli-name"]));
  });

  it("treats duplicate-segment github URLs as missing canonical evidence", () => {
    const duplicateRepo = ["foo", "foo"].join("/");
    const prompt = `## Mission\nExternal tool install.\n## Steps\n- download release from https://github.com/${duplicateRepo}/releases/latest/download/foo.tgz\n- run and probe \`foo\``;

    const findings = detectExternalIntegrationEvidenceGaps({ promptContent: prompt });
    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0]?.missing).toContain("canonical-upstream-repo-url");
  });
});
