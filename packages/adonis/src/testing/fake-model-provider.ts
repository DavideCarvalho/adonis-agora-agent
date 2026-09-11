import type { ModelProvider, ModelTurnArgs, ModelTurnResult } from '../index.js';

/** One tool the scripted turn asks for. Its call id is derived from the turn index and the name. */
export interface FakeToolCall {
  name: string;
  input: unknown;
}

export interface FakeTurn {
  text: string;
  /** If set, the turn asks to call this tool instead of finishing. */
  toolCall?: FakeToolCall;
  /** Several tools in ONE turn — what a model routinely does. Takes precedence over `toolCall`. */
  toolCalls?: FakeToolCall[];
  /** If set, the turn reports an actual USD cost — as a gateway provider would. */
  costUsd?: number;
}

/**
 * `turnIndex` = how many assistant turns have already happened this run (derived from the
 * message history), so the script is a pure function of its inputs — deterministic and
 * replay-safe with no internal counter.
 */
export type FakeScript = (args: ModelTurnArgs, turnIndex: number) => FakeTurn;

/**
 * A deterministic, offline `ModelProvider`. Drives the agent loop without any API key,
 * streaming the scripted text to the sink and optionally requesting one tool call.
 */
export class FakeModelProvider implements ModelProvider {
  constructor(private readonly script: FakeScript) {}

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    const turnIndex = args.messages.filter((message) => message.role === 'assistant').length;
    const turn = this.script(args, turnIndex);

    await args.sink.write({ t: 'text', v: turn.text });

    const requested = turn.toolCalls ?? (turn.toolCall ? [turn.toolCall] : []);
    const toolCalls = requested.map((call) => ({
      id: `call-${turnIndex}-${call.name}`,
      name: call.name,
      input: call.input,
    }));

    return {
      text: turn.text,
      toolCalls,
      usage: { inputTokens: args.messages.length, outputTokens: turn.text.length },
      ...(turn.costUsd !== undefined ? { costUsd: turn.costUsd } : {}),
    };
  }
}

/** A trivial script: stream a fixed reply and never call a tool. */
export function echoScript(reply = 'ok'): FakeScript {
  return () => ({ text: reply });
}
