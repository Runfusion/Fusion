import { describe, it, expect } from "vitest";
import { canTransition, getValidTransitions, resolveDependencyOrder } from "./board.js";
import { VALID_TRANSITIONS, type Task, type Column } from "./types.js";

/**
 * Board logic tests
 *
 * Tests for column transition validation and dependency resolution.
 */

describe("board", () => {
  describe("canTransition", () => {
    it("returns true for all valid transitions defined in VALID_TRANSITIONS", () => {
      for (const [from, validTos] of Object.entries(VALID_TRANSITIONS)) {
        for (const to of validTos) {
          expect(canTransition(from as Column, to)).toBe(true);
        }
      }
    });

    it("returns false for invalid transitions", () => {
      const allColumns: Column[] = ["triage", "todo", "in-progress", "in-review", "done", "archived"];

      for (const from of allColumns) {
        for (const to of allColumns) {
          const isValid = VALID_TRANSITIONS[from].includes(to);
          if (!isValid) {
            expect(canTransition(from, to)).toBe(false);
          }
        }
      }
    });

    it("returns false for some invalid backwards transitions", () => {
      // done cannot go back to in-review directly
      expect(canTransition("done", "in-review")).toBe(false);
      // archived cannot go directly back to in-progress
      expect(canTransition("archived", "in-progress")).toBe(false);
      // triage cannot go backwards at all (no transitions before it)
      expect(canTransition("triage", "done")).toBe(false);
      expect(canTransition("triage", "archived")).toBe(false);
    });

    it("returns false for skipping columns", () => {
      // triage cannot skip to in-progress
      expect(canTransition("triage", "in-progress")).toBe(false);
      // todo cannot skip to in-review
      expect(canTransition("todo", "in-review")).toBe(false);
      // in-progress cannot skip to done
      expect(canTransition("in-progress", "done")).toBe(false);
    });
  });

  describe("getValidTransitions", () => {
    it("returns correct arrays for each column", () => {
      for (const [column, expected] of Object.entries(VALID_TRANSITIONS)) {
        expect(getValidTransitions(column as Column)).toEqual(expected);
      }
    });

    it("returns a copy of the array (modifications don't affect original)", () => {
      const transitions = getValidTransitions("todo");
      transitions.push("archived" as Column);

      // Original should be unchanged
      expect(getValidTransitions("todo")).not.toContain("archived");
    });

    it("returns correct transitions for triage", () => {
      expect(getValidTransitions("triage")).toEqual(["todo"]);
    });

    it("returns correct transitions for todo", () => {
      expect(getValidTransitions("todo")).toEqual(["in-progress", "triage"]);
    });

    it("returns correct transitions for in-progress", () => {
      expect(getValidTransitions("in-progress")).toEqual(["in-review", "todo", "triage"]);
    });

    it("returns correct transitions for in-review", () => {
      expect(getValidTransitions("in-review")).toEqual(["done", "in-progress", "todo"]);
    });

    it("returns correct transitions for done", () => {
      expect(getValidTransitions("done")).toEqual(["todo", "triage", "archived"]);
    });

    it("returns correct transitions for archived", () => {
      expect(getValidTransitions("archived")).toEqual(["done"]);
    });
  });

  describe("resolveDependencyOrder", () => {
    function createTask(id: string, dependencies: string[] = []): Task {
      return {
        id,
        description: `Task ${id}`,
        column: "todo",
        dependencies,
        steps: [],
        currentStep: 0,
        log: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
    }

    it("returns empty array for empty task array", () => {
      expect(resolveDependencyOrder([])).toEqual([]);
    });

    it("returns single task ID when no dependencies", () => {
      const task = createTask("FN-001");
      expect(resolveDependencyOrder([task])).toEqual(["FN-001"]);
    });

    it("handles linear dependencies (A → B → C)", () => {
      // C depends on B, B depends on A
      const taskC = createTask("FN-003", ["FN-002"]);
      const taskB = createTask("FN-002", ["FN-001"]);
      const taskA = createTask("FN-001");

      const order = resolveDependencyOrder([taskC, taskB, taskA]);

      // A should come before B, B should come before C
      const indexA = order.indexOf("FN-001");
      const indexB = order.indexOf("FN-002");
      const indexC = order.indexOf("FN-003");

      expect(indexA).toBeLessThan(indexB);
      expect(indexB).toBeLessThan(indexC);
    });

    it("handles diamond dependencies (A → B, A → C, B → D, C → D)", () => {
      //     A
      //    / \
      //   B   C
      //    \ /
      //     D
      const taskA = createTask("FN-A");
      const taskB = createTask("FN-B", ["FN-A"]);
      const taskC = createTask("FN-C", ["FN-A"]);
      const taskD = createTask("FN-D", ["FN-B", "FN-C"]);

      const order = resolveDependencyOrder([taskD, taskC, taskB, taskA]);

      const indexA = order.indexOf("FN-A");
      const indexB = order.indexOf("FN-B");
      const indexC = order.indexOf("FN-C");
      const indexD = order.indexOf("FN-D");

      // A should be first
      expect(indexA).toBeLessThan(indexB);
      expect(indexA).toBeLessThan(indexC);
      // Both B and C should come before D
      expect(indexB).toBeLessThan(indexD);
      expect(indexC).toBeLessThan(indexD);
    });

    it("handles disconnected components (independent tasks)", () => {
      const taskA = createTask("FN-A");
      const taskB = createTask("FN-B");
      const taskC = createTask("FN-C");

      const order = resolveDependencyOrder([taskB, taskC, taskA]);

      // All tasks should be in the output
      expect(order).toContain("FN-A");
      expect(order).toContain("FN-B");
      expect(order).toContain("FN-C");
      expect(order).toHaveLength(3);
    });

    it("handles circular dependencies gracefully (should not infinite loop)", () => {
      // A → B → C → A (circular)
      const taskA = createTask("FN-A", ["FN-C"]);
      const taskB = createTask("FN-B", ["FN-A"]);
      const taskC = createTask("FN-C", ["FN-B"]);

      // Should complete without hanging
      const order = resolveDependencyOrder([taskA, taskB, taskC]);

      // All tasks should be in the output (order is not strictly defined for circular)
      expect(order).toContain("FN-A");
      expect(order).toContain("FN-B");
      expect(order).toContain("FN-C");
      expect(order).toHaveLength(3);
    });

    it("handles self-referential dependencies gracefully", () => {
      const taskA = createTask("FN-A", ["FN-A"]);
      const taskB = createTask("FN-B");

      // Should complete without infinite recursion
      const order = resolveDependencyOrder([taskA, taskB]);

      expect(order).toContain("FN-A");
      expect(order).toContain("FN-B");
      expect(order).toHaveLength(2);
    });

    it("handles partial ordering correctly", () => {
      // A depends on B, C and D are independent
      const taskA = createTask("FN-A", ["FN-B"]);
      const taskB = createTask("FN-B");
      const taskC = createTask("FN-C");
      const taskD = createTask("FN-D");

      const order = resolveDependencyOrder([taskA, taskB, taskC, taskD]);

      // B must come before A
      expect(order.indexOf("FN-B")).toBeLessThan(order.indexOf("FN-A"));

      // All tasks should be present
      expect(order).toHaveLength(4);
    });

    it("handles empty dependencies array correctly", () => {
      const taskA = createTask("FN-A", []);
      const taskB = createTask("FN-B", []);

      const order = resolveDependencyOrder([taskA, taskB]);

      expect(order).toContain("FN-A");
      expect(order).toContain("FN-B");
      expect(order).toHaveLength(2);
    });

    it("handles complex dependency graph", () => {
      // E depends on D
      // D depends on B and C
      // B depends on A
      // C depends on A
      // A has no deps
      const taskA = createTask("FN-A");
      const taskB = createTask("FN-B", ["FN-A"]);
      const taskC = createTask("FN-C", ["FN-A"]);
      const taskD = createTask("FN-D", ["FN-B", "FN-C"]);
      const taskE = createTask("KB-E", ["FN-D"]);

      const order = resolveDependencyOrder([taskE, taskD, taskC, taskB, taskA]);

      // Validate partial ordering constraints
      expect(order.indexOf("FN-A")).toBeLessThan(order.indexOf("FN-B"));
      expect(order.indexOf("FN-A")).toBeLessThan(order.indexOf("FN-C"));
      expect(order.indexOf("FN-B")).toBeLessThan(order.indexOf("FN-D"));
      expect(order.indexOf("FN-C")).toBeLessThan(order.indexOf("FN-D"));
      expect(order.indexOf("FN-D")).toBeLessThan(order.indexOf("KB-E"));

      expect(order).toHaveLength(5);
    });

    it("preserves all tasks from input (no tasks dropped)", () => {
      const tasks = Array.from({ length: 10 }, (_, i) =>
        createTask(`KB-${String(i + 1).padStart(3, "0")}`)
      );

      const order = resolveDependencyOrder(tasks);

      expect(order).toHaveLength(10);
      for (const task of tasks) {
        expect(order).toContain(task.id);
      }
    });

    it("returns deterministic order for same input", () => {
      const taskA = createTask("FN-A");
      const taskB = createTask("FN-B", ["FN-A"]);
      const taskC = createTask("FN-C", ["FN-A"]);

      const order1 = resolveDependencyOrder([taskA, taskB, taskC]);
      const order2 = resolveDependencyOrder([taskA, taskB, taskC]);

      expect(order1).toEqual(order2);
    });
  });
});
