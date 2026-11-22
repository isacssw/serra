// The settings pages' rules, kept free of React and Node so `node --test` and the renderer share them.
//
// Each form turns the owner's text into a profile section and says what is wrong field by field. These checks give
// quick, specific messages while typing; they are not the gate. Main saves through APP-4's `updateProfileSection`,
// which runs `validateProfile` on the whole profile before anything reaches disk.
import type { AppliesWhen, BotStatus, MessageTrigger, Profile, ProfileSection, Repository } from '../../../../src/contracts.ts';

// ---------------------------------------------------------------------------------------------------------------
// When a change applies
// ---------------------------------------------------------------------------------------------------------------

export type AppliesTone = 'up' | 'neutral';

/** The badge text next to a section. Same wording as the CLI (`appliesLabel` in src/profile-settings.ts). */
export const appliesLabel = (when: AppliesWhen): string =>
  when === 'now' ? 'Applies now' : when === 'next job' ? 'Applies on the next job' : 'Applies after a restart';

/** Live changes read green; the rest are neutral, and the restart banner calls out what is still waiting. */
export const appliesTone = (when: AppliesWhen): AppliesTone => (when === 'now' ? 'up' : 'neutral');

/** One save of a section that only takes effect when the daemon starts again. */
export interface RestartSave { section: ProfileSection; savedAt: string }

/**
 * The saved sections the running daemon hasn't picked up: saved after it started. A stopped daemon reads the file
 * when it starts, so nothing is pending then. Unknown status (not reported yet) keeps every save pending.
 */
export const pendingRestart = (saves: readonly RestartSave[], status: BotStatus | null): ProfileSection[] => {
  if (status?.state === 'stopped') return [];
  const started = status ? Date.parse(status.startedAt) : Number.NEGATIVE_INFINITY;
  const pending = saves.filter((save) => Date.parse(save.savedAt) >= started).map((save) => save.section);
  return [...new Set(pending)];
};

/** "Bot, owner and worker" for the restart banner. */
export const sectionList = (sections: readonly ProfileSection[]): string => {
  const names = sections.map((section) => sectionTitles[section]);
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
};

export const sectionTitles: Record<ProfileSection, string> = {
  bot: 'Bot',
  owner: 'Owner',
  project: 'Main project',
  allowedUsers: 'Allowed people',
  messageTriggers: 'Alert triggers',
  review: 'Review channel',
  repositories: 'Other repositories',
  worker: 'Worker',
  serviceLabel: 'Service label',
  t3Bin: 'T3 command',
  branchPattern: 'Task branches',
  updates: 'Developer: update from a checkout',
};

// ---------------------------------------------------------------------------------------------------------------
// Field checks. Each returns the message to show under the field, or null when the value is fine.
// ---------------------------------------------------------------------------------------------------------------

export type Problem = string | null;

const MEMBER_ID = /^[UW][A-Z0-9]+$/;
const CHANNEL_ID = /^[CG][A-Z0-9]+$/;
const SLACK_BOT_ID = /^B[A-Z0-9]+$/;
const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;

/** Required single-line text, as `validateProfile` wants every string field. */
const textProblem = (value: string, label: string): Problem => {
  if (!value.trim()) return `${label} is required.`;
  if (/[\r\n\0]/.test(value)) return `${label} must be one line.`;
  return null;
};

export const memberIdProblem = (value: string): Problem => {
  const id = value.trim();
  if (!id) return 'Enter a Slack member ID.';
  if (!MEMBER_ID.test(id)) return 'Not a Slack member ID. Member IDs start with U or W, like U0123456789.';
  return null;
};

export const channelIdProblem = (value: string): Problem => {
  const id = value.trim();
  if (!id) return 'Enter a Slack channel ID.';
  if (!CHANNEL_ID.test(id)) return 'Not a Slack channel ID. Channel IDs start with C or G, like C0123456789 (not #name).';
  return null;
};

const botIdProblem = (value: string): Problem => {
  if (!value.trim()) return 'Bot id is required.';
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(value)) return 'Start with a lowercase letter and use up to 48 lowercase letters, digits or hyphens.';
  return null;
};

const absolutePathProblem = (value: string, label: string, example = '/Users/you/project'): Problem =>
  textProblem(value, label) ?? (value.startsWith('/') ? null : `${label} must be an absolute path, like ${example}.`);

const githubRepoProblem = (value: string): Problem => {
  if (!value.trim()) return 'Enter a GitHub repository.';
  if (!GITHUB_REPO.test(value.trim())) return 'Use owner/name, like acme/project.';
  return null;
};

const githubLoginProblem = (value: string): Problem =>
  textProblem(value, 'GitHub login') ?? (/^[\w-]+$/.test(value) ? null : 'Use letters, digits, underscores and hyphens only.');

/** Values that become command-line arguments must not read as flags. */
const notFlagProblem = (value: string, label: string): Problem =>
  textProblem(value, label) ?? (value.startsWith('-') ? `${label} can't start with a hyphen.` : null);

const serviceLabelProblem = (value: string): Problem =>
  textProblem(value, 'Service label') ?? (/^[a-zA-Z0-9][a-zA-Z0-9.-]+$/.test(value) ? null : 'Use letters, digits, dots and hyphens, like dev.serra.mybot.');

/** The quick part of `branchPatternProblem`; the full Git-name check runs when saving. */
const branchPatternFieldProblem = (value: string): Problem => {
  if (/[\r\n\0]/.test(value)) return 'The pattern must be one line.';
  if (!value.includes('{slug}') || !value.includes('{stamp}')) return 'Include {slug} and {stamp}, so two jobs never share a branch.';
  return null;
};

// ---------------------------------------------------------------------------------------------------------------
// Forms for sections made of text fields
// ---------------------------------------------------------------------------------------------------------------

export type FormValues = Record<string, string>;
export type FieldErrors = Record<string, string>;

interface FieldSpec {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  /** Long text gets a multi-line box. */
  multiline?: boolean;
}

/**
 * One section edited as text fields. `parse` returns the section's new value (or `undefined` to remove an optional
 * section) and the problems by field. A form with problems is never sent to main.
 */
export interface SectionForm<S extends ProfileSection = ProfileSection> {
  section: S;
  description: string;
  fields: FieldSpec[];
  toForm(profile: Profile): FormValues;
  parse(form: FormValues): { value: Profile[S] | undefined; errors: FieldErrors };
}

const collect = (checks: Record<string, Problem>): FieldErrors =>
  Object.fromEntries(Object.entries(checks).filter((entry): entry is [string, string] => entry[1] !== null));

/** Repositories typed one per line or separated by commas. */
const splitList = (text: string): string[] => text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);

const optional = (value: string | undefined): string => value ?? '';

export const botForm: SectionForm<'bot'> = {
  section: 'bot',
  description: 'How the bot names itself in Slack and on disk.',
  fields: [
    { key: 'name', label: 'Display name', placeholder: 'Friday' },
    { key: 'id', label: 'Bot id', hint: 'Names the background service and job branches.', placeholder: 'friday' },
  ],
  toForm: (profile) => ({ name: profile.bot.name, id: profile.bot.id }),
  parse: (form) => {
    const value = { id: form.id ?? '', name: form.name ?? '' };
    return { value, errors: collect({ name: textProblem(value.name, 'Display name'), id: botIdProblem(value.id) }) };
  },
};

export const ownerForm: SectionForm<'owner'> = {
  section: 'owner',
  description: 'The person the bot works for. The owner always has access.',
  fields: [
    { key: 'name', label: 'Name' },
    { key: 'slackUserId', label: 'Slack member ID', placeholder: 'U0123456789' },
    { key: 'githubLogin', label: 'GitHub login' },
  ],
  toForm: (profile) => ({ ...profile.owner }),
  parse: (form) => {
    const value = { name: form.name ?? '', slackUserId: (form.slackUserId ?? '').trim(), githubLogin: form.githubLogin ?? '' };
    return {
      value,
      errors: collect({ name: textProblem(value.name, 'Name'), slackUserId: memberIdProblem(value.slackUserId), githubLogin: githubLoginProblem(value.githubLogin) }),
    };
  },
};

export const reviewForm: SectionForm<'review'> = {
  section: 'review',
  description: 'Where the bot posts pull requests for review. Leave both empty to turn review posting off.',
  fields: [
    { key: 'channel', label: 'Review channel ID', placeholder: 'C0123456789' },
    { key: 'repositories', label: 'Repositories it may post', hint: 'One per line or comma separated.', placeholder: 'acme/project', multiline: true },
  ],
  toForm: (profile) => ({ channel: optional(profile.review?.channel), repositories: (profile.review?.repositories ?? []).join('\n') }),
  parse: (form) => {
    const channel = (form.channel ?? '').trim();
    const repositories = splitList(form.repositories ?? '');
    if (!channel && !repositories.length) return { value: undefined, errors: {} };
    const repoProblem = repositories.length
      ? repositories.map(githubRepoProblem).find((problem) => problem !== null) ?? null
      : 'Add at least one repository, or clear the channel to turn review posting off.';
    return { value: { channel, repositories }, errors: collect({ channel: channelIdProblem(channel), repositories: repoProblem }) };
  },
};

export const serviceLabelForm: SectionForm<'serviceLabel'> = {
  section: 'serviceLabel',
  description: 'The launchd label of the background service. Empty uses dev.serra.<bot id>.',
  fields: [{ key: 'serviceLabel', label: 'Service label', placeholder: 'dev.serra.friday' }],
  toForm: (profile) => ({ serviceLabel: optional(profile.serviceLabel) }),
  parse: (form) => {
    const value = (form.serviceLabel ?? '').trim();
    if (!value) return { value: undefined, errors: {} };
    return { value, errors: collect({ serviceLabel: serviceLabelProblem(value) }) };
  },
};

export const projectForm: SectionForm<'project'> = {
  section: 'project',
  description: 'The repository jobs start in.',
  fields: [
    { key: 'path', label: 'Local path', placeholder: '/Users/you/project' },
    { key: 'githubRepo', label: 'GitHub repository', placeholder: 'acme/project' },
    { key: 'remote', label: 'Remote', placeholder: 'origin' },
    { key: 'baseRef', label: 'Base ref', hint: 'Where new task branches start.', placeholder: 'origin/main' },
  ],
  toForm: (profile) => ({ ...profile.project }),
  parse: (form) => {
    const value = { path: form.path ?? '', remote: form.remote ?? '', baseRef: form.baseRef ?? '', githubRepo: (form.githubRepo ?? '').trim() };
    return {
      value,
      errors: collect({
        path: absolutePathProblem(value.path, 'Local path'),
        githubRepo: githubRepoProblem(value.githubRepo),
        remote: notFlagProblem(value.remote, 'Remote'),
        baseRef: notFlagProblem(value.baseRef, 'Base ref'),
      }),
    };
  },
};

export const workerForm: SectionForm<'worker'> = {
  section: 'worker',
  description: 'The T3 provider instance and model that run jobs. Leave both empty to use the project default in T3.',
  fields: [
    { key: 'provider', label: 'Provider instance', hint: 'Optional.' },
    { key: 'model', label: 'Model' },
  ],
  toForm: (profile) => ({ provider: optional(profile.worker?.provider), model: optional(profile.worker?.model) }),
  parse: (form) => {
    const provider = (form.provider ?? '').trim();
    const model = (form.model ?? '').trim();
    if (!provider && !model) return { value: undefined, errors: {} };
    return {
      value: provider ? { provider, model } : { model },
      errors: collect({ model: notFlagProblem(model, 'Model'), provider: provider ? notFlagProblem(provider, 'Provider instance') : null }),
    };
  },
};

export const branchPatternForm: SectionForm<'branchPattern'> = {
  section: 'branchPattern',
  description: 'How task branches are named. Placeholders: {id}, {slug}, {stamp}, {DDMM}, {MMDD}. Empty uses {id}/{slug}-{stamp}.',
  fields: [{ key: 'branchPattern', label: 'Branch pattern', placeholder: '{id}/{slug}-{stamp}' }],
  toForm: (profile) => ({ branchPattern: optional(profile.branchPattern) }),
  parse: (form) => {
    const value = (form.branchPattern ?? '').trim();
    if (!value) return { value: undefined, errors: {} };
    return { value, errors: collect({ branchPattern: branchPatternFieldProblem(value) }) };
  },
};

export const t3BinForm: SectionForm<'t3Bin'> = {
  section: 't3Bin',
  description: 'The t3 command the bot runs. Empty uses T3_BIN or ~/.t3/bin/t3.',
  fields: [{ key: 't3Bin', label: 'T3 command path', placeholder: '/Users/you/.t3/bin/t3' }],
  toForm: (profile) => ({ t3Bin: optional(profile.t3Bin) }),
  parse: (form) => {
    const value = (form.t3Bin ?? '').trim();
    if (!value) return { value: undefined, errors: {} };
    return { value, errors: collect({ t3Bin: absolutePathProblem(value, 'T3 command path', '/Users/you/.t3/bin/t3') }) };
  },
};

export const updatesForm: SectionForm<'updates'> = {
  section: 'updates',
  description: 'For working on Serra itself. Set a clone of the Serra repository and Updates switches to developer mode: it lists new commits on the branch, and you build the bot from the clone and restart it by hand. Leave empty to update from GitHub Releases, with the bot following the app.',
  fields: [
    { key: 'source', label: 'Checkout path', placeholder: '/Users/you/git/serra' },
    { key: 'ref', label: 'Branch', hint: 'Empty uses origin/main.', placeholder: 'origin/main' },
  ],
  toForm: (profile) => ({ source: optional(profile.updates?.source), ref: optional(profile.updates?.ref) }),
  parse: (form) => {
    const source = (form.source ?? '').trim();
    const ref = (form.ref ?? '').trim();
    if (!source && !ref) return { value: undefined, errors: {} };
    return {
      value: ref ? { source, ref } : { source },
      errors: collect({ source: absolutePathProblem(source, 'Checkout path', '/Users/you/git/serra'), ref: ref ? notFlagProblem(ref, 'Branch') : null }),
    };
  },
};

/** True when the form would save something different from what the profile has. */
export const formChanged = (form: SectionForm, profile: Profile, values: FormValues): boolean => {
  const current = (profile as unknown as Record<string, unknown>)[form.section];
  return JSON.stringify(form.parse(values).value) !== JSON.stringify(current);
};

// ---------------------------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------------------------

export interface PersonRow {
  slackUserId: string;
  access: 'owner' | 'allowed';
  /** Only the owner's name is in the profile. Allowed people are shown by member ID; nothing looks names up. */
  name: string | null;
}

/** The owner first (always allowed, listed or not), then allowed people in file order, without repeats. */
export const peopleRows = (profile: Profile): PersonRow[] => {
  const owner = profile.owner.slackUserId;
  return [
    { slackUserId: owner, access: 'owner', name: profile.owner.name },
    ...[...new Set(profile.allowedUsers)].filter((id) => id !== owner).map((id): PersonRow => ({ slackUserId: id, access: 'allowed', name: null })),
  ];
};

/** Why the Add person field can't be added as typed, or null. */
export const addPersonProblem = (input: string, profile: Profile): Problem => {
  const problem = memberIdProblem(input);
  if (problem) return problem;
  const id = input.trim();
  if (id === profile.owner.slackUserId) return 'That is the owner, who always has access.';
  if (profile.allowedUsers.includes(id)) return 'Already allowed.';
  return null;
};

/** Slack member IDs are at least nine characters (U plus eight). */
const MIN_MEMBER_ID_LENGTH = 9;

/**
 * What the Add person field shows while the owner types: nothing for an empty field or a member ID still being
 * typed, a format message as soon as the text can't become one, and the full check once it is ID-length.
 */
export const addPersonFieldMessage = (input: string, profile: Profile): Problem => {
  const id = input.trim();
  if (!id) return null;
  if (!/^[UW][A-Z0-9]*$/.test(id)) return memberIdProblem(id);
  return id.length < MIN_MEMBER_ID_LENGTH ? null : addPersonProblem(id, profile);
};

// ---------------------------------------------------------------------------------------------------------------
// Lists: other repositories and alert triggers
// ---------------------------------------------------------------------------------------------------------------

export interface RepositoryRow { name: string; path: string; baseRef: string; githubRepo: string }

export const repositoryRows = (profile: Profile): RepositoryRow[] =>
  (profile.repositories ?? []).map((repo) => ({ name: repo.name, path: repo.path, baseRef: repo.baseRef, githubRepo: optional(repo.githubRepo) }));

export const emptyRepositoryRow = (): RepositoryRow => ({ name: '', path: '', baseRef: 'origin/main', githubRepo: '' });

/** The `repositories` section from its rows (none removes it) and problems keyed `<row>.<field>`. */
export const parseRepositories = (rows: readonly RepositoryRow[]): { value: Repository[] | undefined; errors: FieldErrors } => {
  const errors: FieldErrors = {};
  const value = rows.map((row, index): Repository => {
    const githubRepo = row.githubRepo.trim();
    Object.assign(errors, Object.fromEntries(Object.entries(collect({
      name: textProblem(row.name, 'Name'),
      path: absolutePathProblem(row.path, 'Path'),
      baseRef: notFlagProblem(row.baseRef, 'Base ref'),
      githubRepo: githubRepo ? githubRepoProblem(githubRepo) : null,
    })).map(([field, message]) => [`${index}.${field}`, message])));
    return { name: row.name.trim(), path: row.path.trim(), baseRef: row.baseRef.trim(), ...(githubRepo ? { githubRepo } : {}) };
  });
  return { value: value.length ? value : undefined, errors };
};

/** Which messages a trigger answers in its channel. */
export type TriggerSource = 'any' | 'bot' | 'user';

export interface TriggerRow { channel: string; source: TriggerSource; sourceId: string; instructions: string }

export const triggerRows = (profile: Profile): TriggerRow[] =>
  (profile.messageTriggers ?? []).map((trigger) => ({
    channel: trigger.channel,
    source: trigger.botId ? 'bot' : trigger.userId ? 'user' : 'any',
    sourceId: trigger.botId ?? trigger.userId ?? '',
    instructions: trigger.instructions,
  }));

export const emptyTriggerRow = (): TriggerRow => ({ channel: '', source: 'bot', sourceId: '', instructions: '' });

export const MAX_INSTRUCTIONS = 10_000;

/** The `messageTriggers` section from its rows and problems keyed `<row>.<field>`, including repeated sources. */
export const parseTriggers = (rows: readonly TriggerRow[]): { value: MessageTrigger[] | undefined; errors: FieldErrors } => {
  const errors: FieldErrors = {};
  const seen = new Set<string>();
  const value = rows.map((row, index): MessageTrigger => {
    const channel = row.channel.trim();
    const sourceId = row.source === 'any' ? '' : row.sourceId.trim();
    const sourceProblem = row.source === 'bot'
      ? (SLACK_BOT_ID.test(sourceId) ? null : 'Not a Slack bot ID. Bot IDs start with B, like B0123456789.')
      : row.source === 'user' ? memberIdProblem(sourceId) : null;
    const instructions = row.instructions;
    const instructionsProblem = !instructions.trim() ? 'Tell the worker what to do with these messages.'
      : instructions.length > MAX_INSTRUCTIONS ? `Keep instructions under ${MAX_INSTRUCTIONS} characters.`
        : instructions.includes('\0') ? 'Instructions contain an invalid character.' : null;
    const key = `${channel}:${sourceId || '*'}`;
    const duplicate = channel && seen.has(key) ? 'Another trigger already answers these messages in this channel.' : null;
    seen.add(key);
    Object.assign(errors, Object.fromEntries(Object.entries(collect({
      channel: channelIdProblem(channel) ?? duplicate,
      sourceId: sourceProblem,
      instructions: instructionsProblem,
    })).map(([field, message]) => [`${index}.${field}`, message])));
    return {
      channel,
      ...(row.source === 'bot' ? { botId: sourceId } : row.source === 'user' ? { userId: sourceId } : {}),
      instructions,
    };
  });
  return { value: value.length ? value : undefined, errors };
};
