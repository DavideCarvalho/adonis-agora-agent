import { useEffect, useState } from 'react';
import { defaultRange, isIsoDay, normalizeRange } from '../client/default-range.js';
import type { GovernanceRange } from '../client/types.js';
import { ApprovalsSection } from './ApprovalsSection.js';
import { Overview } from './Overview.js';
import { PricingSection } from './PricingSection.js';
import { QuotaSection } from './QuotaSection.js';
import { ReliabilitySection } from './ReliabilitySection.js';
import { RunsSection } from './RunsSection.js';
import { ThreadsSection } from './ThreadsSection.js';
import { ToolCallsSection } from './ToolCallsSection.js';
import { ToolsSection } from './ToolsSection.js';

type SectionKey =
  | 'overview'
  | 'runs'
  | 'threads'
  | 'tools'
  | 'approvals'
  | 'toolstats'
  | 'reliability'
  | 'quota'
  | 'pricing';

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'runs', label: 'Runs' },
  { key: 'threads', label: 'Threads' },
  { key: 'tools', label: 'Tool calls' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'toolstats', label: 'Tools' },
  { key: 'reliability', label: 'Reliability' },
  { key: 'quota', label: 'Quota' },
  { key: 'pricing', label: 'Pricing' },
];

function sectionFromHash(hash: string): SectionKey {
  const key = hash.replace(/^#/, '') as SectionKey;
  return SECTIONS.some((s) => s.key === key) ? key : 'overview';
}

/** The console shell: brand, section tabs, range picker, theme toggle, and the active section. */
export function App() {
  const [section, setSection] = useState<SectionKey>(() =>
    sectionFromHash(typeof window !== 'undefined' ? window.location.hash : ''),
  );
  const [range, setRange] = useState<GovernanceRange>(() => defaultRange());
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);

  useEffect(() => {
    const onHash = () => setSection(sectionFromHash(window.location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme) root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
  }, [theme]);

  const go = (key: SectionKey) => {
    setSection(key);
    if (typeof window !== 'undefined') window.location.hash = key;
  };

  const setDay = (field: 'fromDay' | 'toDay', value: string) => {
    if (!isIsoDay(value)) return;
    setRange((prev) => normalizeRange({ ...prev, [field]: value }));
  };

  return (
    <>
      <div className="app-bg" />
      <div className="shell">
        <header className="masthead">
          <div className="brand">
            <div className="brand-mark mono">A</div>
            <div>
              <h1>Agent · governance console</h1>
              <p>@adonis-agora/agent — spend, usage &amp; activity</p>
            </div>
          </div>
          <div className="controls">
            {section === 'overview' && (
              <>
                <input
                  className="range-input"
                  type="date"
                  aria-label="from day"
                  value={range.fromDay}
                  onChange={(e) => setDay('fromDay', e.target.value)}
                />
                <span className="muted">→</span>
                <input
                  className="range-input"
                  type="date"
                  aria-label="to day"
                  value={range.toDay}
                  onChange={(e) => setDay('toDay', e.target.value)}
                />
              </>
            )}
            <button
              type="button"
              className="icon-btn"
              aria-label="toggle theme"
              title="Toggle light / dark"
              onClick={() => setTheme((t) => (t === 'light' ? 'dark' : 'light'))}
            >
              {theme === 'light' ? '☾' : '☀'}
            </button>
          </div>
        </header>

        <nav className="tabs" aria-label="sections">
          {SECTIONS.map((s) => (
            <button
              key={s.key}
              type="button"
              className="tab"
              aria-selected={section === s.key}
              onClick={() => go(s.key)}
            >
              {s.label}
            </button>
          ))}
        </nav>

        <main>
          {section === 'overview' && <Overview range={range} />}
          {section === 'runs' && <RunsSection />}
          {section === 'threads' && <ThreadsSection />}
          {section === 'tools' && <ToolCallsSection />}
          {section === 'approvals' && <ApprovalsSection />}
          {section === 'toolstats' && <ToolsSection />}
          {section === 'reliability' && <ReliabilitySection />}
          {section === 'quota' && <QuotaSection />}
          {section === 'pricing' && <PricingSection />}
        </main>

        <div className="foot">
          {/* The fromDay/toDay range only scopes Overview's queries (every other section reads its
              own unbounded or section-scoped feed) — showing it here on every tab would claim a
              filter that is not actually in effect, so it only appears while Overview is active. */}
          Read-only governance data
          {section === 'overview' && (
            <>
              {' '}
              · {range.fromDay} → {range.toDay}
            </>
          )}
        </div>
      </div>
    </>
  );
}
