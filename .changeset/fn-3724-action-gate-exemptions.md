---
"@runfusion/fusion": patch
---

Exempt internal Fusion coordination tools (heartbeat-done, task/document/memory writes used for coordination, delegation, identity, reflection) from the permanent-agent action gate so heartbeats cannot deadlock under restrictive permission policies. Mirrors the existing action-gate exemption set onto the sibling permanent-agent gating path.
