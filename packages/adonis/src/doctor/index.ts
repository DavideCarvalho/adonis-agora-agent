import type { AgoraDoctorCheck } from './agora_doctor.js';
import { agentDoctorChecks } from './checks.js';

export type {
  AgoraDoctorCheck,
  AgoraDoctorRegistry,
  AgoraDoctorReport,
  AgoraDoctorResult,
  AgoraDoctorStatus,
} from './agora_doctor.js';
export { AGORA_DOCTOR_BINDING, registerDoctorChecks } from './agora_doctor.js';

/**
 * Every agent check, for `node ace agora:doctor --no-boot` (which imports this entry instead of
 * booting the providers). Without a booted app the checks that need the store or the dev tools hub
 * skip.
 */
export const agoraDoctorChecks: AgoraDoctorCheck[] = agentDoctorChecks();
