# Capability parity with `@dudousxd/nestjs-agent`

This library and [`nestjs-agent`](https://github.com/DavideCarvalho/nestjs-agent) are the same
product on two frameworks, and the goal is parity of **capability** — not of signature.

The ledger is kept in ONE place so the two copies cannot disagree about who has what:
[`nestjs-agent/PARITY.md`](https://github.com/DavideCarvalho/nestjs-agent/blob/master/PARITY.md).

Adding a capability to either repo means adding its row there, with a status for the other side.
New capabilities and shared fixes are one delivery across Aviary and Agora: paired PRs,
equivalent behaviour tests, and explicit shared-package release dependencies. A re-export alone
does not establish parity. `not ported` means work remains, not that the delivery is complete;
`not applicable` must explain a framework-specific reason. Silence is not a status.
