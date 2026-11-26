import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  AppModeBadge,
  actionsUnavailableReason,
  FederatedNotice,
} from '../agora-kit/blocks/app-mode';
import { ScopeMenu, type ScopeOption } from '../agora-kit/blocks/scope-menu';
import {
  type AgentClient,
  type ConsoleAppEntry,
  type ConsoleAppsView,
  pageApp,
} from '../client/agent-client.js';
import { useAgentClient } from './use-governance.js';

/**
 * Put `app` in the page URL (`?app=`, absent = this app). The organization picked belongs to the
 * app being left, so `?tenant=` goes too.
 */
export function setPageApp(app: string | null): void {
  const url = new URL(window.location.href);
  if (app === null) url.searchParams.delete('app');
  else url.searchParams.set('app', app);
  url.searchParams.delete('tenant');
  window.history.pushState(window.history.state, '', url.toString());
}

/** `?app=` as the page URL has it now, following the picker and back/forward (`popstate`). */
export function usePageApp(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      window.addEventListener('popstate', onChange);
      return () => window.removeEventListener('popstate', onChange);
    },
    pageApp,
    () => null,
  );
}

/**
 * The menu's id for "this app" (no `?app=`); app ids are config keys, never this. A lone control
 * character, so a search never matches it by an id the viewer does not see.
 */
export const LOCAL_APP = '\u0000';

const TEXT = {
  noun: 'App',
  all: 'All apps',
  some: 'Pick an app',
  search: 'Search apps',
  empty: 'No apps.',
};

/**
 * The "App" header control (the federated console): whose agents the console shows — this app, or
 * one of the other apps in `dashboard.apps`. Nothing when the console shows only this app.
 *
 * It shows the app the server serves for the URL (`selected`: an unknown or ungranted `?app=` is
 * none of the listed apps), and follows back/forward; the URL's own value is shown only until the
 * server has answered for it. `onChange` runs whenever the URL's app moves: `picked` from the
 * control, or not (back/forward).
 */
export function AppPicker({
  onChange,
}: {
  onChange: (app: string | null, how: { picked: boolean }) => void;
}) {
  const urlApp = usePageApp();
  const answer = useAppsAnswer(urlApp);

  // The URL's app moved (a pick, or back/forward): the pages read again for it.
  const changed = useRef(onChange);
  changed.current = onChange;
  const seen = useRef(urlApp);
  const picking = useRef(false);
  useEffect(() => {
    if (seen.current === urlApp) return;
    seen.current = urlApp;
    const picked = picking.current;
    picking.current = false;
    changed.current(urlApp, { picked });
  }, [urlApp]);

  const view = answer?.view ?? null;
  if (view === null || !Array.isArray(view.apps) || view.apps.length === 0) return null;
  const current = answer?.for === urlApp ? (view.selected ?? null) : urlApp;
  const shown = view.apps.find((app) => app.id === current);

  const items: ScopeOption[] = [
    // This app is a normal option under its own label, "this app" beside it (its id is internal).
    { id: LOCAL_APP, label: view.local.label, hint: 'this app' },
    ...view.apps.map((app) => ({
      id: app.id,
      label: app.label,
      ...(app.mode === 'federated' ? { hint: 'federated' } : {}),
    })),
  ];

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <ScopeMenu
        items={items}
        all={false}
        current={current ?? LOCAL_APP}
        text={TEXT}
        labelOf={(id) => items.find((item) => item.id === id)?.label ?? id}
        onChoose={(next) => {
          const app = next === undefined || next === LOCAL_APP ? null : next;
          // The URL already says so: no history entry for a no-op pick.
          if (app === urlApp) return;
          picking.current = true;
          setPageApp(app);
          // A pushState fires nothing: say the URL moved (the picker and the pages follow it).
          window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
        }}
      />
      {shown !== undefined && (
        <AppModeBadge mode={shown.mode} actions={shown.actions} appLabel={shown.label} />
      )}
    </span>
  );
}

/**
 * `/apps` as the server answers it for the page's `?app=`: one request per client and URL app,
 * shared by the picker, the notice and every page that asks who runs actions. A new `?app=` reads
 * again; a failed read (an older server has no `/apps`: nothing to pick) is `null` and is retried
 * by the next caller.
 */
const appsReads = new WeakMap<
  AgentClient,
  { for: string | null; answer: Promise<ConsoleAppsView | null> }
>();

export function readApps(
  client: AgentClient,
  urlApp: string | null,
): Promise<ConsoleAppsView | null> {
  const cached = appsReads.get(client);
  if (cached !== undefined && cached.for === urlApp) return cached.answer;
  const entry = {
    for: urlApp,
    answer: Promise.resolve()
      .then(() => client.apps())
      .catch(() => {
        if (appsReads.get(client) === entry) appsReads.delete(client);
        return null;
      }),
  };
  appsReads.set(client, entry);
  return entry.answer;
}

/** The shared `/apps` answer for `urlApp`, with the URL app it answered; undefined until then. */
function useAppsAnswer(
  urlApp: string | null,
): { view: ConsoleAppsView | null; for: string | null } | undefined {
  const client = useAgentClient();
  const [answer, setAnswer] = useState<{ view: ConsoleAppsView | null; for: string | null }>();
  useEffect(() => {
    let live = true;
    void readApps(client, urlApp).then((view) => {
      if (live) setAnswer({ view, for: urlApp });
    });
    return () => {
      live = false;
    };
  }, [client, urlApp]);
  return answer;
}

/**
 * The other app the page shows (`?app=`, as the server serves it), with its mode and who runs its
 * actions: `null` for this app (no `?app=`), an unknown `?app=` or an older server; `undefined`
 * while `/apps` has not answered for the URL's app yet. Follows the URL, not a remount.
 */
export function usePickedApp(): ConsoleAppEntry | null | undefined {
  const urlApp = usePageApp();
  const answer = useAppsAnswer(urlApp);
  if (urlApp === null) return null;
  if (answer === undefined || answer.for !== urlApp) return undefined;
  const view = answer.view;
  if (view === null || !Array.isArray(view.apps)) return null;
  return view.apps.find((entry) => entry.id === view.selected) ?? null;
}

/**
 * Why the viewer may not do what `capability` allows, or undefined when they may (or the server does
 * not say): the console's `authorize` narrowed them (`capabilities`, or `access: 'read'`). The
 * server refuses it too; this only keeps the button from offering it.
 */
export function useViewerLacks(capability: string): string | undefined {
  const answer = useAppsAnswer(usePageApp());
  const capabilities = answer?.view?.viewer?.capabilities;
  if (!Array.isArray(capabilities) || capabilities.includes(capability)) return undefined;
  return `Your access does not include this (${capability}).`;
}

/** Shown while the picked app's `/apps` answer is pending: actions wait until it is known. */
export const ACTIONS_PENDING = 'Checking who runs actions for this app…';

/**
 * Why the page's actions are off for the picked app, or undefined when they are on: pending until
 * `/apps` answers for a picked app, then `actionsUnavailableReason` (federated, read-only here).
 */
export function actionsBlockedFor(app: ConsoleAppEntry | null | undefined): string | undefined {
  if (app === undefined) return ACTIONS_PENDING;
  return app === null ? undefined : actionsUnavailableReason(app.label, app);
}

/** Top of the page body while a federated app is shown: where its data comes from, who acts. */
export function PickedAppNotice() {
  const app = usePickedApp();
  if (app == null || app.mode !== 'federated') return null;
  return (
    <div className="px-4 pt-5 md:px-6">
      <FederatedNotice appLabel={app.label} mode={app.mode} actions={app.actions} />
    </div>
  );
}
