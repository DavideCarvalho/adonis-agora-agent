import { ListLoader } from '@adonisjs/core/ace';
import { AgentApprovalsApprove, AgentApprovalsReject } from './agent_approvals.js';
import {
  AgentPricingList,
  AgentPricingSet,
  AgentQuotaShow,
  AgentTenantsList,
  AgentToolsList,
  AgentToolsStats,
} from './agent_catalog.js';
import AgentDoctor from './agent_doctor.js';
import {
  AgentApprovalsList,
  AgentRunsList,
  AgentRunsShow,
  AgentThreadsList,
  AgentThreadsShow,
  AgentToolCallsList,
} from './agent_runs.js';
import {
  AgentGenuiShow,
  AgentReliabilityShow,
  AgentSpendShow,
  AgentUsageBreakdown,
  AgentUsageTrend,
} from './agent_usage.js';
import AgoraDoctor from './agora_doctor.js';

/**
 * The commands barrel for `@adonis-agora/agent`, registered in `adonisrc.ts` by `node ace configure
 * @adonis-agora/agent` (`rcFile.addCommand('@adonis-agora/agent/commands')`): `agora:doctor` (the
 * health check every Agora lib ships), `agent:doctor`, and the `agent:*` operator commands — what
 * the governance console shows and does, from the shell.
 */
const loader = new ListLoader([
  AgoraDoctor,
  AgentDoctor,
  AgentSpendShow,
  AgentUsageTrend,
  AgentUsageBreakdown,
  AgentReliabilityShow,
  AgentGenuiShow,
  AgentRunsList,
  AgentRunsShow,
  AgentThreadsList,
  AgentThreadsShow,
  AgentToolCallsList,
  AgentApprovalsList,
  AgentApprovalsApprove,
  AgentApprovalsReject,
  AgentQuotaShow,
  AgentToolsList,
  AgentToolsStats,
  AgentPricingList,
  AgentPricingSet,
  AgentTenantsList,
]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
