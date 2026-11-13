import { formatTimestamp } from '../client/format.js';
import type { RunMessageRow } from '../client/types.js';
import { StatusBadge } from './ui.js';

/** A run's or a thread's message timeline (presentational): role badge, time, the text. */
export function MessageList({ messages }: { messages: RunMessageRow[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {messages.map((m) => (
        <li key={m.id} className="rounded-md border border-border bg-sunken/20 px-3.5 py-3">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <StatusBadge status={m.role} />
            <span className="mono tnum text-[10.5px] text-faint">
              {formatTimestamp(m.createdAt)}
            </span>
          </div>
          <div className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-fg-2">
            {m.content}
          </div>
        </li>
      ))}
    </ol>
  );
}
