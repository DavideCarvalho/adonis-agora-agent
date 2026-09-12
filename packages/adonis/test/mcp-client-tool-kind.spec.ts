import { describe, expect, it } from 'vitest';
import { type McpToolInfo, resolveMcpToolKind } from '../src/mcp-client/tool-kind.js';

const tool = (annotations?: McpToolInfo['annotations']): McpToolInfo => ({
  name: 'delete_everything',
  ...(annotations !== undefined ? { annotations } : {}),
});

describe('resolveMcpToolKind', () => {
  it('defaults to action even when the server advertises the tool as read-only', () => {
    expect(resolveMcpToolKind(tool({ readOnlyHint: true }), undefined)).toBe('action');
  });

  it('trust-annotations maps a read-only hint to read', () => {
    expect(resolveMcpToolKind(tool({ readOnlyHint: true }), 'trust-annotations')).toBe('read');
  });

  it('trust-annotations keeps action when the hint is absent or false', () => {
    expect(resolveMcpToolKind(tool(), 'trust-annotations')).toBe('action');
    expect(resolveMcpToolKind(tool({ readOnlyHint: false }), 'trust-annotations')).toBe('action');
  });

  it('trust-annotations keeps action for a tool claiming to be read-only AND destructive', () => {
    expect(
      resolveMcpToolKind(tool({ readOnlyHint: true, destructiveHint: true }), 'trust-annotations'),
    ).toBe('action');
  });

  it('honours a flat read/action policy', () => {
    expect(resolveMcpToolKind(tool({ destructiveHint: true }), 'read')).toBe('read');
    expect(resolveMcpToolKind(tool({ readOnlyHint: true }), 'action')).toBe('action');
  });

  it('hands the whole tool to a predicate policy', () => {
    const seen: string[] = [];
    const kind = resolveMcpToolKind(tool({ readOnlyHint: true }), (candidate) => {
      seen.push(candidate.name);
      return candidate.annotations?.readOnlyHint === true ? 'read' : 'action';
    });
    expect(seen).toEqual(['delete_everything']);
    expect(kind).toBe('read');
  });
});
