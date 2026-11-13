import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { MetricCard, MetricGrid, MetricGridSkeleton } from '../agora-kit/blocks/metric-card';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { PageBody } from '../agora-kit/shell/app-shell';
import { formatCount } from '../client/format.js';
import { asQuery, useQuotaToday } from './use-governance.js';

/**
 * The caller's own token spend so far today, from the day window of `GET /agent/quota`. The ONE
 * per-actor (not cross-actor) page: it answers "how much of my budget have I used today" for whoever
 * the actor resolver identifies on this request.
 */
export function QuotaSection() {
  const quota = asQuery(useQuotaToday());
  return (
    <PageBody>
      <PageHeader title="Quota" description="Your own usage today (per actor, not cross-actor)." />
      <ErrorBoundary label="Quota">
        <QueryBoundary query={quota} label="Quota" skeleton={<MetricGridSkeleton count={1} />}>
          {(data) => (
            <MetricGrid className="md:grid-cols-3">
              <MetricCard
                label="Tokens used today"
                value={formatCount(data.usedTokens)}
                caption="UTC day, resets at 00:00"
                tone="brand"
              />
            </MetricGrid>
          )}
        </QueryBoundary>
      </ErrorBoundary>
    </PageBody>
  );
}
