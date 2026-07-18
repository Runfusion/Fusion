---
"@runfusion/fusion": patch
---

summary: Keep floating windows stacked by last-opened and last-interacted order.
category: fix
dev: FloatingWindow only reclaims z-index on hidden→visible (not every mount effect), restoring shared-stack cross-type ordering with RightDockExpandModal.
