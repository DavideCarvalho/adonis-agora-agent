---
'@adonis-agora/agent': minor
'@adonis-agora/agent-dashboard': minor
---

Add `GET`/`POST /agent/governance/pricing` and a Pricing panel in the console.

The `pricingStore` bound to the agent (default-mirrored from a Lucid `store`, or opt-in for other
backends) was already driving cost accounting for runs, but had no read/write surface of its own —
operators had to reach for the database directly to see or change a model's per-1M-token rates. The
two new routes expose `AgentPricingStore.listCurrentPrices()`/`upsertModelPrice()` behind the same
authenticated + authorized governance gate as every other `/agent/governance/*` route, mounted only
when a pricing store is bound. The dashboard's new "Pricing" section reads and edits rates through
them.
