import type { Finding, SecretType } from '../types.js';
import { SECRET_TYPES } from '../types.js';

interface SecretPattern {
  type: SecretType;
  re: RegExp;
  /** Capture group holding the secret (the rest is context such as `api_key=`). Default 0. */
  group?: number;
  score: number;
  valid?: (value: string) => boolean;
}

/** Shannon entropy in bits per character: tells random tokens from words ("password=changeme"). */
export function entropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const c of counts.values()) {
    const p = c / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const PATTERNS: SecretPattern[] = [
  {
    type: 'private_key',
    re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----|$)/g,
    score: 0.99,
  },
  {
    type: 'anthropic_key',
    re: /(?<![\w-])sk-ant-(?:api|admin|oat)\d{0,2}-?[A-Za-z0-9_-]{20,}/g,
    score: 0.99,
  },
  {
    type: 'openai_key',
    re: /(?<![\w-])sk-(?!ant-)(?:proj-|svcacct-|admin-|None-)?[A-Za-z0-9_-]{20,}/g,
    score: 0.95,
    valid: (v) => entropy(v) > 3.5,
  },
  {
    type: 'aws_access_key',
    re: /(?<![A-Z0-9])(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}(?![A-Z0-9])/g,
    score: 0.98,
  },
  {
    type: 'aws_secret_key',
    re: /(?:aws_?secret_?access_?key|aws_?secret|secretaccesskey)["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})(?![A-Za-z0-9/+=])/gi,
    group: 1,
    score: 0.97,
  },
  {
    type: 'github_token',
    re: /(?<![\w])(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})/g,
    score: 0.99,
  },
  { type: 'gitlab_token', re: /(?<![\w-])glpat-[A-Za-z0-9_-]{20,}/g, score: 0.99 },
  {
    type: 'slack_token',
    re: /(?<![\w-])(?:xox[abprseo]-[A-Za-z0-9-]{10,}|https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,})/g,
    score: 0.98,
  },
  { type: 'google_api_key', re: /(?<![\w-])AIza[0-9A-Za-z_-]{35}(?![\w-])/g, score: 0.97 },
  { type: 'stripe_key', re: /(?<![\w])(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}/g, score: 0.97 },
  {
    type: 'jwt',
    re: /(?<![\w-])eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![\w-])/g,
    score: 0.9,
  },
  {
    type: 'bearer_token',
    re: /\bbearer\s+([A-Za-z0-9._~+/-]{20,}=*)/gi,
    group: 1,
    score: 0.85,
    valid: (v) => entropy(v) > 3.5,
  },
  {
    type: 'generic_secret',
    re: /\b(?:api[_-]?key|api[_-]?secret|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|password|passwd|senha)\b["']?\s*[:=]\s*["']?([^\s"',;]{8,200})/gi,
    group: 1,
    score: 0.7,
    // Words and placeholders ("changeme", "<your-key>", "${API_KEY}") are not secrets.
    valid: (v) => entropy(v) >= 3 && !/^[<{$[]/.test(v) && !/^(?:x+|\*+|\.+)$/i.test(v),
  },
];

export function detectSecrets(
  text: string,
  types: readonly SecretType[] = SECRET_TYPES,
): Finding[] {
  const want = new Set(types);
  const out: Finding[] = [];
  for (const p of PATTERNS) {
    if (!want.has(p.type)) continue;
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      if (m[0].length === 0) {
        p.re.lastIndex++;
        continue;
      }
      const group = p.group ?? 0;
      const value = m[group];
      if (!value) continue;
      if (p.valid && !p.valid(value)) continue;
      const start = m.index + (group === 0 ? 0 : m[0].lastIndexOf(value));
      out.push({
        detector: 'secrets',
        category: `secret.${p.type}`,
        start,
        end: start + value.length,
        score: p.score,
        value,
        spanned: true,
      });
    }
  }
  return out;
}
