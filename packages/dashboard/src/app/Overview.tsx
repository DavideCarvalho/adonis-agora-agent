import { useState } from 'react';
import { formatCount, formatModelLabel, formatUsd } from '../client/format.js';
import {
  donutSegments,
  summarizeActors,
  summarizeSpend,
  withShares,
} from '../client/spend-summary.js';
import type { TrendMetric } from '../client/trend-path.js';
import type { GovernanceRange } from '../client/types.js';
import { Donut } from './Donut.js';
import { TrendChart } from './TrendChart.js';
import { AsyncBlock, colorAt, Panel, SectionTitle, ShareBar, Stat } from './ui.js';
import { useSpendByActor, useSpendByModel, useUsageTrend } from './use-governance.js';

/**
 * The console's landing view: headline spend/usage stats, a spend-by-model donut + table, the daily
 * usage/cost trend, and a spend-by-actor breakdown. Every number comes from the agent's own
 * `/agent/governance/*` rollups for the selected range.
 */
export function Overview({ range }: { range: GovernanceRange }) {
  const models = useSpendByModel(range);
  const actors = useSpendByActor(range);
  const trend = useUsageTrend(range);
  const [metric, setMetric] = useState<TrendMetric>('costUsd');

  const totals = models.data ? summarizeSpend(models.data) : null;
  const shares = models.data ? withShares(models.data) : [];
  const segments = donutSegments(shares);

  return (
    <div className="stack">
      {/* headline stats */}
      <div className="grid stat-4">
        <Stat
          label="Total spend"
          value={totals ? formatUsd(totals.costUsd) : '—'}
          sub="over range"
        />
        <Stat
          label="Tokens"
          value={totals ? formatCount(totals.totalTokens) : '—'}
          sub={
            totals
              ? `${formatCount(totals.inputTokens)} in · ${formatCount(totals.outputTokens)} out`
              : undefined
          }
        />
        <Stat
          label="Requests"
          value={totals ? formatCount(totals.requests) : '—'}
          sub="model calls"
        />
        <Stat label="Models" value={models.data ? String(models.data.length) : '—'} sub="in use" />
      </div>

      {/* spend by model */}
      <Panel>
        <SectionTitle title="Spend by model" hint="priced against the current model rates" />
        <AsyncBlock
          state={models}
          isEmpty={(rows) => rows.length === 0}
          empty="No usage recorded in this range."
        >
          {(rows) => (
            <div className="grid cols-2" style={{ alignItems: 'center' }}>
              <div style={{ display: 'grid', placeItems: 'center', gap: 14 }}>
                <Donut
                  segments={segments}
                  centerLabel={totals ? formatUsd(totals.costUsd) : undefined}
                  centerSub="total"
                />
                <div className="legend" style={{ width: '100%' }}>
                  {shares.slice(0, 6).map((row, i) => (
                    <div className="row" key={row.modelId}>
                      <span className="swatch" style={{ background: colorAt(i) }} />
                      <span className="name" title={row.modelId}>
                        {formatModelLabel(row.modelId)}
                      </span>
                      <span className="mono tnum muted">{formatUsd(row.costUsd)}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th className="num">Requests</th>
                      <th className="num">Tokens</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.modelId}>
                        <td title={row.modelId}>{formatModelLabel(row.modelId)}</td>
                        <td className="num mono tnum">{formatCount(row.requests)}</td>
                        <td className="num mono tnum">
                          {formatCount(row.inputTokens + row.outputTokens)}
                        </td>
                        <td className="num mono tnum">{formatUsd(row.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </AsyncBlock>
      </Panel>

      {/* usage trend */}
      <Panel>
        <SectionTitle
          title="Usage trend"
          hint={
            <span className="controls" role="tablist">
              <button
                type="button"
                role="tab"
                className="tab"
                aria-selected={metric === 'costUsd'}
                onClick={() => setMetric('costUsd')}
              >
                Cost
              </button>
              <button
                type="button"
                role="tab"
                className="tab"
                aria-selected={metric === 'totalTokens'}
                onClick={() => setMetric('totalTokens')}
              >
                Tokens
              </button>
            </span>
          }
        />
        <AsyncBlock
          state={trend}
          isEmpty={(points) => points.length === 0}
          empty="No trend data in this range."
        >
          {(points) => <TrendChart points={points} metric={metric} />}
        </AsyncBlock>
      </Panel>

      {/* spend by actor */}
      <Panel>
        <SectionTitle title="Spend by actor" hint="who is driving cost" />
        <AsyncBlock
          state={actors}
          isEmpty={(rows) => rows.length === 0}
          empty="No actor activity in this range."
        >
          {(rows) => {
            const actorTotals = summarizeActors(rows);
            const maxCost = Math.max(...rows.map((r) => r.costUsd), 0);
            return (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Actor</th>
                      <th className="num">Requests</th>
                      <th className="num">Tokens</th>
                      <th className="num">Cost</th>
                      <th style={{ width: 160 }}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.actorRef}>
                        <td className="mono" title={row.actorRef}>
                          {row.actorRef}
                        </td>
                        <td className="num mono tnum">{formatCount(row.requests)}</td>
                        <td className="num mono tnum">{formatCount(row.totalTokens)}</td>
                        <td className="num mono tnum">{formatUsd(row.costUsd)}</td>
                        <td>
                          <ShareBar fraction={maxCost > 0 ? row.costUsd / maxCost : 0} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className="muted">Total</td>
                      <td className="num mono tnum muted">{formatCount(actorTotals.requests)}</td>
                      <td className="num mono tnum muted">
                        {formatCount(actorTotals.totalTokens)}
                      </td>
                      <td className="num mono tnum muted">{formatUsd(actorTotals.costUsd)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            );
          }}
        </AsyncBlock>
      </Panel>
    </div>
  );
}
