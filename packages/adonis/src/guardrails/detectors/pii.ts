import type { Finding, PiiType } from '../types.js';
import { PII_TYPES } from '../types.js';

/** Dotted-quad IPv4 with every octet in 0-255 and no leading zeros. */
export function isIPv4(raw: string): boolean {
  const parts = raw.split('.');
  return (
    parts.length === 4 && parts.every((p) => /^(?:0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255)
  );
}

/** Luhn (mod 10) checksum over a digit string. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Card brands by IIN prefix (digits only). Unknown prefixes are not treated as cards. */
export function cardBrand(digits: string): string | undefined {
  const p2 = Number(digits.slice(0, 2));
  const p3 = Number(digits.slice(0, 3));
  const p4 = Number(digits.slice(0, 4));
  const p6 = Number(digits.slice(0, 6));
  const len = digits.length;
  // Brazilian brands first: their ranges overlap Visa/Discover/Mastercard prefixes.
  if (
    [
      401178, 401179, 431274, 438935, 451416, 457393, 457631, 457632, 504175, 627780, 636297,
      636368,
    ].includes(p6)
  )
    return 'elo';
  if (
    (p6 >= 506699 && p6 <= 506778) ||
    (p6 >= 509000 && p6 <= 509999) ||
    (p6 >= 650031 && p6 <= 650051)
  )
    return 'elo';
  if (p6 === 606282 || p4 === 3841) return 'hipercard';
  if (digits.startsWith('4') && (len === 13 || len === 16 || len === 19)) return 'visa';
  if (((p2 >= 51 && p2 <= 55) || (p4 >= 2221 && p4 <= 2720)) && len === 16) return 'mastercard';
  if ((p2 === 34 || p2 === 37) && len === 15) return 'amex';
  if ((p4 === 6011 || p2 === 65 || (p3 >= 644 && p3 <= 649)) && len >= 16) return 'discover';
  if ((p2 === 36 || p2 === 38 || (p3 >= 300 && p3 <= 305)) && len >= 14) return 'diners';
  if (p4 >= 3528 && p4 <= 3589 && len >= 16) return 'jcb';
  if ((p2 === 62 || p2 === 81) && len >= 16) return 'unionpay';
  if (
    (p4 === 5018 || p4 === 5020 || p4 === 5038 || p4 === 6304 || p4 === 6759 || p4 === 6761) &&
    len >= 12
  )
    return 'maestro';
  return undefined;
}

/** CPF (Brazilian individual taxpayer id): 11 digits, two mod-11 check digits. */
export function cpfValid(raw: string): boolean {
  const d = raw.replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += (d.charCodeAt(i) - 48) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return check(9) === d.charCodeAt(9) - 48 && check(10) === d.charCodeAt(10) - 48;
}

/**
 * CNPJ (Brazilian company id), numeric or the alphanumeric format in use since July 2026: 12
 * characters [0-9A-Z] + 2 check digits, each character valued at its ASCII code minus 48.
 */
export function cnpjValid(raw: string): boolean {
  const c = raw.replace(/[.\-/\s]/g, '').toUpperCase();
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || /^(\d)\1{13}$/.test(c)) return false;
  const value = (i: number) => c.charCodeAt(i) - 48;
  const check = (len: number) => {
    const weights =
      len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += value(i) * (weights[i] ?? 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return check(12) === value(12) && check(13) === value(13);
}

/** US Social Security Number structure (no 000/666/9xx area, no 00 group, no 0000 serial). */
export function ssnValid(raw: string): boolean {
  const m = /^(\d{3})[- ](\d{2})[- ](\d{4})$/.exec(raw);
  if (!m) return false;
  const area = m[1] ?? '';
  const group = m[2] ?? '';
  const serial = m[3] ?? '';
  if (area === '000' || area === '666' || area.startsWith('9')) return false;
  if (group === '00' || serial === '0000') return false;
  // Well-known advertising / sample numbers.
  if (['078-05-1120', '219-09-9999', '123-45-6789'].includes(`${area}-${group}-${serial}`))
    return false;
  return true;
}

/** IBAN lengths by country (ISO 13616 registry, main countries). */
const IBAN_LENGTHS: Record<string, number> = {
  AD: 24,
  AE: 23,
  AT: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BR: 29,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DK: 18,
  DO: 28,
  EE: 20,
  ES: 24,
  FI: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MR: 27,
  MT: 31,
  MU: 30,
  NL: 18,
  NO: 15,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  SA: 24,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  TN: 24,
  TR: 26,
  UA: 29,
  VG: 24,
  XK: 20,
};

/** IBAN: known country length and ISO 7064 mod 97-10 checksum. */
export function ibanValid(raw: string): boolean {
  const s = raw.replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const expected = IBAN_LENGTHS[s.slice(0, 2)];
  if (expected !== undefined && s.length !== expected) return false;
  if (expected === undefined) return false;
  const rearranged = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const v = ch >= 'A' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of v) rem = (rem * 10 + (digit.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** Phone numbers: international (+CC), Brazilian and North American formats with separators. */
export function phoneValid(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  if (raw.trim().startsWith('+')) return digits.length >= 8 && digits.length <= 15;
  if (digits.length < 10 || digits.length > 11) return false;
  // Brazil: (11) 91234-5678, 11 91234-5678, (11) 3123-4567
  if (/^\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]\d{4}$/.test(raw.trim())) return true;
  // North America: (415) 555-0132, 415-555-0132, 415.555.0132
  if (/^\(?\d{3}\)?[\s.-]?\d{3}[\s.-]\d{4}$/.test(raw.trim())) return true;
  return false;
}

interface PiiPattern {
  type: PiiType;
  re: RegExp;
  valid?: (match: string) => boolean;
  score: number;
}

// Boundaries are explicit look-arounds instead of \b so formatted numbers ("(11) 9…") are whole.
const PATTERNS: PiiPattern[] = [
  {
    type: 'email',
    re: /(?<![\w.+-])[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,63})@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,62})\.)+[A-Za-z]{2,24}(?![\w-])/g,
    score: 0.99,
  },
  {
    type: 'iban',
    re: /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}(?![A-Za-z0-9])/g,
    valid: ibanValid,
    score: 0.99,
  },
  {
    type: 'cnpj',
    re: /(?<![\w./-])[0-9A-Z]{2}\.?[0-9A-Z]{3}\.?[0-9A-Z]{3}\/?[0-9A-Z]{4}-?\d{2}(?![\w/-])/g,
    valid: (m) =>
      cnpjValid(m) && (/^\d/.test(m.replace(/\D/g, '')) || /[./-]/.test(m)) && !/^[A-Z]+$/.test(m),
    score: 0.98,
  },
  {
    type: 'cpf',
    re: /(?<![\w./-])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![\w/-])/g,
    valid: cpfValid,
    score: 0.95,
  },
  {
    type: 'credit_card',
    re: /(?<![\d-])\d(?:[ -]?\d){11,18}(?![\d-])/g,
    valid: (m) => {
      const digits = m.replace(/\D/g, '');
      // Mixed separators ("4111 1111-1111 1111") are unusual for cards; accept one kind.
      if (/ /.test(m) && /-/.test(m)) return false;
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits) && !!cardBrand(digits);
    },
    score: 0.97,
  },
  {
    type: 'ssn',
    re: /(?<![\d-])\d{3}[- ]\d{2}[- ]\d{4}(?![\d-])/g,
    valid: ssnValid,
    score: 0.85,
  },
  {
    type: 'phone',
    re: /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?\(?\d{2,4}\)?[\s.-]?\d{3,5}[\s.-]\d{4}(?![\w])/g,
    valid: phoneValid,
    score: 0.75,
  },
  {
    type: 'ip_address',
    re: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g,
    valid: (m) => isIPv4(m) && !m.startsWith('0.') && m !== '127.0.0.1',
    score: 0.6,
  },
];

/** PII with format + checksum validation. Overlaps are resolved by the caller (longest, earliest). */
export function detectPii(text: string, types: readonly PiiType[] = PII_TYPES): Finding[] {
  const want = new Set(types);
  const out: Finding[] = [];
  for (const p of PATTERNS) {
    if (!want.has(p.type)) continue;
    p.re.lastIndex = 0;
    for (let m = p.re.exec(text); m; m = p.re.exec(text)) {
      const value = m[0];
      if (p.valid && !p.valid(value)) continue;
      out.push({
        detector: 'pii',
        category: `pii.${p.type}`,
        start: m.index,
        end: m.index + value.length,
        score: p.score,
        value,
        spanned: true,
      });
    }
  }
  return out;
}
