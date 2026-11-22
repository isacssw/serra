// Meetings (SERRA-62), on the services in src/meeting-store.ts, src/meeting-settings.ts and src/meeting-sources.ts.
// Handlers only check input and call them. Approving, discarding and forgetting are the owner's, here in the app.
import { join } from 'node:path';
import { isRecord } from '../../../src/json-guards.ts';
import { createMeetingStore, type MeetingReviewed } from '../../../src/meeting-store.ts';
import { MEETING_NOTICE, readMeetingSettings, writeMeetingSettings } from '../../../src/meeting-settings.ts';
import { createSourceReader } from '../../../src/meeting-sources.ts';
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

export const meetingsHandlers = (context: HandlerContext): Handlers<'meetings'> => {
  // A new service per call: the profile folder can change while the app runs.
  const store = () => createMeetingStore({ knowledgeDir: join(context.profileDir(), 'knowledge') });
  const settings = () => ({ ...readMeetingSettings(context.profileDir()), notice: MEETING_NOTICE });
  return {
    settings,
    setEnabled: (enabled) => {
      if (typeof enabled !== 'boolean') throw new Error('Turn meeting capture on or off.');
      writeMeetingSettings(context.profileDir(), enabled);
      return settings();
    },
    sources: async () => createSourceReader({ path: await toolSearchPath() }).status(),
    list: () => store().listMeetings(),
    history: () => store().history(),
    approve: (meeting, item, reviewed) => store().approve(id(meeting, 'Meeting'), id(item, 'Edit'), reviewedInput(reviewed)),
    discard: (meeting, item) => { store().discard(id(meeting, 'Meeting'), id(item, 'Edit')); },
    discardMeeting: (meeting) => { store().discardMeeting(id(meeting, 'Meeting')); },
    forget: (meeting) => store().forget(id(meeting, 'Meeting')),
  };
};
