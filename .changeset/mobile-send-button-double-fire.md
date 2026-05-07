---
"@runfusion/fusion": patch
---

Fix mobile chat send button silently failing on quick taps. Both the
ChatView and QuickChat send/stop buttons had `onPointerDown` and
`onTouchStart` handlers that each invoked the send/stop action — on a
quick mobile tap both handlers fire, so the action ran twice in rapid
succession. The second invocation closed the first one's SSE stream,
which the server treated as a cancel, leaving the chat with no output.
A long press happened to suppress one of the events, so holding the
button "worked" while quick tapping silently failed.

The handlers now share the existing `handledMobile*Ref` flag so only
the first event for a given tap actually fires the action. The send
button also gets `touch-action: manipulation` and an expanded invisible
hit area so slightly-off taps don't fall through to the surrounding
textarea (which would dismiss the keyboard without sending).
