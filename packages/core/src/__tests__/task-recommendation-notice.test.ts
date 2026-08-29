import { describe, expect, it } from "vitest";
import {
  buildTaskRecommendationNoticeContent,
  buildTaskRecommendationNoticeIdempotencyKey,
  notifyOperatorOfTaskRecommendations,
  registerTaskRecommendationNoticeMailbox,
  type MessageCreateInput,
  type TaskRecommendation,
} from "../index.js";

const task = { id: "FN-9021", title: "Mailbox recommendation notice" };
const recommendations: TaskRecommendation[] = [
  { id: "follow-up-a", title: "Improve docs", description: "Document the next step.", category: "improvement" },
  { id: "follow-up-b", title: "Add a feature", description: "Expose the operator control.", category: "feature" },
];

function createStore(): object {
  return {};
}

describe("task recommendation notice", () => {
  it("writes non-empty recommendations with prose only in content", async () => {
    const store = createStore();
    const sent: Array<{ input: MessageCreateInput; key: string }> = [];
    registerTaskRecommendationNoticeMailbox(store as never, {
      sendMessageOnce: async (input, key) => { sent.push({ input, key }); },
    });

    await expect(notifyOperatorOfTaskRecommendations(store as never, task, recommendations, {})).resolves.toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].input).toMatchObject({
      toId: "dashboard",
      toType: "user",
      type: "system",
      metadata: {
        kind: "task-recommendation-notice",
        taskId: task.id,
        recommendationCount: 2,
        recommendationIds: ["follow-up-a", "follow-up-b"],
        categories: ["improvement", "feature"],
      },
    });
    expect(sent[0].input.content).toContain("Use the **Create task** button beside each recommendation");
    expect(sent[0].input.content).toContain(`open ${task.id}'s **Recommendations** tab`);
    for (const recommendation of recommendations) {
      expect(sent[0].input.content).toContain(recommendation.title);
      expect(JSON.stringify(sent[0].input.metadata)).not.toContain(recommendation.title);
      expect(JSON.stringify(sent[0].input.metadata)).not.toContain(recommendation.description);
    }
  });

  it.each([
    ["empty list", [] as TaskRecommendation[], {}],
    ["omitted list", undefined, {}],
    ["disabled setting", recommendations, { recommendationMailboxNoticeEnabled: false }],
  ])("does not write for %s", async (_name, value, settings) => {
    const store = createStore();
    let calls = 0;
    registerTaskRecommendationNoticeMailbox(store as never, { sendMessageOnce: async () => { calls += 1; } });
    await expect(notifyOperatorOfTaskRecommendations(store as never, task, value, settings)).resolves.toBe(false);
    expect(calls).toBe(0);
  });

  it("silently degrades without a mailbox and swallows mailbox failures", async () => {
    const absentStore = createStore();
    await expect(notifyOperatorOfTaskRecommendations(absentStore as never, task, recommendations, {})).resolves.toBe(false);
    const failingStore = createStore();
    registerTaskRecommendationNoticeMailbox(failingStore as never, { sendMessageOnce: async () => { throw new Error("unavailable"); } });
    await expect(notifyOperatorOfTaskRecommendations(failingStore as never, task, recommendations, {})).resolves.toBe(false);
  });

  it("keeps the inline-action copy in the standalone content builder", () => {
    expect(buildTaskRecommendationNoticeContent(task, recommendations)).toContain("Use the **Create task** button beside each recommendation");
  });

  it("dedupes equal id sets but changes keys for changed ids", () => {
    expect(buildTaskRecommendationNoticeIdempotencyKey(task.id, recommendations)).toBe(
      buildTaskRecommendationNoticeIdempotencyKey(task.id, [...recommendations].reverse()),
    );
    expect(buildTaskRecommendationNoticeIdempotencyKey(task.id, recommendations)).not.toBe(
      buildTaskRecommendationNoticeIdempotencyKey(task.id, [recommendations[0]]),
    );
  });
});
