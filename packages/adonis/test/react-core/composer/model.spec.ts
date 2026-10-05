import { describe, expect, it } from 'vitest';
import {
  type AutocompleteSource,
  applyCompletion,
  filterAutocompleteItems,
  findActiveTrigger,
} from '../../../src/react/core/composer/model.js';

const commands: AutocompleteSource = {
  id: 'commands',
  trigger: '/',
  position: 'start',
  getItems: () => [],
};

const mentions: AutocompleteSource = {
  id: 'mentions',
  trigger: '@',
  position: 'word',
  getItems: () => [],
};

/** Caret at the end of the text, which is where a person typing one actually is. */
function at(text: string, sources = [commands]) {
  return findActiveTrigger(text, text.length, sources);
}

describe('findActiveTrigger', () => {
  it('opens a start-anchored trigger typed as the first character', () => {
    expect(at('/')).toMatchObject({ index: 0, query: '' });
    expect(at('/dep')).toMatchObject({ index: 0, query: 'dep' });
  });

  it('leaves a path alone — the case people type most', () => {
    expect(at('src/foo')).toBeNull();
    expect(at('look at src/')).toBeNull();
    expect(at('deploy to a/b/c')).toBeNull();
  });

  it('refuses a start-anchored trigger that is not at the start, even after a space', () => {
    expect(at('run /deploy')).toBeNull();
  });

  it('opens a word-anchored trigger at the start of any word', () => {
    expect(at('@ad', [mentions])).toMatchObject({ index: 0, query: 'ad' });
    expect(at('ask @ad', [mentions])).toMatchObject({ index: 4, query: 'ad' });
  });

  it('refuses a word-anchored trigger glued to the end of a word', () => {
    expect(at('ada@example', [mentions])).toBeNull();
  });

  it('closes once the token gains whitespace, so the rest is free text', () => {
    expect(at('/deploy now')).toBeNull();
    expect(at('/deploy ')).toBeNull();
  });

  it('reads the token up to the caret, not to the end of the text', () => {
    expect(findActiveTrigger('/deploy', 4, [commands])).toMatchObject({ query: 'dep' });
  });

  it('keeps scanning past a trigger that failed its own position rule', () => {
    // `@ad/x` is one mention query containing a slash, not a command.
    expect(at('@ad/x', [commands, mentions])).toMatchObject({
      index: 0,
      query: 'ad/x',
      source: mentions,
    });
  });

  it('lets the nearest matching trigger own the token', () => {
    expect(at('@a', [commands, mentions])?.source).toBe(mentions);
    expect(at('/a', [commands, mentions])?.source).toBe(commands);
  });
});

describe('filterAutocompleteItems', () => {
  const items = [
    { id: '1', label: 'deploy', description: 'ship the current build' },
    { id: '2', label: 'rollback' },
    { id: '3', label: 'summarise', description: 'condense a Deployment thread' },
  ];

  it('returns everything for an empty query', () => {
    expect(filterAutocompleteItems(items, '')).toEqual(items);
  });

  it('matches the label case-insensitively', () => {
    expect(filterAutocompleteItems(items, 'DEP').map((item) => item.id)).toEqual(['1', '3']);
  });

  it('matches the description too', () => {
    expect(filterAutocompleteItems(items, 'condense').map((item) => item.id)).toEqual(['3']);
  });

  it('returns nothing when nothing matches', () => {
    expect(filterAutocompleteItems(items, 'zzz')).toEqual([]);
  });
});

describe('applyCompletion', () => {
  const match = { source: commands, index: 0, query: 'dep' };

  it('replaces the token, keeps the trigger, and lands the caret after a trailing space', () => {
    expect(applyCompletion('/dep', 4, match, { id: '1', label: 'deploy' })).toEqual({
      text: '/deploy ',
      caret: 8,
    });
  });

  it('prefers an explicit value over the label', () => {
    expect(
      applyCompletion('/dep', 4, match, { id: '1', label: 'Deploy the build', value: 'deploy' }),
    ).toMatchObject({ text: '/deploy ' });
  });

  it('keeps whatever follows the caret and does not move it', () => {
    expect(applyCompletion('/dep tail', 4, match, { id: '1', label: 'deploy' })).toEqual({
      text: '/deploy  tail',
      caret: 8,
    });
  });

  it('honours a source that wants no trailing space', () => {
    const glued = { source: { ...commands, insertSuffix: '' }, index: 0, query: 'dep' };
    expect(applyCompletion('/dep', 4, glued, { id: '1', label: 'deploy' })).toEqual({
      text: '/deploy',
      caret: 7,
    });
  });
});
