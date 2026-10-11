---
'@adonis-agora/agent': patch
---

Text channels no longer draw a genui component whose frame was written for a schema version newer than the catalog knows: its native conversion, chart image and props summary are skipped and the frame's own `fallbackText` is sent (nothing, when it has none). Older versions still convert, told their version. `ChannelComponentInput.fallbackText` carries the frame's text into `renderChannelMessages`.
