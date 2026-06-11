import { describe, it, expect, vi } from 'vitest';
import { Bitrix24EventPoller } from '../../src/bitrix24/poller.js';
import type { AccountConfig } from '../../src/bitrix24/types.js';

function makeAccount(overrides: Partial<AccountConfig> = {}): AccountConfig {
  return {
    id: 'default',
    domain: 'test.bitrix24.ru',
    auth: { type: 'webhook', webhookUrl: 'https://test.bitrix24.ru/rest/1/secret/' },
    enabled: true,
    textChunkLimit: 4000,
    bot: {
      name: 'OpenClaw',
      clientId: 'client-id',
      botToken: 'bot-token',
    },
    botId: 1,
    botCode: 'openclaw_default',
    botToken: 'bot-token',
    eventMode: 'fetch',
    pollIntervalMs: 5000,
    pollLimit: 100,
    processedEventIds: [],
    dmPolicy: 'open',
    ...overrides,
  };
}

function makeEvent(id = 10) {
  return {
    id,
    event: 'ONIMBOTV2MESSAGEADD',
    bot: { id: 1, code: 'openclaw_default' },
    message: {
      id: 500,
      chatId: 200,
      authorId: 42,
      text: 'hello',
    },
    chat: {
      id: 200,
      dialogId: 'chat200',
      type: 'chat',
    },
    user: {
      id: 42,
      firstName: 'Ivan',
      lastName: 'Petrov',
      bot: false,
    },
  };
}

describe('Bitrix24EventPoller', () => {
  it('processes events before committing nextOffset', async () => {
    const callMethod = vi.fn().mockResolvedValue({
      events: [makeEvent()],
      nextOffset: 11,
      hasMore: false,
    });
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const onState = vi.fn().mockResolvedValue(undefined);

    const poller = new Bitrix24EventPoller({
      account: makeAccount(),
      client: { callMethod } as any,
      onMessage,
      onState,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });

    await (poller as any).tick();
    poller.stop();

    expect(callMethod).toHaveBeenCalledWith('imbot.v2.Event.get', {
      botId: 1,
      botToken: 'bot-token',
      limit: 100,
    });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onState).toHaveBeenCalledWith({
      nextOffset: 11,
      processedEventIds: ['10'],
    });
    expect(onMessage.mock.invocationCallOrder[0]).toBeLessThan(onState.mock.invocationCallOrder[0]);
  });

  it('skips duplicate event IDs from persisted state', async () => {
    const callMethod = vi.fn().mockResolvedValue({
      events: [makeEvent(10)],
      nextOffset: 12,
      hasMore: false,
    });
    const onMessage = vi.fn().mockResolvedValue(undefined);
    const onState = vi.fn().mockResolvedValue(undefined);

    const poller = new Bitrix24EventPoller({
      account: makeAccount({ nextOffset: 11, processedEventIds: ['10'] }),
      client: { callMethod } as any,
      onMessage,
      onState,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    });

    await (poller as any).tick();
    poller.stop();

    expect(callMethod).toHaveBeenCalledWith('imbot.v2.Event.get', {
      botId: 1,
      botToken: 'bot-token',
      limit: 100,
      offset: 11,
    });
    expect(onMessage).not.toHaveBeenCalled();
    expect(onState).toHaveBeenCalledWith({
      nextOffset: 12,
      processedEventIds: ['10'],
    });
  });
});
