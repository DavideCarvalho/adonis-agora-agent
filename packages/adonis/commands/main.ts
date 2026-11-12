import { ListLoader } from '@adonisjs/core/ace';
import AgentDoctor from './agent_doctor.js';
import AgoraDoctor from './agora_doctor.js';

/**
 * The commands barrel for `@adonis-agora/agent`, registered in `adonisrc.ts` by `node ace configure
 * @adonis-agora/agent` (`rcFile.addCommand('@adonis-agora/agent/commands')`): `agora:doctor` (the
 * health check every Agora lib ships) and `agent:doctor`.
 */
const loader = new ListLoader([AgoraDoctor, AgentDoctor]);

export const getMetaData = loader.getMetaData.bind(loader);
export const getCommand = loader.getCommand.bind(loader);

export default loader;
