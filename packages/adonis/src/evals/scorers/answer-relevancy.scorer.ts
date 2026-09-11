import type { ModelProvider } from '../../spi/model-provider.js';
import { discardingSink, MAX_JUDGE_SCORE, parseJudgeVerdict } from '../judge.js';
import type { ScorableRun, ScoreResult, Scorer, ScorerKind } from '../types.js';

/** {@link AnswerRelevancyScorer}'s stable name. */
export const ANSWER_RELEVANCY_SCORER = 'answer-relevancy';

const DEFAULT_JUDGE_PROMPT = [
  'You grade an AI assistant answer for RELEVANCY to the question it was given.',
  'Judge only whether the answer addresses what was asked — not style, length, or whether you',
  'personally agree with it. An answer that is fluent but answers a different question scores low.',
  '',
  `Reply in exactly this shape, with no other text: "SCORE: <0-${MAX_JUDGE_SCORE}>" on the first`,
  'line and "REASON: <one sentence>" on the second.',
].join('\n');

export interface AnswerRelevancyOptions {
  /** The judge. Deliberately a separate {@link ModelProvider} — nothing forces it to be the model under test. */
  model: ModelProvider;
  /** Override the grading instructions (e.g. to add domain rules the judge must apply). */
  systemPrompt?: string;
}

/**
 * LLM-as-judge: does the answer address the question that was asked?
 *
 * The expensive family, and the reason this module is offline-first — grading a turn costs a whole
 * model call, so it happens over stored runs on your schedule, not inside the turn where it would
 * double the latency and the bill of every message a user sends.
 *
 * `null` when there is no question or no answer to compare: a judge asked to grade an empty string
 * will invent a number, and `run-completion` has already scored that run 0.
 */
export class AnswerRelevancyScorer implements Scorer {
  readonly name = ANSWER_RELEVANCY_SCORER;
  readonly kind: ScorerKind = 'model';

  constructor(private readonly options: AnswerRelevancyOptions) {}

  async score(run: ScorableRun): Promise<ScoreResult | null> {
    if (run.input.trim() === '' || run.output.trim() === '') {
      return null;
    }
    const result = await this.options.model.runTurn({
      system: this.options.systemPrompt ?? DEFAULT_JUDGE_PROMPT,
      messages: [{ role: 'user', content: `QUESTION:\n${run.input}\n\nANSWER:\n${run.output}` }],
      tools: [],
      sink: discardingSink(),
    });
    return parseJudgeVerdict(result.text);
  }
}
