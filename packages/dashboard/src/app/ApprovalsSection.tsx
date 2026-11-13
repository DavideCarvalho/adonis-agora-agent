import { useState } from 'react';
import { type Column, DataTable } from '../agora-kit/blocks/data-table';
import { EmptyState } from '../agora-kit/blocks/empty-state';
import { ErrorBoundary, RegionError } from '../agora-kit/blocks/error-boundary';
import { PageHeader } from '../agora-kit/blocks/page-header';
import { Panel } from '../agora-kit/blocks/panel';
import { QueryBoundary } from '../agora-kit/blocks/query-boundary';
import { CheckIcon, XIcon } from '../agora-kit/icons';
import { PageBody } from '../agora-kit/shell/app-shell';
import { Button } from '../agora-kit/ui/button';
import { formatTimestamp } from '../client/format.js';
import type { PendingApprovalRow } from '../client/types.js';
import { ApprovalIcon } from './icons.js';
import { payload, TableSkeleton } from './ui.js';
import { asQuery, useAgentClient, usePendingApprovals } from './use-governance.js';

type Decision = 'approve' | 'reject';

function approvalColumns(
  busy: Record<string, boolean>,
  onDecide: (row: PendingApprovalRow, action: Decision) => void,
): Column<PendingApprovalRow>[] {
  return [
    {
      id: 'tool',
      header: 'Tool',
      cell: (row) => <span className="mono text-fg">{row.toolName}</span>,
    },
    {
      id: 'input',
      header: 'Input',
      hideBelow: 'md',
      className: 'max-w-[20rem] truncate',
      cell: (row) => (
        <span className="mono" title={payload(row.input)}>
          {payload(row.input).slice(0, 48)}
        </span>
      ),
    },
    {
      id: 'actor',
      header: 'Actor',
      hideBelow: 'sm',
      cell: (row) => (
        <span className="mono" title={row.actorRef}>
          {row.actorRef}
        </span>
      ),
    },
    {
      id: 'thread',
      header: 'Thread',
      hideBelow: 'lg',
      cell: (row) => (
        <span className="mono" title={row.threadId}>
          {row.threadId ? `${row.threadId.slice(0, 8)}…` : '—'}
        </span>
      ),
    },
    {
      id: 'requested',
      header: 'Requested',
      align: 'right',
      hideBelow: 'md',
      cell: (row) => <span className="mono tnum">{formatTimestamp(row.requestedAt)}</span>,
    },
    {
      id: 'decision',
      header: 'Decision',
      align: 'right',
      cell: (row) => {
        // A call recorded before run tracking has no runId: it cannot be actioned from here.
        const disabled = row.runId === null || busy[row.toolCallId] === true;
        return (
          <span className="inline-flex gap-1.5">
            <Button
              variant="brand"
              size="sm"
              disabled={disabled}
              onClick={() => onDecide(row, 'approve')}
            >
              <CheckIcon />
              Approve
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={disabled}
              onClick={() => onDecide(row, 'reject')}
            >
              <XIcon />
              Reject
            </Button>
          </span>
        );
      },
    },
  ];
}

/**
 * The cross-thread HITL approvals inbox from `GET /agent/governance/approvals/pending`, oldest
 * first (container). Approve / reject call the EXISTING mutating routes `POST
 * /agent/tool-call/approve|reject` (`{ runId, toolCallId }`), then reload so the drained call drops
 * off.
 */
export function ApprovalsSection() {
  const client = useAgentClient();
  const approvalsState = usePendingApprovals();
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [decisionError, setDecisionError] = useState<Error | null>(null);

  const decide = async (row: PendingApprovalRow, action: Decision) => {
    if (row.runId === null) return;
    setBusy((b) => ({ ...b, [row.toolCallId]: true }));
    setDecisionError(null);
    try {
      if (action === 'approve') await client.approveToolCall(row.runId, row.toolCallId);
      else await client.rejectToolCall(row.runId, row.toolCallId);
      approvalsState.reload();
    } catch (error) {
      setDecisionError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setBusy((b) => ({ ...b, [row.toolCallId]: false }));
    }
  };

  const columns = approvalColumns(busy, (row, action) => void decide(row, action));

  return (
    <PageBody>
      <PageHeader
        title="Approvals"
        description="Tool calls waiting for a human decision, across every thread, oldest first."
      />
      {decisionError && <RegionError title="The decision was not saved" error={decisionError} />}
      <ErrorBoundary label="Approvals inbox">
        <Panel title="Pending" description="HITL inbox · oldest first" flush>
          <QueryBoundary
            query={asQuery(approvalsState)}
            label="Approvals"
            skeleton={<TableSkeleton columns={columns} rows={5} />}
            isEmpty={(rows) => rows.length === 0}
            empty={
              <EmptyState
                icon={<ApprovalIcon />}
                title="No tool calls awaiting approval."
                description="Calls to tools that need a human show up here."
              />
            }
          >
            {(rows) => (
              <DataTable
                label="pending approvals"
                columns={columns}
                rows={rows}
                rowKey={(row) => row.toolCallId}
              />
            )}
          </QueryBoundary>
        </Panel>
      </ErrorBoundary>
    </PageBody>
  );
}
