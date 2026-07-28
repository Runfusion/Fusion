import { expect } from "vitest";
import { userEvent } from "@testing-library/user-event";

/*
FNXC:TypingStability 2026-07-26-22:15:
Shared assertion for "this field survives being typed into". A text field breaks when the render
that follows a keystroke gives it a NEW DOM node: React drops the old element, the browser drops
focus with it, and every character after the first lands nowhere. That is how FN-8606 shipped an
untypable Planning Mode and Settings.

`fireEvent.change` cannot observe this — it sets `value` in one shot on a node it already holds and
never needs focus — so most of our field coverage is blind to it. This helper types character by
character through userEvent and asserts the three things a remount destroys: node identity, the
accumulated value, and focus.

`requery` must re-run the original query (getByPlaceholderText/getByLabelText/...) so identity is
compared against what the CURRENT tree renders, not the stale reference.
*/
export async function expectStableTyping(
  field: HTMLInputElement | HTMLTextAreaElement,
  text: string,
  requery: () => HTMLElement,
): Promise<void> {
  const user = userEvent.setup();
  const initialValue = field.value;

  await user.click(field);
  await user.type(field, text);

  expect(requery()).toBe(field);
  expect(field.value).toBe(`${initialValue}${text}`);
  expect(document.activeElement).toBe(field);
}
