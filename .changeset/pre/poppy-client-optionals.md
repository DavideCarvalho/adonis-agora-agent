---
'@adonis-agora/agent': minor
---

Poppy client (Personal Agent side): the optional parts of Personal Agent Protocol 1.0. The Operations extension (v3) on every interface (APIs with `Poppy-Approval`, MCP `_meta`, conversations, websites through the operations endpoint) with user and agent approvals, declines and at-most-once retries; Browser Control (v1) for the browser you drive; Links and Disclosures in Company messages; skill artifacts fetched and verified (`fetchSkill`, `.tar.gz` and `.zip`); PS384 blind signing, Agent IDs and anonymous User IDs. `poppy-connections` declares Operations, Links and Disclosures, adds the `poppy_approve` tool (the person approves the exact terms on its card) and an `operations.approve` hook, and returns links and disclosures with the Company's replies.
