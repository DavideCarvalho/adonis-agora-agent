---
'@adonis-agora/agent': minor
---

Approval prompts read as the tool's own words on every adapter. A new shared helper, `resolveToolConfirmation(toolName, input, presentation?)` (with `humanizeToolName` and `DEFAULT_CONFIRM_VERB`), words a prompt: the tool's `presentation.confirm` filled from the call input, else `"<presentation.label>?"`, else the humanized name (`refund_order` → "Refund order?") — never the raw identifier.

- AG-UI: an interrupt's `message` is the confirmation title (it now outranks a free-form `reason`); without one it is the humanized name instead of `Approve <tool>?`.
- A2UI: the approve button is labelled with the confirmation's `verb` ("Refund"), and an approval without a confirmation reads as the tool's name in words instead of `Approve?`.
- Independent proposals: the stored confirmation is filled by the shared filler (placeholders collapse like everywhere else) and falls back to the label / humanized name instead of `Allow <tool>?`.
- Text channels: the approve button uses the tool's `confirm.verb` (the localized `texts.approve` when none was declared), a label-only press of that verb still decides the card, and the no-confirmation fallback no longer prints the identifier.
- OpenCode: an app tool's approval carries its filled `confirmation` (frame and persisted row), resolved from the tool's presentation behind OpenCode's prefixed name.
- A2A: an outcome summary without a confirmation uses the humanized name.
