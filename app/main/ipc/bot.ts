// The daemon. Status comes from the profile's status socket (APP-6's client, see `status.ts`); start, stop and
// restart go through `src/bot-service.ts`, which drives launchd through `deploy.ts` (APP-11).
import { restartBot, startBot, stopBot } from '../../../src/bot-service.ts';
import type { Handlers } from '../bridge.ts';
import type { HandlerContext } from './context.ts';

/** The service calls, replaceable in tests. */
export interface BotService {
  start(profileDir: string): Promise<void>;
  stop(profileDir: string): Promise<void>;
  restart(profileDir: string): Promise<void>;
}

const launchdService: BotService = { start: startBot, stop: stopBot, restart: restartBot };

/**
 * One start, stop or restart at a time: the window and the menubar share these handlers, and a second click while
 * launchd is still working gets a message instead of a second bootout.
 */
export const botHandlers = (context: HandlerContext, service: BotService = launchdService): Handlers<'bot'> => {
  let busy = false;
  const exclusive = (action: keyof BotService) => async (): Promise<void> => {
    if (context.runtime.platform !== 'darwin') throw new Error('Starting and stopping the bot needs launchd, so it works on macOS only.');
    const profileDir = context.profileDir();
    if (busy) throw new Error('The bot is already starting, stopping or restarting. Try again when that finishes.');
    busy = true;
    try { await service[action](profileDir); }
    finally { busy = false; }
  };
  return {
    // Right after a profile switch the source says `stopped` until the new daemon answers; wait a moment for it.
    status: async () => { await context.status.settled?.(1_500); return context.status.current(); },
    start: exclusive('start'),
    stop: exclusive('stop'),
    restart: exclusive('restart'),
  };
};
