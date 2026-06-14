---
"@fusion/dashboard": patch
---

Fix sporadic quick chat send failures on mobile (notably the first message after a response). A real touch tap dispatches both `pointerdown` and `touchstart`, and the quick chat send button ran its action on each — firing `handleSendMessage` twice per tap. Because React had not yet flushed the composer clear between the two events, both reads saw the same text and sent, and the hook's second send closed the first's freshly-opened stream and re-POSTed, which could drop the response. The send and stop buttons now claim a single action per tap so only the first of the paired events fires.
