import type { SinkWriter } from '../spi/token-stream-sink.js';
import type { ScoreResult } from './types.js';

/** The toolkit a model-graded (LLM-as-judge) scorer needs: a sink to nowhere and a verdict parser. */

/**
 * A {@link SinkWriter} that drops every token.
 *
 * {@link import('../spi/model-provider.js').ModelProvider.runTurn} streams deltas as it generates,
 * but a judge's verdict is read from the assembled `text` it returns and nobody is watching it
 * arrive — a judge call has no run, so there is no live stream to join.
 */
export function discardingSink(): SinkWriter {
  return {
    write: () => {},
    end: () => {},
  };
}

/**
 * The upper end of the scale a judge is asked for. A 0–5 integer band is easier for a model to hold
 * consistently than a raw 0–1 float, so the prompt asks for that and the parser normalizes.
 */
export const MAX_JUDGE_SCORE = 5;

/** A judge reply that could not be read as a verdict. */
export class JudgeVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JudgeVerdictError';
  }
}

const SCORE_PATTERN = /SCORE:\s*(\d+(?:\.\d+)?)/i;
const REASON_PATTERN = /REASON:\s*([\s\S]+)/i;

/**
 * Read a `SCORE: n` / `REASON: …` reply into a {@link ScoreResult}, normalizing the score to `0..1`.
 *
 * A missing or out-of-band score THROWS rather than scoring 0: a judge that did not answer is a
 * broken evaluation, and recording it as a bad run would put the blame on the agent. The batch
 * runner catches it as a per-run scorer failure. A missing reason is tolerated — the number is the
 * verdict, the sentence is the courtesy.
 */
export function parseJudgeVerdict(text: string): ScoreResult {
  const scoreMatch = SCORE_PATTERN.exec(text);
  const raw = scoreMatch?.[1];
  if (raw === undefined) {
    throw new JudgeVerdictError(`judge reply carried no "SCORE:" line: ${text.slice(0, 200)}`);
  }
  const rawScore = Number(raw);
  if (!Number.isFinite(rawScore) || rawScore > MAX_JUDGE_SCORE) {
    throw new JudgeVerdictError(
      `judge scored ${raw}, outside the 0-${MAX_JUDGE_SCORE} scale it was asked for`,
    );
  }
  return {
    score: rawScore / MAX_JUDGE_SCORE,
    reason: REASON_PATTERN.exec(text)?.[1]?.trim() ?? 'the judge gave no reason',
    metadata: { rawScore, maxScore: MAX_JUDGE_SCORE },
  };
}
