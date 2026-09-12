import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { McpToolCallError } from '../src/mcp-client/tool-source.js';
import { isTransientMcpError } from '../src/mcp-client/transient.js';

describe('isTransientMcpError', () => {
  it('classifies a dropped connection and a request timeout as transient', () => {
    expect(isTransientMcpError(new McpError(ErrorCode.ConnectionClosed, 'closed'))).toBe(true);
    expect(isTransientMcpError(new McpError(ErrorCode.RequestTimeout, 'timed out'))).toBe(true);
  });

  it('does not retry a protocol-level refusal — the same call would be refused again', () => {
    expect(isTransientMcpError(new McpError(ErrorCode.InvalidParams, 'bad args'))).toBe(false);
    expect(isTransientMcpError(new McpError(ErrorCode.MethodNotFound, 'no tool'))).toBe(false);
    expect(isTransientMcpError(new McpError(ErrorCode.InternalError, 'boom'))).toBe(false);
  });

  it('classifies retryable HTTP statuses from the streamable-HTTP transport', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isTransientMcpError(Object.assign(new Error('http'), { code: status }))).toBe(true);
    }
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isTransientMcpError(Object.assign(new Error('http'), { code: status }))).toBe(false);
    }
  });

  it('classifies socket-level failures, including one wrapped as a fetch cause', () => {
    expect(isTransientMcpError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(
      true,
    );
    expect(
      isTransientMcpError(
        Object.assign(new TypeError('fetch failed'), {
          cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
        }),
      ),
    ).toBe(true);
    // Only the cause carries a marker here — the wrapper's own message says nothing.
    expect(
      isTransientMcpError(
        Object.assign(new Error('the request failed'), {
          cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
        }),
      ),
    ).toBe(true);
  });

  it('classifies a call made while the transport is down', () => {
    expect(isTransientMcpError(new Error('Not connected'))).toBe(true);
  });

  it("never treats a tool's own reported error as transient, whatever its text", () => {
    expect(isTransientMcpError(new McpToolCallError('docs', 'search', 'fetch failed'))).toBe(false);
  });

  it('leaves an ordinary tool failure alone', () => {
    expect(isTransientMcpError(new Error('the city you asked for does not exist'))).toBe(false);
    expect(isTransientMcpError('not even an error')).toBe(false);
    expect(isTransientMcpError(undefined)).toBe(false);
  });
});
