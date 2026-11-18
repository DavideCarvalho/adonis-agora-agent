import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { ComboSelect } from '../agora-kit/blocks/combo-field';
import { type ConsoleAppsView, pageApp } from '../client/agent-client.js';
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

/** The combo's value for "this app" (no `?app=`); app ids are config keys, never this. */
export const LOCAL_APP = '\u0000local';

/** The topbar pickers' look: the field height and surface of the other header controls. */
export const pickerClass = 'h-8 min-w-0 flex-1 bg-panel-2 text-xs md:w-48 md:flex-none';

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
  const client = useAgentClient();
  const urlApp = usePageApp();
  const [answer, setAnswer] = useState<{ view: ConsoleAppsView | null; for: string | null }>();
  const id = useId();

  useEffect(() => {
    let live = true;
    client
      .apps()
      .then((result) => {
        if (live) setAnswer({ view: result, for: urlApp });
      })
      .catch(() => {
        // An older server has no `/governance/apps`: nothing to pick.
        if (live) setAnswer({ view: null, for: urlApp });
      });
    return () => {
      live = false;
    };
  }, [client, urlApp]);

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

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <label className="text-[11px] text-faint" htmlFor={id}>
        App
      </label>
      <ComboSelect
        id={id}
        className={pickerClass}
        options={[
          { value: LOCAL_APP, label: view.local.label },
          ...view.apps.map((app) => ({ value: app.id, label: app.label })),
        ]}
        clearable={false}
        value={current ?? LOCAL_APP}
        onValueChange={(next) => {
          if (next === null) return;
          const app = next === LOCAL_APP ? null : next;
          // The URL already says so: no history entry for a no-op pick.
          if (app === urlApp) return;
          picking.current = true;
          setPageApp(app);
          // A pushState fires nothing: say the URL moved (the picker and the pages follow it).
          window.dispatchEvent(new PopStateEvent('popstate', { state: window.history.state }));
        }}
      />
    </span>
  );
}
