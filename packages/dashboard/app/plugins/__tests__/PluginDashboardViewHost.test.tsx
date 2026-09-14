import { lazy } from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ListChecks } from "lucide-react";
import { PluginDashboardViewHost } from "../PluginDashboardViewHost";
import { PluginDashboardViewHeader } from "../PluginDashboardViewHeader";
import { __test_clearPluginViewRegistry, registerPluginView } from "../pluginViewRegistry";

const PLUGIN_VIEW = "plugin:plugin-layout-test:main" as const;

describe("PluginDashboardViewHost standardized layout", () => {
  beforeEach(() => {
    __test_clearPluginViewRegistry();
    registerPluginView(
      "plugin-layout-test",
      "main",
      lazy(async () => ({
        default: () => (
          <>
            <PluginDashboardViewHeader
              title="Plugin-owned title"
              actions={<button type="button">Refresh plugin data</button>}
            />
            <div data-testid="plugin-body">Plugin body</div>
          </>
        ),
      })),
    );
  });

  it("keeps the legacy unframed host contract when no layout is supplied", async () => {
    const { container } = render(<PluginDashboardViewHost taskView={PLUGIN_VIEW} />);

    expect(await screen.findByTestId("plugin-body")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Plugin-owned title" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Refresh plugin data" })).toBeInTheDocument();
    expect(container.querySelector(".view-layout")).toBeNull();
  });

  it("composes canonical header, sidebar, and bounded content for a full destination", async () => {
    render(
      <PluginDashboardViewHost
        taskView={PLUGIN_VIEW}
        layout={{
          title: "Todos",
          icon: ListChecks,
          primaryAction: { label: "Create list", kind: "create", onClick: () => undefined },
          sidebar: <button type="button">Inbox</button>,
          sidebarLabel: "Todo lists",
        }}
      />,
    );

    expect(await screen.findByTestId("plugin-body")).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { name: "Todos" })).toHaveLength(1);
    expect(screen.queryByRole("heading", { name: "Plugin-owned title" })).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Refresh plugin data" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create list" })).toBeInTheDocument();
    expect(screen.getByRole("complementary", { name: "Todo lists" })).toBeInTheDocument();
    expect(screen.getByRole("separator", { name: "Resize sidebar" })).toBeInTheDocument();
  });
});
