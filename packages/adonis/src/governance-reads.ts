/**
 * The governance console's list and detail reads, as the `/agent/governance/*` routes and the
 * `agent:*` ace commands both serve them: the same read-model call, the same `filter`/sort/paging
 * rules (`@adonis-agora/filter` wire, refused with `InvalidColumnFilterError`) and the same actor
 * labels. `qs` is the decoded query string — the CLI builds the same object from its flags.
 *
 * Server-only: the provider and the commands import it, the browser entry points never do.
 */
import { withActorLabel, withActorLabels } from './actor-labels.js';
import {
  ApprovalsFilter,
  applyListFilter,
  assertFixedSort,
  cursorPage,
  type ListQuery,
  type ListSizes,
  NoFieldsFilter,
  parseForwardParams,
  parseListWindow,
  RunsFilter,
  windowFetchSize,
  windowPage,
} from './list-api.js';
import type { ActorDirectory } from './spi/actor-directory.js';
import type { AgentGovernanceQueries } from './spi/governance-queries.js';

/** Page sizes of the governance lists. */
export const GOVERNANCE_LIST_SIZES: ListSizes = { defaultSize: 50, maxSize: 200 };

type Directory = ActorDirectory | null | undefined;

/** Check a list request that takes no filter and has one order; throws on anything else. */
export async function plainList(qs: ListQuery, order: string): Promise<void> {
  await applyListFilter({}, NoFieldsFilter, qs);
  assertFixedSort(qs.sort, order);
}

/**
 * Runs, newest first: `filter[actor|agent|status]`, `filter[startedAt][gte|lte|between]` (UTC
 * days); sort fixed to `-startedAt`; forward cursor paging (`after` + `first`).
 */
export async function governanceRunsPage(
  gov: AgentGovernanceQueries,
  directory: Directory,
  qs: ListQuery,
) {
  const filter = await applyListFilter({}, RunsFilter, qs);
  assertFixedSort(qs.sort, '-startedAt');
  const { after, size } = parseForwardParams(qs, GOVERNANCE_LIST_SIZES);
  const page = await gov.listRuns({
    ...filter,
    first: size,
    ...(after !== undefined ? { after } : {}),
  });
  return cursorPage({ ...page, items: await withActorLabels(page.items, directory) });
}

/** One run's full trace (run + messages + tool calls + approvals + usage), or `null`. */
export async function governanceRunDetail(
  gov: AgentGovernanceQueries,
  directory: Directory,
  runId: string,
) {
  const detail = await gov.runDetail(runId);
  if (detail === null) return null;
  return { ...detail, run: (await withActorLabel(detail.run, directory)) ?? detail.run };
}

/** The cross-actor HITL inbox, oldest first: `filter[actor]`; sort fixed to `requestedAt`. */
export async function governancePendingApprovalsPage(
  gov: AgentGovernanceQueries,
  directory: Directory,
  qs: ListQuery,
) {
  const filter = await applyListFilter({}, ApprovalsFilter, qs);
  assertFixedSort(qs.sort, 'requestedAt');
  const window = parseListWindow(qs, GOVERNANCE_LIST_SIZES);
  const rows = await gov.pendingApprovals({ ...filter, limit: windowFetchSize(window) });
  const page = windowPage(rows, window);
  return { ...page, data: await withActorLabels(page.data, directory) };
}

/** The recent tool-call activity feed, newest first; no filter; sort fixed to `-createdAt`. */
export async function governanceToolCallsPage(gov: AgentGovernanceQueries, qs: ListQuery) {
  await plainList(qs, '-createdAt');
  const window = parseListWindow(qs, GOVERNANCE_LIST_SIZES);
  return windowPage(await gov.recentToolCalls(windowFetchSize(window)), window);
}

/** The recent thread activity feed, newest first; no filter; sort fixed to `-lastActivityAt`. */
export async function governanceThreadsPage(
  gov: AgentGovernanceQueries,
  directory: Directory,
  qs: ListQuery,
) {
  await plainList(qs, '-lastActivityAt');
  const window = parseListWindow(qs, GOVERNANCE_LIST_SIZES);
  const page = windowPage(await gov.recentThreads(windowFetchSize(window)), window);
  return { ...page, data: await withActorLabels(page.data, directory) };
}

/**
 * One thread's drill-down (metadata + lifetime usage + recent runs/messages), `null` when unknown,
 * `undefined` when the read-model does not support it (an optional SPI method → `501`).
 */
export async function governanceThreadDetail(
  gov: AgentGovernanceQueries,
  directory: Directory,
  threadId: string,
) {
  if (gov.threadDetail === undefined) return undefined;
  const detail = await withActorLabel(await gov.threadDetail(threadId), directory);
  if (detail === null) return null;
  return { ...detail, runs: await withActorLabels(detail.runs, directory) };
}
