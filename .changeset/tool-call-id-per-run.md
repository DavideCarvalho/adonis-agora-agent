---
"@adonis-agora/agent": patch
---

fix(store): two runs handed the same tool call id no longer collide (#183). A provider only promises a tool call id is unique within one response, and some (short `call_<digits>` ids behind OpenRouter) repeat one across runs: the second run's `agent_tool_call` insert failed on the primary key, and the thread was left with a call answered by nothing.

- `LucidAgentStore` keys a call by its run: the PK is `<run_id>:<toolCallId>`, and the model's id is kept as-is in the new `call_id` column (indexed with `run_id`). Rows written before keep their PK and a NULL `call_id`, and are still found by the id the model gave them — nothing is rewritten. If you read `agent_tool_call` directly, take the model's id from `call_id` (falling back to `id` on an older row).
- `createAgentTables` adds the column to an existing table (schema repair), so with `autoCreateTables` on there is nothing to do. With it off, add a migration that calls `createAgentTables` again.
- `InMemoryAgentStore` keeps both calls too (it used to replace the first one).
- SPI: `UpdateToolCallInput.runId`, and an optional `runId` on `toolCallApproval` / `toolCallInput` (also `AgentService.toolCallApproval` / `answerProblem`), scope the call to its run. The loop, the runners and the approve / reject / answer routes pass it. Without it, the newest call recorded under the id is used, which is also what `getToolCallRunId` and `toolCallOutcomes` answer.
