---
'@adonis-agora/agent': patch
---

A memory provider written as a class keeps its receiver, so `remember` can actually write

`writeMemory` read the method off the config and called it detached:

```ts
const write = config.provider.write;
…
const record = await write({ … });
```

A provider is normally a class — an Adonis service with its model or repository injected — and a detached method has lost its receiver, so the first `this.` inside it throws a `TypeError`. The loop reports that as a failed tool call, the model narrates the failure, and nothing is ever written down. Reads were unaffected: `list` and `forget` are called through the object.

`offerMemories` detached `search` the same way, which breaks the same host on the RECALL path — and that one runs on every turn, so it breaks before anything is ever written. Both are bound now.

Every provider in this repo's own tests is an object literal of arrow functions, which needs no receiver — which is exactly why it went unseen. The regression test is a provider written the way a host writes one, with both `search` and `write` reading its storage off `this`.
