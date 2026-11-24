import type { CompanyClient } from './company.js';
import { throwForResponse } from './company.js';
import { PoppyError } from './errors.js';
import { readJson } from './http.js';
import type {
  ExcludedTask,
  SkillEntry,
  TaskAlternative,
  TaskCoverage,
  TaskReference,
} from './types.js';
import { requireSecureUrl } from './util.js';

/** The Agent Skills discovery index schema this client knows (9.4). */
export const SKILL_INDEX_SCHEMA = 'https://schemas.agentskills.io/discovery/0.2.0/schema.json';
const SKILL_TYPES = ['skill-md', 'archive'];
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/;
const MAX_FEEDBACK_TASK = 200;
const MAX_FEEDBACK_DESCRIPTION = 2000;

const EMPTY: TaskCoverage = { excludedTasks: [], skills: [] };

/** One tasks response per Session (9): reused only in the Session that got it. */
const cached = new WeakMap<CompanyClient, { sid: string; until: number; value: TaskCoverage }>();

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** How long the response may be reused in its Session, from `Cache-Control` (9). */
function reuseMs(cacheControl: string | null): number {
  if (!cacheControl) return Number.POSITIVE_INFINITY;
  if (/no-store|no-cache/i.test(cacheControl)) return 0;
  const m = /max-age=(\d+)/i.exec(cacheControl);
  return m ? Number(m[1]) * 1000 : Number.POSITIVE_INFINITY;
}

/**
 * The skills of a `skill_index` (9.4): only with the schema this client knows, entries of a known
 * type with a valid digest, each `url` resolved against `tasks.endpoint` (RFC 3986 section 5).
 */
function skillsOf(index: unknown, base: string, company: CompanyClient): SkillEntry[] {
  if (!isObject(index) || index.$schema !== SKILL_INDEX_SCHEMA || !Array.isArray(index.skills)) {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const raw of index.skills) {
    if (!isObject(raw)) continue;
    const { name, description, type, url, digest } = raw;
    if (typeof name !== 'string' || typeof description !== 'string') continue;
    if (typeof type !== 'string' || !SKILL_TYPES.includes(type)) continue;
    if (typeof url !== 'string' || typeof digest !== 'string' || !DIGEST_RE.test(digest)) continue;
    let resolved: string;
    try {
      resolved = requireSecureUrl(
        new URL(url, base).toString(),
        'skill url',
        company.security,
      ).toString();
    } catch {
      continue;
    }
    out.push({ ...raw, name, description, type, url: resolved, digest } as SkillEntry);
  }
  return out;
}

/**
 * Drops what 9.2 says to ignore: references of a type this client doesn't know, and `openapi` or
 * `mcp` references to an API the Company doesn't list, so an alternative can't aim it elsewhere.
 */
export function safeAlternative(
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

/**
 * The tasks response for the current Session (section 9): `GET {tasks.endpoint}` with the Session
 * header and no access token, early in a Session. It's reused only in the Session that got it, as
 * its caching headers allow. Without a response, there are no excluded tasks, skills or feedback.
 */
export async function taskCoverage(
  company: CompanyClient,
  opts: { refresh?: boolean | undefined } = {},
): Promise<TaskCoverage> {
  const endpoint = company.document.tasks?.endpoint;
  if (!endpoint) return EMPTY;
  const sid = company.sessionId;
  const hit = cached.get(company);
  if (!opts.refresh && hit && hit.sid === sid && hit.until > Date.now()) return hit.value;
  requireSecureUrl(endpoint, 'tasks.endpoint', company.security);
  let res: Response;
  try {
    res = await company.fetch(endpoint, {
      headers: { accept: 'application/json' },
      signedOut: true,
    });
  } catch (e) {
    company.agent.log(`tasks.endpoint: ${(e as Error).message}`);
    return EMPTY;
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    company.agent.log(`tasks.endpoint: HTTP ${res.status}`);
    return EMPTY;
  }
  const doc = await readJson<Record<string, unknown>>(res);
  if (!isObject(doc)) return EMPTY;
  const excluded = Array.isArray(doc.excluded_tasks) ? (doc.excluded_tasks as ExcludedTask[]) : [];
  const value: TaskCoverage = {
    excludedTasks: excluded
      .filter((t) => typeof t?.task === 'string')
      .map((t) => {
        const alternative = safeAlternative(company, t.alternative);
        const { alternative: _raw, ...rest } = t;
        return alternative ? { ...rest, alternative } : rest;
      }),
    skills: skillsOf(doc.skill_index, endpoint, company),
  };
  const feedback = isObject(doc.feedback) ? doc.feedback.endpoint : undefined;
  if (typeof feedback === 'string') {
    try {
      value.feedbackEndpoint = requireSecureUrl(
        feedback,
        'feedback.endpoint',
        company.security,
      ).toString();
    } catch {}
  }
  // The Session may have changed while fetching (session_ended): keep it for the one that got it.
  cached.set(company, {
    sid: company.sessionId,
    until: Date.now() + reuseMs(res.headers.get('cache-control')),
    value,
  });
  return value;
}

/** The tasks the Company chose not to offer through this protocol (9.1), for this Session. */
export async function excludedTasks(company: CompanyClient): Promise<ExcludedTask[]> {
  return (await taskCoverage(company)).excludedTasks;
}

/**
 * Reports a task that can't be done through this protocol (9.3) to the `feedback.endpoint` of this
 * Session's tasks response. Answers the Company's alternative when it has one (HTTP 200), or `null`
 * (HTTP 202). No personal data or secrets in the report.
 */
export async function sendFeedback(
  company: CompanyClient,
  report: { task: string; description: string },
): Promise<TaskAlternative | null> {
  const endpoint = (await taskCoverage(company)).feedbackEndpoint;
  if (!endpoint) throw new PoppyError('no_feedback_endpoint', 'Company takes no feedback');
  if (
    report.task.length > MAX_FEEDBACK_TASK ||
    report.description.length > MAX_FEEDBACK_DESCRIPTION
  ) {
    throw new PoppyError('invalid_request', 'task is at most 200 characters, description 2,000');
  }
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
