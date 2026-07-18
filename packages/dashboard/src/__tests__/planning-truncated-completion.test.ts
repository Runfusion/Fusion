// @vitest-environment node

import { describe, expect, it } from "vitest";
import { parseAgentResponse } from "../planning.js";

const completePrefix = '{"type":"complete","data":{"title":"Plan","description":"Complete description","keyDeliverables":[';

describe("parseAgentResponse truncated completion recovery", () => {
  it("accepts a clean complete payload, including legitimately empty deliverables", () => {
    const response = parseAgentResponse(JSON.stringify({
      type: "complete",
      data: { title: "Plan", description: "Complete description", keyDeliverables: [] },
    }));

    expect(response).toEqual({
      type: "complete",
      data: { title: "Plan", description: "Complete description", keyDeliverables: [] },
    });
  });

  it.each([
    ['{"type":"complete","data":{"title":"Plan","description":"chopped', "unclosed string"],
    [`${completePrefix}{"title":"first"}`, "unclosed array"],
    ['{"type":"complete","data":{"title":"Plan"', "unclosed object"],
  ])("rejects a %s completion instead of accepting repair as final", (response) => {
    expect(() => parseAgentResponse(response)).toThrow("truncated completion");
  });

  it("keeps trailing-comma question recovery tolerant", () => {
    expect(parseAgentResponse('{"type":"question","data":{"question":"What next?",}}')).toEqual({
      type: "question",
      data: { question: "What next?" },
    });
  });
});
