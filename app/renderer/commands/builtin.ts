// The palette's own actions: go to any screen, Restart bot, Open profile folder and Add allowed user.
// Screen tickets register their own actions in their own files (see registry.ts).
import type { AppliesWhen } from '../../../src/contracts.ts';
import type { SerraBridge } from '../../main/bridge.ts';
import { routes, sections } from '../routes.ts';
import type { Action, ActionContext } from './registry.ts';

const PEOPLE_PATH = '/settings/people';

/** The bridge, or the message an action shows outside the app. */
const bridgeOf = (context: ActionContext): SerraBridge => {
  if (!context.bridge) throw new Error('This only works in the Serra app.');
  return context.bridge;
};

/** How a change reads after it is saved, as in the CLI: "Applies now". */
export const appliesText = (when: AppliesWhen): string =>
  when === 'now' ? 'Applies now.' : when === 'next job' ? 'Applies on the next job.' : 'Applies after a restart.';

const sectionHeading = (id: string): string | undefined => sections.find((section) => section.id === id)?.heading ?? undefined;

/** Where a screen's button is: its sidebar item, or the Jobs tab or sidebar button that opens it. */
export const navigationButton = (route: (typeof routes)[number]): string => {
  if (route.id === 'new-task') return 'Sidebar › New task';
  if (route.section === 'jobs') return `Sidebar › Jobs › ${route.label}`;
  return `Sidebar › ${route.label}`;
};

/** One "Go to" action per screen, so every screen is reachable from ⌘K. */
export const navigationActions: Action[] = routes.map((route) => {
  const heading = route.section === 'jobs' ? (route.id === 'new-task' ? undefined : 'Jobs') : sectionHeading(route.section);
  return {
    id: `go:${route.id}`,
    title: route.label,
    group: 'Go to',
    ...(heading ? { hint: heading } : {}),
    keywords: ['go', 'open', 'show', ...(heading ? [heading] : [])],
    button: navigationButton(route),
    ...(route.id === 'new-task' ? { hint: '⌘N' } : route.id === 'settings-bot' ? { hint: 'Settings · ⌘,' } : {}),
    run: (context) => context.navigate(route.path),
  };
});

export const restartBot: Action = {
  id: 'bot:restart',
  title: 'Restart bot',
  group: 'Actions',
  keywords: ['daemon', 'service', 'reload', 'launchd'],
  button: 'Menubar menu › Restart bot, and Restart on settings that apply after a restart',
  run: async (context) => {
    await bridgeOf(context).bot.restart();
    context.toast({ message: 'Bot restarted.', tone: 'success' });
  },
};

export const openProfileFolder: Action = {
  id: 'app:open-profile-folder',
  title: 'Open profile folder',
  group: 'Actions',
  keywords: ['finder', 'files', 'reveal', 'show'],
  button: 'Settings › Bot & Slack › Open profile folder',
  run: async (context) => { await bridgeOf(context).app.openProfileFolder(); },
};

export const addAllowedUser: Action = {
  id: 'people:add',
  title: 'Add allowed user',
  group: 'Actions',
  keywords: ['people', 'person', 'member', 'access', 'invite', 'slack'],
  button: 'Settings › People › Add',
  argument: { placeholder: 'Slack member ID, like U0123456789', hint: 'In Slack: their profile › ⋯ › Copy member ID.' },
  run: async (context, value = '') => {
    const id = value.trim();
    if (id === '') throw new Error('Enter a Slack member ID.');
    const added = await bridgeOf(context).people.add(id);
    context.toast({
      message: added.changed ? `${added.slackUserId} can now use the bot. ${appliesText(added.applies)}` : `${added.slackUserId} already has access.`,
      tone: added.changed ? 'success' : 'info',
      action: { label: 'Show people', onClick: () => context.navigate(PEOPLE_PATH) },
    });
  },
};

/** Everything the palette ships with: the actions first, then navigation. */
export const builtinActions: Action[] = [restartBot, openProfileFolder, addAllowedUser, ...navigationActions];
