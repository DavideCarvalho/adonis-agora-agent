---
"@adonis-agora/agent": patch
---

Poppy connections on MySQL: `agent_poppy_connection` could not be created there — its primary key (`owner` + a 1024-character `issuer`) is past InnoDB's 3072-byte key limit. On MySQL the key is now `(owner, issuer_hash)`, a stored SHA-256 of the issuer the database computes itself, so uniqueness stays exact. Postgres and SQLite are unchanged; no MySQL install needs a repair, since the table never got created there.
