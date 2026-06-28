---
"@runfusion/fusion": minor
---

summary: Close the Quick Chat window by clicking outside it.
category: feature
dev: New opt-in `closeOnOutsidePointerDown` prop on FloatingWindow; enabled only for the Quick Chat (windowKey="chat-modal"). Uses a capture-phase document pointerdown listener that excludes in-flight drag/resize and nested dialog/floating surfaces. Task pop-outs are unaffected.
