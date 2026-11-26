// Meetings (SERRA-62, SERRA-69), on the services in src/meeting-store.ts, src/meeting-settings.ts and
// src/meeting-runs.ts. Handlers only check input and call them. Approving, discarding and forgetting are the owner's,
// here in the app. `sources` reads files only (with the last Test's answers, kept by `testSource`); a model call happens
// only in `testSource`, on the owner's button.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { profileT3Bin } from '../../../src/cleanup.ts';
import { readProfileFile } from '../../../src/config.ts';
import { isRecord } from '../../../src/json-guards.ts';
import { errorMessage, shortError } from '../../../src/lib/errors.ts';
import { createMeetingStore, type MeetingReviewed } from '../../../src/meeting-store.ts';
import { MEETING_NOTICE, readMeetingSettings, writeMeetingSettings } from '../../../src/meeting-settings.ts';
import { createMeetingRuns, meetingRunner, runnerIdentity } from '../../../src/meeting-runs.ts';
import { saveSourceTest, sourceStatuses } from '../../../src/meeting-source-tests.ts';
import { PROVIDER_IDS, type MeetingProvider } from '../../../src/meeting-sources.ts';
import { readT3Providers } from '../../../src/t3-providers.ts';
import {
  addCustomAcpAgent, agentBackendConfigError, agentBackendPath, agentChoices, ensureAgentBackendFile,
  readAgentBackend, removeCustomAcpAgent, writeAgentBackend, type AgentBackendView,
} from '../../../src/agent/acp-agents.ts';
import { acpRunner, chosenAcpAgent, chosenBackend } from '../../../src/agent/select.ts';
import { toolSearchPath } from '../../../src/shell-path.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

const id = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !/^[\w-]{1,40}$/.test(value)) throw new Error(`${what} is missing.`);
  return value;
};

const reviewedInput = (value: unknown): MeetingReviewed => {
  if (!isRecord(value) || typeof value.rendered !== 'string' || typeof value.evidence !== 'string' || (value.page !== null && typeof value.page !== 'string')) {
    throw new Error('Review the edit in the app before approving it.');
  }
  return { rendered: value.rendered, page: value.page, evidence: value.evidence };
};

const source = (value: unknown): MeetingProvider => {
  const found = PROVIDER_IDS.find((entry) => entry === value);
  if (!found) throw new Error('Pick Granola or Google Meet.');
  return found;
};

/** Tests swap the T3 runs, T3 settings reader and tool search PATH. */
export interface MeetingsHandlerOptions {
  runs?: typeof createMeetingRuns;
  readProviders?: typeof readT3Providers;
  searchPath?: () => Promise<string>;
}

export const meetingsHandlers = (context: HandlerContext, options: MeetingsHandlerOptions = {}): Handlers<'meetings'> => {
  const makeRuns = options.runs ?? createMeetingRuns;
  const readProviders = options.readProviders ?? readT3Providers;
  const searchPath = options.searchPath ?? toolSearchPath;
  const worker = () => readProfileFile(context.profileDir()).worker;
  // A new service per call: the profile folder can change while the app runs.
  const store = () => createMeetingStore({ knowledgeDir: join(context.profileDir(), 'knowledge') });
  const settings = () => ({ ...readMeetingSettings(context.profileDir()), notice: MEETING_NOTICE });
  const backendView = async (profileDir: string, path?: string): Promise<AgentBackendView> => {
    const current = readAgentBackend(profileDir);
    return {
      backend: current.backend, agent: current.agent,
      agents: agentChoices(current, path ?? await searchPath()), models: current.models,
      configPath: agentBackendPath(profileDir), configError: agentBackendConfigError(profileDir),
    };
  };
  return {
    settings,
    setEnabled: (enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('Turn meeting capture on or off.');
      writeMeetingSettings(context.profileDir(), enabled);
      return settings();
    },
    sources: async () => {
      const t3Bin = profileT3Bin(context.profileDir());
      const chosen = worker();
      let agent: ReturnType<typeof chosenAcpAgent>;
      try { agent = chosenAcpAgent(context.profileDir()); } catch (error) {
        return { runner: { label: 'ACP agent', model: null, ready: false, detail: errorMessage(error) }, sources: sourceStatuses(context.profileDir(), { instance: 'acp:', model: null }) };
      }
      if (agent) return { runner: await acpRunner(agent), sources: sourceStatuses(context.profileDir(), { instance: `acp:${agent.id}`, model: null }) };
      const t3 = readProviders();
      return {
        runner: meetingRunner(chosen, t3, existsSync(t3Bin)),
        sources: sourceStatuses(context.profileDir(), runnerIdentity(chosen, t3)),
      };
    },
    testSource: (provider) => {
      const chosen = worker();
      const profileDir = context.profileDir();
      // The runner as the test starts, so a default changed mid-run can't claim this answer.
      let agent: ReturnType<typeof chosenAcpAgent>;
      try { agent = chosenAcpAgent(profileDir); } catch (error) { throw new Error(shortError(error)); }
      const runner = agent ? { instance: `acp:${agent.id}`, model: null } : runnerIdentity(chosen, readProviders());
      return makeRuns({
        t3Bin: profileT3Bin(profileDir),
        ...(chosen?.provider ? { provider: chosen.provider } : {}), ...(chosen?.model ? { model: chosen.model } : {}),
        ...(agent ? { backend: () => chosenBackend(profileDir, { t3Bin: profileT3Bin(profileDir) }) } : {}),
      }).checkSource(source(provider)).then((result) => saveSourceTest(profileDir, result, runner)).catch((error: unknown) => {
        // The screen gets a short reason; the full one (a command's output, paths) stays in the app's log.
        console.error(`[serra] meetings test failed: ${errorMessage(error)}`);
        throw new Error(shortError(error));
      });
    },
    agentBackend: async (): Promise<AgentBackendView> => backendView(context.profileDir()),
    setAgentBackend: async (choice): Promise<AgentBackendView> => {
      if (!isRecord(choice) || (choice.backend !== 't3' && choice.backend !== 'acp')) throw new Error('Pick T3 or an ACP agent.');
      const agent = choice.backend === 'acp' ? id(choice.agent, 'ACP agent') : null;
      const profileDir = context.profileDir();
      const path = await searchPath();
      const current = readAgentBackend(profileDir);
      if (agent && !agentChoices(current, path).some((entry) => entry.id === agent && entry.installed)) throw new Error('That ACP agent isn’t installed on this Mac.');
      if (choice.model !== undefined && typeof choice.model !== 'string') throw new Error('That isn’t a model name.');
      writeAgentBackend(profileDir, { backend: choice.backend, agent, ...(typeof choice.model === 'string' ? { model: choice.model } : {}) });
      return backendView(profileDir, path);
    },
    addAcpAgent: async (input): Promise<AgentBackendView> => {
      if (!isRecord(input) || typeof input.name !== 'string' || typeof input.command !== 'string') {
        throw new Error('Enter a name and command for the ACP agent.');
      }
      if (input.id !== undefined && typeof input.id !== 'string') throw new Error('Invalid agent ID.');
      if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((arg) => typeof arg !== 'string'))) {
        throw new Error('Arguments must be a list of strings.');
      }
      const args = Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === 'string') : [];
      const profileDir = context.profileDir();
      addCustomAcpAgent(profileDir, {
        ...(typeof input.id === 'string' ? { id: input.id } : {}),
        name: input.name,
        command: input.command,
        args,
      });
      return backendView(profileDir);
    },
    removeAcpAgent: async (agentId): Promise<AgentBackendView> => {
      const profileDir = context.profileDir();
      removeCustomAcpAgent(profileDir, id(agentId, 'ACP agent'));
      return backendView(profileDir);
    },
    openAgentBackendConfig: async () => {
      const file = ensureAgentBackendFile(context.profileDir());
      await context.openPath(file);
    },
    list: () => store().listMeetings(),
    history: () => store().history(),
    approve: (meeting, item, reviewed) => store().approve(id(meeting, 'Meeting'), id(item, 'Edit'), reviewedInput(reviewed)),
    discard: (meeting, item) => { store().discard(id(meeting, 'Meeting'), id(item, 'Edit')); },
    discardMeeting: (meeting) => { store().discardMeeting(id(meeting, 'Meeting')); },
    forget: (meeting) => store().forget(id(meeting, 'Meeting')),
  };
};
