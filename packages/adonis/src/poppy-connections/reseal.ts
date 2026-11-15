import { connectionStateAad, pendingFlowAad, type Sealer } from './crypto.js';
import type { PoppyConnectionStore, PoppySealedRef } from './store.js';

/** One sealed column: how its values stand against the keys, and what a reseal did to them. */
export interface SealedColumnReport {
  column: string;
  scanned: number;
  /** Open with the key that seals now. */
  active: number;
  /** Open only with an older key (or are not in the KMS envelope now configured). */
  retired: number;
  /** In the format agent wrote before the crypto kit. */
  legacy: number;
  /** Nothing configured opens them (key gone, damaged). */
  unreadable: number;
  /** Re-sealed with the key that seals now (with `dryRun`: would be). */
  resealed: number;
  /** Could not be re-sealed (did not open). */
  failed: number;
  /** Changed by the app between the read and the write; left alone (run again). */
  skipped: number;
}

export interface SealedReport {
  /** False when the store can't list its sealed values (a custom store without `listSealed`). */
  walkable: boolean;
  dryRun: boolean;
  columns: SealedColumnReport[];
}

const COLUMNS = {
  connection: 'agent_poppy_connection.state',
  pending: 'agent_poppy_connect.flow',
} as const;

const aadOf = (ref: PoppySealedRef) =>
  ref.table === 'connection' ? connectionStateAad(ref.owner, ref.issuer) : pendingFlowAad(ref.id);

function column(name: string): SealedColumnReport {
  return {
    column: name,
    scanned: 0,
    active: 0,
    retired: 0,
    legacy: 0,
    unreadable: 0,
    resealed: 0,
    failed: 0,
    skipped: 0,
  };
}

/**
 * Walk every sealed value of the store. `reseal: false` only classifies them; `reseal: true`
 * re-seals the `retired` and `legacy` ones (`all`: every value that opens — for keys the kit can't
 * tell apart, like the app's own `config/encryption.ts`). `dryRun` writes nothing.
 */
export async function walkSealed(
  store: PoppyConnectionStore,
  sealer: Sealer,
  options: { reseal: boolean; dryRun?: boolean; all?: boolean },
): Promise<SealedReport> {
  const dryRun = options.dryRun === true;
  if (typeof store.listSealed !== 'function') return { walkable: false, dryRun, columns: [] };
  if (options.reseal && !dryRun && typeof store.replaceSealed !== 'function') {
    return { walkable: false, dryRun, columns: [] };
  }
  const columns = { connection: column(COLUMNS.connection), pending: column(COLUMNS.pending) };
  for (const { ref, value } of await store.listSealed()) {
    const report = columns[ref.table];
    const aad = aadOf(ref);
    const status = await sealer.status(value, aad);
    report.scanned++;
    report[status]++;
    if (!options.reseal) continue;
    if (status === 'active' && options.all !== true) continue;
    if (status === 'unreadable') {
      report.failed++;
      continue;
    }
    const fresh = await sealer.seal(await sealer.open<unknown>(value, aad), aad);
    if (dryRun) report.resealed++;
    else if (await store.replaceSealed?.(ref, value, fresh)) report.resealed++;
    else report.skipped++;
  }
  return { walkable: true, dryRun, columns: [columns.connection, columns.pending] };
}

/** The `agent.crypto` doctor result for a {@link SealedReport}. */
export function sealedReportVerdict(report: SealedReport): {
  status: 'ok' | 'warn' | 'error' | 'skip';
  message: string;
  fix?: string;
  docs: string;
} {
  const docs =
    'https://davidecarvalho.github.io/agora/docs/agent/poppy-connections#rotating-the-sealing-key';
  if (!report.walkable) {
    return {
      status: 'skip',
      message: 'The poppy-connections store cannot list its sealed values.',
      docs,
    };
  }
  const sum = (field: 'scanned' | 'legacy' | 'retired' | 'unreadable') =>
    report.columns.reduce((total, c) => total + c[field], 0);
  if (sum('unreadable') > 0) {
    return {
      status: 'error',
      message: `${sum('unreadable')} sealed value(s) can't be opened with the configured keys.`,
      fix: 'Put the key they were sealed with back in `crypto.keys` of config/poppy_connections.ts',
      docs,
    };
  }
  if (sum('legacy') + sum('retired') > 0) {
    return {
      status: 'warn',
      message: `${sum('legacy')} value(s) in the pre-1.0 format and ${sum('retired')} sealed with a retired key (of ${sum('scanned')}).`,
      fix: 'Run `node ace agent:crypto:reseal`',
      docs,
    };
  }
  return {
    status: 'ok',
    message: `${sum('scanned')} sealed value(s), all on the active key.`,
    docs,
  };
}
