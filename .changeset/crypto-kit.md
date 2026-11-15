---
"@adonis-agora/agent": minor
---

Poppy connections are sealed at rest with the Agora crypto kit (a verbatim copy at `src/crypto-kit/`, the same in every Agora lib), on top of Adonis' own encryption: by default the app's `encryption` service (`config/encryption.ts`), each value bound to its row. Connections saved by earlier versions (the `v1.` format, keyed from the app key) still open with no migration step; new writes use the kit's `agora:v1:` format.

- `crypto` in `config/poppy_connections.ts`: `keys` (newest first: the first seals, all open), an `encryption` instance, or a `kms` for envelope encryption. `secret` still opens old values; set explicitly, it seals new ones too.
- `node ace agent:crypto:reseal [--dry-run] [--all] [--json]` rewrites values sealed with an older key or in the old format (`--all`: every value, after rotating `config/encryption.ts`). Exit 1 when a value doesn't open.
- `agent.crypto` doctor check (`--deep`): warns on old-format or retired-key values, errors on values that don't open.
- `Sealer.seal(value, aad)` / `open(sealed, aad)` / `status(sealed, aad)` are now async and take the row binding; `PoppyConnectionStore` gains the optional `listSealed` / `replaceSealed` (memory, Lucid and Redis stores implement them; Redis needs `scan`).
- The flaky `Sealer` test is deterministic: it flips a bit of the decoded tag instead of rewriting base64 characters.
