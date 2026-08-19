import type { AiToolOptions } from './ai-tool-ref.js';
import type { AiToolCtx, ToolHandler } from './spi/tool.js';

/**
 * Optional base class for the class-authoring form of a tool — the counterpart of durable's
 * `BaseWorkflow`. Declaring `static tool?: AiToolOptions` here means a subclass writes
 * `static tool = { name, kind, description, input, … }` and gets it type-checked by the inherited
 * static declaration — no `satisfies AiToolOptions` needed. Implement `execute(input, ctx)`; the
 * discovery scan reads the static `tool` off the subclass and registers it (the abstract base
 * carries no `static tool`, so it is never registered itself).
 *
 * `I` is the parsed (Zod) input; `O` is the return — both flow into `execute`'s signature, so the
 * compiler checks the body against what the tool promises.
 *
 * ```ts
 * export default class FilaDeAlocacao extends BaseTool<Input, Row[]> {
 *   static tool = {
 *     name: 'fila_de_alocacao',
 *     kind: 'read',
 *     description: '…',
 *     input: z.object({}),
 *     ability: 'agent.coordenador.fila.ler',
 *   }
 *   async execute(_input: Input, ctx: AiToolCtx): Promise<Row[]> { … }
 * }
 * ```
 */
export abstract class BaseTool<I = unknown, O = unknown> implements ToolHandler<I, O> {
  static tool?: AiToolOptions;
  abstract execute(input: I, ctx: AiToolCtx): Promise<O> | O;
}

/** A tool's config on the kind-specific bases: {@link AiToolOptions} minus `kind` (the base pins it). */
export type BaseToolOptions = Omit<AiToolOptions, 'kind'>;

/**
 * Kind-specific bases — `ReadTool` pins `kind: 'read'`, `ActionTool` pins `kind: 'action'`. Because the
 * subclass does NOT declare `kind`, its `static tool = { name, description, input, ability }` carries no
 * union field and type-checks **truly bare** — no `satisfies AiToolOptions`, no `: AiToolOptions`
 * annotation (which {@link BaseTool}'s `kind: 'read' | 'action'` would demand, since an inherited static
 * gives no contextual typing and the literal would widen `kind` to `string`). Discovery reads `kind` off
 * the base's own static. `execute` is still typed through `<I, O>`.
 *
 * ```ts
 * export default class AllocationQueue extends ReadTool<Input, Row[]> {
 *   static tool = { name: 'allocation_queue', description: '…', input: z.object({}), ability: '…' }
 *   async execute(_input: Input, ctx: AiToolCtx): Promise<Row[]> { … }
 * }
 * ```
 */
export abstract class ReadTool<I = unknown, O = unknown> implements ToolHandler<I, O> {
  static readonly kind = 'read';
  static tool?: BaseToolOptions;
  abstract execute(input: I, ctx: AiToolCtx): Promise<O> | O;
}

/** Kind-specific base for `action` tools (they require human approval). See {@link ReadTool}. */
export abstract class ActionTool<I = unknown, O = unknown> implements ToolHandler<I, O> {
  static readonly kind = 'action';
  static tool?: BaseToolOptions;
  abstract execute(input: I, ctx: AiToolCtx): Promise<O> | O;
}
