import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ map: {} as Record<string, string> }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, def?: string) => state.map[key] ?? def ?? key,
  }),
}));

const { useColumnLabel } = await import("../labels");

describe("useColumnLabel", () => {
  it("falls back to the English COLUMN_LABELS when no translation exists", () => {
    state.map = {};
    const label = renderHook(() => useColumnLabel()).result.current;
    expect(label("done")).toBe("Done");
    expect(label("in-progress")).toBe("In Progress");
  });

  it("uses the translated value when present", () => {
    state.map = { "columns.done": "完成", "columns.in-progress": "进行中" };
    const label = renderHook(() => useColumnLabel()).result.current;
    expect(label("done")).toBe("完成");
    expect(label("in-progress")).toBe("进行中");
  });
});
