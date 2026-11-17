import { useEffect, useId, useState } from 'react';
import { type ConsoleAppsView, pageApp } from '../client/agent-client.js';
import { fieldClass } from './ui.js';
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

/**
 * The "App" header control (the federated console): whose agents the console shows — this app, or
 * one of the other apps in `dashboard.apps`. Nothing when the console shows only this app.
 */
export function AppPicker({ onChange }: { onChange: (app: string | null) => void }) {
  const client = useAgentClient();
  const [view, setView] = useState<ConsoleAppsView | null>(null);
  const [current, setCurrent] = useState(pageApp);
  const id = useId();

  useEffect(() => {
    let live = true;
    client
      .apps()
      .then((result) => {
        if (live) setView(result);
      })
      .catch(() => {
        // An older server has no `/governance/apps`: nothing to pick.
        if (live) setView(null);
      });
    return () => {
      live = false;
    };
  }, [client]);

  if (view === null || !Array.isArray(view.apps) || view.apps.length === 0) return null;

  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <label className="text-[11px] text-faint" htmlFor={id}>
        App
      </label>
      <select
        id={id}
        className={`${fieldClass} min-w-0 flex-1 md:max-w-[12rem] md:flex-none`}
        value={current ?? ''}
        onChange={(event) => {
          const next = event.target.value === '' ? null : event.target.value;
          setPageApp(next);
          setCurrent(next);
          onChange(next);
        }}
      >
        <option value="">{view.local.label}</option>
        {view.apps.map((app) => (
          <option key={app.id} value={app.id}>
            {app.label}
          </option>
        ))}
      </select>
    </span>
  );
}
