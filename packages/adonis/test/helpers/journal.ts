/**
 * The durable engine's replay contract, reduced to what a loop spec needs: a position is taken on
 * the CALL and held even when the body throws (`ctx.localStep` records a failed checkpoint at that
 * seq), a name that disagrees with the one recorded there is a refusal, and outputs round-trip
 * through JSON like a real checkpoint's do — so nothing passes between two passes except what the
 * journal could actually carry.
 */
export class Journal {
  private readonly entries: { name: string; done: boolean; output: string | undefined }[] = [];
  private seq = 0;

  constructor(private readonly runId = 'run-1') {}

  /** Start a new pass over the same recorded history — a resume. */
  rewind(): void {
    this.seq = 0;
  }

  names(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  /** The recorded names from the first tool checkpoint onwards. */
  toolNames(): string[] {
    const names = this.names();
    const start = names.findIndex(
      (name) => name.startsWith('persist:toolcall:') || name.startsWith('patch:'),
    );
    return start === -1 ? [] : names.slice(start);
  }

  /** The recorded names strictly between two checkpoints, for asserting on one region of a run. */
  namesBetween(after: string, before: string): string[] {
    const names = this.names();
    const from = names.indexOf(after);
    const to = names.indexOf(before);
    return from === -1 || to === -1 ? [] : names.slice(from + 1, to);
  }

  /** Corrupt one recorded name, to force a divergence at a position of the test's choosing. */
  renameAt(position: number, name: string): void {
    const entry = this.entries[position];
    if (entry === undefined) throw new Error(`no entry at ${position}`);
    entry.name = name;
  }

  /** Drop one recorded entry, leaving the history a shape that never reached it would have left. */
  dropAt(position: number): void {
    if (this.entries[position] === undefined) throw new Error(`no entry at ${position}`);
    this.entries.splice(position, 1);
  }

  /** Drop one recorded output, as a checkpoint written before the step returned a value would. */
  forgetOutputAt(position: number): void {
    const entry = this.entries[position];
    if (entry === undefined) throw new Error(`no entry at ${position}`);
    entry.output = undefined;
  }

  async at<T>(name: string, produce: () => Promise<T>): Promise<T> {
    const position = this.seq;
    this.seq += 1;
    const existing = this.entries[position];
    if (existing !== undefined) {
      if (existing.name !== name) {
        // `@adonis-agora/durable`'s own refusal, reproduced by NAME — that is what
        // `isReplayIntegrityError` keys off, since the engine and the remote replay context spell
        // the class differently.
        const refusal = new Error(
          `non-determinism at ${this.runId}#${position}: code expects "${name}" but history recorded "${existing.name}"`,
        );
        refusal.name = 'NonDeterminismError';
        throw refusal;
      }
      if (existing.done) {
        return (existing.output === undefined ? undefined : JSON.parse(existing.output)) as T;
      }
    } else {
      this.entries[position] = { name, done: false, output: undefined };
    }
    const output = await produce();
    const serialized = output === undefined ? undefined : JSON.stringify(output);
    this.entries[position] = { name, done: true, output: serialized };
    return (serialized === undefined ? undefined : JSON.parse(serialized)) as T;
  }

  /** `ctx.patched`: consume a position for a run that first arrives here, give it back otherwise. */
  async patched(id: string): Promise<boolean> {
    const marker = `patch:${id}`;
    const position = this.seq;
    this.seq += 1;
    const existing = this.entries[position];
    if (existing !== undefined) {
      if (existing.name === marker) return true;
      this.seq -= 1;
      return false;
    }
    this.entries[position] = { name: marker, done: true, output: 'true' };
    return true;
  }
}
