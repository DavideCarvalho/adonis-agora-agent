---
"@adonis-agora/agent-dashboard": patch
---

Fixed three visual bugs found while running the console against real seeded data end-to-end (Chrome DevTools MCP, not just source-level review):

- The "Set a price" form's cache-write/cache-read rate inputs had no minimum width, so their placeholder text ("cache write $/1M (optional)") was clipped mid-word by unconstrained flex-shrink. They now carry a `min-width` so the full placeholder is always legible; the row already wraps, so this never comes at the cost of a broken layout on narrow screens.
- The shell's footer always rendered `Read-only governance data · {fromDay} → {toDay}`, even on the eight sections (Runs, Threads, Tool calls, Approvals, Tools, Reliability, Quota, Pricing) that are not scoped by that date range at all — visibly contradicting the data shown (e.g. a Runs row dated before the claimed range start). The range now only appears while Overview, the one section it actually filters, is active.
- The Tools panel's empty state read "No tool calls recorded in this range.", a copy-paste leftover implying date-range scoping that section never had (unlike Overview's genuinely range-scoped empty states). It now reads "No tool calls recorded yet.", matching its sibling sections' phrasing.
