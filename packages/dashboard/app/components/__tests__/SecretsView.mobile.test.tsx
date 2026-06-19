import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAllAppCss, loadAllAppCssBaseOnly } from "../../test/cssFixture";
import { SecretsView } from "../SecretsView";
import { MOBILE_MEDIA_QUERY } from "../../hooks/useViewportMode";

type JsonResponse = {
  ok: boolean;
  status?: number;
  body: unknown;
};

function mockJsonResponse({ ok, status = ok ? 200 : 400, body }: JsonResponse): Response {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

function extractRuleBlock(css: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\}`));
  return match?.[1] ?? "";
}

function findRuleBodyContainingSelector(css: string, selector: string): string {
  const ruleRegex = /([^{}]+)\{([^}]*)\}/g;
  let match: RegExpExecArray | null;

  while ((match = ruleRegex.exec(css)) !== null) {
    const selectors = match[1]?.split(",").map((part) => part.trim()) ?? [];
    if (selectors.includes(selector)) {
      return match[2] ?? "";
    }
  }

  return "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractMobileMediaBlocks(content: string): string {
  const blocks: string[] = [];
  const queryPattern = `(?:${escapeRegExp(MOBILE_MEDIA_QUERY)}|\\(max-width:\\s*768px\\))(?:\\s*,\\s*\\([^)]*\\))*`;
  const regex = new RegExp(`@media\\s*${queryPattern}\\s*\\{`, "g");
  let match: RegExpExecArray | null;

  while ((match = regex.exec(content)) !== null) {
    const startIdx = match.index + match[0].length;
    let braceCount = 1;
    let endIdx = startIdx;

    while (braceCount > 0 && endIdx < content.length) {
      if (content[endIdx] === "{") braceCount += 1;
      if (content[endIdx] === "}") braceCount -= 1;
      endIdx += 1;
    }

    if (braceCount === 0) {
      blocks.push(content.slice(startIdx, endIdx - 1));
    }
  }

  return blocks.join("\n");
}

function installCss(css: string) {
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  return () => style.remove();
}

const secretsViewCss = readFileSync(resolve(__dirname, "../SecretsView.css"), "utf8");
const allCss = loadAllAppCss();
const baseCss = loadAllAppCssBaseOnly();

function seedFetchForSecretsList() {
  const secrets = [
    {
      id: "secret-1",
      scope: "project",
      key: "LONG_SECRET_KEY_NAME_FOR_WRAP_TESTING",
      description: null,
      accessPolicy: "prompt",
      envExportable: false,
      envExportKey: null,
      lastReadAt: null,
    },
  ];

  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { secrets } }))
    .mockResolvedValueOnce(mockJsonResponse({ ok: true, body: { configured: false } }));

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SecretsView mobile layout contracts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("keeps SecretsView.css token-only", () => {
    const normalizedCss = secretsViewCss
      .replace(new RegExp(escapeRegExp(MOBILE_MEDIA_QUERY), "g"), "MOBILE_MEDIA_QUERY")
      .replace(/max-width:\s*768px/g, "max-width: MOBILE_BREAKPOINT")
      .replace(/max-height:\s*480px/g, "max-height: MOBILE_HEIGHT_BREAKPOINT")
      .replace(/\b0px\b/g, "0");

    expect(normalizedCss).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(normalizedCss).not.toMatch(/rgba?\(/);
    expect(normalizedCss).not.toMatch(/\b\d+px\b/);
  });

  it("grows the root container to fill the project-content flex row", () => {
    const rootBlock = extractRuleBlock(secretsViewCss, ".secrets-view");

    expect(rootBlock).toMatch(/flex\s*:\s*1\s+1\s+auto/);
    expect(rootBlock).toMatch(/width\s*:\s*100%/);
  });

  it("keeps the mobile media block free of button and modal-close overrides", () => {
    const mobileCss = extractMobileMediaBlocks(secretsViewCss);

    expect(mobileCss).not.toMatch(/\.btn(?:\b|[-_])/);
    expect(mobileCss).not.toMatch(/\.modal-close/);
  });

  it.each([".secrets-header", ".secrets-row", ".secrets-sync-header"])(
    "mobile media rules stack %s as a column",
    (selector) => {
      const mobileCss = extractMobileMediaBlocks(secretsViewCss);
      const ruleBlock = findRuleBodyContainingSelector(mobileCss, selector);

      expect(ruleBlock).toMatch(/flex-direction\s*:\s*column/);
    },
  );

  it("renders add-secret modal body with scoped spacing", async () => {
    const removeCss = installCss(baseCss);
    seedFetchForSecretsList();

    render(<SecretsView addToast={vi.fn()} />);
    await screen.findByText("LONG_SECRET_KEY_NAME_FOR_WRAP_TESTING");

    await userEvent.click(screen.getByRole("button", { name: "Add Secret" }));

    const modalBody = document.querySelector(".secrets-modal-body");
    expect(modalBody).toBeTruthy();
    expect(getComputedStyle(modalBody as Element).gap).not.toBe("");

    removeCss();
  });
});

describe("SecretsView revealed value styling", () => {
  it("keeps revealed values scrollable within the card", () => {
    const revealedBlock = extractRuleBlock(allCss, ".secrets-revealed");

    expect(revealedBlock).toMatch(/overflow-x\s*:\s*auto/);
    expect(revealedBlock).toMatch(/max-width\s*:\s*100%/);
  });
});
