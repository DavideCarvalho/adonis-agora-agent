---
'@adonis-agora/agent': minor
---

Expose registered agents to personal agents (ChatGPT, Meta AI, a user's own assistant) over A2A 1.0 HTTP+JSON, following PACT (https://openpactprotocol.org). Register `@adonis-agora/agent/a2a_provider` and add `config/a2a.ts` (`defineA2aConfig`, from `@adonis-agora/agent/a2a`).

- Per agent: an Agent Card, a synchronous `message:send`, and the task routes as PACT fixes them. Served as server middleware ahead of the router, so authentication happens before the body is read.
- `authKitPersonalAgents()` authenticates with `@adonis-agora/authkit-server` 0.76+ personal agents: the agent's signed JWT and, when the user delegated, the delegation token. A delegated turn runs as the user's account, with the delegated scopes as roles.
- Conversations: `contextId` is bound to one agent and one (personal agent, user), and to the account once a delegated turn ran in it. A repeated `messageId` returns the stored reply. Conversation state lives in two tables created on first use (`store: 'lucid'`), or in memory.
- `action` calls that park for approval are approved when the delegation grants one of the tool's roles, and rejected otherwise (`actions: 'reject'` rejects all of them). Question sets are skipped.
- `request_permission` lets the model ask for a scope the user has not granted. The reply becomes a `TASK_STATE_AUTH_REQUIRED` step-up with a consent link.
- Replies under delegation carry a signed receipt listing the tools that ran under a delegated scope.

**Security:** the agent provider now wraps the configured authorizer with `personalAgentGate`. An actor with the `personal_agent` role reaches only tools that declare one of its roles; tools with no `roles` are out of its reach. Nothing changes for any other actor.
