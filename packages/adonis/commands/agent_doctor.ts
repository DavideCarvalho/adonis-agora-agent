import AgoraDoctor from './agora_doctor.js';

/** `node ace agent:doctor`: `agora:doctor` for the agent's checks only (same flags). */
export default class AgentDoctor extends AgoraDoctor {
  static override commandName = 'agent:doctor';
  static override description = 'Check the @adonis-agora/agent configuration';
  protected override presetLib: string | undefined = 'agent';
}
