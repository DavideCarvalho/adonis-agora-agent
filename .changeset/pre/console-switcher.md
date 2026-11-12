---
"@adonis-agora/agent": minor
"@adonis-agora/agent-dashboard": minor
---

The agent governance console joins the Agora console switcher. It registers itself (Agents, `@adonis-agora/agent`) into the shared `'agora.consoles'` registry; its brand becomes a menu of the other Agora consoles the viewer may open, and a Search button (Ctrl/⌘-K) searches every one of them. The agent's own search finds runs and threads by id and the latest runs of an actor or an agent. New routes: `GET /agent/governance/consoles` and `GET /agent/governance/consoles/search?q=`, behind `dashboard.authorize`. Runs and threads open from `#runs/<id>` and `#threads/<id>`. While the switcher asks other consoles, `ctx.agoraProbe` is `true`.
