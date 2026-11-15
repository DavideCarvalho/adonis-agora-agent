import { flags } from '@adonisjs/core/ace';
import { AgentCommand } from '../src/cli/agent_command.js';
import type { SealedReport } from '../src/poppy-connections/reseal.js';
import { PoppyConnections } from '../src/poppy-connections/service.js';

/**
 * `agent:crypto:reseal [--dry-run] [--json]` — re-seal what the agent keeps encrypted at rest (the
 * poppy connections) with the active key of `crypto` in `config/poppy_connections.ts`: values in
 * the pre-1.0 format and values sealed with a retired key. Exit `1` when a value could not be opened.
 */
export class AgentCryptoReseal extends AgentCommand {
  static override commandName = 'agent:crypto:reseal';
  static override description = 'Re-seal encrypted-at-rest values with the active key';

  @flags.boolean({ description: 'Count and test-open what would be re-sealed; write nothing' })
  declare dryRun: boolean;

  @flags.boolean({
    description:
      'Re-seal every value, not only retired/legacy ones (after rotating the keys of config/encryption.ts)',
  })
  declare all: boolean;

  protected async execute() {
    if (!this.app.container.hasBinding(PoppyConnections)) {
      const empty: SealedReport = { walkable: true, dryRun: this.dryRun === true, columns: [] };
      return this.output(empty, () =>
        this.logger.info('Nothing sealed: poppy-connections is not configured.'),
      );
    }
    const connections = await this.app.container.make(PoppyConnections);
    const report = await connections.reseal({
      dryRun: this.dryRun === true,
      all: this.all === true,
    });
    if (!report.walkable) {
      return this.refuse(
        'The poppy-connections store cannot list its sealed values (a custom store needs `listSealed` and `replaceSealed`).',
      );
    }
    this.output(report, (value) => {
      this.table(
        [
          'Column',
          'Scanned',
          'Active',
          'Retired',
          'Legacy',
          'Unreadable',
          value.dryRun ? 'Would reseal' : 'Resealed',
          'Failed',
          'Skipped',
        ],
        value.columns.map((c) => [
          c.column,
          c.scanned,
          c.active,
          c.retired,
          c.legacy,
          c.unreadable,
          c.resealed,
          c.failed,
          c.skipped,
        ]),
      );
      if (value.dryRun) this.logger.info('Dry run: nothing was written.');
    });
    const failed = report.columns.reduce((total, c) => total + c.failed, 0);
    if (failed > 0) {
      this.logger.error(
        `${failed} value(s) could not be opened: a key is missing from \`crypto.keys\`, or the value is damaged.`,
      );
      this.exitCode = 1;
    }
  }
}
