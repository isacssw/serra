// Setup's logic (APP-27, SERRA-51): the flow's steps and paths, where to resume, how the first screen reads what was
// found, the profile form's checks, and the sidebar's progress. Pure data and functions: imported by `node --test`
// as well as the renderer.
import type { SetupDetection } from '../../main/bridge.ts';
import type { BotStatus, SecretName, SecretStatus } from '../../../src/contracts.ts';
import { isKeychainLocked, isTokenVerdict } from '../../../src/token-errors.ts';
import type { ActivationOutcome } from '../../../src/releases.ts';
import type { ProfileDraft, ProfileSummary, SetupChat, SetupProgress, SetupStepId, TokenSummary } from '../../../src/setup.ts';

/** The setup's start: the welcome, what was found, or a choice between profiles. */
export const SETUP_PATH = '/setup';
export const DONE_PATH = '/setup/done';

export interface FlowStep {
  id: SetupStepId;
  path: string;
  /** The step's heading. */
  title: string;
  /** Its name in the progress rail. */
  short: string;
  /** One short line under the heading, when the title and fields don't already say it. */
  summary?: string;
}

/** The chats setup's first screen offers, as equals, in this order, with no default. */
export const CHAT_CHOICES: readonly { id: SetupChat; name: string; detail: string }[] = [
  { id: 'slack', name: 'Slack', detail: 'In your workspace' },
  { id: 'telegram', name: 'Telegram', detail: 'On your phone' },
  { id: 'discord', name: 'Discord', detail: 'In your community' },
];

export const chatName = (chat: SetupChat): string => CHAT_CHOICES.find((choice) => choice.id === chat)!.name;

/**
 * The first thing to try, as the end of setup and a new bot's Jobs say it: where to reach the bot, and a request.
 * `handle` is the Telegram or Discord bot's username; Slack uses the bot ID it was installed with.
 */
export const firstTry = (chat: SetupChat, botId: string, handle: string | null): { lead: string; example: string } => {
  const name = `@${chat === 'slack' ? botId : handle ?? botId}`;
  if (chat === 'telegram') return { lead: `Message ${name} in Telegram, like`, example: '“what does this repo do?”' };
  if (chat === 'discord') return { lead: `Mention ${name} in Discord, like`, example: `“${name} what does this repo do?”` };
  return { lead: `Invite ${name} to a Slack channel, then try`, example: `“${name} what does this repo do?”` };
};

/** Whether the bot answers and is connected to `chat`: what setup calls running. */
export const chatConnected = (status: BotStatus | null, chat: SetupChat): boolean => {
  if (status?.state !== 'up') return false;
  if (chat === 'slack') return status.slackConnected;
  return status.chats?.some((entry) => entry.kind === chat && entry.connected) === true;
};

const PROFILE_STEP: FlowStep = { id: 'profile', path: '/setup/you', title: 'You and your repository', short: 'You & repo' };
const SERVICE_STEP: FlowStep = { id: 'service', path: '/setup/service', title: 'Install and start', short: 'Install', summary: 'It runs in the background and starts again when you log in.' };

/**
 * The steps for each chat, in order. Slack confirms your member ID before the bot starts; on Telegram and Discord you
 * make the bot yours by messaging it, so that comes once it runs.
 */
const FLOWS: Record<SetupChat, readonly FlowStep[]> = {
  slack: [
    PROFILE_STEP,
    { id: 'chat', path: '/setup/slack', title: 'Connect Slack', short: 'Slack' },
    { id: 'owner', path: '/setup/owner', title: 'Confirm it’s you', short: 'Confirm you', summary: 'Slack checks your member ID.' },
    SERVICE_STEP,
  ],
  telegram: [
    PROFILE_STEP,
    { id: 'chat', path: '/setup/telegram', title: 'Connect Telegram', short: 'Telegram' },
    SERVICE_STEP,
    { id: 'owner', path: '/setup/telegram/yours', title: 'Make it yours', short: 'Make it yours' },
  ],
  discord: [
    PROFILE_STEP,
    { id: 'chat', path: '/setup/discord', title: 'Connect Discord', short: 'Discord' },
    SERVICE_STEP,
    { id: 'owner', path: '/setup/discord/yours', title: 'Make it yours', short: 'Make it yours' },
  ],
};

/** The steps for `chat`; Slack's when it isn't known yet (a profile from before the choice). */
export const flowFor = (chat: SetupChat | null | undefined): readonly FlowStep[] => FLOWS[chat ?? 'slack'];

/** Slack's steps: the flow of every profile set up before the chat choice, and of the CLI. */
export const FLOW: readonly FlowStep[] = FLOWS.slack;

/** How many steps setup has (the same for every chat). */
const STEP_COUNT = FLOW.length;

/** Add… › Profile (SB-10): the new step first, then the profile form for a new profile. */
export const NEW_PROFILE_PATH = '/setup/new';
export const NEW_PROFILE_FORM_PATH = '/setup/new/you';

/** What the new step picked, carried to the form. */
export interface NewProfileChoice {
  name: string; color: string; agent: string | null;
  /** eve on Vercel, Checked, with the host whose notice the owner accepted. Its secret is held apart (eve.logic.ts). */
  eve?: { url: string; team: string; host: string } | null;
}

/** True on the two screens of Add… › Profile, where the rail is the new profile's (nothing done yet), not the one in use. */
export const isNewProfilePath = (path: string): boolean => path === NEW_PROFILE_PATH || path === NEW_PROFILE_FORM_PATH;

export const isSetupPath = (path: string): boolean => path === SETUP_PATH || path.startsWith(`${SETUP_PATH}/`);

const chatOf = (progress: SetupProgress | null): SetupChat => progress?.chat ?? 'slack';

export const pathForStep = (id: SetupStepId, chat: SetupChat = 'slack'): string => flowFor(chat).find((step) => step.id === id)?.path ?? SETUP_PATH;

/** Where to pick up: the first step not done, or the end. */
export const resumePath = (progress: SetupProgress | null): string =>
  !progress ? SETUP_PATH : progress.next ? pathForStep(progress.next, progress.chat) : DONE_PATH;

export const hasProfile = (progress: SetupProgress | null): boolean => progress?.steps[0]?.done === true;

const indexOf = (id: SetupStepId, chat: SetupChat): number => flowFor(chat).findIndex((step) => step.id === id);

/**
 * Whether a step can be opened: one already done, or any up to the first that isn't. Later steps wait, since each
 * needs the one before it (the owner check needs the chat's token; the install's checks need the chat).
 */
export const stepOpen = (progress: SetupProgress | null, id: SetupStepId): boolean => {
  if (id === 'profile') return true;
  if (!progress) return false;
  if (stepDone(progress, id)) return true;
  return progress.next !== null && indexOf(id, chatOf(progress)) <= indexOf(progress.next, chatOf(progress));
};

/** Why a step can't be opened yet, mid-sentence for screen readers ("…, available after Slack"); `capitalize` for a tooltip. */
export const lockedReason = (progress: SetupProgress | null, id: SetupStepId, chat: SetupChat | null = chatOf(progress)): string => {
  const flow = flowFor(chat);
  return `available after ${flow[indexOf(id, chat ?? 'slack') - 1]?.short ?? 'the step before'}`;
};

export const capitalize = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export const stepDone = (progress: SetupProgress | null, id: SetupStepId): boolean =>
  progress?.steps.find((step) => step.id === id)?.done === true;

/** How many steps are done, for the rail and the sidebar's ring. */
export const doneCount = (progress: SetupProgress | null): number => progress?.steps.filter((step) => step.done).length ?? 0;

/** The step a path opens, in whichever chat's flow has it. */
const stepAt = (path: string): { flow: readonly FlowStep[]; index: number } | null => {
  for (const flow of Object.values(FLOWS)) {
    const index = flow.findIndex((step) => step.path === path);
    if (index >= 0) return { flow, index };
  }
  return null;
};

/** What a screen reader hears when a step opens, counted in `chat`'s flow (a shared step like Install sits differently). */
export const announcement = (path: string, chat?: SetupChat | null): string => {
  if (path === DONE_PATH) return 'Setup complete';
  if (isNewProfilePath(path)) return `Step 1 of ${STEP_COUNT}: New profile`;
  const own = flowFor(chat).findIndex((step) => step.path === path);
  const at = own >= 0 ? { flow: flowFor(chat), index: own } : stepAt(path);
  return at ? `Step ${at.index + 1} of ${STEP_COUNT}: ${at.flow[at.index]!.title}` : 'Serra setup';
};

/** The neighbouring paths, for Back and for Continue once a step is done. */
export const previousPath = (path: string, chat: SetupChat = 'slack'): string => {
  const flow = flowFor(chat);
  if (path === DONE_PATH) return flow[flow.length - 1]!.path;
  const index = flow.findIndex((step) => step.path === path);
  return index > 0 ? flow[index - 1]!.path : SETUP_PATH;
};

/** After a step: the next step still to do, or the end. A step already done further on is skipped. */
export const nextPath = (progress: SetupProgress | null, path: string): string => {
  const flow = flowFor(chatOf(progress));
  const index = flow.findIndex((step) => step.path === path);
  const later = flow.slice(index + 1).find((step) => !stepDone(progress, step.id));
  return later ? later.path : progress?.next ? pathForStep(progress.next, chatOf(progress)) : DONE_PATH;
};

// ---------------------------------------------------------------------------------------------------------------
// The first screen
// ---------------------------------------------------------------------------------------------------------------

/** What the first screen shows: a first-time welcome, what was found for the profile in use, or a choice. */
export type StartView = 'fresh' | 'summary' | 'picker';

export const startView = (detection: SetupDetection): StartView => {
  if (detection.selected && hasProfile(detection.selected)) return 'summary';
  return detection.others.some((profile) => hasProfile(profile)) ? 'picker' : 'fresh';
};

export interface SummaryRow { id: SetupStepId; label: string; value: string; done: boolean }

const TOKEN_LABELS: Record<SecretName, string> = { SLACK_BOT_TOKEN: 'bot token', SLACK_APP_TOKEN: 'app token', TELEGRAM_BOT_TOKEN: 'Telegram token', DISCORD_BOT_TOKEN: 'Discord token' };

/** Whether a summary's Slack row has a problem to show: a token Slack refused. */
export const slackRefused = (tokens: readonly TokenSummary[]): boolean =>
  tokens.some((token) => token.state === 'rejected' && isTokenVerdict(token.error));

/** One line for both tokens: connected, found and still to check, or what is missing. */
export const slackLine = (tokens: readonly TokenSummary[], workspace: string | null): string => {
  if (tokens.length && tokens.every((token) => token.state === 'verified')) return workspace ? `Connected to ${workspace}` : 'Connected';
  if (tokens.some((token) => token.state === 'rejected')) {
    return tokens.some((token) => token.state === 'rejected' && isTokenVerdict(token.error)) ? 'Slack didn’t accept a token' : 'Couldn’t check a token';
  }
  const found = tokens.filter((token) => token.state !== 'missing');
  if (found.length === tokens.length && found.length) {
    const where = [...new Set(found.map((token) => token.where))].join(' and ');
    return `${found.length} tokens found in ${where}`;
  }
  const missing = tokens.filter((token) => token.state === 'missing').map((token) => TOKEN_LABELS[token.name]);
  return missing.length ? `No ${missing.join(' or ')} yet` : 'Not connected';
};

/**
 * What the Slack step's "The Slack app" card says: create the app, the tokens are in, or Slack refused them. A refused
 * token means the app may need making or reinstalling again, so the card says so instead of "here".
 */
export const slackAppCard = (tokens: readonly TokenSummary[]): { tone: 'todo' | 'done' | 'problem'; text: string; create: boolean } => {
  const refused = tokens.filter((token) => token.state === 'rejected' && isTokenVerdict(token.error));
  if (refused.length) {
    const which = refused.length === tokens.length && tokens.length > 1 ? 'either token' : `the ${TOKEN_LABELS[refused[0]!.name]}`;
    const paste = refused.length > 1 ? 'Paste new ones' : 'Paste a new one';
    return { tone: 'problem', text: `Slack didn’t accept ${which}. ${paste} below, or create and install the app again.`, create: refused.length === tokens.length };
  }
  if (tokens.length && tokens.every((token) => token.state === 'verified')) return { tone: 'done', text: 'Your Slack app is connected.', create: false };
  if (tokens.length && tokens.every((token) => token.state !== 'missing')) return { tone: 'done', text: 'Your app’s tokens are here.', create: false };
  return { tone: 'todo', text: 'Create Serra’s app and install it to your workspace.', create: true };
};

/** The rows of the "found" card, in step order. */
export const summaryRows = (summary: ProfileSummary): SummaryRow[] => {
  const done = (id: SetupStepId): boolean => stepDone(summary, id);
  const rows: SummaryRow[] = [
    { id: 'profile', label: 'Profile', value: [summary.bot?.name, summary.repo].filter(Boolean).join(' · ') || 'Can’t be read', done: done('profile') },
    {
      id: 'chat', label: chatName(summary.chat), done: done('chat'),
      value: summary.chat === 'slack' ? slackLine(summary.tokens, summary.workspace) : stepDetail(summary, 'chat'),
    },
    {
      id: 'owner', label: 'You', done: done('owner'),
      value: summary.chat !== 'slack' ? stepDetail(summary, 'owner')
        : summary.owner ? (summary.owner.slackName ? `${summary.owner.slackName} · ${summary.owner.slackUserId}` : `${summary.owner.slackUserId}, not confirmed`) : 'Not set',
    },
    // Done once the installed bot has answered (or, for a profile not in use, is installed): the same rule as `next`.
    {
      id: 'service', label: 'Service', done: done('service'),
      value: summary.service === 'running' ? 'Running' : summary.service === 'disconnected' ? `Running, not connected to ${chatName(summary.chat)}`
        : summary.service === 'none' ? 'Not installed' : done('service') ? 'Installed' : 'Installed, hasn’t answered yet',
    },
  ];
  return rows.sort((a, b) => indexOf(a.id, summary.chat) - indexOf(b.id, summary.chat));
};

const stepDetail = (progress: SetupProgress, id: SetupStepId): string => progress.steps.find((step) => step.id === id)?.detail ?? '';

/** The card's headline: how much of setup the profile already has. */
export const foundLine = (summary: ProfileSummary): string => {
  if (summary.service === 'disconnected') return `Set up, but not connected to ${chatName(summary.chat)}.`;
  const done = summaryRows(summary).filter((row) => row.done).length;
  return done === FLOW.length ? 'All set up' : `${done} of ${FLOW.length} done`;
};

/**
 * What a screen that needs a profile shows without one: pick one of the bots already on this Mac (several profiles, no
 * saved choice, as after lost prefs), carry on with the one in use, or set up the first.
 */
export const gateView = (progress: SetupProgress | null, detection: SetupDetection | null): { kind: 'pick'; count: number } | { kind: 'continue' } | { kind: 'setup' } => {
  if (hasProfile(progress)) return { kind: 'continue' };
  const count = detection ? pickable(detection).length : 0;
  return count > 0 ? { kind: 'pick', count } : { kind: 'setup' };
};

/** The profiles to choose between, the one in use first. Profiles that can't be read are left out. */
export const pickable = (detection: SetupDetection): ProfileSummary[] =>
  [detection.selected, ...detection.others].filter((profile): profile is ProfileSummary => profile !== null && hasProfile(profile));

// ---------------------------------------------------------------------------------------------------------------
// The sidebar's "Finish setup" row
// ---------------------------------------------------------------------------------------------------------------

/** The ring's stroke: the done fraction of a circle of radius `r`. */
export const ringDash = (done: number, total: number, r: number): { length: number; dash: string } => {
  const length = 2 * Math.PI * r;
  const filled = total > 0 ? (Math.min(done, total) / total) * length : 0;
  return { length, dash: `${filled.toFixed(2)} ${length.toFixed(2)}` };
};

export const setupRowLabel = (progress: SetupProgress): { text: string; detail: string; aria: string } => {
  const done = doneCount(progress);
  const left = FLOW.length - done;
  return {
    text: done === 0 ? 'Set up Serra' : 'Finish setup',
    detail: `${left} left`,
    aria: `${done === 0 ? 'Set up Serra' : 'Finish setup'}: ${done} of ${FLOW.length} steps done`,
  };
};

// ---------------------------------------------------------------------------------------------------------------
// The profile form
// ---------------------------------------------------------------------------------------------------------------

/** The form as typed. Every field is text so the inputs stay controlled. */
export type DraftForm = Required<Omit<ProfileDraft, 't3Bin' | 'directory' | 'chat' | 'ownerSlackUserId' | 'agent'>> & {
  t3Bin: string; directory: string; ownerSlackUserId: string;
  /** The coding agent picked: 't3', an ACP agent's id, or '' before the agents on this Mac are known. */
  agent: string;
  /** The chat picked on the first screen, or '' before. */
  chat: string;
};

/** The draft's chat, when it names one. */
export const draftChat = (draft: { chat?: string } | null | undefined): SetupChat | null =>
  CHAT_CHOICES.find((choice) => choice.id === draft?.chat)?.id ?? null;

export const emptyDraft = (): DraftForm => ({
  chat: '', agent: '', botName: '', botId: '', ownerName: '', ownerSlackUserId: '', githubLogin: '',
  projectPath: '', remote: 'origin', baseRef: '', githubRepo: '', t3Bin: '', directory: '',
});

/** A saved draft (prefs) over the empty form, keeping only known text fields. */
export const restoreDraft = (saved: Record<string, string> | null | undefined): DraftForm => {
  const draft = emptyDraft();
  if (!saved) return draft;
  for (const key of Object.keys(draft) as (keyof DraftForm)[]) if (typeof saved[key] === 'string') draft[key] = saved[key];
  return draft;
};

/** What to save in prefs: only fields the owner typed (the defaults come back on their own). */
export const draftToSave = (draft: DraftForm): Record<string, string> | null => {
  const saved: Record<string, string> = {};
  const empty = emptyDraft();
  for (const [key, value] of Object.entries(draft) as [keyof DraftForm, string][]) if (value !== empty[key]) saved[key] = value;
  return Object.keys(saved).length ? saved : null;
};

/** A bot ID from a display name, as `pnpm run setup` suggests it. Kept equal to `suggestBotId` in src/setup.ts. */
export const suggestId = (name: string): string => {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return id || 'bot';
};

export type DraftErrors = Partial<Record<keyof DraftForm, string>>;

/** Field messages before anything is sent. Main validates again with `validateProfile`. */
export const draftErrors = (draft: DraftForm): DraftErrors => {
  const errors: DraftErrors = {};
  const id = draft.botId.trim() || suggestId(draft.botName);
  if (!draft.botName.trim()) errors.botName = 'Give the bot a name.';
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(id)) errors.botId = 'Start with a letter; use up to 48 lowercase letters, digits or hyphens.';
  if (!draft.ownerName.trim()) errors.ownerName = 'Enter your name.';
  // Only Slack asks who you are up front; Telegram and Discord learn it when you message the bot.
  if ((draftChat(draft) ?? 'slack') === 'slack' && !/^[UW][A-Z0-9]+$/.test(draft.ownerSlackUserId.trim())) errors.ownerSlackUserId = draft.ownerSlackUserId.trim() ? 'Starts with U, like U0123456789.' : 'Enter your member ID.';
  if (!/^[\w-]+$/.test(draft.githubLogin.trim())) errors.githubLogin = 'Enter your GitHub login.';
  if (!draft.projectPath.trim().startsWith('/')) errors.projectPath = 'Choose the repository’s folder.';
  if (!draft.remote.trim() || draft.remote.trim().startsWith('-')) errors.remote = 'Enter the Git remote, usually origin.';
  if (draft.githubRepo.trim() && !/^[\w.-]+\/[\w.-]+$/.test(draft.githubRepo.trim())) errors.githubRepo = 'Use owner/repo.';
  if (draft.t3Bin.trim() && !draft.t3Bin.trim().startsWith('/')) errors.t3Bin = 'Use an absolute path, or leave empty for ~/.t3/bin/t3.';
  if (draft.directory.trim() && !draft.directory.trim().startsWith('/')) errors.directory = 'Use an absolute path, or leave empty.';
  return errors;
};

/** What Create sends: trimmed, with empty optional fields left out so main fills in its defaults. */
export const draftRequest = (draft: DraftForm): ProfileDraft => {
  const request: Record<string, string> = {};
  for (const [key, value] of Object.entries(draft)) if (value.trim()) request[key] = value.trim();
  return request as unknown as ProfileDraft;
};

/** Where the profile will go, for the hint under the folder field. */
export const profileFolder = (draft: DraftForm, root: string): string =>
  draft.directory.trim() || `${root.replace(/\/+$/, '')}/${draft.botId.trim() || suggestId(draft.botName)}`;

/** A profile folder as the owner reads it: the home folder as `~`. */
export const shortPath = (path: string, home: string): string =>
  home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;

/** How an install outcome reads. */
export const outcomeText = (outcome: ActivationOutcome): { tone: 'up' | 'down'; text: string } => {
  if (outcome.ok) return { tone: 'up', text: 'Installed. Waiting for the bot to answer…' };
  if (outcome.stage === 'checks') return { tone: 'down', text: `Nothing was installed. Fix this and try again: ${outcome.error}` };
  if (outcome.restored) return { tone: 'down', text: `The bot didn’t start, and nothing changed: ${outcome.error}` };
  return { tone: 'down', text: `The bot didn’t start: ${outcome.error}. Open Updates and roll back.` };
};

/** True when the token itself is wrong and needs a new value; false when only the check failed (see src/token-errors.ts). */
export const tokenRefused = (error: string | null): boolean => isTokenVerdict(error);

/** A check error without the token's variable name, its file path or a repeated "Couldn't reach Slack". */
export const plainError = (error: string | null): string => isKeychainLocked(error) ? 'your Keychain is locked. Unlock it, then Check again' : (error ?? 'unknown error')
  .replace(/^Slack rejected SLACK_(BOT|APP)_TOKEN: (ratelimited|rate_limited)$/, 'Slack is busy. Try again in a minute')
  .replace(/^Slack rejected SLACK_(BOT|APP)_TOKEN: (fatal_error|internal_error|service_unavailable|request_timeout)$/, 'Slack had a problem. Try again in a minute')
  .replace(/^Couldn't reach Slack: A rate limit was exceeded.*$/, 'Slack is busy. Try again in a minute')
  .replace(/^Couldn't reach Slack: (A request error occurred: )?(.*)$/, 'Slack is unreachable ($2)')
  .replace(/SLACK_(BOT|APP)_TOKEN from \/\S*\/\.env/, '.env')
  .replace(/^SLACK_(BOT|APP)_TOKEN (from )?/, '');

/** What to do about a token that failed, in plain words. */
const refusedText = (token: TokenSummary): string => {
  const error = token.error ?? '';
  const prefix = token.name === 'SLACK_BOT_TOKEN' ? 'xoxb-' : 'xapp-';
  if (/isn't a real x(?:oxb|app)- token/.test(error)) return `This isn’t an ${prefix} token. Paste the ${token.name === 'SLACK_BOT_TOKEN' ? 'bot' : 'app'} token.`;
  if (/missing_scope/.test(error)) return token.name === 'SLACK_APP_TOKEN'
    ? 'It’s missing the connections:write scope. Generate a new app token with it.'
    : 'It’s missing a scope. Reinstall the app from the manifest, then paste the new token.';
  return 'Slack didn’t accept this token. Paste a new one.';
};

/** A token's state as its row says it. */
export const tokenText = (token: TokenSummary, workspace: string | null): string => {
  switch (token.state) {
    case 'verified': return ['Verified', token.name === 'SLACK_BOT_TOKEN' ? workspace : null, `from ${token.where}`].filter(Boolean).join(' · ');
    case 'found': return `Found in ${token.where}`;
    case 'rejected': return tokenRefused(token.error) ? refusedText(token) : `Couldn’t check it: ${plainError(token.error)}`;
    case 'missing': return 'Not added yet';
  }
};

const WHERE: Record<SecretStatus['source']['kind'], TokenSummary['where']> = { keychain: 'Keychain', '1password': '1Password', env: '.env' };

/** A Secrets status as setup reads it (the same rule as `tokenState` in src/setup.ts). */
export const toToken = (status: SecretStatus): TokenSummary => ({
  name: status.name,
  // A Keychain lookup that failed just now says nothing new: an earlier pass stands, as in setup's progress.
  state: !status.set ? (status.lookupFailed ? (status.verifiedAt ? 'verified' : 'rejected') : 'missing')
    : status.verifiedAt && (!status.error || !isTokenVerdict(status.error)) ? 'verified' : status.error ? 'rejected' : 'found',
  where: WHERE[status.source.kind],
  error: status.error,
});

/** Tokens setup checks on its own when the Slack step opens: found, unchecked, and not in 1Password (no unlock prompt). */
export const tokensToPrecheck = (statuses: readonly SecretStatus[]): SecretName[] =>
  statuses.filter((status) => toToken(status).state === 'found' && status.source.kind !== '1password').map((status) => status.name);
