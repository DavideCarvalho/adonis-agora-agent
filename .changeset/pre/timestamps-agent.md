---
'@adonis-agora/agent': minor
---

createdAt / updatedAt on the rows the agent changes. `agent_model_pricing` gains `created_at` / `updated_at` (retiring a price moves `updated_at`), and `agent_a2a_context` gains `updated_at` (the account binding moves it). Both are added at boot by the existing schema repair (`createAgentTables` / `ensureA2aTables`), NULL-able with no default, so old rows are left as they were. `CurrentModelPrice` and `A2aContext` gain optional `createdAt?: Date` / `updatedAt?: Date`; `GET /agent/governance/pricing` sends them as ISO 8601 strings or `null` (`toModelPriceDto`), and the threads feed (`ThreadActivityRow`) now carries the thread's `createdAt` / `updatedAt`. Ships the console with the new Pricing "Updated" column and the thread detail's Created / Updated.
