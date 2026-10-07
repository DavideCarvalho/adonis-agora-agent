import type { ActionProposalExecutor } from './action-proposal-executor.js';
import type { ActionProposalOutcomeStore } from './spi/action-proposal-outcome-store.js';
import type { ActionProposal, ActionProposalStore } from './spi/action-proposal-store.js';
import type { ActionProposalWorkerStore } from './spi/action-proposal-worker-store.js';
export interface ActionProposalWorkerOptions {
  store: ActionProposalStore & ActionProposalWorkerStore & ActionProposalOutcomeStore;
  executor: ActionProposalExecutor;
  workerId: string;
  pollIntervalMs?: number;
  leaseMs?: number;
  maxConcurrency?: number;
  onError?(error: unknown): void;
  /** After a proposal's execution settled (succeeded or failed). A throw goes to `onError`. */
  onSettled?(proposal: ActionProposal): void | Promise<void>;
}
export class ActionProposalWorker {
  private readonly leaseMs: number;
  private readonly pollIntervalMs: number;
  private readonly maxConcurrency: number;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private readonly renewals = new Set<ReturnType<typeof setInterval>>();
  private active: Promise<void> | undefined;
  constructor(private readonly options: ActionProposalWorkerOptions) {
    this.leaseMs = options.leaseMs ?? 30000;
    this.pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.maxConcurrency = options.maxConcurrency ?? 1;
    for (const value of [this.leaseMs, this.pollIntervalMs, this.maxConcurrency])
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new RangeError('Worker configuration must be positive safe integers');
    if (this.pollIntervalMs >= this.leaseMs / 3)
      throw new RangeError('Worker poll interval must be below one third of lease');
    if (!options.workerId) throw new TypeError('workerId is required');
  }
  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const tick = async () => {
      if (this.stopped) return;
      try {
        await this.runOnce();
      } catch (error) {
        this.options.onError?.(error);
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.pollIntervalMs);
    };
    this.timer = setTimeout(tick, 0);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.renewals) clearInterval(timer);
    this.renewals.clear();
    if (this.timer !== undefined) clearTimeout(this.timer);
    await this.active;
  }
  runOnce(): Promise<void> {
    if (this.active) return this.active;
    if (this.stopped) return Promise.resolve();
    const task = this.tick();
    this.active = task;
    return task.finally(() => {
      if (this.active === task) this.active = undefined;
    });
  }
  private async tick(): Promise<void> {
    await this.options.store.expireActionProposals({ limit: 100 });
    const work: Promise<void>[] = [];
    for (let index = 0; index < this.maxConcurrency && !this.stopped; index++) {
      const proposal = await this.options.store.claimNextActionProposal({
        workerId: this.options.workerId,
        leaseMs: this.leaseMs,
      });
      if (!proposal) break;
      work.push(this.execute(proposal));
    }
    await Promise.all(work);
    for (let index = 0; index < 32 && !this.stopped; index++) {
      const delivery = await this.options.store.claimNextActionProposalOutcome({
        workerId: this.options.workerId,
        leaseMs: this.leaseMs,
      });
      if (!delivery) break;
      await this.options.store.admitActionProposalOutcome(delivery.lease);
    }
  }
  private async execute(proposal: ActionProposal): Promise<void> {
    const lease = proposal.execution?.lease;
    if (!lease) throw new Error('Claimed action lacks execution lease');
    let fenced = true;
    let renewing: Promise<void> | undefined;
    const renew = () => {
      if (renewing || !fenced) return;
      renewing = this.options.store
        .extendActionProposalLease(proposal, proposal.id, {
          token: lease.token,
          generation: lease.generation,
          leaseMs: this.leaseMs,
        })
        .then(
          (result) => {
            if (result.status !== 'applied') fenced = false;
          },
          (error) => {
            fenced = false;
            this.options.onError?.(error);
          },
        )
        .finally(() => {
          renewing = undefined;
        });
    };
    const timer = setInterval(renew, this.leaseMs / 3);
    this.renewals.add(timer);
    try {
      const result = await this.options.executor.execute(proposal);
      clearInterval(timer);
      await renewing;
      if (!fenced) return;
      const settled = await this.options.store.settleActionProposal(proposal, proposal.id, {
        ...result,
        token: lease.token,
        generation: lease.generation,
      });
      if (settled.status === 'applied' && settled.proposal) {
        try {
          await this.options.onSettled?.(settled.proposal);
        } catch (error) {
          // The settlement is already committed: a broken listener must not fail the tick.
          this.options.onError?.(error);
        }
      }
    } finally {
      clearInterval(timer);
      this.renewals.delete(timer);
      await renewing;
    }
  }
}
