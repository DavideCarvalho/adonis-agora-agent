import { formatCount } from '../client/format.js';
import { AsyncBlock, Panel, SectionTitle, Stat } from './ui.js';
import { useQuotaToday } from './use-governance.js';

/**
 * The caller's own token spend so far today, from the day window of `GET /agent/quota`. This is the ONE per-actor
 * (not cross-actor) surface — it reports the spend of whoever the actor resolver identifies for the
 * request, so it answers "how much of my budget have I used today".
 */
export function QuotaSection() {
  const quota = useQuotaToday();
  return (
    <Panel>
      <SectionTitle title="Quota — today" hint="your own usage (per actor)" />
      <AsyncBlock state={quota} empty="No quota data." skeletonRows={2}>
        {(data) => (
          <div className="grid stat-4">
            <Stat
              label="Tokens used today"
              value={formatCount(data.usedTokens)}
              sub="UTC day, resets at 00:00"
            />
          </div>
        )}
      </AsyncBlock>
    </Panel>
  );
}
