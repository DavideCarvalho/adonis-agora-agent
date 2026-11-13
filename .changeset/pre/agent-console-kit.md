---
"@adonis-agora/agent-dashboard": minor
"@adonis-agora/agent": minor
---

The agent console now runs on the shared Agora console kit, like durable's.

- Layout: a sidebar grouped as MONITOR (Overview, Reliability), ACTIVITY (Runs, Threads, Tool calls, Generative UI), GOVERNANCE (Approvals, Quota) and CONFIG (Tools, Pricing). The organization picker and the day range moved to the top bar. Below 768px the sidebar becomes a drawer and the pickers move to the top of the page. The console switcher and ⌘K search are the kit's.
- Look: authkit's palette with the agent's rose accent (`#fb7185`), Sora and JetBrains Mono bundled (no Google Fonts request), light mode on every page. Tailwind 4 and vendored shadcn/ui components (Base UI) replace the hand-written stylesheet.
- Every page and data region has its own error boundary with a retry, a skeleton shaped like its content, and an empty state. Run and thread lists use the kit's Load more over the cursor envelope.
- Approve/reject in the Approvals inbox now shows an error when the call fails instead of failing silently.
- Server: the console's data block gains `viewer` and `signOut`. New `dashboard.viewer(ctx)` and `dashboard.signOut` options; without them the console reads `ctx.auth.user` and uses the sign-out authkit announces on the `agora.consoles` registry. A POST sign-out carries the request's CSRF token.
