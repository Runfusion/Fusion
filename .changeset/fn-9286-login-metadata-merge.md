---
"@runfusion/fusion": patch
---

summary: Re-signing in to a credential account now keeps its name and metadata.
category: fix
dev: Uses mergeStoredCredentialPreservingMetadata at the three provider-auth.ts login write sites.
