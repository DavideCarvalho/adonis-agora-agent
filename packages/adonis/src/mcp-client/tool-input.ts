import type { JsonSchemaType, jsonSchemaValidator } from '@modelcontextprotocol/sdk/validation';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { StandardJSONSchemaV1, StandardSchemaV1 } from '@standard-schema/spec';
import { findUnsafePattern } from './unsafe-regex.js';

/**
 * The default validator: the SDK's own AJV adapter, which is already configured for the schemas MCP
 * servers actually emit (non-strict, format-aware, no meta-schema resolution — so a server that
 * declares draft-2020-12 compiles as readily as one that declares draft-07).
 */
let defaultValidator: jsonSchemaValidator | undefined;

function sharedValidator(): jsonSchemaValidator {
  defaultValidator ??= new AjvJsonSchemaValidator();
  return defaultValidator;
}

export interface McpInputSchemaOptions {
  /**
   * Compiles the JSON Schema. Defaults to the SDK's AJV adapter; swap in
   * `CfWorkerJsonSchemaValidator` (or your own) on a runtime where AJV's code generation is not
   * available.
   */
  validator?: jsonSchemaValidator;
  /**
   * Reject a schema carrying a `pattern` that can backtrack exponentially (see
   * {@link findUnsafePattern}). Default `true`. Turn it off only for a `validator` whose regex
   * engine does not backtrack, where the screen costs tools and buys nothing.
   */
  rejectUnsafePatterns?: boolean;
}

/**
 * Wraps one MCP tool's JSON Schema as the [Standard Schema](https://standardschema.dev) that
 * `ToolSpec.inputSchema` requires, so an imported tool goes through the same `~standard.validate`
 * gate in `ToolRegistry.invoke` as a hand-written `@AiTool`.
 *
 * Both halves are the server's real schema, not an approximation of it:
 *  - `validate` compiles the schema and rejects what it rejects. A tool whose schema cannot be
 *    compiled THROWS from here — the caller drops that tool, because the alternative (a schema that
 *    accepts anything) would let the model send a remote tool arbitrary arguments under the
 *    appearance of a validated call. A schema whose `pattern` can backtrack exponentially throws
 *    the same way: validating against it is a denial of service on this process, so the tool is
 *    worth no more than one whose schema does not compile.
 *  - `jsonSchema.input` hands the schema back verbatim, which is what makes the model see the real
 *    parameter shapes: `@adonis-agora/agent/ai-sdk` derives tool parameters from Zod or from
 *    this Standard JSON Schema extension, and degrades any other Standard Schema to an untyped
 *    object.
 *
 * `input` and `output` return the same document because validation here is a pass-through: a valid
 * value is handed on unchanged, so the input and output types are the same type. The requested
 * `target` draft is ignored — the server's schema is a document we relay, not one we can transpile.
 */
export function mcpInputSchema(
  jsonSchema: Record<string, unknown>,
  options: McpInputSchemaOptions = {},
): StandardSchemaV1<unknown, Record<string, unknown>> & StandardJSONSchemaV1 {
  if (options.rejectUnsafePatterns !== false) {
    const unsafe = findUnsafePattern(jsonSchema);
    if (unsafe !== undefined) {
      throw new Error(
        `input schema carries a pattern that can backtrack exponentially: /${unsafe}/`,
      );
    }
  }
  // The MCP wire type describes a tool's schema as an open record and the validator SPI describes
  // it as a typed JSON Schema interface — the same document, typed from two directions.
  const validate = (options.validator ?? sharedValidator()).getValidator<Record<string, unknown>>(
    jsonSchema as JsonSchemaType,
  );
  return {
    '~standard': {
      version: 1,
      vendor: 'adonis-agora-agent-mcp',
      validate(value: unknown) {
        const result = validate(value);
        return result.valid
          ? { value: result.data }
          : { issues: [{ message: result.errorMessage }] };
      },
      jsonSchema: {
        input: () => jsonSchema,
        output: () => jsonSchema,
      },
    },
  };
}
