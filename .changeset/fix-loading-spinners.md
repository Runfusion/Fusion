---
"@runfusion/fusion": patch
---

Fix loading spinners that didn't spin across the dashboard. Many loading states (Settings, task tabs, agents, documents, plugins, model pickers, command center, and more) rendered bare "Loading…" text with no spinner — and a couple rendered an unstyled `loading-spinner` div that never showed anything. Added a shared `<LoadingSpinner>` component (self-contained animated SVG, no `lucide-react` dependency so it survives partial test mocks) and adopted it across ~45 loading placeholders so every loading state now shows a consistent animated spinner.
