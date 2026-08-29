import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";

const voice = { enabled: true, supported: true, state: "idle" as const, partialText: "", finalText: "", error: undefined, start: vi.fn(), stop: vi.fn() };
vi.mock("../useVoiceDictation", () => ({ useVoiceDictation: () => voice }));
import { useComposerDictation } from "../useComposerDictation";

function Composer({ label, onResize }: { label: string; onResize?: () => void }) {
  const [value, setValue] = useState("before after");
  const ref = useRef<HTMLTextAreaElement>(null);
  const { micProps } = useComposerDictation({ textareaRef: ref, value, onChange: setValue, onResize });
  return <><textarea aria-label={label} ref={ref} value={value} onChange={(event) => setValue(event.target.value)} /><button onClick={() => void micProps.start()}>start {label}</button><output>{value}</output></>;
}

describe("useComposerDictation", () => {
  it("captures each controlled composer's own caret before dictation", async () => {
    render(<><Composer label="first" /><Composer label="second" /></>);
    const first = screen.getByLabelText("first") as HTMLTextAreaElement;
    const second = screen.getByLabelText("second") as HTMLTextAreaElement;
    first.setSelectionRange(7, 7);
    second.setSelectionRange(0, 6);
    await act(async () => { await screen.getByRole("button", { name: "start first" }).click(); });
    expect(voice.start).toHaveBeenCalled();
    expect(first.selectionStart).toBe(7);
    expect(second.selectionStart).toBe(0);
  });

  it("reanchors when the user replaces the original selection before the first partial", async () => {
    const view = render(<Composer label="pre-partial edit" />);
    const textarea = screen.getByLabelText("pre-partial edit") as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 6);
    await act(async () => { await screen.getByRole("button", { name: "start pre-partial edit" }).click(); });
    fireEvent.change(textarea, { target: { value: "typed after" } });
    textarea.setSelectionRange(5, 5);
    voice.state = "listening";
    voice.partialText = " speech";
    await act(async () => { view.rerender(<Composer label="pre-partial edit" />); });
    expect((screen.getByLabelText("pre-partial edit") as HTMLTextAreaElement).value).toBe("typed speech after");
    voice.state = "idle";
    voice.partialText = "";
  });

  it("runs the composer's resize callback after applying dictated text", async () => {
    const onResize = vi.fn();
    const view = render(<Composer label="resizable" onResize={onResize} />);
    const textarea = screen.getByLabelText("resizable") as HTMLTextAreaElement;
    textarea.setSelectionRange(6, 6);
    await act(async () => { await screen.getByRole("button", { name: "start resizable" }).click(); });
    voice.state = "listening";
    voice.partialText = " dictated";
    await act(async () => { view.rerender(<Composer label="resizable" onResize={onResize} />); });
    expect(onResize).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("resizable") as HTMLTextAreaElement).value).toBe("before dictated after");
    voice.state = "idle";
    voice.partialText = "";
  });
});
