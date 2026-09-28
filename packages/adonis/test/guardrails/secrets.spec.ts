import { describe, expect, it } from 'vitest';
import { detectSecrets, entropy } from '../../src/guardrails/detectors/secrets.js';

// Test fixtures are assembled at runtime so secret scanners do not flag this file.
const j = (...parts: string[]) => parts.join('');
const RAND = 'Zx9Qm2Lp7Rt4Vw8Yb3Nc6Hd1Kf5Gs0Aj';

describe('detectSecrets', () => {
  const cases: Array<[string, string, string]> = [
    ['secret.openai_key', j('sk-', 'proj-', RAND, 'Ab12Cd34'), 'key'],
    ['secret.anthropic_key', j('sk-ant-', 'api03-', RAND, RAND, 'xY'), 'key'],
    ['secret.aws_access_key', j('AKIA', 'IOSFODNN7EXAMPLE'), 'id'],
    ['secret.github_token', j('ghp_', RAND, 'abcd'), 'token'],
    ['secret.github_token', j('github_pat_', '11ABCDEFG0', RAND), 'token'],
    ['secret.gitlab_token', j('glpat-', RAND.slice(0, 20)), 'token'],
    ['secret.slack_token', j('xoxb-', '1234567890-', RAND), 'token'],
    ['secret.google_api_key', j('AIza', 'SyD', RAND.slice(0, 32)), 'key'],
    ['secret.stripe_key', j('sk_', 'live_', RAND), 'key'],
  ];

  for (const [category, value] of cases) {
    it(`finds ${category}`, () => {
      const text = `here it is: ${value} — keep it safe`;
      const hits = detectSecrets(text);
      expect(hits.map((h) => h.category)).toContain(category);
      const hit = hits.find((h) => h.category === category);
      expect(text.slice(hit?.start, hit?.end)).toBe(value);
    });
  }

  it('finds AWS secret keys by context and masks only the value', () => {
    const secret = j('wJalrXUtnFEMI/K7MDENG/', 'bPxRfiCYEXAMPLEKEY');
    const text = `aws_secret_access_key = ${secret}`;
    const [hit] = detectSecrets(text, ['aws_secret_key']);
    expect(hit?.value).toBe(secret);
    expect(text.slice(hit?.start, hit?.end)).toBe(secret);
  });

  it('finds JWTs and bearer tokens', () => {
    const jwt = j(
      'eyJhbGciOiJIUzI1NiJ9',
      '.',
      'eyJzdWIiOiIxMjM0NTY3ODkwIn0',
      '.',
      'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    );
    expect(detectSecrets(`token ${jwt}`, ['jwt'])).toHaveLength(1);
    const bearer = detectSecrets(`Authorization: Bearer ${RAND}${RAND}`, ['bearer_token']);
    expect(bearer[0]?.value).toBe(`${RAND}${RAND}`);
  });

  it('finds PEM private keys, even when cut off', () => {
    const pem = j(
      '-----BEGIN ',
      'RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA',
      RAND,
      '\n-----END RSA PRIVATE KEY-----',
    );
    expect(detectSecrets(`key:\n${pem}\nthanks`, ['private_key'])[0]?.value).toBe(pem);
    const partial = j('-----BEGIN ', 'PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC');
    expect(detectSecrets(partial, ['private_key'])[0]?.value).toBe(partial);
  });

  it('generic assignments need entropy: words and placeholders are not secrets', () => {
    expect(detectSecrets('password: changeme', ['generic_secret'])).toEqual([]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal placeholder is the fixture
    expect(detectSecrets('api_key=${API_KEY}', ['generic_secret'])).toEqual([]);
    expect(detectSecrets('api_key=<your-key-here>', ['generic_secret'])).toEqual([]);
    expect(detectSecrets('senha: xxxxxxxxxx', ['generic_secret'])).toEqual([]);
    const real = detectSecrets(`api_key="${RAND}"`, ['generic_secret']);
    expect(real[0]?.value).toBe(RAND);
  });

  it('ignores prose mentioning keys', () => {
    const text =
      'Rotate the sk- prefixed keys monthly; AKIA ids belong to IAM users. Use a bearer token.';
    expect(detectSecrets(text)).toEqual([]);
  });

  it('entropy separates random tokens from words', () => {
    expect(entropy('aaaaaaaa')).toBe(0);
    expect(entropy(RAND)).toBeGreaterThan(4);
    expect(entropy('password')).toBeLessThan(3);
  });
});
