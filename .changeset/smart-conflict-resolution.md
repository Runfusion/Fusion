---
"@dustinbyrne/kb": minor
---

Add smart automatic merge conflict resolution. Lock files, generated files, and trivial whitespace conflicts are now resolved automatically without AI intervention, reducing merge latency and API costs.

New API in `@kb/engine`:
- `classifyConflict(filePath, cwd)` - returns 'lockfile-ours' | 'generated-theirs' | 'trivial-whitespace' | 'complex'
- `getConflictedFiles(cwd)` - list conflicted files via git
- `resolveWithOurs(filePath, cwd)` - resolve using current branch
- `resolveWithTheirs(filePath, cwd)` - resolve using incoming branch
- `resolveTrivialWhitespace(filePath, cwd)` - resolve whitespace conflicts
- `isTrivialWhitespaceConflict(filePath, cwd)` - detect using git diff-tree -w
- Exported pattern constants: `LOCKFILE_PATTERNS`, `GENERATED_PATTERNS`

New setting: `smartConflictResolution` (alias for `autoResolveConflicts`)
New MergeResult fields: `resolutionMethod`, `autoResolvedCount` for tracking resolution paths
