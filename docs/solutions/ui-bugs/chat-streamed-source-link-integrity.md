---
title: "Chat streamed source-link integrity"
date: 2026-08-19
category: ui-bugs
module: packages/engine/src/execution/streaming-delta.ts and packages/dashboard/app/components/StandardChatSurface.tsx
problem_type: data_integrity
component: chat_streaming
symptoms:
  - "Streaming Chat source labels changed numeric dotted tokens such as GPT-5.6 into GPT-5. 6"
  - "The inserted space also corrupted dotted URL path segments and source destinations"
  - "Chat Markdown source links opened in the current tab and had weak/default contrast"
root_cause: overly_broad_stream_boundary_repair
resolution_type: code_fix
severity: medium
related_components:
  - runtime_bridge
  - markdown_renderer
  - url_sanitization
  - chat_persistence
  - responsive_ui
tags:
  - chat
  - streaming
  - source-links
  - markdown
  - new-tab
  - contrast
  - runtime-bridges
---

# Chat streamed source-link integrity

## Problem

Some providers split a response immediately after a numeric period. The shared sentence-boundary repair treated every punctuation-plus-digit boundary as a missing sentence space, so chunks such as `GPT-5.` + `6 Luna` and `/gpt-5.` + `6-luna` were persisted as `GPT-5. 6` and `/gpt-5. 6-luna`. The Chat renderer then produced incomplete destinations, opened ordinary links in the current tab, and inherited a low-contrast browser link color.

## Solution

Classify a digit-period-digit boundary before applying the existing sentence repair. This narrow exception covers versions, decimals, IP addresses, and dotted URL path segments while preserving legitimate repairs such as `Done.` + `Next` and `Phase complete.` + `2 more items`. The engine normalizer and every runtime bridge apply the rule before their accumulators or callbacks emit deltas, so live SSE, in-flight recovery, final PostgreSQL messages, and resumed history share one corrected value. Text and thinking accumulators remain independent.

The shared `standardChatMarkdownComponents` anchor preserves ReactMarkdown's sanitized `href`, adds semantic `target="_blank"` and `rel="noopener noreferrer"`, and removes an unsafe sanitized anchor shell without bypassing `defaultUrlTransform`. Native structure references still become preview cards and file-path controls retain their in-app behavior. Chat-scoped CSS uses `var(--text)` against assistant `var(--surface-1)`, keeps normal and visited links underlined, and uses existing transition and focus tokens; no global anchor rule or render-time content rewrite was added.

## Regression matrix

- Engine normalizer: exact three-link Markdown split after every numeric period, decimals/IPs, sentence-plus-number repair, whitespace idempotence, lowercase/property continuation, cross-block fallback, and independent text/thinking tails.
- pi-Claude, generic ACP, Droid, Claude ACP, Grok ACP, and OMP ACP bridges: exact source links at the accumulator/callback boundary plus thinking-token coverage where the bridge owns a separate accumulator.
- Shared Markdown renderer: persisted and streaming links, exact href/target/rel, repeated links, unsafe schemes, native structure references, file paths, force-plain/empty content, and no nested or empty interactive shell.
- Production hosts: desktop Direct Chat persisted/live bubbles, Chat Room transcript, task-detail Planner Chat history and reattached stream, and narrow/mobile Direct Chat.
- Verification: targeted runtime/dashboard Vitest suites, changed-only `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`.

## Non-goals

Historical persisted messages are not rewritten. Terminal-only CLI output, Task Activity/AgentLog, Mailbox, Documents, Workflow Results, and other separate Markdown renderers retain their existing contracts unless they independently adopt the shared Chat renderer.
