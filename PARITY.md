# Capability parity with Aviary

Agora and [Aviary](https://github.com/DavideCarvalho/nestjs-agent) are independent products on different frameworks. Each owns its source, dependencies, tests, documentation and releases. Agora does not install or re-export Aviary packages.

Capability parity compares observable behavior and compatible protocols, rather than requiring identical signatures or shared implementation. Agora owns its GenUI catalog, React client, AG-UI adapters and media upload client. Existing stream events, component frames, approvals, capabilities and persisted history retain their wire contracts.

The cross-project comparison ledger lives in [Aviary/PARITY.md](https://github.com/DavideCarvalho/nestjs-agent/blob/master/PARITY.md). Update the relevant status when a capability changes, and validate Agora's behavior locally. A compatible protocol does not imply a package dependency, coordinated publication or release-order requirement.

Use `not ported` when an implementation remains incomplete. Use `not applicable` only with a framework-specific explanation. A matching export alone does not establish behavioral parity.

## Paired deliveries

Capabilities delivered alongside a parallel change in Aviary, recorded here until the shared ledger catches up.

| Capability | Agora | Aviary |
| --- | --- | --- |
| Run metrics: TTFT, cost/model on run, run.failed/run.cancelled diagnostics, tool timing, dashboard latency | yes | paired delivery |

## Pending ports

Capabilities Agora delivered whose Aviary port (`packages/channels` in [Aviary](https://github.com/DavideCarvalho/nestjs-agent)) is still to do.

| Capability | Agora | Aviary |
| --- | --- | --- |
| Text channels: `coalesce` — a burst of messages of one conversation as one turn (durable sleep, control messages never grouped, `coalesced` / `parts` / `queueWaitMs` on the hooks) | yes | not ported |
| Message send time: `sentAt` on inbound channel messages (provider timestamp), sends and stored/queued messages; opt-in `messageTimestamps` labels user messages in the model's view (`[sent …]`) without changing stored content | yes | not ported |
| Text channels: phases as dispatched durable steps (`agora.channel.<phase>`, workflow version `2`, version `1` kept for in-flight runs) | yes | not ported |
