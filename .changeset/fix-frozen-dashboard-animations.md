---
"@fusion/dashboard": patch
---

Unfreeze dashboard spinners and pulse/enter animations. Transition tokens
(`--transition-slow: 0.3s ease`) bundle a duration and an easing; 15 animation
declarations reused them as bare durations, which made the whole `animation`
declaration invalid at computed-value time and silently resolved it to
`animation: none`. Animation rules now use new duration-only tokens
(`--duration-instant/fast/normal/slow`), with the transition tokens derived
from them, and a repo-wide CSS regression test forbids the pattern.
