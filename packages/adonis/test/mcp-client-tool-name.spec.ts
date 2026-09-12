import { describe, expect, it } from 'vitest';
import { localToolName, MAX_TOOL_NAME_LENGTH } from '../src/mcp-client/tool-name.js';

describe('localToolName', () => {
  it('namespaces a remote tool under its server by default', () => {
    expect(localToolName('github', 'create_issue', undefined)).toBe('github_create_issue');
  });

  it('replaces characters a model provider will not accept in a tool name', () => {
    expect(localToolName('git hub', 'repo/create.issue', undefined)).toBe(
      'git_hub_repo_create_issue',
    );
  });

  it('leaves the remote name unprefixed when namespacing is off', () => {
    expect(localToolName('github', 'create.issue', false)).toBe('create_issue');
  });

  it('uses an explicit prefix when given one', () => {
    expect(localToolName('github', 'create_issue', 'gh')).toBe('gh_create_issue');
  });

  it('truncates an over-long name to a stable, still-distinct one', () => {
    const shared = 'a'.repeat(80);
    const first = localToolName('srv', `${shared}_one`, undefined);
    const second = localToolName('srv', `${shared}_two`, undefined);

    expect(first.length).toBe(MAX_TOOL_NAME_LENGTH);
    expect(first).not.toBe(second);
    expect(localToolName('srv', `${shared}_one`, undefined)).toBe(first);
  });
});
