import type { CompanyClient } from './company.js';
import { throwForResponse } from './company.js';
import { PoppyError } from './errors.js';
import { readJson } from './http.js';
import type { ExcludedTask, TaskAlternative, TaskReference } from './types.js';
import { requireSecureUrl } from './util.js';

/**
 * Drops what 9.2 says to ignore: references of a type this client doesn't know, and `openapi` or
 * `mcp` references to an API the Company doesn't list, so an alternative can't aim it elsewhere.
 */
function safeAlternative(
  company: CompanyClient,
  alternative: TaskAlternative | undefined,
): TaskAlternative | undefined {
  if (!alternative || typeof alternative !== 'object') return undefined;
  const listed = (type: string, url: unknown) =>
    (company.document.apis ?? []).some((a) => a?.type === type && a.url === url);
  const references = Array.isArray(alternative.references)
    ? alternative.references.filter((r: TaskReference) => {
        if (r?.type === 'web') return typeof r.url === 'string';
        return (r?.type === 'openapi' || r?.type === 'mcp') && listed(r.type, r.url);
      })
    : undefined;
  if (typeof alternative.instructions !== 'string' && !references?.length) return undefined;
  const { references: _raw, ...rest } = alternative;
  return { ...rest, ...(references ? { references } : {}) };
}

/** The public list of tasks the Company chose not to offer (9.1): a GET with no token. */
export async function excludedTasks(company: CompanyClient): Promise<ExcludedTask[]> {
  const url = company.document.excluded_tasks?.url;
  if (!url) return [];
  requireSecureUrl(url, 'excluded_tasks.url', company.security);
  const res = await company.http.request(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new PoppyError(`http_${res.status}`, `could not load ${url}`);
  const doc = await readJson<{ tasks?: unknown }>(res);
  if (!Array.isArray(doc?.tasks)) throw new PoppyError('invalid_response', 'tasks must be a list');
  return (doc.tasks as ExcludedTask[])
    .filter((t) => typeof t?.task === 'string')
    .map((t) => {
      const alternative = safeAlternative(company, t.alternative);
      const { alternative: _raw, ...rest } = t;
      return alternative ? { ...rest, alternative } : rest;
    });
}

/**
 * Reports a task that can't be done through this protocol (9.3). Answers the Company's alternative
 * when it has one (HTTP 200), or `null` (HTTP 202). No personal data or secrets in the report.
 */
export async function sendFeedback(
  company: CompanyClient,
  report: { task: string; description: string },
): Promise<TaskAlternative | null> {
  const endpoint = company.document.feedback?.endpoint;
  if (!endpoint) throw new PoppyError('no_feedback_endpoint', 'Company lists no feedback endpoint');
  requireSecureUrl(endpoint, 'feedback.endpoint', company.security);
  const res = await company.fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ task: report.task, description: report.description }),
    signedOut: true,
  });
  if (res.status === 202) return null;
  if (!res.ok) await throwForResponse(res);
  return safeAlternative(company, await readJson<TaskAlternative>(res)) ?? null;
}
