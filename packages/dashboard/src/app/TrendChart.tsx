import { useCallback, useMemo } from 'react';
import { TimeSeriesChart } from '../agora-kit/charts/time-series-chart';
import { formatCount, formatUsd } from '../client/format.js';
import type { TrendMetric } from '../client/trend-path.js';
import type { UsageTrendPoint } from '../client/types.js';

const day = (point: UsageTrendPoint) => point.day;

/**
 * The daily usage trend (cost or tokens) as the kit's area chart. Hovering or focusing a day shows
 * its value in the kit tooltip, formatted as USD or a token count.
 */
export function TrendChart({ points, metric }: { points: UsageTrendPoint[]; metric: TrendMetric }) {
  const cost = metric === 'costUsd';
  const series = useMemo(
    () => [
      {
        key: metric,
        label: cost ? 'cost' : 'tokens',
        value: (point: UsageTrendPoint) => point[metric],
      },
    ],
    [metric, cost],
  );
  const formatValue = useCallback((n: number) => (cost ? formatUsd(n) : formatCount(n)), [cost]);

  return (
    <TimeSeriesChart
      data={points}
      x={day}
      series={series}
      formatValue={formatValue}
      integer={!cost}
      ariaLabel={`daily ${cost ? 'cost' : 'token'} trend`}
      height={200}
    />
  );
}
