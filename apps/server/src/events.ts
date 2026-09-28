/**
 * What happened in an office, in order.
 *
 * Every change the API makes is published here with an offset, so a canvas that
 * loses its connection can say what it last saw and be given the rest rather
 * than reloading the world. Offsets count per office: one busy tenant must not
 * make another tenant's client look far behind.
 *
 * History is bounded, so a long-running server cannot be filled by its own
 * event log. A client that has fallen past the kept history is told so — being
 * handed a gap silently is how a canvas ends up quietly wrong.
 */
export interface OfficeEvent {
  readonly offset: number;
  readonly officeId: string;
  readonly at: number;
  readonly data: Readonly<Record<string, unknown>>;
}

export type EventListener = (event: OfficeEvent) => void;

export const DEFAULT_HISTORY_LIMIT = 500;

export interface OfficeEventLogOptions {
  readonly now?: () => number;
  /** Events kept per office for replay. */
  readonly historyLimit?: number;
}

interface OfficeChannel {
  events: OfficeEvent[];
  nextOffset: number;
  readonly listeners: Set<EventListener>;
}

export class OfficeEventLog {
  private readonly channels = new Map<string, OfficeChannel>();
  private readonly now: () => number;
  private readonly historyLimit: number;

  constructor(options: OfficeEventLogOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.historyLimit = Math.max(1, options.historyLimit ?? DEFAULT_HISTORY_LIMIT);
  }

  publish(officeId: string, data: Readonly<Record<string, unknown>>): OfficeEvent {
    const channel = this.channelFor(officeId);
    const event: OfficeEvent = {
      offset: channel.nextOffset,
      officeId,
      at: this.now(),
      data,
    };
    channel.nextOffset += 1;
    channel.events.push(event);
    if (channel.events.length > this.historyLimit) {
      channel.events = channel.events.slice(channel.events.length - this.historyLimit);
    }

    for (const listener of channel.listeners) {
      try {
        listener(event);
      } catch {
        // One broken listener must not stop the others hearing about this.
      }
    }
    return event;
  }

  /** Everything after the offset a client says it has. */
  since(officeId: string, offset: number): readonly OfficeEvent[] {
    return this.channelFor(officeId).events.filter((event) => event.offset > offset);
  }

  /** Whether the kept history still reaches back to where this client left off. */
  canReplayFrom(officeId: string, offset: number): boolean {
    const channel = this.channelFor(officeId);
    const oldest = channel.events[0];
    if (oldest === undefined) return true;
    return offset >= oldest.offset - 1;
  }

  /**
   * Whether this entity changed after the offset a client is working from.
   *
   * When the history no longer reaches that far back it answers true: nobody
   * can prove the client is up to date, and refusing a save it might clobber is
   * the safer of the two wrong answers.
   */
  changedSince(officeId: string, entityId: string, offset: number): boolean {
    if (!this.canReplayFrom(officeId, offset)) return true;
    return this.since(officeId, offset).some((event) => event.data["id"] === entityId);
  }

  subscribe(officeId: string, listener: EventListener): () => void {
    const channel = this.channelFor(officeId);
    channel.listeners.add(listener);
    return () => channel.listeners.delete(listener);
  }

  private channelFor(officeId: string): OfficeChannel {
    const existing = this.channels.get(officeId);
    if (existing !== undefined) return existing;
    const channel: OfficeChannel = { events: [], nextOffset: 1, listeners: new Set() };
    this.channels.set(officeId, channel);
    return channel;
  }
}
