import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const hosts = [
  "../../components/TaskCard.tsx",
  "../../components/ListView.tsx",
  "../../components/TaskDetailModal.tsx",
];

describe("task status badge host inventory", () => {
  it("keeps every badge host wired to the durable contention wait reason", () => {
    for (const host of hosts) {
      const source = readFileSync(resolve(__dirname, host), "utf8");
      expect(source).toContain("getTaskStatusBadgeLabel");
      expect(source).toContain("sessionContentionWaitReason");
    }
  });
});
