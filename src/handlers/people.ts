// People (APP-16): allowing a Slack member, on APP-4's `addAllowedUser`. The ⌘K action and the People screen's
// Add button both call this.
import { addAllowedUser } from '../profile-settings.ts';
import type { Handlers } from '../api.ts';
import type { CoreContext } from './context.ts';

export const peopleHandlers = (context: CoreContext): Handlers<'people'> => ({
  add: (slackUserId) => {
    if (typeof slackUserId !== 'string') throw new Error('Enter a Slack member ID.');
    const change = addAllowedUser(context.profileDir(), slackUserId);
    return { slackUserId: slackUserId.trim(), changed: change.changed, applies: change.appliesWhen };
  },
});
