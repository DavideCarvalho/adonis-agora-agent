import { describe, it } from 'vitest';
import { cryptoKitCases } from '../src/crypto-kit/crypto-kit.cases.js';

/** The crypto kit's own tests (`src/crypto-kit/` is a verbatim copy of `_1x/shared/crypto-kit`). */
describe('crypto-kit', () => {
  for (const [name, run] of Object.entries(cryptoKitCases)) it(name, run);
});
