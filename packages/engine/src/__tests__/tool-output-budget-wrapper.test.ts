import { describe, expect, it } from "vitest";
import { DEFAULT_TOOL_OUTPUT_MAX_CHARS, buildToolOutputTruncationMarker } from "@fusion/core";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { wrapCustomToolsForPluginRuntime } from "../agent-session-helpers.js";
import { wrapToolsWithOutputBudget } from "../pi.js";

function toolWithResult(result: unknown, name = "fn_budget_test"): ToolDefinition {
  return { name, label: name, description: name, parameters: {} as never, execute: async () => result } as ToolDefinition;
}

async function execute(tool: ToolDefinition): Promise<any> {
  return (tool.execute as any)("call", {}, undefined);
}

describe("tool output budget wrapper", () => {
  it("enforces a single total cap across text blocks while preserving mixed blocks and details", async () => {
    const details = { nested: { untouched: true } };
    const original = {
      content: [
        { type: "text", text: "a".repeat(12_000) },
        { type: "image", data: "unchanged" },
        { type: "text", text: "b".repeat(12_000) },
        { type: "text", text: "c".repeat(100) },
      ],
      details,
      isError: true,
    };
    const result = await execute(wrapToolsWithOutputBudget([toolWithResult(original)])[0]);
    const texts = result.content.filter((block: any) => block.type === "text").map((block: any) => block.text);
    expect(texts.join("").length).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_MAX_CHARS);
    expect(texts[1]).toContain("Tool output truncated");
    expect(texts[2]).toBe("");
    expect(result.content[1]).toEqual(original.content[1]);
    expect(result.details).toBe(details);
    expect(result.isError).toBe(true);
    expect(texts[0]).not.toBe("");
  });

  it("preserves empty and undefined text, and puts a boundary overflow marker in document order", async () => {
    const marker = buildToolOutputTruncationMarker();
    const result = await execute(wrapToolsWithOutputBudget([
      toolWithResult({ content: [{ type: "text", text: "abcd" }, { type: "text", text: "z".repeat(200) }, { type: "text", text: undefined }] }),
    ], { overrides: { fn_budget_test: marker.length + 4 } })[0]);
    expect(result.content.map((block: any) => block.text)).toEqual(["abcd", marker, ""]);
  });

  it("honors a custom base budget and finite named overrides without double-marking", async () => {
    const source = "x".repeat(700);
    const custom = await execute(wrapToolsWithOutputBudget([toolWithResult({ content: [{ type: "text", text: source }] })], { maxChars: 500 })[0]);
    const override = await execute(wrapToolsWithOutputBudget([toolWithResult({ content: [{ type: "text", text: source }] })], {
      maxChars: 500,
      overrides: { fn_budget_test: 100 },
    })[0]);
    expect(custom.content[0].text.length).toBeLessThanOrEqual(500);
    expect(override.content[0].text.length).toBeLessThanOrEqual(100);
    await expect(execute(wrapToolsWithOutputBudget([toolWithResult({ content: [{ type: "text", text: source }] })], { overrides: { fn_budget_test: Infinity } })[0])).rejects.toThrow(/finite positive integers/);
    const once = wrapToolsWithOutputBudget([toolWithResult({ content: [{ type: "text", text: source }] })], { maxChars: 100 });
    const twice = wrapToolsWithOutputBudget(once, { maxChars: 100 });
    const result = await execute(twice[0]);
    expect(result.content[0].text.match(/Tool output truncated/g)).toHaveLength(1);
  });

  it("applies the same configurable clamp on the non-pi plugin-runtime path exactly once", async () => {
    const result = await execute(wrapCustomToolsForPluginRuntime([
      toolWithResult({ content: [{ type: "text", text: "x".repeat(DEFAULT_TOOL_OUTPUT_MAX_CHARS + 1) }] }),
    ], {})![0]);
    const custom = await execute(wrapCustomToolsForPluginRuntime([
      toolWithResult({ content: [{ type: "text", text: "x".repeat(700) }] }),
    ], { toolOutputMaxChars: 500 })![0]);
    expect(result.content[0].text.length).toBeLessThanOrEqual(DEFAULT_TOOL_OUTPUT_MAX_CHARS);
    expect(result.content[0].text.match(/Tool output truncated/g)).toHaveLength(1);
    expect(custom.content[0].text.length).toBeLessThanOrEqual(500);
    expect(custom.content[0].text.match(/Tool output truncated/g)).toHaveLength(1);
  });

  it("returns pi and plugin tool lists unchanged when the resolved setting is unlimited", async () => {
    const original = {
      content: [
        { type: "text", text: "a".repeat(800) },
        { type: "image", data: "unchanged" },
        { type: "text", text: "b".repeat(800) },
      ],
      details: { retained: true },
      isError: true,
    };
    const piTools = [toolWithResult(original)];
    const pluginTools = [toolWithResult(original)];
    expect(wrapToolsWithOutputBudget(piTools, { maxChars: null })).toBe(piTools);
    const piResult = await execute(wrapToolsWithOutputBudget(piTools, { maxChars: null })[0]);
    const pluginResult = await execute(wrapCustomToolsForPluginRuntime(pluginTools, { toolOutputMaxChars: null })![0]);
    expect(piResult).toBe(original);
    expect(pluginResult).toBe(original);
  });
});
