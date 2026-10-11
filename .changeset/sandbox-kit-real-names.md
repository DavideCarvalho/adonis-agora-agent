---
"@adonis-agora/agent": patch
---

Sandbox kit fixes from the app rollouts:

- The prompt names theme variables as they exist in the frame. A variable named `--color-surface-secondary` is now listed as `var(--color-surface-secondary)`, not `var(--surface-secondary)`, which does not exist. Its Tailwind utility (`bg-surface-secondary`) is listed separately.
- A stylesheet's imports are followed from its real path. A workspace package linked or pnpm-injected into `node_modules` resolves its own imports beside its dependencies, so `@workspace/ui`'s `shadcn/tailwind.css` (with the `data-open:` and `data-horizontal:` variants) now reaches the frame's Tailwind.
- The prompt tells the model to lay the view out at the frame's full width (`width: 100%`, `w-full` with Tailwind) unless the user asks for something narrower.
