---
"@adonis-agora/agent": minor
---

Dashboard-gate contract: `dashboard.authorize` and `governanceAuthorize` now return an `AuthorizeResult` (`boolean | { allowed: boolean; reason?: 'unauthenticated' | 'forbidden' }`), the same contract every `@adonis-agora/*` console uses. `true`/`{ allowed: true }` allows; `{ allowed: false, reason: 'unauthenticated' }` answers `401`; `false`, `{ allowed: false }`, `reason: 'forbidden'` or a throw answer `403`. A denying decision object (truthy) is always treated as a denial. The governance JSON routes now also keep a redirect/body the hook wrote itself instead of overwriting it, like the console already did. `AuthorizeDecision` and `AuthorizeResult` are exported from `@adonis-agora/agent` and `@adonis-agora/agent/dashboard`.
