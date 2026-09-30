---
'@adonis-agora/agent': minor
---

Serve the agent over AG-UI 1.0. With `agUi: true` in the config, `POST <path>/ag-ui` takes a `RunAgentInput` and answers with the run as AG-UI events, so any AG-UI client (`@ag-ui/client`, CopilotKit) drives the agent as-is. The native stream is unchanged.

- A run that stops for an approval or a question set ends with the interrupt outcome; a later request answers it in `resume` and continues the parked run. The interrupt id carries the whole address, so nothing is kept between the two requests and any replica serves the resume.
- Multimodal input: a media part carried inline becomes an attachment through the configured attachment store.
- `RUN_FINISHED.usage` reports tokens per model; a stopped run ends with the cancelled outcome; generative UI, title and the queue travel as `agora.*` custom events.
- New subpath `@adonis-agora/agent/ag-ui` (`AgUiEncoder`, `agUiEvents`, the input readers) for a host that mounts its own route.
- `CreateThreadInput.id` (optional): a store may create a thread under an id the caller names. `step-finish` gains an optional `model`.
