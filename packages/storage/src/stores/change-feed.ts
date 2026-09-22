/**
 * Change feeds deliver new events per office. Adapters with listen/notify push
 * them; everything else falls back to polling the event store with backoff.
 */
import type { EventStore, StoredEvent } from "./types.js";

export type ChangeHandler = (event: StoredEvent) => void;
export type Unsubscribe = () => void;

export interface ChangeFeed {
  subscribe(officeId: string, handler: ChangeHandler): Unsubscribe;
  close(): Promise<void>;
}

/** An event store that can push changes itself. */
export interface PushCapableEventStore extends EventStore {
  changeFeed(): ChangeFeed;
}

export interface PollingOptions {
  readonly intervalMs?: number;
  readonly maxIntervalMs?: number;
  readonly pageSize?: number;
}

interface OfficePoller {
  handlers: Set<ChangeHandler>;
  since: Date;
  seenAtSince: Set<string>;
  interval: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class PollingChangeFeed implements ChangeFeed {
  private readonly pollers = new Map<string, OfficePoller>();
  private readonly baseInterval: number;
  private readonly maxInterval: number;
  private readonly pageSize: number;
  private closed = false;

  constructor(
    private readonly store: EventStore,
    options: PollingOptions = {},
  ) {
    this.baseInterval = options.intervalMs ?? 1_000;
    this.maxInterval = Math.max(this.baseInterval, options.maxIntervalMs ?? 30_000);
    this.pageSize = options.pageSize ?? 200;
  }

  subscribe(officeId: string, handler: ChangeHandler): Unsubscribe {
    let poller = this.pollers.get(officeId);
    if (!poller) {
      poller = {
        handlers: new Set(),
        since: new Date(),
        seenAtSince: new Set(),
        interval: this.baseInterval,
        timer: null,
      };
      this.pollers.set(officeId, poller);
      this.schedule(officeId, poller);
    }
    poller.handlers.add(handler);
    return () => {
      const p = this.pollers.get(officeId);
      if (!p) return;
      p.handlers.delete(handler);
      if (p.handlers.size === 0) {
        if (p.timer) clearTimeout(p.timer);
        this.pollers.delete(officeId);
      }
    };
  }

  private schedule(officeId: string, poller: OfficePoller): void {
    poller.timer = setTimeout(() => {
      void this.poll(officeId, poller);
    }, poller.interval);
  }

  private async poll(officeId: string, poller: OfficePoller): Promise<void> {
    if (this.closed || !this.pollers.has(officeId)) return;
    let delivered = 0;
    try {
      const page = await this.store.query({ officeId, from: poller.since, limit: this.pageSize });
      for (const event of page.items) {
        const atSince = event.at.getTime() === poller.since.getTime();
        if (atSince && poller.seenAtSince.has(event.id)) continue;
        if (event.at.getTime() > poller.since.getTime()) {
          poller.since = event.at;
          poller.seenAtSince.clear();
        }
        poller.seenAtSince.add(event.id);
        delivered += 1;
        for (const handler of poller.handlers) handler(event);
      }
    } catch {
      // A failing poll is retried at the next interval; the feed never throws into callers.
    }
    poller.interval =
      delivered > 0 ? this.baseInterval : Math.min(poller.interval * 2, this.maxInterval);
    if (this.pollers.has(officeId)) this.schedule(officeId, poller);
  }

  close(): Promise<void> {
    this.closed = true;
    for (const p of this.pollers.values()) if (p.timer) clearTimeout(p.timer);
    this.pollers.clear();
    return Promise.resolve();
  }
}

export function createChangeFeed(store: EventStore, options?: PollingOptions): ChangeFeed {
  if (store.capabilities.listenNotify && "changeFeed" in store) {
    return (store as PushCapableEventStore).changeFeed();
  }
  return new PollingChangeFeed(store, options);
}
