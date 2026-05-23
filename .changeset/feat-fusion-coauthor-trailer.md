---
"@runfusion/fusion": minor
---

Attribute Fusion as a `Co-authored-by` trailer on managed commits instead of overriding the primary author. The user's configured git identity now remains the author/committer of every commit Fusion produces, and the configured commit author (default `Fusion <noreply@runfusion.ai>`) is appended as a `Co-authored-by:` trailer that GitHub recognizes for shared attribution. The `commitAuthorEnabled` toggle and `commitAuthorName`/`commitAuthorEmail` settings keep their existing keys; the dashboard settings UI relabels them from "Author" to "Co-author" to match the new behavior.
