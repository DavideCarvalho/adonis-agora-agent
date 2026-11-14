---
"@adonis-agora/agent": minor
---

Dev tools hub: `devTools.auth` signs MCP clients in with any OAuth server, not only authkit. `jwtAuth({ issuer })` checks JWT access tokens against the issuer's JWKS (discovered from its metadata, keys cached; `iss`, `aud` = the hub URL, `exp`); `introspectionAuth(…)` checks opaque tokens (RFC 7662); or pass your own `{ authorizationServers, verify }`. The hub advertises the issuers in its protected-resource metadata and challenges with `resource_metadata`. The verified principal reaches the consoles' `authorize` through `devToolsPrincipal(ctx)`, and as `ctx.auth.user` with `resolveUser`. With `devTools.auth` set the hub does not register with authkit. With OAuth on, a request without credentials is a `401` with the sign-in pointer even when a console answers a bare `false`. New `agora:doctor` check `agent.dev-tools-auth` reports the sign-in mode (authkit / custom auth / token-only) and flags a broken `devTools.auth`.
