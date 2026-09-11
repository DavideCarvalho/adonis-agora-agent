import { describe, expect, it } from 'vitest';
import type { Actor, Skill, SkillContext, SkillProvider, SkillSummary } from '../src/index.js';
import {
  actorScope,
  buildSkillsBlock,
  compositeSkillProvider,
  defaultScopeResolver,
  GLOBAL_SCOPE,
  loadSkill,
  offerSkills,
  resolveSkillCatalog,
  skillInputSchema,
  skillToolDefinition,
  skillWriteVerdict,
  staticSkillProvider,
  tenantScope,
} from '../src/index.js';

const ACTOR: Actor = { id: 'u1', roles: ['ADMIN'] };
const CTX: SkillContext = { actor: ACTOR, threadId: 't1' };

function summary(name: string, scope: string, description = `does ${name}`): SkillSummary {
  return { name, description, scope };
}

function skill(name: string, scope: string, body: string): Skill {
  return { name, description: `does ${name}`, scope, body };
}

describe('scope tokens', () => {
  it('orders an actor’s own scopes most specific first', () => {
    const scopes = defaultScopeResolver.resolve({
      actor: { id: 'u1', tenantRef: 'base-7' },
      threadId: 't1',
    });
    expect(scopes).toEqual(['actor:u1', 'tenant:base-7', 'global']);
  });

  it('leaves the tenant token out when the actor has none', () => {
    expect(defaultScopeResolver.resolve(CTX)).toEqual(['actor:u1', 'global']);
  });

  it('takes a host’s own axis without this package knowing what it is', async () => {
    const provider = staticSkillProvider([
      skill('triage', 'sector:logistics', 'the logistics way'),
      skill('triage', GLOBAL_SCOPE, 'the org way'),
    ]);
    const offer = await offerSkills(
      {
        provider,
        // An axis `Actor` has no field for, and that no enum in this package mentions.
        scopes: { resolve: () => ['sector:logistics', GLOBAL_SCOPE] },
      },
      CTX,
    );
    expect(offer.scopes).toEqual(['sector:logistics', GLOBAL_SCOPE]);
    expect(offer.entries).toEqual([
      {
        name: 'triage',
        description: 'does triage',
        scope: 'sector:logistics',
        shadows: [GLOBAL_SCOPE],
      },
    ]);
  });
});

describe('resolving a catalog against an ordered scope list', () => {
  it('lets the most specific scope win and records what it shadowed', () => {
    const resolved = resolveSkillCatalog(
      [summary('triage', GLOBAL_SCOPE), summary('triage', 'actor:u1')],
      ['actor:u1', 'tenant:base-7', GLOBAL_SCOPE],
    );
    expect(resolved.entries).toEqual([
      { name: 'triage', description: 'does triage', scope: 'actor:u1', shadows: [GLOBAL_SCOPE] },
    ]);
  });

  it('says nothing about shadows when nothing was shadowed', () => {
    const resolved = resolveSkillCatalog([summary('triage', GLOBAL_SCOPE)], [GLOBAL_SCOPE]);
    expect(resolved.entries[0]).not.toHaveProperty('shadows');
  });

  it('drops a scope the resolver never returned, whatever the provider said', () => {
    const resolved = resolveSkillCatalog(
      [summary('secret', 'actor:someone-else'), summary('triage', GLOBAL_SCOPE)],
      ['actor:u1', GLOBAL_SCOPE],
    );
    expect(resolved.entries.map((entry) => entry.name)).toEqual(['triage']);
  });

  it('orders most specific first, then by name', () => {
    const resolved = resolveSkillCatalog(
      [summary('zulu', 'actor:u1'), summary('alpha', GLOBAL_SCOPE), summary('bravo', 'actor:u1')],
      ['actor:u1', GLOBAL_SCOPE],
    );
    expect(resolved.entries.map((entry) => entry.name)).toEqual(['bravo', 'zulu', 'alpha']);
  });

  it('trims the WIDEST skills when the ceiling bites, and reports how many', () => {
    const resolved = resolveSkillCatalog(
      [summary('mine', 'actor:u1'), summary('theirs', GLOBAL_SCOPE)],
      ['actor:u1', GLOBAL_SCOPE],
      1,
    );
    expect(resolved.entries.map((entry) => entry.scope)).toEqual(['actor:u1']);
    expect(resolved.omitted).toBe(1);
  });
});

describe('reading several sources as one', () => {
  it('lets the earlier source win a same-name-same-scope collision', async () => {
    const provider = compositeSkillProvider([
      staticSkillProvider([skill('triage', GLOBAL_SCOPE, 'the host’s row')]),
      staticSkillProvider([skill('triage', GLOBAL_SCOPE, 'the shipped default')]),
    ]);
    const offer = await offerSkills({ provider }, CTX);
    const loaded = await loadSkill({ config: { provider }, offer, name: 'triage', ctx: CTX });
    expect(loaded.ok && loaded.skill.body).toBe('the host’s row');
  });
});

describe('serving one `skill` call against the catalog the turn was offered', () => {
  it('refuses a name the turn was never offered, and names what it may have', async () => {
    const provider: SkillProvider = {
      list: () => [summary('triage', GLOBAL_SCOPE)],
      // A provider that would happily serve anything asked of it.
      load: () => 'the body of whatever you asked for',
    };
    const offer = await offerSkills({ provider }, CTX);
    const loaded = await loadSkill({
      config: { provider },
      offer,
      name: 'someone-elses-skill',
      ctx: CTX,
    });
    expect(loaded).toEqual({
      ok: false,
      error: 'No skill named "someone-elses-skill" is available to you. Available: triage.',
    });
  });

  it('reports a listed skill whose body has since gone', async () => {
    const provider: SkillProvider = {
      list: () => [summary('triage', GLOBAL_SCOPE)],
      load: () => null,
    };
    const offer = await offerSkills({ provider }, CTX);
    const loaded = await loadSkill({ config: { provider }, offer, name: 'triage', ctx: CTX });
    expect(loaded).toEqual({
      ok: false,
      error: 'Skill "triage" is listed but its body could not be read.',
    });
  });

  it('loads the body of the scope that WON, not of the one it shadowed', async () => {
    const provider = staticSkillProvider([
      skill('triage', 'actor:u1', 'mine'),
      skill('triage', GLOBAL_SCOPE, 'the org’s'),
    ]);
    const offer = await offerSkills({ provider }, CTX);
    const loaded = await loadSkill({ config: { provider }, offer, name: 'triage', ctx: CTX });
    expect(loaded.ok && loaded.skill.body).toBe('mine');
    expect(loaded.ok && loaded.shadows).toEqual([GLOBAL_SCOPE]);
  });
});

describe('the catalog block the model reads', () => {
  it('spends one line per skill, carrying the scope and what it overrides', () => {
    const block = buildSkillsBlock([
      { name: 'triage', description: 'sort a queue', scope: 'actor:u1', shadows: [GLOBAL_SCOPE] },
      { name: 'report', description: 'write it up', scope: GLOBAL_SCOPE },
    ]);
    expect(block).toContain('- triage [actor:u1] — sort a queue (overrides the one from global)');
    expect(block).toContain('- report [global] — write it up');
    // The bodies are NOT here: that is the whole claim of progressive disclosure.
    expect(block).not.toContain('sort a queue\n  ');
  });
});

describe('the `skill` tool’s input schema', () => {
  it('refuses anything but a non-empty name', async () => {
    const validate = skillInputSchema['~standard'].validate;
    expect(await validate({ name: '' })).toMatchObject({ issues: [{ path: ['name'] }] });
    expect(await validate('triage')).toMatchObject({ issues: [{ path: [] }] });
    expect(await validate({ name: 'triage' })).toEqual({ value: { name: 'triage' } });
  });

  it('publishes a JSON Schema a provider can constrain generation against', () => {
    const published = (
      skillInputSchema['~standard'] as unknown as {
        jsonSchema: { input: () => Record<string, unknown> };
      }
    ).jsonSchema.input();
    expect(published).toMatchObject({ type: 'object', required: ['name'] });
  });

  it('is offered under its own kind, so its branch is never a registry lookup', () => {
    expect(skillToolDefinition()).toMatchObject({ name: 'skill', kind: 'skill' });
  });
});

describe('who may author a skill at a scope', () => {
  const scopes = [actorScope(ACTOR), tenantScope('base-7'), GLOBAL_SCOPE];

  it('lets anyone write at their own scope', () => {
    expect(
      skillWriteVerdict({
        scope: actorScope(ACTOR),
        actor: ACTOR,
        scopes,
        author: { kind: 'agent' },
      }),
    ).toEqual({ allowed: true });
  });

  it('refuses an agent a wider scope however elevated the host says it is', () => {
    const verdict = skillWriteVerdict({
      scope: tenantScope('base-7'),
      actor: ACTOR,
      scopes,
      author: { kind: 'agent' },
      elevated: true,
    });
    expect(verdict).toEqual({
      allowed: false,
      reason:
        'only a human may author a skill at "tenant:base-7"; an agent may write only at "actor:u1"',
    });
  });

  it('lets an elevated human write wider, and an unelevated one not', () => {
    const request = {
      scope: tenantScope('base-7'),
      actor: ACTOR,
      scopes,
      author: { kind: 'human' as const },
    };
    expect(skillWriteVerdict({ ...request, elevated: true })).toEqual({ allowed: true });
    expect(skillWriteVerdict(request).allowed).toBe(false);
  });

  it('refuses a scope the actor is not in at all', () => {
    expect(
      skillWriteVerdict({
        scope: 'tenant:somewhere-else',
        actor: ACTOR,
        scopes,
        author: { kind: 'human' },
        elevated: true,
      }),
    ).toEqual({
      allowed: false,
      reason: '"tenant:somewhere-else" is not a scope this actor belongs to',
    });
  });
});
