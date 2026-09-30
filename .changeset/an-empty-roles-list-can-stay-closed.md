---
'@adonis-agora/agent': minor
---

`emptyRoles: 'deny'` — a ready-made closed roles gate, for apps where an empty roles list means "no one". Closes #235.

**Upgrade note for 0.46, which did not say it outright:** since 0.46 `DefaultRolesPolicy` / `DefaultToolAuthorizer` treat an empty roles list as **open**. Before, `[]` denied everyone. So `roles: []` on a tool, `defaultRoles: []`, `registerFunctionalTool(registry, tool, [])` and any computed `roles` that can come out empty ("the roles holding permission X" when none does) went from reaching nobody to reaching every resolved actor, with no error and no warning. On a multi-tenant MCP server that is silent and serious.

The default does not change — an empty list is still open, which is what makes `defineConfig({ model })` a working chat. What is new is the switch to keep it closed:

```ts
// config/agent.ts and config/mcp.ts
export default defineConfig({ emptyRoles: 'deny' })
export default defineMcpConfig({ name, version, defaultRoles: [], emptyRoles: 'deny' })

// or the policy itself
new ClosedRolesPolicy(defaultRoles) // = new DefaultRolesPolicy(defaultRoles, { emptyRoles: 'deny' })
new ClosedToolAuthorizer(defaultRoles) // = new DefaultToolAuthorizer(defaultRoles, { emptyRoles: 'deny' })
```

Closed, the actor needs a role the tool declares (else one of `defaultRoles`): a tool with no `roles` and no default roles, or with an explicitly empty list, is neither offered nor invocable, and an actor with no roles reaches nothing.

- `DefaultRolesPolicy` and `DefaultToolAuthorizer` take a second argument, `{ emptyRoles?: 'allow' | 'deny' }` (default `'allow'`); `ClosedRolesPolicy`, `ClosedToolAuthorizer` and the `EmptyRoles` / `RolesPolicyOptions` types are exported from the root entry.
- `emptyRoles` on `defineConfig` and `defineMcpConfig`, passed to the default authorizer. It is ignored when you set your own `authorizer` / `rolesPolicy`.
