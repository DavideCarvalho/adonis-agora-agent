---
'@adonis-agora/agent': minor
---

Generative UI: A2UI catalog negotiation, thread replay and data model; UI-action chips; nested sandboxes stream.

- **A2UI catalog id per client.** The basic catalog is sent under the id the client advertises (`a2uiClientCapabilities` on the A2UI route; `forwardedProps.a2uiClientCapabilities` or CopilotKit's "A2UI catalog capabilities" context entry over AG-UI). With none advertised, AG-UI uses the id AG-UI's A2UI binding and CopilotKit 1.77 register (`A2UI_LEGACY_BASIC_CATALOG_ID`), so CopilotKit's A2UI renderer draws with no `catalogId` workaround; the A2UI route keeps the current id. New: `A2UI_BASIC_CATALOG_IDS`, `isA2uiBasicCatalogId`, `negotiateA2uiCatalog`, `readA2uiClientCapabilities`, `readAgUiA2uiCatalogIds`, and the `basicCatalogId` option.
- **Reopening an A2UI thread.** `GET <path>/a2ui/threads/:threadId` answers a stored thread as `{ threadId, entries }` (user lines, and each assistant step's surfaces under the live surface ids); `a2uiThreadReplay()` is the framework-free conversion.
- **A2UI data model.** `sendDataModel: true` creates surfaces with `sendDataModel`; the route reads `a2uiClientDataModel` (body or `metadata`, at most `maxDataModelBytes`) into `pageContext.a2uiDataModel` for the prompt builder.
- **UI actions draw as chips.** `readUiActionText()` reads a message `uiActionText()` wrote back into its parts, `uiActionSummary()` makes its one-line summary. The React transcript sets `uiAction` on such a user message's text block and item, `MessageItem` draws it as the new `<UiActionChip>` (payload kept in the message for the model, out of sight).
- **Nested sandboxes stream.** A `streaming: 'complete'` layout around a component that streams `partial` of its own accord (a `Sandbox`) is drawn — `incomplete`, with its children so far — once its own props are whole, instead of holding the sandbox back until the call ends.
