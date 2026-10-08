---
'@adonis-agora/agent': patch
---

An empty assistant message no longer poisons a thread. When the model ended a step with no text (Claude does this right after a tool whose result is the answer, such as `renderResult`), the loop stored an assistant message with empty content and replayed it on the next turn. Anthropic and Bedrock refuse the whole request for it ("The content field in the Message object at messages.N is empty"), so every later message on that thread failed.

- The loop no longer stores a step that has no text and nothing else on it (no tool call, pushed UI or reasoning). A tool-call-only assistant message is still stored and replayed as before. The `persist:assistant:<step>` checkpoint stays (it records `null`) and still ends the step on the stream, so runs in flight replay unchanged.
- History building drops every assistant message whose text is empty or whitespace-only and that has no tool calls or results, so a thread that already stored one heals on its next turn.
- `aiSdkModel` never sends an empty assistant message or a whitespace-only text part next to tool calls.
- A detached run that ended on a blank step delivers no empty message to the delegating thread.
