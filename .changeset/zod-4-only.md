---
'@adonis-agora/agent': minor
---

Require zod 4: the optional `zod` peer narrows from `^3.23.0 || ^4.0.0` to `^4.0.0`.

The zod 3 half was a promise this package could not keep. `@adonis-agora/durable` — which agent
peers on — types its public step API with zod 4 (`import type { z } from 'zod'`), and a zod 3 schema
does **not** satisfy zod 4's `ZodType`: an app on zod 3 was already broken against the published
ecosystem, it just failed later and less clearly. Narrowing makes the manifest honest.

The peer stays **optional** — nothing changes for an app that never passes a zod schema. If you are
still on zod 3, upgrade to zod 4 (`z.object`/`z.string()`/`z.infer`, the surface agent uses, is
unchanged across the major).
