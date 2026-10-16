---
"@adonis-agora/agent": patch
---

fix(store): a tool call id handed out twice no longer collides (#183). A provider only promises a tool call id is unique within one response, and some (short `call_<digits>` ids behind OpenRouter) repeat one across runs: the second `agent_tool_call` insert failed on the primary key, and the thread was left with a call answered by nothing.

- `LucidAgentStore` keys a call by the assistant message that carries it, one per model response: the PK is `<message_id>:<toolCallId>`, and the model's id is kept as-is in the new `call_id` column (indexed with `run_id`). This also covers a provider that numbers calls per response (`call_0` again on the next step of the same run) and a call recorded without a run. Rows written before keep their PK and a NULL `call_id`, and are still found by the id the model gave them — nothing is rewritten. If you read `agent_tool_call` directly, take the model's id from `call_id` (falling back to `id` on an older row).
- **The schema repairs itself at boot.** With `autoCreateTables` on (the default), the agent provider adds the column and its index to an existing table as the app starts — there is nothing to do.
- With `autoCreateTables` off the schema is the app's: add a migration that calls `createAgentTables()` again. Until it runs the store does not fail: it detects the missing column at startup, warns once, and keeps the old layout (where the collision is still possible).
- `InMemoryAgentStore` keys calls the same way (it used to replace the first one).
- SPI: `UpdateToolCallInput.runId`, and an optional `runId` on `toolCallApproval` / `toolCallInput` (also `AgentService.toolCallApproval` / `answerProblem`), pick the call of that run — the newest under the id, which is the live one since a run's steps settle in order. The loop, the runners and the approve / reject / answer routes pass it. Without it, the newest call recorded under the id is used, which is also what `getToolCallRunId` and `toolCallOutcomes` answer.
