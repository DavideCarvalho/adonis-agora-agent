import type Configure from '@adonisjs/core/commands/configure';
import { stubsRoot } from './stubs/main.js';

/**
 * `node ace configure @adonis-agora/agent` — auto-wires the package:
 *
 * 1. registers the agent service provider in `adonisrc.ts`;
 * 2. registers the embedded dashboard provider — the governance console SPA, bundled into this
 *    package's own `dist/` (`@adonis-agora/agent-dashboard`'s build output, copied in at build time),
 *    served with no separate install. Toggle/relocate it with the optional `config('agent').dashboard`
 *    block (see `config/agent.ts`); it mounts only once `governanceAuthorize` is configured — see the
 *    provider's own doc comment for why;
 * 3. registers the Assembler `init` hook that generates the typed `app/agent_tools` barrel at
 *    build/dev time (the provider imports it instead of scanning at runtime; it falls back to the
 *    runtime scan when the barrel is absent);
 * 4. publishes `config/agent.ts`;
 * 5. publishes `config/mcp.ts` (the MCP endpoint config; the MCP provider is separate);
 * 6. publishes the Lucid migration for the six agent tables (run `node ace migration:run`; delete it
 *    if you only use the in-memory store). It delegates to `createAgentTables`, so it is idempotent
 *    and safe to run against a database the library already auto-created;
 * 7. publishes the pgvector migration for the RAG chunk table (Postgres + pgvector only; delete it
 *    unless you use `retrievers.pgvector({...})`).
 */
export async function configure(command: Configure) {
  const codemods = await command.createCodemods();

  await codemods.updateRcFile((rcFile) => {
    rcFile.addProvider('@adonis-agora/agent/agent_provider');
    rcFile.addProvider('@adonis-agora/agent/dashboard_provider');
    // Generate the typed app/agent_tools barrel at build/dev time (replaces the runtime readdir scan).
    rcFile.addAssemblerHook('init', '@adonis-agora/agent/hooks/tools');
  });

  await codemods.makeUsingStub(stubsRoot, 'config/agent.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'config/mcp.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'database/migrations/create_agent_tables.stub', {});
  await codemods.makeUsingStub(stubsRoot, 'database/migrations/create_agent_rag_chunks.stub', {});
}
