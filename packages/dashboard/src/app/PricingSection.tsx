import { type FormEvent, useId, useMemo, useState } from 'react';
import { type ComboOption, ComboSelect } from '../agora-kit/blocks/combo-field';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import { isUnavailable } from '../client/agent-client.js';
import { defaultRange } from '../client/default-range.js';
import { formatTimestamp, formatUsd } from '../client/format.js';
import type { CurrentModelPrice } from '../client/types.js';
import { actionsBlockedFor, usePickedApp } from './AppPicker.js';
import { TagIcon } from './icons.js';
import { fieldClass, Notice, numClass, TableSkeleton } from './ui.js';
import { asQuery, useAgentClient, usePricing, useSpendByModel } from './use-governance.js';

const emptyForm = {
  /** The model picked in the combo; `modelText` is what its input shows (and what is saved). */
  modelId: '',
  modelText: '',
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

/**
 * The model id suggestions: every priced model, then the models with usage in the trailing 30 days
 * that have no price yet (hinted "unpriced": the ones whose cost the rollups can't count).
 */
export function priceModelOptions(
  prices: readonly CurrentModelPrice[],
  spend: readonly { modelId: string }[],
): ComboOption[] {
  const priced = new Set(prices.map((p) => p.modelId));
  const unpriced = [...new Set(spend.map((s) => s.modelId))].filter((id) => !priced.has(id));
  return [
    ...[...priced].map((value) => ({ value })),
    ...unpriced.map((value) => ({ value, hint: 'unpriced' })),
  ];
}

/** The "set a price" form (presentational: state and submit come in as props). */
export function PriceFormView({
  form,
  modelOptions = [],
  onChange,
  onSubmit,
  saving,
  error,
  blocked,
}: {
  form: PriceForm;
  /** Suggestions for the model id: priced models and models with recent usage. */
  modelOptions?: readonly ComboOption[];
  onChange: (field: keyof PriceForm, value: string) => void;
  onSubmit: (e: FormEvent) => void;
  saving: boolean;
  error: string | null;
  /** Why a price cannot be saved from here (a federated app that is read-only here), or undefined. */
  blocked?: string | undefined;
}) {
  const modelFieldId = useId();
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
        <div className="flex min-w-0 flex-col gap-1 sm:col-span-2 lg:col-span-1">
          <label
            htmlFor={modelFieldId}
            className="text-[10px] font-semibold uppercase tracking-[0.12em] text-faint"
          >
            Model
          </label>
          <ComboSelect
            id={modelFieldId}
            className="mono h-8 bg-panel-2 text-xs"
            placeholder="model id (e.g. gpt-4o)"
            options={modelOptions}
            creatable
            value={form.modelId === '' ? null : form.modelId}
            onValueChange={(next) => {
              onChange('modelId', next ?? '');
              onChange('modelText', next ?? '');
            }}
            onQueryChange={(text) => onChange('modelText', text)}
          />
        </div>
        {field('inputPricePer1m', 'input $/1M', 'Input', true)}
        {field('outputPricePer1m', 'output $/1M', 'Output', true)}
        {field('cacheWritePricePer1m', 'cache write $/1M (optional)', 'Cache write', true)}
        {field('cacheReadPricePer1m', 'cache read $/1M (optional)', 'Cache read', true)}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={saving || blocked !== undefined} title={blocked}>
          {saving ? 'Saving…' : 'Save price'}
        </Button>
        {blocked !== undefined ? (
          <span className="text-[11px] text-faint">{blocked}</span>
        ) : error ? (
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
  const [spendRange] = useState(() => defaultRange(new Date(), 30));
  const spendState = useSpendByModel(spendRange);
  const [form, setForm] = useState(emptyForm);
  // Bumped after a save: remounts the form so the model combo drops its typed text too.
  const [formKey, setFormKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const blocked = actionsBlockedFor(usePickedApp());

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (blocked !== undefined) return;
    // What the model input shows: a picked model, or text typed without picking it.
    const modelId = (form.modelText.trim() || form.modelId).trim();
    const inputRate = Number.parseFloat(form.inputPricePer1m);
    const outputRate = Number.parseFloat(form.outputPricePer1m);
    if (modelId === '' || Number.isNaN(inputRate) || Number.isNaN(outputRate)) {
      setSaveError('model id, input rate and output rate are required');
      return;
    }
    const cacheWrite = Number.parseFloat(form.cacheWritePricePer1m);
    const cacheRead = Number.parseFloat(form.cacheReadPricePer1m);
    setSaving(true);
    setSaveError(null);
    try {
      await client.upsertPrice({
        modelId,
        inputPricePer1m: inputRate,
        outputPricePer1m: outputRate,
        ...(Number.isNaN(cacheWrite) ? {} : { cacheWritePricePer1m: cacheWrite }),
        ...(Number.isNaN(cacheRead) ? {} : { cacheReadPricePer1m: cacheRead }),
      });
      setForm(emptyForm);
      setFormKey((k) => k + 1);
      pricesState.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const modelOptions = useMemo(
    () => priceModelOptions(pricesState.data ?? [], spendState.data ?? []),
    [pricesState.data, spendState.data],
  );

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
            key={formKey}
            form={form}
            modelOptions={modelOptions}
            onChange={(field, value) => setForm((f) => ({ ...f, [field]: value }))}
            onSubmit={(e) => void submit(e)}
            saving={saving}
            error={saveError}
            blocked={blocked}
          />
        </Panel>
      </ErrorBoundary>
    </PageBody>
  );
}
