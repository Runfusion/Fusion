/*
FNXC:MergePush 2026-07-11-23:35:
The push-after-merge target moved from one free-text field to a remote dropdown + target
branch dropdown (persisting to the same `pushRemote` setting string). These tests pin the
parse/compose round-trip, the dropdown rendering, the remote→branch reload, the Custom…
escape hatch, and the free-text fallback when the repo has no configured remotes.
*/
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MergeSection, parsePushRemoteSetting, composePushRemoteSetting } from "../MergeSection";
import type { MergeSectionProps } from "../MergeSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

const mockFetchGitRemoteBranches = vi.fn();
vi.mock("../../../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../api")>();
  return {
    ...actual,
    fetchGitRemoteBranches: (...args: unknown[]) => mockFetchGitRemoteBranches(...args),
  };
});

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  } as Response;
}

function makeProps(
  formOverrides: Partial<MergeSectionProps["form"]> = {},
  propOverrides: Partial<MergeSectionProps> = {},
): MergeSectionProps {
  return {
    scopeBanner: null,
    form: {
      autoMerge: true,
      planApprovalMode: "workflow",
      merger: { mode: "ai" },
      testMode: false,
      mergeStrategy: "direct",
      pushAfterMerge: true,
      ...formOverrides,
    } as MergeSectionProps["form"],
    setForm: vi.fn(),
    integrationBranchOptions: ["main"],
    integrationBranchCustomMode: false,
    setIntegrationBranchCustomMode: vi.fn(),
    gitRemoteOptions: ["origin", "upstream"],
    projectId: "proj-1",
    ...propOverrides,
  };
}

function lastFormUpdate(props: MergeSectionProps): MergeSectionProps["form"] {
  const updater = vi.mocked(props.setForm).mock.calls.at(-1)?.[0] as (state: MergeSectionProps["form"]) => MergeSectionProps["form"];
  return updater(props.form);
}

describe("parsePushRemoteSetting / composePushRemoteSetting", () => {
  it("round-trips the supported setting shapes", () => {
    expect(parsePushRemoteSetting(undefined)).toEqual({ remote: "origin", branch: "" });
    expect(parsePushRemoteSetting("origin")).toEqual({ remote: "origin", branch: "" });
    expect(parsePushRemoteSetting("upstream main")).toEqual({ remote: "upstream", branch: "main" });
    expect(parsePushRemoteSetting("  upstream   main  ")).toEqual({ remote: "upstream", branch: "main" });

    expect(composePushRemoteSetting("origin", "")).toBeUndefined();
    expect(composePushRemoteSetting("origin", "main")).toBe("origin main");
    expect(composePushRemoteSetting("upstream", "")).toBe("upstream");
    expect(composePushRemoteSetting("upstream", "release")).toBe("upstream release");
  });
});

describe("MergeSection push remote/branch dropdowns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ candidates: [], count: 0 })));
    mockFetchGitRemoteBranches.mockResolvedValue(["main", "develop"]);
  });

  it("renders remote + branch dropdowns and loads the selected remote's branches", async () => {
    render(<MergeSection {...makeProps()} />);

    const remoteSelect = screen.getByTestId("push-remote-select") as HTMLSelectElement;
    expect(remoteSelect.value).toBe("origin");
    expect(screen.getByRole("option", { name: "upstream" })).toBeInTheDocument();

    await waitFor(() => expect(mockFetchGitRemoteBranches).toHaveBeenCalledWith("origin", "proj-1"));
    await waitFor(() => expect(screen.getByRole("option", { name: "develop" })).toBeInTheDocument());
    const branchSelect = screen.getByTestId("push-remote-branch-select") as HTMLSelectElement;
    expect(branchSelect.value).toBe("");
    expect(screen.getByRole("option", { name: "(same as integration branch — default)" })).toBeInTheDocument();
  });

  it("composes 'remote branch' into the pushRemote setting when a branch is picked", async () => {
    const props = makeProps({ pushRemote: undefined });
    render(<MergeSection {...props} />);
    await waitFor(() => expect(screen.getByRole("option", { name: "develop" })).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("push-remote-branch-select"), { target: { value: "develop" } });
    expect(lastFormUpdate(props).pushRemote).toBe("origin develop");
  });

  it("switching the remote resets the target branch and stores the bare remote", async () => {
    const props = makeProps({ pushRemote: "origin develop" });
    render(<MergeSection {...props} />);

    fireEvent.change(screen.getByTestId("push-remote-select"), { target: { value: "upstream" } });
    expect(lastFormUpdate(props).pushRemote).toBe("upstream");
  });

  it("shows a persisted branch that is unknown on the remote as custom text input", async () => {
    render(<MergeSection {...makeProps({ pushRemote: "origin not-fetched-yet" })} />);

    const customInput = await screen.findByTestId("push-remote-branch-custom-input");
    expect(customInput).toHaveValue("not-fetched-yet");
    expect(screen.getByTestId("push-remote-branch-use-dropdown")).toBeInTheDocument();
  });

  it("falls back to the free-text Push Remote input when no remotes are configured", () => {
    render(<MergeSection {...makeProps({ pushRemote: "origin main" }, { gitRemoteOptions: [] })} />);

    expect(screen.queryByTestId("push-remote-select")).not.toBeInTheDocument();
    const input = screen.getByLabelText("Push Remote") as HTMLInputElement;
    expect(input.value).toBe("origin main");
    expect(mockFetchGitRemoteBranches).not.toHaveBeenCalled();
  });

  it("renders nothing push-related when push-after-merge is disabled", () => {
    render(<MergeSection {...makeProps({ pushAfterMerge: false })} />);

    expect(screen.queryByTestId("push-remote-select")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Push Remote")).not.toBeInTheDocument();
    expect(mockFetchGitRemoteBranches).not.toHaveBeenCalled();
  });
});
