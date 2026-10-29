---
'@adonis-agora/agent': patch
---

A broken live stream no longer fails the run. The provider now wraps the configured sink in `ResilientTokenStreamSink`: when a write to the token stream throws — Redis out of memory (`OOM command not allowed` → `EXECABORT`), a dropped connection, a Lucid sink that can't write — the first failure of the run is reported (`console.warn`, or `onFailure` when you build the wrapper yourself), that run's writer goes quiet, and the run carries on to the end. The answer is persisted as usual and a reload (the thread read, not the stream) shows it whole. Before, the rejection reached the agent loop's `await writer.write(…)` and failed the run, so the model's answer was never written even though only the live view was broken.
