import { describe, expect, it } from 'vitest';
import {
  askInputSchema,
  type ElicitationQuestion,
  type ElicitationRequest,
  readElicitationQuestions,
  settleElicitation,
  validateElicitationAnswer,
  validateElicitationValue,
} from '../src/index.js';

function typed(input: ElicitationQuestion['input'], extra: Partial<ElicitationQuestion> = {}) {
  return { id: 'q', prompt: 'Q?', input, ...extra } as ElicitationQuestion;
}

describe('validateElicitationValue — one canonical string per type', () => {
  it.each([
    [{ type: 'number' as const }, '42', null],
    [{ type: 'number' as const }, '-1.5', null],
    [{ type: 'number' as const }, 'forty', 'must be a number'],
    [{ type: 'number' as const, min: 1, max: 10 }, '0', 'must be at least 1'],
    [{ type: 'number' as const, min: 1, max: 10 }, '11', 'must be at most 10'],
    [{ type: 'boolean' as const }, 'true', null],
    [{ type: 'boolean' as const }, 'yes', 'must be "true" or "false"'],
    [{ type: 'date' as const }, '2026-02-28', null],
    [{ type: 'date' as const }, '2026-02-30', 'must be a date as YYYY-MM-DD'],
    [{ type: 'date' as const, min: '2026-01-01' }, '2025-12-31', 'must be on or after 2026-01-01'],
    [{ type: 'email' as const }, 'a@b.co', null],
    [{ type: 'email' as const }, 'not-an-email', 'must be an email address'],
    [{ type: 'url' as const }, 'https://example.com/x', null],
    [{ type: 'url' as const }, 'javascript:alert(1)', 'must be an http(s) URL'],
    [{ type: 'text' as const, min: 3 }, 'ab', 'must be at least 3 characters'],
    [{ type: 'textarea' as const, max: 5 }, 'line\nline', 'must be at most 5 characters'],
    [{ type: 'text' as const, pattern: '[A-Z]{3}-\\d+' }, 'ABC-12', null],
    [
      { type: 'text' as const, pattern: '[A-Z]{3}-\\d+' },
      'ABC-12x',
      'does not match the expected format',
    ],
    [{ type: 'text' as const, pattern: '([' }, 'anything', null],
  ])('%j accepts %j → %j', (input, value, expected) => {
    expect(validateElicitationValue(typed(input), value)).toBe(expected);
  });

  it('holds a select (and a plain question) to its options unless free text is allowed', () => {
    const select = typed(
      { type: 'select' },
      { options: [{ value: 'a', label: 'A' }], allowFreeText: false },
    );
    expect(validateElicitationValue(select, 'a')).toBeNull();
    expect(validateElicitationValue(select, 'z')).toBe('must be one of the offered options');
    expect(validateElicitationValue({ ...select, allowFreeText: true }, 'z')).toBeNull();
  });
});

describe('validateElicitationAnswer', () => {
  it('refuses a required question left empty and a second value for a single choice', () => {
    const question = typed({ type: 'text', required: true });
    expect(validateElicitationAnswer(question, [])).toBe('requires an answer');
    expect(validateElicitationAnswer(question, [''])).toBe('requires an answer');
    expect(validateElicitationAnswer(question, ['a', 'b'])).toBe('takes a single value');
    expect(validateElicitationAnswer(question, ['a'])).toBeNull();
    expect(validateElicitationAnswer(typed({ type: 'text' }), [])).toBeNull();
  });
});

describe('the ask tool accepts typed questions', () => {
  it('parses a typed question without options, with a description and a valid default', () => {
    const parsed = askInputSchema['~standard'].validate({
      questions: [
        {
          id: 'count',
          prompt: 'How many seats?',
          description: 'Between 1 and 50.',
          input: { type: 'number', min: 1, max: 50, required: true, extra: 'dropped' },
          defaults: ['5'],
        },
        { id: 'email', prompt: 'Your email?', input: { type: 'email', placeholder: 'you@x.com' } },
      ],
    });
    expect(parsed).toEqual({
      value: {
        questions: [
          {
            id: 'count',
            prompt: 'How many seats?',
            description: 'Between 1 and 50.',
            input: { type: 'number', min: 1, max: 50, required: true },
            defaults: ['5'],
          },
          {
            id: 'email',
            prompt: 'Your email?',
            input: { type: 'email', placeholder: 'you@x.com' },
          },
        ],
      },
    });
  });

  it('refuses an unknown input type, a typed default its rules reject, and a select without options', () => {
    const result = askInputSchema['~standard'].validate({
      questions: [
        { id: 'a', prompt: 'A?', input: { type: 'color' } },
        { id: 'b', prompt: 'B?', input: { type: 'number' }, defaults: ['many'] },
        { id: 'c', prompt: 'C?', input: { type: 'select' } },
      ],
    }) as unknown as { issues: { path: (string | number)[] }[] };
    expect(result.issues.map((each) => each.path.join('.'))).toEqual([
      'questions.0.input.type',
      'questions.1.defaults',
      'questions.2.options',
    ]);
  });

  it('still requires defaults on a pick from options', () => {
    const result = askInputSchema['~standard'].validate({
      questions: [{ id: 'a', prompt: 'A?', options: [{ value: 'x', label: 'X' }] }],
    }) as unknown as { issues: { path: (string | number)[] }[] };
    expect(result.issues[0]?.path).toEqual(['questions', 0, 'defaults']);
  });
});

describe('settling typed answers', () => {
  const request: ElicitationRequest = {
    id: 'call-1',
    source: 'ask',
    questions: [
      { id: 'seats', prompt: 'Seats?', input: { type: 'number', min: 1 }, defaults: ['2'] },
      { id: 'when', prompt: 'When?', input: { type: 'date' } },
      { id: 'note', prompt: 'Anything else?', input: { type: 'textarea' } },
    ],
  };

  it('keeps valid typed values, drops the ones its rules refuse, and reads them back raw', () => {
    const result = settleElicitation({
      request,
      reply: { answers: { seats: ['0', '3'], when: ['2026-13-01'], note: ['window seat'] } },
    });
    expect(result.answers).toEqual({ seats: ['3'], when: [], note: ['window seat'] });
    expect(result.summary).toBe(
      'The user answered:\nSeats? → 3\nWhen? → (no answer)\nAnything else? → window seat',
    );
  });

  it('fills an unanswered typed question from its defaults, or leaves it empty', () => {
    const result = settleElicitation({ request, reply: { answers: {} } });
    expect(result.answers).toEqual({ seats: ['2'], when: [], note: [] });
  });
});

describe('readElicitationQuestions', () => {
  it('reads the questions a parked call recorded, leniently', () => {
    expect(
      readElicitationQuestions({
        questions: [
          { id: 'a', prompt: 'A?', input: { type: 'number', max: 3 } },
          { prompt: 'no id' },
          'junk',
          { id: 'b', prompt: 'B?', options: [{ value: 'x', label: 'X' }, { nope: 1 }] },
        ],
      }),
    ).toEqual([
      { id: 'a', prompt: 'A?', options: [], input: { type: 'number', max: 3 } },
      { id: 'b', prompt: 'B?', options: [{ value: 'x', label: 'X' }] },
    ]);
    expect(readElicitationQuestions(null)).toEqual([]);
  });
});

describe('AgentService.answerProblem — what the answer route refuses with a 400', () => {
  async function serviceWithParkedQuestions() {
    const {
      AgentDepsFactory,
      AgentRegistry,
      AgentService,
      DefaultToolAuthorizer,
      InlineAgentRunner,
      InProcessTokenStreamSink,
      ToolRegistry,
    } = await import('../src/index.js');
    const { FakeModelProvider, InMemoryAgentStore } = await import('../src/testing/index.js');
    const store = new InMemoryAgentStore();
    const factory = new AgentDepsFactory({
      model: new FakeModelProvider(() => ({ text: '' })),
      store,
      sink: new InProcessTokenStreamSink(),
      rolesPolicy: new DefaultToolAuthorizer(),
      registry: new ToolRegistry(),
      agents: new AgentRegistry(),
    });
    const thread = await store.createThread({ actor: { id: 'u1' }, persona: 'default' });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: '',
    });
    await store.recordToolCall({
      toolCallId: 'ask-1',
      messageId: message.id,
      toolName: 'ask',
      toolType: 'action',
      status: 'pending_approval',
      input: {
        questions: [
          {
            id: 'seats',
            prompt: 'Seats?',
            input: { type: 'number', min: 1, max: 4 },
            defaults: ['2'],
          },
          { id: 'email', prompt: 'Email?', input: { type: 'email', required: true } },
        ],
      },
    });
    return new AgentService(new InlineAgentRunner(factory, store), store, factory);
  }

  it('names the question and the rule a value breaks', async () => {
    const service = await serviceWithParkedQuestions();
    expect(await service.answerProblem('ask-1', { seats: ['9'], email: ['a@b.co'] })).toMatch(
      /^answers\["seats"\] /,
    );
  });

  it('refuses a required question left without an answer or a default', async () => {
    const service = await serviceWithParkedQuestions();
    expect(await service.answerProblem('ask-1', {})).toMatch(/^answers\["email"\] /);
  });

  it('accepts a reply every question can settle, with defaults filling the gaps', async () => {
    const service = await serviceWithParkedQuestions();
    expect(await service.answerProblem('ask-1', { email: ['a@b.co'] })).toBeNull();
  });
});
