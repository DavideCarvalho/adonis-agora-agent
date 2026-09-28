/**
 * `@adonis-agora/agent/guardrails` — PII, secret, prompt-injection and tool-poisoning detection, a
 * rule engine with reversible redaction, and the adapter onto the agent loop's processor seams.
 *
 * A port of `@dudousxd/nestjs-agent-core/guardrails` (the reference implementation, see PARITY.md):
 * the detectors and the engine are the same code. The provider wire-format helpers and the SSE
 * `StreamGuard` live only there, since nothing in this package proxies raw provider traffic.
 */

export {
  type AgentGuardContext,
  createGuardrails,
  GuardrailBlockedError,
  type GuardrailEvent,
  type GuardrailEventHit,
  type GuardrailRulesSource,
  Guardrails,
  type GuardrailsOptions,
  type InjectionShorthand,
  InMemoryVaultStore,
  type PiiShorthand,
  type SecretsShorthand,
  screenToolDefinition,
  shorthandRules,
  type ToolPoisoningShorthand,
  type VaultStore,
} from './agent.js';
export { compileGuardPattern, detectKeywords, detectRegex, fold } from './detectors/custom.js';
export {
  decodeTagChars,
  INJECTION_SIGNALS,
  type InjectionResult,
  type Signal,
  scoreInjection,
} from './detectors/injection.js';
export {
  cardBrand,
  cnpjValid,
  cpfValid,
  detectPii,
  ibanValid,
  isIPv4,
  luhnValid,
  phoneValid,
  ssnValid,
} from './detectors/pii.js';
export { detectSecrets, entropy } from './detectors/secrets.js';
export {
  type PoisoningResult,
  scoreToolText,
  type ToolDefinitionText,
  toolText,
} from './detectors/tool-poisoning.js';
export {
  applyRedactions,
  DEFAULT_APPROVAL_MESSAGE,
  DEFAULT_MESSAGES,
  type GuardHit,
  INJECTION_REPLACEMENT,
  orderRules,
  resolveOverlaps,
  ruleApplies,
  runDetector,
  type ScanOptions,
  type ScanResult,
  scan,
  spanLocator,
} from './engine.js';
export { globToRegExp, matchesAny } from './glob.js';
export { jsonSlots, type Slot } from './segments.js';
export {
  ACTION_SEVERITY,
  type CustomDetector,
  type DetectorKind,
  type DetectorSpec,
  type Finding,
  GUARDRAIL_STAGES,
  type GuardContext,
  type GuardrailAction,
  type GuardrailMatch,
  type GuardrailOptions,
  type GuardrailRule,
  type GuardrailStage,
  PII_TYPES,
  type PiiType,
  SECRET_TYPES,
  type SecretType,
  type Segment,
  type SegmentSource,
} from './types.js';
export { labelFor, Vault, type VaultSnapshot } from './vault.js';
