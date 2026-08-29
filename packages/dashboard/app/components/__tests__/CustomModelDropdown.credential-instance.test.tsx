import type { ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CustomModelDropdown } from "../CustomModelDropdown";

vi.mock("../ProviderIcon", () => ({
  ProviderIcon: () => <span />,
}));

const models = [{ provider: "openai", id: "gpt-4o", name: "GPT-4o", reasoning: false, contextWindow: 128000 }];

async function openDropdown(props: Partial<ComponentProps<typeof CustomModelDropdown>>) {
  const user = userEvent.setup();
  render(<CustomModelDropdown label="Model" value="openai/gpt-4o" onChange={vi.fn()} models={models} {...props} />);
  await user.click(screen.getByRole("button", { name: "Model" }));
  return user;
}

describe("CustomModelDropdown credential instance", () => {
  it.each([undefined, {}, { openai: { instances: [] } }, { openai: { instances: [{ id: "only", isDefault: true }] } }])(
    "renders no instance control unless the selected provider has two instances",
    async (credentialInstances) => {
      await openDropdown({ credentialInstances });
      expect(screen.queryByTestId("custom-model-dropdown-credential-instance")).toBeNull();
      expect(screen.queryByTestId("custom-model-dropdown-credential-instance-badge")).toBeNull();
    },
  );

  it("keeps hidden menus structurally free of an instance shell at desktop and mobile breakpoints", async () => {
    for (const width of [1024, 768, 480]) {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: width });
      const user = await openDropdown({ credentialInstances: { openai: { instances: [{ id: "only", isDefault: true }] } } });
      const menu = screen.getAllByTestId("model-combobox-portal").at(-1)!;
      expect([...menu.children].map((element) => element.className)).not.toContain("model-combobox-instance");
      expect(screen.queryByTestId("custom-model-dropdown-credential-instance")).toBeNull();
      expect(screen.queryByTestId("custom-model-dropdown-credential-instance-badge")).toBeNull();
      await user.keyboard("{Escape}");
      cleanup();
    }
  });

  it("shows availability-driven control even before an owner supplies a persistence callback", async () => {
    await openDropdown({
      credentialInstances: { openai: { instances: [{ id: "primary", isDefault: true }, { id: "backup", isDefault: false }] } },
    });
    expect(screen.getByTestId("custom-model-dropdown-credential-instance")).toBeDisabled();
  });

  it("deduplicates instances, preserves a stale selection, and emits empty only for Default", async () => {
    const onCredentialInstanceChange = vi.fn();
    const user = await openDropdown({
      credentialInstanceId: "stale",
      onCredentialInstanceChange,
      credentialInstances: {
        openai: { instances: [{ id: "primary", isDefault: true }, { id: "primary", isDefault: false }, { id: "backup", isDefault: false }] },
      },
    });

    const select = screen.getByTestId("custom-model-dropdown-credential-instance") as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual(["", "primary", "backup", "stale"]);
    expect(select.value).toBe("stale");
    await user.selectOptions(select, "backup");
    expect(onCredentialInstanceChange).toHaveBeenLastCalledWith("backup");
    await user.selectOptions(select, "");
    expect(onCredentialInstanceChange).toHaveBeenLastCalledWith("");
  });

  it("recomputes availability after the selected provider changes without affecting keyboard dismissal", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onCredentialInstanceChange = vi.fn();
    const { rerender } = render(
      <CustomModelDropdown
        label="Model"
        value="openai/gpt-4o"
        onChange={onChange}
        models={[
          ...models,
          { provider: "anthropic", id: "claude", name: "Claude", reasoning: false, contextWindow: 128000 },
        ]}
        credentialInstances={{
          openai: { instances: [{ id: "primary", isDefault: true }, { id: "backup", isDefault: false }] },
          anthropic: { instances: [{ id: "only", isDefault: true }] },
        }}
        onCredentialInstanceChange={onCredentialInstanceChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByTestId("custom-model-dropdown-credential-instance")).toBeTruthy();
    rerender(
      <CustomModelDropdown
        label="Model"
        value="anthropic/claude"
        onChange={onChange}
        models={[
          ...models,
          { provider: "anthropic", id: "claude", name: "Claude", reasoning: false, contextWindow: 128000 },
        ]}
        credentialInstances={{
          openai: { instances: [{ id: "primary", isDefault: true }, { id: "backup", isDefault: false }] },
          anthropic: { instances: [{ id: "only", isDefault: true }] },
        }}
        onCredentialInstanceChange={onCredentialInstanceChange}
      />,
    );
    expect(screen.queryByTestId("custom-model-dropdown-credential-instance")).toBeNull();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("model-combobox-portal")).toBeNull();
  });
});
