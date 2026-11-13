import { type FormEvent, useState } from 'react';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import { isUnavailable } from '../client/agent-client.js';
import { formatTimestamp, formatUsd } from '../client/format.js';
import type { CurrentModelPrice } from '../client/types.js';
import { TagIcon } from './icons.js';
import { fieldClass, Notice, numClass, TableSkeleton } from './ui.js';
import { asQuery, useAgentClient, usePricing } from './use-governance.js';

const emptyForm = {
  modelId: '',
  inputPricePer1m: '',
  outputPricePer1m: '',
  cacheWritePricePer1m: '',
  cacheReadPricePer1m: '',
};
type PriceForm = typeof emptyForm;

const optionalUsd = (value: number | undefined) => (value === undefined ? '—' : formatUsd(value));

const priceColumns: Column<CurrentModelPrice>[] = [
  { id: 'model', header: 'Model', cell: (p) => <span className="mono text-fg">{p.modelId}</span> },
  {
    id: 'input',
    header: 'Input / 1M',
    align: 'right',
    cell: (p) => <span className="mono tnum text-fg">{formatUsd(p.inputPricePer1m)}</span>,
  },
  {
    id: 'output',
    header: 'Output / 1M',
    align: 'right',
    cell: (p) => <span className="mono tnum text-fg">{formatUsd(p.outputPricePer1m)}</span>,
  },
  {
    id: 'cacheWrite',
    header: 'Cache write / 1M',
    align: 'right',
    hideBelow: 'md',
    cell: (p) => <span className={numClass}>{optionalUsd(p.cacheWritePricePer1m)}</span>,
  },
  {
    id: 'cacheRead',
    header: 'Cache read / 1M',
    align: 'right',
    hideBelow: 'md',
    cell: (p) => <span className={numClass}>{optionalUsd(p.cacheReadPricePer1m)}</span>,
  },
  {
    id: 'from',
    header: 'Effective from',
    align: 'right',
    hideBelow: 'lg',
    cell: (p) => <span className="mono tnum">{formatTimestamp(p.effectiveFrom)}</span>,
  },
];

/** The "set a price" form (presentational: state and submit come in as props). */
export function PriceFormView({
  form,
  onChange,
  onSubmit,
  saving,
  error,
}: {
  form: PriceForm;
  onChange: (field: keyof PriceForm, value: string) => void;
  onSubmit: (e: FormEvent) => void;
  saving: boolean;
  error: string | null;
}) {
  const field = (
    name: keyof PriceForm,
    placeholder: string,
    label: string,
    numeric: boolean,
    className = '',
  ) => (
    <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
        {label}
      </span>
      <input
        className={`${fieldClass} ${numeric ? 'mono tnum' : 'mono'}`}
        placeholder={placeholder}
        value={form[name]}
        onChange={(e) => onChange(name, e.target.value)}
        {...(numeric ? { type: 'number', step: 'any', min: 0 } : {})}
      />
    </label>
  );
  return (
    <form className="flex flex-col gap-3" onSubmit={onSubmit}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[2fr_repeat(4,1fr)]">
        {field('modelId', 'model id (e.g. gpt-4o)', 'Model', false, 'sm:col-span-2 lg:col-span-1')}
        {field('inputPricePer1m', 'input $/1M', 'Input', true)}
        {field('outputPricePer1m', 'output $/1M', 'Output', true)}
        {field('cacheWritePricePer1m', 'cache write $/1M (optional)', 'Cache write', true)}
        {field('cacheReadPricePer1m', 'cache read $/1M (optional)', 'Cache read', true)}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save price'}
        </Button>
        {error ? (
          <span role="alert" className="text-xs text-bad">
            {error}
          </span>
        ) : (
          <span className="text-[11px] text-faint">Rates are per 1M tokens, in USD.</span>
        )}
      </div>
    </form>
  );
}

/**
 * Model pricing from `GET /agent/governance/pricing` and an upsert form (`POST
 * /agent/governance/pricing`) — the rates the loop's cost fold and every governance rollup price
 * usage against (container). `501` (`404` from an older server) means no pricing store is bound
 * (`pricingStore: false`): an expected state with its own notice, not an error.
 */
export function PricingSection() {
  const client = useAgentClient();
  const pricesState = usePricing();
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const inputRate = Number.parseFloat(form.inputPricePer1m);
    const outputRate = Number.parseFloat(form.outputPricePer1m);
    if (form.modelId.trim() === '' || Number.isNaN(inputRate) || Number.isNaN(outputRate)) {
      setSaveError('model id, input rate and output rate are required');
      return;
    }
    const cacheWrite = Number.parseFloat(form.cacheWritePricePer1m);
    const cacheRead = Number.parseFloat(form.cacheReadPricePer1m);
    setSaving(true);
    setSaveError(null);
    try {
      await client.upsertPrice({
        modelId: form.modelId.trim(),
        inputPricePer1m: inputRate,
        outputPricePer1m: outputRate,
        ...(Number.isNaN(cacheWrite) ? {} : { cacheWritePricePer1m: cacheWrite }),
        ...(Number.isNaN(cacheRead) ? {} : { cacheReadPricePer1m: cacheRead }),
      });
      setForm(emptyForm);
      pricesState.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const header = (
    <PageHeader
      title="Pricing"
      description="Per-1M token rates every cost figure in this console is priced against."
    />
  );

  if (isUnavailable(pricesState.error)) {
    return (
      <PageBody>
        {header}
        <Notice title="No pricing store">
          No pricing store is bound on this server (<code>pricingStore: false</code>), so cost stays
          unpriced everywhere. Configure a pricing store in <code>config/agent.ts</code> to enable
          this page.
        </Notice>
      </PageBody>
    );
  }

  return (
    <PageBody>
      {header}
      <ErrorBoundary label="Prices">
        <Panel title="Current rates" description="per-1M token rates" flush>
          <QueryBoundary
            query={asQuery(pricesState)}
            label="Prices"
            skeleton={<TableSkeleton columns={priceColumns} rows={4} />}
            isEmpty={(rows) => rows.length === 0}
            empty={
              <EmptyState
                icon={<TagIcon />}
                title="No model prices set yet."
                description="Set one below; usage recorded before it stays unpriced."
              />
            }
          >
            {(rows) => (
              <DataTable
                label="model prices"
                columns={priceColumns}
                rows={rows}
                rowKey={(p) => p.modelId}
              />
            )}
          </QueryBoundary>
        </Panel>
      </ErrorBoundary>
      <ErrorBoundary label="Set a price">
        <Panel title="Set a price" description="upserts — retires the model's prior rate">
          <PriceFormView
            form={form}
            onChange={(field, value) => setForm((f) => ({ ...f, [field]: value }))}
            onSubmit={(e) => void submit(e)}
            saving={saving}
            error={saveError}
          />
        </Panel>
      </ErrorBoundary>
    </PageBody>
  );
}
