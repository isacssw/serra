/**
 * Discord's Gateway: one outbound WebSocket (`wss://gateway.discord.gg`) that brings Serra its messages and button
 * presses, the way Slack's Socket Mode does. `@discordjs/ws` keeps it alive: heartbeats, resuming after sleep or a drop,
 * reconnecting. Nothing listens on this machine.
 *
 * Serra asks for four intents: servers (for threads), server messages, DMs, and Message Content, without which a
 * follow-up in a thread arrives empty. Never members or presences.
 */
import { GatewayIntentBits, type GatewayDispatchPayload } from '@discordjs/core/http-only';
import type { REST } from '@discordjs/rest';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';

export const INTENTS = GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages | GatewayIntentBits.DirectMessages | GatewayIntentBits.MessageContent;

/** Close codes that end the session for good: retrying can't help, and Discord bans a token that keeps trying. */
export const BAD_TOKEN = 4004;
export const DISALLOWED_INTENTS = 4014;
export const FATAL_CLOSES: ReadonlySet<number> = new Set([BAD_TOKEN, 4010, 4011, 4012, 4013, DISALLOWED_INTENTS]);

interface GatewayEvents {
  dispatch(payload: GatewayDispatchPayload): void;
  /** The session is up (identified or resumed). */
  ready(): void;
  /** The socket closed with `code`; the library reconnects by itself unless the code is in `FATAL_CLOSES`. */
  closed(code: number): void;
}

/** What the connection needs from the Gateway. Tests hand in one that plays it (`tests/fakes/discord.ts`). */
export interface DiscordGateway {
  /** Connects, and keeps the session alive until `destroy`. Rejects when the first connection can't be made. */
  connect(events: GatewayEvents): Promise<void>;
  destroy(): Promise<void>;
}

export const createDiscordGateway = (token: () => string, rest: REST): DiscordGateway => {
  let manager: WebSocketManager | null = null;
  return {
    async connect(events) {
      if (manager) await Promise.resolve(manager.destroy()).catch(() => {});
      const next = new WebSocketManager({ token: token(), intents: INTENTS, rest });
      manager = next;
      next.on(WebSocketShardEvents.Dispatch, (payload) => events.dispatch(payload));
      next.on(WebSocketShardEvents.Ready, () => events.ready());
      next.on(WebSocketShardEvents.Resumed, () => events.ready());
      next.on(WebSocketShardEvents.Closed, (code) => events.closed(code));
      // The library reports these and recovers on its own; the close code is what Serra acts on.
      next.on(WebSocketShardEvents.Error, () => {});
      await next.connect();
    },
    async destroy() {
      const current = manager;
      manager = null;
      await current?.destroy({ reason: 'Serra is stopping' });
    },
  };
};
