---
'@adonis-agora/agent': patch
---

Dev tools MCP: `authKitAuth()` verifies the JWT access tokens (RFC 9068) authkit mints for a resource in another process.

The dev tools hub read every bearer with `provider.AccessToken.find`, which only knows the opaque tokens the oidc-provider persists. A JWT access token is self-contained — authkit issues one when the resource is declared in the Hub's `mcpClients.resources` — so it was never found and every call answered `401 valid or expired access token`, even though the signature was valid and `aud` named the endpoint.

`verify` now falls back to verifying the JWT against the issuer's public JWKS (`authkit.server.publicJwks`, the same keys `jwks_uri` serves) with `iss` and `typ: at+jwt`, refusing `cnf` tokens (DPoP/mTLS cannot be proven by a plain Bearer call) and `client_credentials` ones (no account behind them). The rest of the strategy is unchanged: `aud` must still name the endpoint, and `toActor` sees the same shape for opaque and JWT.
