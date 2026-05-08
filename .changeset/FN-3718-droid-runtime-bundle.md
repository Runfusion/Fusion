---
"@runfusion/fusion": patch
---

Stage `fusion-plugin-droid-runtime` (including its `mcp-schema-server.cjs`
bridge asset) into the published CLI tarball, mirroring the
`fusion-plugin-openclaw-runtime` build pipeline. The droid runtime plugin
is now bundled and asserted by the bundle-output test suite.
