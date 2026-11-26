import { BaseCommand, flags } from '@adonisjs/core/ace';
import type { CommandOptions } from '@adonisjs/core/types/ace';
import { appKeyOf } from '../src/app_key_of.js';
import { CliRefusal } from '../src/cli/agent_command.js';
import { publicJwk } from '../src/crypto-kit/index.js';
import type { AgentConfig } from '../src/define_config.js';
import { consoleCommandKeys } from '../src/federation/console.js';

/**
 * `agent:console-key [--prefix <prefix>]` — print this app's console-command public key: what a
 * federated console names as `controlPlane.publicKey` for this app in token mode. Derived from
 * `APP_KEY` and `consoleCommands.prefix`, so it changes when either does. Public: safe to copy into
 * the console's config or an env var. The console must take it from there, never from Redis.
 */
export class AgentConsoleKey extends BaseCommand {
  static override commandName = 'agent:console-key';
  static override description =
    "Print this app's console-command public key (a federated console's controlPlane.publicKey)";
  static override options: CommandOptions = { startApp: false };

  @flags.string({ description: 'The consoleCommands prefix (default: the one in config/agent.ts)' })
  declare prefix?: string;

  override async run(): Promise<void> {
    try {
      const configured = this.app.config.get<AgentConfig | undefined>(
        'agent',
        undefined,
      )?.consoleCommands;
      const prefix =
        this.prefix !== undefined && this.prefix !== '' ? this.prefix : configured?.prefix;
      if (prefix === undefined || prefix === '') {
        throw new CliRefusal(
          'No prefix: set `consoleCommands.prefix` in config/agent.ts or pass --prefix.',
        );
      }
      const appKey = await appKeyOf(this.app);
      if (appKey === undefined) {
        throw new CliRefusal('No APP_KEY: the console-command key is derived from it.');
      }
      this.logger.log(JSON.stringify(publicJwk(consoleCommandKeys(appKey, prefix).publicKey)));
    } catch (error) {
      if (!(error instanceof CliRefusal)) throw error;
      this.logger.error(error.message);
      this.exitCode = 1;
    }
  }
}
