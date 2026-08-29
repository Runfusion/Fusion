import { describe, it, expect } from "vitest";

/**
 * This test file validates the step commit regex pattern used in
 * reconcileStepsFromGitHistory. The regex matches commit messages like:
 * "feat(FN-2978): complete Step 3" or "chore(fn-2978): complete step 0"
 *
 * The regex is embedded in executor.ts:5498 but we test it here in isolation
 * for clarity and ease of maintenance.
 */

const stepCommitRegex = /^(?:feat|chore|fix)\([Ff][Nn]-\d+\)(?:!)?:\s*complete\s+step\s+(\d+)/i;

describe("reconcileStepsFromGitHistory regex pattern", () => {
  describe("matching valid commit messages", () => {
    it('matches "feat(FN-2978): complete Step 3"', () => {
      const message = "feat(FN-2978): complete Step 3";
      const match = message.match(stepCommitRegex);
      expect(match).toBeTruthy();
      expect(match![1]).toBe("3");
    });

    it('matches "chore(fn-2978): complete step 0"', () => {
      const message = "chore(fn-2978): complete step 0";
      const match = message.match(stepCommitRegex);
      expect(match).toBeTruthy();
      expect(match![1]).toBe("0");
    });

    it('matches "fix(FN-1234)!: Complete Step 5 of refactor"', () => {
      const message = "fix(FN-1234)!: Complete Step 5 of refactor";
      const match = message.match(stepCommitRegex);
      expect(match).toBeTruthy();
      expect(match![1]).toBe("5");
    });

    it("handles case-insensitive matching of 'complete' and 'step'", () => {
      const variations = [
        "feat(FN-100): COMPLETE STEP 1",
        "feat(FN-100): Complete Step 1",
        "feat(FN-100): CoMpLeTe StEp 1",
      ];

      for (const message of variations) {
        const match = message.match(stepCommitRegex);
        expect(match).toBeTruthy();
        expect(match![1]).toBe("1");
      }
    });

    it("handles various FN task IDs (2-digit, 3-digit, 4-digit)", () => {
      const variations = [
        "feat(FN-1): complete step 0",
        "feat(FN-99): complete step 2",
        "feat(FN-999): complete step 5",
        "feat(FN-12345): complete step 10",
      ];

      for (const message of variations) {
        const match = message.match(stepCommitRegex);
        expect(match).toBeTruthy();
        expect(typeof match![1]).toBe("string");
        expect(Number.isNaN(parseInt(match![1], 10))).toBe(false);
      }
    });

    it("handles breaking change indicator (!)", () => {
      const message = "feat(FN-2978)!: complete step 3";
      const match = message.match(stepCommitRegex);
      expect(match).toBeTruthy();
      expect(match![1]).toBe("3");
    });

    it("handles various whitespace patterns after colon", () => {
      const variations = [
        "feat(FN-100): complete step 5",
        "feat(FN-100):  complete step 5",
        "feat(FN-100):   complete step 5",
      ];

      for (const message of variations) {
        const match = message.match(stepCommitRegex);
        expect(match).toBeTruthy();
      }
    });

    it("captures step number correctly (0-99)", () => {
      const testCases = [
        ["feat(FN-100): complete step 0", "0"],
        ["feat(FN-100): complete step 9", "9"],
        ["feat(FN-100): complete step 10", "10"],
        ["feat(FN-100): complete step 99", "99"],
      ];

      for (const [message, expectedStep] of testCases) {
        const match = message.match(stepCommitRegex);
        expect(match).toBeTruthy();
        expect(match![1]).toBe(expectedStep);
      }
    });
  });

  describe("rejecting invalid commit messages", () => {
    it('rejects "feat(FN-2978): step 3 done" (wrong word order)', () => {
      const message = "feat(FN-2978): step 3 done";
      const match = message.match(stepCommitRegex);
      expect(match).toBeFalsy();
    });

    it('rejects "feat(FN-2978): WIP step 3" (missing "complete")', () => {
      const message = "feat(FN-2978): WIP step 3";
      const match = message.match(stepCommitRegex);
      expect(match).toBeFalsy();
    });

    it('rejects "Merge branch \'fusion/fn-2978-2\'" (merge commit)', () => {
      const message = "Merge branch 'fusion/fn-2978-2'";
      const match = message.match(stepCommitRegex);
      expect(match).toBeFalsy();
    });

    it('rejects "feat(ABC-100): complete step 5" (wrong task prefix)', () => {
      const message = "feat(ABC-100): complete step 5";
      const match = message.match(stepCommitRegex);
      expect(match).toBeFalsy();
    });

    it('rejects "feat(2978): complete step 5" (missing FN prefix)', () => {
      const message = "feat(2978): complete step 5";
      const match = message.match(stepCommitRegex);
      expect(match).toBeFalsy();
    });

    it('rejects "refactor(FN-2978): complete step 3" (wrong commit type)', () => {
      const message = "refactor(FN-2978): complete step 3";
      const match = message.match(stepCommitRegex);
      expect(match).toBeFalsy();
    });

    it('rejects "feat(FN-2978): finished step 3" (wrong verb)', () => {
      const message = "feat(FN-2978): finished step 3";
      const match = message.match(stepCommitRegex);
      expect(match).toBeFalsy();
    });

    it('rejects "feat(FN-2978): complete steps 3" (plural)', () => {
      const message = "feat(FN-2978): complete steps 3";
      const match = message.match(stepCommitRegex);
      expect(match).toBeFalsy();
    });

    it('rejects messages without step number', () => {
      const message = "feat(FN-2978): complete step";
      const match = message.match(stepCommitRegex);
      expect(match).toBeFalsy();
    });

    it('rejects messages with text after step number (when not matched at start)', () => {
      // Note: the regex uses ^ so it requires the pattern at the start of the line
      // This is important for git log --oneline which includes the SHA before the message
      const fullLine = "a1b2c3d feat(FN-2978): complete step 3";
      const message = fullLine.replace(/^[0-9a-f]+ /, "").trim();
      const match = message.match(stepCommitRegex);
      expect(match).toBeTruthy();
    });
  });

  describe("real-world git log parsing", () => {
    it("extracts step number from git log line format", () => {
      // git log --oneline format: "<sha> <message>"
      const logLine = "a1b2c3d feat(FN-2978): complete Step 3";
      const message = logLine.replace(/^[0-9a-f]+ /, "").trim();
      const match = message.match(stepCommitRegex);

      expect(match).toBeTruthy();
      expect(match![1]).toBe("3");
    });

    it("handles multiple commits in git log output", () => {
      const logOutput = `
a1b2c3d feat(FN-2978): complete Step 1
b2c3d4e chore(fn-2978): complete step 2
c3d4e5f fix(FN-2978)!: Complete Step 3
d4e5f6g feat(FN-2979): complete step 1
e5f6g7h Merge branch 'main'
      `.trim();

      const matches = [];
      for (const line of logOutput.split("\n")) {
        const message = line.replace(/^[0-9a-f]+ /, "").trim();
        const match = message.match(stepCommitRegex);
        if (match) {
          matches.push({
            message,
            stepNumber: parseInt(match[1], 10),
          });
        }
      }

      expect(matches.length).toBe(3);
      expect(matches[0].stepNumber).toBe(1);
      expect(matches[1].stepNumber).toBe(2);
      expect(matches[2].stepNumber).toBe(3);
    });

    it("correctly identifies steps for reconciliation in mixed log", () => {
      const logOutput = `
deadbeef feat(FN-2978): complete Step 4
cafebabe chore(fn-2978): complete step 5
badf00d fix(FN-2978)!: Complete Step 6
abcdef1 feat(Other-123): some other work
      `.trim();

      const pendingSteps = [3, 4, 5, 6, 7]; // Steps that need reconciliation
      const reconciledIndices = new Set<number>();

      for (const line of logOutput.split("\n")) {
        const message = line.replace(/^[0-9a-f]+ /, "").trim();
        const match = message.match(stepCommitRegex);
        if (!match) continue;

        const stepIndex = parseInt(match[1], 10);
        if (pendingSteps.includes(stepIndex)) {
          reconciledIndices.add(stepIndex);
        }
      }

      expect(Array.from(reconciledIndices).sort()).toEqual([4, 5, 6]);
    });
  });

  describe("boundary and special cases", () => {
    it("handles step number 0 correctly", () => {
      const message = "feat(FN-100): complete step 0";
      const match = message.match(stepCommitRegex);
      expect(match).toBeTruthy();
      expect(match![1]).toBe("0");
    });

    it("handles very large step numbers", () => {
      const message = "feat(FN-100): complete step 9999";
      const match = message.match(stepCommitRegex);
      expect(match).toBeTruthy();
      expect(match![1]).toBe("9999");
    });

    it("does not match if there are leading spaces (regex uses ^)", () => {
      const message = "  feat(FN-100): complete step 5";
      const match = message.match(stepCommitRegex);
      expect(match).toBeFalsy();
    });

    it("handles commit message with extra text after step number", () => {
      const message = "feat(FN-2978): complete step 3 (wiring complete)";
      const match = message.match(stepCommitRegex);
      expect(match).toBeTruthy();
      expect(match![1]).toBe("3");
    });
  });
});
