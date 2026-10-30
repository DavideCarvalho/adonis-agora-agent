---
'@adonis-agora/agent': minor
---

Poppy: update to Personal Agent Protocol Draft 0.3, without compatibility with earlier drafts (experimental API). Needs `@adonis-agora/authkit-server` on Draft 0.3.

The client sends a `Poppy-Session` JWT signed with a delegated key on every request, signs in with plain OAuth (no Session in the token endpoint), finds the issuer from protected resource metadata and treats DPoP as optional. Browsers join in three steps with a one-time code, Mediated Sign-In is the extension grant, and it adds excluded tasks and feedback. The Company side uses the new authenticate contract: `invalid_session`, a code-less 401 and 429; `author` replaces `sender`.

Breaking: `sign_in_required`, `POPPY_READ_SCOPE`/`POPPY_WRITE_SCOPE`, `createBrowserAssertion`/`autoSubmitFormHtml`/`serveOneShotPage`, `token()` session fields and `bearerFor` are gone. `poppy-connections` `readScopes` now defaults to the scopes hinted `changes: none`.
