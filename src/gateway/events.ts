// The gateway's event log: every push from the server's profiles, numbered. A Mac that loses its connection comes
// back with the last number it saw and gets what it missed, in order; one that was away longer than the log keeps
// is told to reload (`reset`) instead of seeing a gap.

export interface GatewayEvent {
  seq: number;
  /** The profile's folder name on the server, or null for the server itself. */
  profile: string | null;
  channel: string;
  payload: unknown;
}

export interface EventLog {
  publish(profile: string | null, channel: string, payload: unknown): GatewayEvent;
  /** The events after `seq`, or null when some of them are no longer kept. */
  since(seq: number): GatewayEvent[] | null;
  /** The newest number given out, 0 before the first event. */
  last(): number;
  subscribe(listener: (event: GatewayEvent) => void): () => void;
}

export const eventLog = (keep = 500): EventLog => {
  const events: GatewayEvent[] = [];
  const listeners = new Set<(event: GatewayEvent) => void>();
  let seq = 0;
  return {
    publish(profile, channel, payload) {
      const event = { seq: ++seq, profile, channel, payload };
      events.push(event);
      if (events.length > keep) events.splice(0, events.length - keep);
      for (const listener of [...listeners]) {
        try { listener(event); } catch { /* one stream's failure is not the others' */ }
      }
      return event;
    },
    since(after) {
      if (after >= seq) return [];
      const oldest = events[0]?.seq ?? seq + 1;
      if (after < oldest - 1) return null;
      return events.filter((event) => event.seq > after);
    },
    last: () => seq,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
};
