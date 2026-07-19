import { describe, expect, it, vi } from "vitest";
import { ClaudeRuntimeAdapter } from "../runtime-adapter.js";
const options={cwd:"/tmp",systemPrompt:"",onText:vi.fn()};
describe("ClaudeRuntimeAdapter", () => {
 it("returns a visible diagnostic instead of rejecting on ACP create failure", async () => { const adapter=new ClaudeRuntimeAdapter({createAcpAdapter:()=>({createSession:async()=>{throw new Error("bridge unavailable")},promptWithFallback:async()=>undefined,describeModel:()=>"claude/default"})}); const result=await adapter.createSession(options); expect(result.session.state.errorMessage).toContain("Claude ACP failed"); expect(options.onText).toHaveBeenCalled(); });
 it("returns a visible diagnostic for follow-up prompts without a live connection", async () => { const adapter=new ClaudeRuntimeAdapter({createAcpAdapter:()=>({createSession:async()=>{throw new Error("bridge unavailable")},promptWithFallback:async()=>undefined,describeModel:()=>"claude/default"})}); const {session}=await adapter.createSession(options); await adapter.promptWithFallback(session,"again"); expect(options.onText).toHaveBeenLastCalledWith(expect.stringContaining("no live connection")); });
});
