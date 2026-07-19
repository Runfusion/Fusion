---
"@runfusion/fusion": minor
---

summary: Quality hub now shows task verification videos when review artifacts are enabled.
category: feature
dev: Quality plugin dashboard view reads type="video" executor feature-video artifacts (authorType==="system" && authorId==="executor") via the host /api/artifacts route, gated on effective reviewArtifacts !== "off"; plays them inline via the bridged artifactMediaUrlWithToken helper and opens source tasks through the plugin context openTaskDetail.
