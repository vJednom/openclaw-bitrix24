import type { AccountConfig, Bitrix24V2EventGetResult, IncomingMessage } from './types.js';
import type { Bitrix24Client } from './client.js';
import { parseV2MessageEvent } from './receive.js';

export interface Bitrix24PollerOptions {
  account: AccountConfig;
  client: Bitrix24Client;
  onMessage: (msg: IncomingMessage) => Promise<void>;
  onState: (state: { nextOffset: number; processedEventIds: string[] }) => void | Promise<void>;
  onJoinChat?: (event: any) => void | Promise<void>;
  onBotDelete?: (event: any) => void | Promise<void>;
  logger: {
    info: (msg: string, ...args: any[]) => void;
    warn: (msg: string, ...args: any[]) => void;
    error: (msg: string, ...args: any[]) => void;
    debug?: (msg: string, ...args: any[]) => void;
  };
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60000;

function eventKey(event: {
  id?: number | string;
  eventId?: number | string;
  event?: string;
  type?: string;
  message?: { id?: number };
  data?: { message?: { id?: number } };
}): string {
  return String(event.id ?? event.eventId ?? event.message?.id ?? event.data?.message?.id ?? `${event.event ?? event.type ?? 'event'}:${JSON.stringify(event)}`);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class Bitrix24EventPoller {
  private stopped = false;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private nextOffset?: number;
  private processedEventIds: string[];
  private backoffMs = MIN_BACKOFF_MS;

  constructor(private readonly options: Bitrix24PollerOptions) {
    this.nextOffset = options.account.nextOffset;
    this.processedEventIds = options.account.processedEventIds.slice(-200);
  }

  start(): void {
    if (this.timer || this.running || this.stopped) return;
    this.options.logger.info(`Bitrix24 fetch poller started for "${this.options.account.id}"`);
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, ms);
  }

  private async tick(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;

    try {
      let hasMore = false;
      do {
        const result = await this.fetchEvents();
        const events = result.events ?? [];

        for (const event of events) {
          const key = eventKey(event);
          if (this.processedEventIds.includes(key)) continue;

          const type = event.event ?? event.type;
          if (type === 'ONIMBOTV2MESSAGEADD' || type === 'ONIMBOTV2COMMANDADD') {
            const msg = parseV2MessageEvent(event, this.options.account.domain);
            if (msg) await this.options.onMessage(msg);
          } else if (type === 'ONIMBOTV2JOINCHAT') {
            await this.options.onJoinChat?.(event);
          } else if (type === 'ONIMBOTV2DELETE') {
            await this.options.onBotDelete?.(event);
          } else {
            this.options.logger.debug?.(`Ignoring unsupported Bitrix24 v2 event ${type ?? key}`);
          }

          this.processedEventIds = [...this.processedEventIds, key].slice(-200);
        }

        if (typeof result.nextOffset === 'number') {
          this.nextOffset = result.nextOffset;
          await this.options.onState({
            nextOffset: result.nextOffset,
            processedEventIds: this.processedEventIds,
          });
        }

        hasMore = result.hasMore === true;
        this.backoffMs = MIN_BACKOFF_MS;
      } while (hasMore && !this.stopped);

      this.schedule(this.options.account.pollIntervalMs);
    } catch (err) {
      this.options.logger.warn(
        `Bitrix24 fetch poll failed for "${this.options.account.id}"; retrying in ${this.backoffMs}ms: ${String(err)}`,
      );
      const waitMs = this.backoffMs;
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      await delay(0);
      this.schedule(waitMs);
    } finally {
      this.running = false;
    }
  }

  private fetchEvents(): Promise<Bitrix24V2EventGetResult> {
    const params: Record<string, any> = {
      botId: this.options.account.botId,
      limit: this.options.account.pollLimit,
    };

    if (this.options.account.auth.type === 'webhook' && this.options.account.botToken) {
      params.botToken = this.options.account.botToken;
    }
    if (typeof this.nextOffset === 'number') {
      params.offset = this.nextOffset;
    }

    return this.options.client.callMethod<Bitrix24V2EventGetResult>('imbot.v2.Event.get', params);
  }
}
