/**
 * An interrupt's id carries everything a resuming request needs, so the producer keeps NOTHING
 * between the run that stopped to ask and the run that answers — the statelessness AG-UI lets a
 * producer have, and what lets any replica serve the resume.
 *
 * It names the library run the human is answering (`parked` — a delegated sub-agent parks its OWN
 * run), the run whose stream carries the work (`stream`), the tool call, and how many of that
 * stream's frames the interrupted AG-UI run already delivered (`position`), which is where the
 * resuming run picks the stream up.
 *
 * It is an address, not a credential: the resume route checks the caller owns the run exactly as
 * the native approve/answer routes do.
 */
export interface InterruptAddress {
  /** `proposal` — an independent proposal's approval, decided through the proposal service. */
  kind: 'approval' | 'elicitation' | 'proposal';
  /** The run to settle the call on. */
  parked: string;
  /** The run whose buffered stream the resume re-attaches to. */
  stream: string;
  toolCallId: string;
  /** Frames of `stream` already delivered when the run was reported interrupted. */
  position: number;
  /** `proposal` only: the proposal and the library thread it belongs to. */
  proposalId?: string;
  threadId?: string;
}

const KIND_CODES = { approval: 'a', elicitation: 'e', proposal: 'p' } as const;

const PREFIX = 'agora_';

export function encodeInterruptId(address: InterruptAddress): string {
  const compact: unknown[] = [
    KIND_CODES[address.kind],
    address.parked,
    address.stream,
    address.toolCallId,
    address.position,
  ];
  if (address.kind === 'proposal') compact.push(address.proposalId, address.threadId);
  return PREFIX + Buffer.from(JSON.stringify(compact), 'utf8').toString('base64url');
}

/** The address an id names, or `null` for an id this producer did not mint. */
export function decodeInterruptId(id: unknown): InterruptAddress | null {
  if (typeof id !== 'string' || !id.startsWith(PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(id.slice(PREFIX.length), 'base64url').toString('utf8'),
    );
    if (!Array.isArray(parsed)) return null;
    const [kind, parked, stream, toolCallId, position, proposalId, threadId] = parsed as unknown[];
    if (
      parsed.length !== (kind === 'p' ? 7 : 5) ||
      (kind === 'p' && (typeof proposalId !== 'string' || typeof threadId !== 'string')) ||
      (kind !== 'a' && kind !== 'e' && kind !== 'p') ||
      typeof parked !== 'string' ||
      typeof stream !== 'string' ||
      typeof toolCallId !== 'string' ||
      typeof position !== 'number' ||
      !Number.isSafeInteger(position) ||
      position < 0
    ) {
      return null;
    }
    return {
      kind: kind === 'a' ? 'approval' : kind === 'e' ? 'elicitation' : 'proposal',
      parked,
      stream,
      toolCallId,
      position,
      ...(kind === 'p' ? { proposalId: proposalId as string, threadId: threadId as string } : {}),
    };
  } catch {
    return null;
  }
}
