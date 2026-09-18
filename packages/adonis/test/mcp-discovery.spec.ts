import { describe, expect, it } from 'vitest';
import {
  mcpResourceUrl,
  normalizeMcpPath,
  protectedResourceMetadata,
  protectedResourceMetadataUrl,
  publicOrigin,
  wwwAuthenticateChallenge,
} from '../src/mcp/discovery.js';

describe('publicOrigin', () => {
  it('reduces a URL to its origin', () => {
    expect(publicOrigin('https://app.example.com')).toBe('https://app.example.com');
    expect(publicOrigin('https://app.example.com/')).toBe('https://app.example.com');
    expect(publicOrigin('https://app.example.com:8443')).toBe('https://app.example.com:8443');
  });

  it('rejects anything that is not an http(s) origin', () => {
    expect(() => publicOrigin('app.example.com')).toThrow(/absolute URL/);
    expect(() => publicOrigin('ftp://app.example.com')).toThrow(/http\(s\)/);
    expect(() => publicOrigin('https://app.example.com/base')).toThrow(/origin only/);
    expect(() => publicOrigin('https://app.example.com/?x=1')).toThrow(/origin only/);
  });
});

describe('resource URLs', () => {
  it('builds the resource and its RFC 9728 well-known URL', () => {
    expect(normalizeMcpPath('/mcp/')).toBe('mcp');
    expect(normalizeMcpPath(undefined)).toBe('mcp');
    expect(mcpResourceUrl('https://app.example.com', '/tools/mcp')).toBe(
      'https://app.example.com/tools/mcp',
    );
    expect(protectedResourceMetadataUrl('https://app.example.com', 'mcp')).toBe(
      'https://app.example.com/.well-known/oauth-protected-resource/mcp',
    );
  });

  it('builds the metadata document', () => {
    expect(
      protectedResourceMetadata(
        {
          issuer: 'https://app.example.com/oidc',
          authorizationEndpoint: 'https://app.example.com/oidc/auth',
          tokenEndpoint: 'https://app.example.com/oidc/token',
          scopesSupported: ['openid'],
          resourceName: 'Acme',
        },
        'https://app.example.com',
        'mcp',
      ),
    ).toEqual({
      resource: 'https://app.example.com/mcp',
      authorization_servers: ['https://app.example.com/oidc'],
      scopes_supported: ['openid'],
      bearer_methods_supported: ['header'],
      resource_name: 'Acme',
    });
  });
});

describe('wwwAuthenticateChallenge', () => {
  const url = 'https://app.example.com/.well-known/oauth-protected-resource/mcp';

  it('is a bare Bearer challenge with nothing to add', () => {
    expect(wwwAuthenticateChallenge()).toBe('Bearer');
  });

  it('points at the metadata, with the error code when a token was refused', () => {
    expect(wwwAuthenticateChallenge({ resourceMetadataUrl: url })).toBe(
      `Bearer resource_metadata="${url}"`,
    );
    expect(wwwAuthenticateChallenge({ error: 'invalid_token', resourceMetadataUrl: url })).toBe(
      `Bearer error="invalid_token", resource_metadata="${url}"`,
    );
  });

  it('escapes quotes in the metadata URL', () => {
    expect(wwwAuthenticateChallenge({ resourceMetadataUrl: 'https://x/"a' })).toBe(
      'Bearer resource_metadata="https://x/\\"a"',
    );
  });
});
