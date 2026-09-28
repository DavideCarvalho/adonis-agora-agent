import { describe, expect, it } from 'vitest';
import {
  cardBrand,
  cnpjValid,
  cpfValid,
  detectPii,
  ibanValid,
  luhnValid,
  phoneValid,
  ssnValid,
} from '../../src/guardrails/detectors/pii.js';

const found = (text: string, types?: Parameters<typeof detectPii>[1]) =>
  detectPii(text, types).map((f) => [f.category, f.value]);

describe('PII validators', () => {
  it('Luhn and card brands (incl. Brazilian Elo and Hipercard)', () => {
    for (const [n, brand] of <Array<[string, string]>>[
      ['4111111111111111', 'visa'],
      ['5555555555554444', 'mastercard'],
      ['2223003122003222', 'mastercard'],
      ['378282246310005', 'amex'],
      ['6011111111111117', 'discover'],
      ['3530111333300000', 'jcb'],
      ['6362970000457013', 'elo'],
      ['6062825624254001', 'hipercard'],
    ]) {
      expect(luhnValid(n), n).toBe(true);
      expect(cardBrand(n), n).toBe(brand);
    }
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(cardBrand('9999999999999995')).toBeUndefined();
  });

  it('CPF check digits (PT-BR)', () => {
    expect(cpfValid('529.982.247-25')).toBe(true);
    expect(cpfValid('52998224725')).toBe(true);
    expect(cpfValid('111.444.777-35')).toBe(true);
    expect(cpfValid('529.982.247-26')).toBe(false);
    expect(cpfValid('111.111.111-11')).toBe(false); // repeated digits pass the checksum but are invalid
    expect(cpfValid('123.456.789-0')).toBe(false);
  });

  it('CNPJ check digits, numeric and alphanumeric (2026 format)', () => {
    expect(cnpjValid('11.222.333/0001-81')).toBe(true);
    expect(cnpjValid('11222333000181')).toBe(true);
    expect(cnpjValid('11.222.333/0001-80')).toBe(false);
    expect(cnpjValid('00.000.000/0000-00')).toBe(false);
    // Receita Federal's example of the alphanumeric CNPJ.
    expect(cnpjValid('12.ABC.345/01DE-35')).toBe(true);
    expect(cnpjValid('12.ABC.345/01DE-36')).toBe(false);
  });

  it('IBAN mod 97 and country lengths', () => {
    expect(ibanValid('GB82 WEST 1234 5698 7654 32')).toBe(true);
    expect(ibanValid('DE89370400440532013000')).toBe(true);
    expect(ibanValid('BR1800360305000010009795493C1')).toBe(true);
    expect(ibanValid('GB82 WEST 1234 5698 7654 33')).toBe(false);
    expect(ibanValid('DE8937040044053201300')).toBe(false); // wrong length
    expect(ibanValid('ZZ82WEST12345698765432')).toBe(false); // unknown country
  });

  it('SSN structure', () => {
    expect(ssnValid('536-22-1234')).toBe(true);
    expect(ssnValid('000-12-3456')).toBe(false);
    expect(ssnValid('666-12-3456')).toBe(false);
    expect(ssnValid('912-12-3456')).toBe(false);
    expect(ssnValid('536-00-1234')).toBe(false);
    expect(ssnValid('536-22-0000')).toBe(false);
    expect(ssnValid('123-45-6789')).toBe(false); // well-known sample
  });

  it('phones: international, Brazilian and North American formats', () => {
    expect(phoneValid('+55 11 91234-5678')).toBe(true);
    expect(phoneValid('(11) 91234-5678')).toBe(true);
    expect(phoneValid('11 3123-4567')).toBe(true);
    expect(phoneValid('(415) 555-0132')).toBe(true);
    expect(phoneValid('415.555.0132')).toBe(true);
    expect(phoneValid('+44 20 7946 0958')).toBe(true);
    expect(phoneValid('2026-09-27')).toBe(false);
  });
});

describe('detectPii', () => {
  it('finds every type in mixed PT-BR / EN text', () => {
    const text =
      'Olá! Meu CPF é 529.982.247-25 e o CNPJ da empresa 11.222.333/0001-81. Cartão 4111 1111 1111 1111, ' +
      'email ana.souza@acme.com.br, celular (11) 91234-5678, SSN 536-22-1234, IBAN DE89 3704 0044 0532 0130 00.';
    expect(found(text)).toEqual([
      ['pii.email', 'ana.souza@acme.com.br'],
      ['pii.iban', 'DE89 3704 0044 0532 0130 00'],
      ['pii.cnpj', '11.222.333/0001-81'],
      ['pii.cpf', '529.982.247-25'],
      ['pii.credit_card', '4111 1111 1111 1111'],
      ['pii.ssn', '536-22-1234'],
      ['pii.phone', '(11) 91234-5678'],
    ]);
  });

  it('finds unformatted CPF and CNPJ and the alphanumeric CNPJ', () => {
    expect(
      found('cpf 52998224725 cnpj 11222333000181 novo 12.ABC.345/01DE-35', ['cpf', 'cnpj']),
    ).toEqual([
      ['pii.cnpj', '11222333000181'],
      ['pii.cnpj', '12.ABC.345/01DE-35'],
      ['pii.cpf', '52998224725'],
    ]);
  });

  it('does not flag numbers that fail their checksum or look like other things', () => {
    const text = [
      'Pedido 4111 1111 1111 1112 (inválido)',
      'CPF errado 529.982.247-26',
      'Nota fiscal 11.222.333/0001-80',
      'order #1234567890123',
      'timestamp 1727467200000',
      'date 2026-09-27 and time 10:30:00',
      'version 1.2.3.4.5',
      'uuid 3f2c1a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60',
    ].join('\n');
    expect(found(text, ['credit_card', 'cpf', 'cnpj', 'ssn', 'phone'])).toEqual([]);
  });

  it('reports offsets that slice back to the value', () => {
    const text = 'x ana@acme.com y';
    const [f] = detectPii(text, ['email']);
    expect(text.slice(f?.start, f?.end)).toBe('ana@acme.com');
    expect(f?.spanned).toBe(true);
  });

  it('is fast on large inputs (in-process budget)', () => {
    const chunk =
      'Relatório trimestral: receita cresceu 12% (R$ 1.234.567,89). Contato: time@acme.com.br, (11) 3123-4567. ';
    const text = chunk.repeat(100); // ~10 KB
    const started = performance.now();
    for (let i = 0; i < 10; i++) detectPii(text);
    const perRun = (performance.now() - started) / 10;
    expect(perRun).toBeLessThan(10);
  });
});
