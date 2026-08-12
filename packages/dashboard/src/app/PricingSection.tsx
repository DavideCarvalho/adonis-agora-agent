import { type FormEvent, useState } from 'react';
import { AgentApiError } from '../client/agent-client.js';
import { formatTimestamp, formatUsd } from '../client/format.js';
import { Empty, ErrorNote, Panel, SectionTitle, Skeleton } from './ui.js';
import { useAgentClient, usePricing } from './use-governance.js';

const emptyForm = {
  modelId: '',
  inputPricePer1m: '',
  outputPricePer1m: '',
  cacheWritePricePer1m: '',
  cacheReadPricePer1m: '',
};

/**
 * Model pricing from `GET /agent/governance/pricing`, plus an inline upsert form
 * (`POST /agent/governance/pricing`) — the same rates the loop's cost fold and every other governance
 * rollup price usage against. `501` means the app has no pricing store bound at all (`pricingStore:
 * false`); that is a distinct, expected state from a network/auth error, so it gets its own panel
 * rather than the generic error note.
 */
export function PricingSection() {
  const client = useAgentClient();
  const prices = usePricing();
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const unavailable = prices.error instanceof AgentApiError && prices.error.status === 501;

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
      prices.reload();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  if (unavailable) {
    return (
      <Panel>
        <SectionTitle title="Pricing" hint="per-1M token rates" />
        <div className="empty">
          No pricing store is bound on this server (<code>pricingStore: false</code>), so cost stays
          unpriced everywhere. Configure a pricing store in <code>config/agent.ts</code> to enable
          this panel.
        </div>
      </Panel>
    );
  }

  return (
    <div className="stack">
      <Panel>
        <SectionTitle title="Pricing" hint="per-1M token rates" />
        {prices.error ? (
          <ErrorNote error={prices.error} />
        ) : prices.loading && prices.data === null ? (
          <Skeleton rows={4} />
        ) : prices.data === null || prices.data.length === 0 ? (
          <Empty>No model prices set yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="num">Input / 1M</th>
                  <th className="num">Output / 1M</th>
                  <th className="num">Cache write / 1M</th>
                  <th className="num">Cache read / 1M</th>
                  <th className="num">Effective from</th>
                </tr>
              </thead>
              <tbody>
                {prices.data.map((price) => (
                  <tr key={price.modelId}>
                    <td className="mono">{price.modelId}</td>
                    <td className="num mono tnum">{formatUsd(price.inputPricePer1m)}</td>
                    <td className="num mono tnum">{formatUsd(price.outputPricePer1m)}</td>
                    <td className="num mono tnum muted">
                      {price.cacheWritePricePer1m === undefined
                        ? '—'
                        : formatUsd(price.cacheWritePricePer1m)}
                    </td>
                    <td className="num mono tnum muted">
                      {price.cacheReadPricePer1m === undefined
                        ? '—'
                        : formatUsd(price.cacheReadPricePer1m)}
                    </td>
                    <td className="num mono tnum muted">{formatTimestamp(price.effectiveFrom)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel>
        <SectionTitle title="Set a price" hint="upserts — retires the model's prior rate" />
        <form className="stack" onSubmit={submit}>
          <div className="controls">
            <input
              className="range-input"
              placeholder="model id (e.g. gpt-4o)"
              value={form.modelId}
              onChange={(e) => setForm((f) => ({ ...f, modelId: e.target.value }))}
            />
            <input
              className="range-input"
              type="number"
              step="any"
              placeholder="input $/1M"
              value={form.inputPricePer1m}
              onChange={(e) => setForm((f) => ({ ...f, inputPricePer1m: e.target.value }))}
            />
            <input
              className="range-input"
              type="number"
              step="any"
              placeholder="output $/1M"
              value={form.outputPricePer1m}
              onChange={(e) => setForm((f) => ({ ...f, outputPricePer1m: e.target.value }))}
            />
            <input
              className="range-input"
              type="number"
              step="any"
              placeholder="cache write $/1M (optional)"
              value={form.cacheWritePricePer1m}
              onChange={(e) => setForm((f) => ({ ...f, cacheWritePricePer1m: e.target.value }))}
            />
            <input
              className="range-input"
              type="number"
              step="any"
              placeholder="cache read $/1M (optional)"
              value={form.cacheReadPricePer1m}
              onChange={(e) => setForm((f) => ({ ...f, cacheReadPricePer1m: e.target.value }))}
            />
            <button type="submit" className="btn approve" disabled={saving}>
              {saving ? 'Saving…' : 'Save price'}
            </button>
          </div>
          {saveError && <div className="err">{saveError}</div>}
        </form>
      </Panel>
    </div>
  );
}
