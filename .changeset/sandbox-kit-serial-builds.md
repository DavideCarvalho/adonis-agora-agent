---
"@adonis-agora/agent": patch
---

The sandbox kit plugin now runs its dev rebuilds one at a time. Each rebuild reads the options when it starts. Before, a slower, older build could finish after a newer one and win, and the server then described the wrong kit. With Tailwind, the theme variables now come from the app's own stylesheets, not from Tailwind's compiled theme layer (`--color-white`, `--spacing`…).
