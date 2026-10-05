# Capability parity with Aviary

Agora and [Aviary](https://github.com/DavideCarvalho/nestjs-agent) are independent products on different frameworks. Each owns its source, dependencies, tests, documentation and releases. Agora does not install or re-export Aviary packages.

Capability parity compares observable behavior and compatible protocols, rather than requiring identical signatures or shared implementation. Agora owns its GenUI catalog, React client, AG-UI adapters and media upload client. Existing stream events, component frames, approvals, capabilities and persisted history retain their wire contracts.

The cross-project comparison ledger lives in [Aviary/PARITY.md](https://github.com/DavideCarvalho/nestjs-agent/blob/master/PARITY.md). Update the relevant status when a capability changes, and validate Agora's behavior locally. A compatible protocol does not imply a package dependency, coordinated publication or release-order requirement.

Use `not ported` when an implementation remains incomplete. Use `not applicable` only with a framework-specific explanation. A matching export alone does not establish behavioral parity.
