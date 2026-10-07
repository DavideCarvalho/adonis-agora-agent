import { expect, it } from 'vitest';
import * as genui from '../src/genui/index.js';
import * as root from '../src/index.js';

it('exports one validateUiCapabilities from the root and the genui entry', () => {
  expect(genui.validateUiCapabilities).toBe(root.validateUiCapabilities);
  expect(root.validateUiCapabilities({ components: [{ name: 'Card', version: 2 }] })).toEqual({
    components: [{ name: 'Card', version: 2 }],
  });
  expect(() => root.validateUiCapabilities({ components: [{ name: '1x', version: 1 }] })).toThrow(
    TypeError,
  );
});
