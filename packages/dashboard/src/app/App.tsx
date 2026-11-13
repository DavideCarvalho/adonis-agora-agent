import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBoundary } from '../agora-kit/blocks/error-boundary';
import { useIsMobile } from '../agora-kit/hooks/use-mobile';
import { ActivityIcon, GridIcon } from '../agora-kit/icons';
import { AppShell, type NavSection } from '../agora-kit/shell/app-shell';
import { readShellConfig } from '../agora-kit/shell-config';
import { CONFIG_ELEMENT_ID } from '../client/api-base.js';
import { defaultRange, isIsoDay, normalizeRange } from '../client/default-range.js';
import type { GovernanceRange } from '../client/types.js';
import { ApprovalsSection } from './ApprovalsSection.js';
import { GenuiSection } from './GenuiSection.js';
import {
  AgentMark,
  ApprovalIcon,
  CalendarIcon,
  GaugeIcon,
  ShieldPulseIcon,
  SparklesIcon,
  TagIcon,
  ThreadIcon,
  ToolboxIcon,
  WrenchIcon,
} from './icons.js';
import { OrgNotice, OrgPicker } from './OrgPicker.js';
import { Overview } from './Overview.js';
import { PricingSection } from './PricingSection.js';
import { QuotaSection } from './QuotaSection.js';
import { ReliabilitySection } from './ReliabilitySection.js';
import { RunsSection } from './RunsSection.js';
import { ThreadsSection } from './ThreadsSection.js';
import { ToolCallsSection } from './ToolCallsSection.js';
import { ToolsSection } from './ToolsSection.js';
import { fieldClass } from './ui.js';

/** The agent console's accent (rose), passed to the kit's ThemeProvider in `main.tsx`. */
export const AGENT_ACCENT = '#fb7185';

export type SectionKey =
  | 'overview'
  | 'reliability'
  | 'runs'
  | 'threads'
  | 'tools'
  | 'genui'
  | 'approvals'
  | 'quota'
  | 'toolstats'
  | 'pricing';

/** Every page: its sidebar label and glyph. The keys are the URL hash (`#runs`, `#runs/<id>`). */
const PAGES: Record<SectionKey, { label: string; icon: ReactNode }> = {
  overview: { label: 'Overview', icon: <GridIcon /> },
  reliability: { label: 'Reliability', icon: <ShieldPulseIcon /> },
  runs: { label: 'Runs', icon: <ActivityIcon /> },
  threads: { label: 'Threads', icon: <ThreadIcon /> },
  tools: { label: 'Tool calls', icon: <WrenchIcon /> },
  genui: { label: 'Generative UI', icon: <SparklesIcon /> },
  approvals: { label: 'Approvals', icon: <ApprovalIcon /> },
  quota: { label: 'Quota', icon: <GaugeIcon /> },
  toolstats: { label: 'Tools', icon: <ToolboxIcon /> },
  pricing: { label: 'Pricing', icon: <TagIcon /> },
};

/** The sidebar: MONITOR · ACTIVITY · GOVERNANCE · CONFIG (CONSOLE-SHELL-SPEC). */
const SECTIONS: { section: string; keys: SectionKey[] }[] = [
  { section: 'Monitor', keys: ['overview', 'reliability'] },
  { section: 'Activity', keys: ['runs', 'threads', 'tools', 'genui'] },
  { section: 'Governance', keys: ['approvals', 'quota'] },
  { section: 'Config', keys: ['toolstats', 'pricing'] },
];

/** The pages whose queries the fromDay/toDay range scopes (the only ones that show the picker). */
const RANGED: ReadonlySet<SectionKey> = new Set<SectionKey>(['overview', 'genui']);

export function sectionFromHash(hash: string): SectionKey {
  const key = hash.replace(/^#\/?/, '').split('/')[0] as SectionKey;
  return Object.hasOwn(PAGES, key) ? key : 'overview';
}

/** The record a deep link opens: `#runs/<id>` or `#threads/<id>` (what global search links to). */
export function detailFromHash(hash: string): string | null {
  const [, ...rest] = hash.replace(/^#\/?/, '').split('/');
  if (rest.length === 0) return null;
  try {
    const id = decodeURIComponent(rest.join('/'));
    return id === '' ? null : id;
  } catch {
    return null;
  }
}

/** The topbar's day range (Overview and Generative UI only). */
function RangePicker({
  range,
  onChange,
}: {
  range: GovernanceRange;
  onChange: (field: 'fromDay' | 'toDay', value: string) => void;
}) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <CalendarIcon className="shrink-0 text-faint" />
      <input
        className={`${fieldClass} mono w-[8.5rem] min-w-0 flex-1 tnum md:flex-none`}
        type="date"
        aria-label="from day"
        value={range.fromDay}
        onChange={(e) => onChange('fromDay', e.target.value)}
      />
      <span className="text-faint" aria-hidden>
        →
      </span>
      <input
        className={`${fieldClass} mono w-[8.5rem] min-w-0 flex-1 tnum md:flex-none`}
        type="date"
        aria-label="to day"
        value={range.toDay}
        onChange={(e) => onChange('toDay', e.target.value)}
      />
    </div>
  );
}

/**
 * The agent governance console: the Agora shell (kit) around ten pages in four sidebar sections,
 * with the organization picker and the day range in the topbar. Every page renders inside its own
 * error boundary; each page's data regions have theirs.
 */
export function App() {
  // What the provider put in the page: switcher, ⌘K search, viewer, sign-out (all optional).
  const shell = useMemo(() => readShellConfig(CONFIG_ELEMENT_ID), []);
  const [section, setSection] = useState<SectionKey>(() =>
    sectionFromHash(typeof window !== 'undefined' ? window.location.hash : ''),
  );
  const [detail, setDetail] = useState<string | null>(() =>
    detailFromHash(typeof window !== 'undefined' ? window.location.hash : ''),
  );
  const [range, setRange] = useState<GovernanceRange>(() => defaultRange());
  // Bumped when the organization changes, so every page reads again under the new `?tenant=`.
  const [tenantKey, setTenantKey] = useState(0);

  useEffect(() => {
    const onHash = () => {
      setSection(sectionFromHash(window.location.hash));
      setDetail(detailFromHash(window.location.hash));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const go = useCallback((key: SectionKey) => {
    setSection(key);
    setDetail(null);
    if (typeof window !== 'undefined' && window.location.hash !== `#${key}`) {
      window.history.pushState(null, '', `#${key}`);
    }
  }, []);

  const setDay = (field: 'fromDay' | 'toDay', value: string) => {
    if (!isIsoDay(value)) return;
    setRange((prev) => normalizeRange({ ...prev, [field]: value }));
  };

  // Topbar pickers. On a phone the topbar only has room for the title, so they move to a toolbar
  // row at the top of the page instead (one instance either way).
  const isMobile = useIsMobile();
  const pickers = (
    <>
      <OrgPicker onChange={() => setTenantKey((key) => key + 1)} />
      {RANGED.has(section) && <RangePicker range={range} onChange={setDay} />}
    </>
  );

  const nav = useMemo<NavSection[]>(
    () =>
      SECTIONS.map(({ section: label, keys }) => ({
        section: label,
        items: keys.map((key) => ({
          id: key,
          label: PAGES[key].label,
          icon: PAGES[key].icon,
          href: `#${key}`,
          onSelect: () => go(key),
        })),
      })),
    [go],
  );

  return (
    <AppShell
      brand={{
        name: 'agent',
        subtitle: 'governance',
        mark: <AgentMark />,
        current: { title: 'Agents', package: '@adonis-agora/agent', icon: 'agent' },
      }}
      nav={nav}
      activeId={section}
      shell={shell}
      title={PAGES[section].label}
      searchPlaceholder="Search runs, threads and every console you can open…"
      actions={isMobile ? undefined : pickers}
    >
      {isMobile && (
        <div
          role="toolbar"
          aria-label="page filters"
          className="flex flex-col gap-2 border-b border-border px-4 py-3 empty:hidden [&>*]:w-full"
        >
          {pickers}
        </div>
      )}
      <ErrorBoundary label={PAGES[section].label} resetKeys={[section, detail, tenantKey]}>
        <div key={tenantKey}>
          <OrgNotice />
          {section === 'overview' && <Overview range={range} />}
          {section === 'reliability' && <ReliabilitySection />}
          {section === 'runs' && <RunsSection key={detail ?? ''} initialRunId={detail} />}
          {section === 'threads' && <ThreadsSection key={detail ?? ''} initialThreadId={detail} />}
          {section === 'tools' && <ToolCallsSection />}
          {section === 'genui' && <GenuiSection range={range} />}
          {section === 'approvals' && <ApprovalsSection />}
          {section === 'quota' && <QuotaSection />}
          {section === 'toolstats' && <ToolsSection />}
          {section === 'pricing' && <PricingSection />}
        </div>
      </ErrorBoundary>
    </AppShell>
  );
}
