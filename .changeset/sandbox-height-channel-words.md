---
'@adonis-agora/agent': patch
---

Sandbox frames follow their content, and the model stops describing web UI on WhatsApp, Telegram and email.

- **The sandbox frame resizes to its content, both ways.** The bridge measured `scrollHeight`, which never drops below the frame's own height, so a frame mounted at the model's `initialHeight` kept that height and left an empty gap under a short view, and it could only grow. It now reports the content's height (the bottom of what the body holds, margins included), re-measures on every resize of the page or a top-level element, on DOM and style changes (Tailwind injecting its CSS, the kit drawing JSX), and once fonts and images load. The first measure also rides `ready`. `initialHeight` only sizes the placeholder and the frame until its first measure.
- **On a channel the server draws for, the model is told what the user gets.** With `genui({ channels })`, a turn on WhatsApp, Telegram or email gets a `## Channel: …` prompt block: the user is not on a web page, what the channel can show, and how each component reaches the user there (its conversion's `describe`, a chart image, or plain text with no buttons). A tool that pushes UI there gets `delivered` on its result, which says what was actually sent (`Shown on WhatsApp as a message "*Your orders*" with a pick-list … of 4 entries …; no table, no web view, and no buttons other than the ones listed`). A conversion may be `{ convert, describe }`. New exports: `channelPrompt`, `describeChannelDelivery`, `describeChannelComponents`, `ChannelConversionSpec`.
