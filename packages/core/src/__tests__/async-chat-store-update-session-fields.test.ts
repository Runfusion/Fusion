import { describe, expect, it } from "vitest";
import { updateChatSession } from "../async-stores/async-chat-store.js";

/*
FNXC:Chat-ModelSwitch 2026-09-01-04:23:
FN-9222 keeps a database-free guard over the update payload because the
PostgreSQL harness can be unavailable. Agent target changes must reach Drizzle
alongside model-pair clears without making omitted targets destructive.
*/

const sessionRow = {
  id: "session-1",
  agentId: "__fn_agent__",
  title: "Direct chat",
  status: "active",
  ownerProjectId: null,
  modelProvider: "p",
  modelId: "m",
  thinkingLevel: "medium",
  memoryFocus: null,
  createdAt: "2020-01-01T00:00:00.000Z",
  updatedAt: "2020-01-01T00:00:00.000Z",
  pinnedAt: "2020-01-02T00:00:00.000Z",
  cliSessionFile: null,
  inFlightGeneration: null,
  cliExecutorAdapterId: null,
};

function createQueryHandle(): { handle: Parameters<typeof updateChatSession>[0]; setValues: Record<string, unknown> | undefined } {
  const queuedRows: Record<string, unknown>[][] = [
    [sessionRow], [], // Existing session plus its tag join.
    [sessionRow], [], // Updated session plus its tag join.
  ];
  let setValues: Record<string, unknown> | undefined;

  const select = () => {
    const rows = queuedRows.shift() ?? [];
    const query = {
      from: () => query,
      innerJoin: () => query,
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      then: <T>(resolve: (value: Record<string, unknown>[]) => T) => Promise.resolve(rows).then(resolve),
    };
    return query;
  };

  const handle = {
    select,
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setValues = values;
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return { handle: handle as never, get setValues() { return setValues; } };
}

describe("updateChatSession field assembly", () => {
  it("forwards an agent target with the model-pair clear payload", async () => {
    const fake = createQueryHandle();

    await updateChatSession(fake.handle, "session-1", {
      agentId: "agent-real",
      modelProvider: null,
      modelId: null,
    });

    expect(fake.setValues).toMatchObject({ agentId: "agent-real", modelProvider: null, modelId: null });
  });

  it("does not add agentId when the update omits it", async () => {
    const fake = createQueryHandle();

    await updateChatSession(fake.handle, "session-1", { title: "x" });

    expect(fake.setValues).not.toHaveProperty("agentId");
  });

  it("forwards agentId while preserving archive pin clearing", async () => {
    const fake = createQueryHandle();

    await updateChatSession(fake.handle, "session-1", { agentId: "agent-real", status: "archived" });

    expect(fake.setValues).toMatchObject({ agentId: "agent-real", status: "archived", pinnedAt: null });
  });
});
