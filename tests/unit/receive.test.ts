import { describe, it, expect } from 'vitest';
import { parseMessageEvent, parseV2MessageEvent, verifyApplicationToken } from '../../src/bitrix24/receive.js';
import type { Bitrix24MessageEvent, Bitrix24V2Event } from '../../src/bitrix24/types.js';

function makeEvent(overrides: Partial<{
  isBot: 'Y' | 'N';
  message: string;
  fromUserId: number;
  applicationToken: string;
}>): Bitrix24MessageEvent {
  return {
    event: 'ONIMBOTMESSAGEADD',
    data: {
      BOT: [{ BOT_ID: 1, BOT_CODE: 'openclaw_default' }],
      PARAMS: {
        DIALOG_ID: '42',
        MESSAGE_ID: 100,
        MESSAGE: overrides.message ?? 'Hello',
        FROM_USER_ID: overrides.fromUserId ?? 42,
        TO_USER_ID: 1,
        TO_CHAT_ID: 200,
        CHAT_TYPE: 'P',
        LANGUAGE: 'ru',
      },
      USER: {
        ID: overrides.fromUserId ?? 42,
        NAME: 'Ivan Petrov',
        FIRST_NAME: 'Ivan',
        LAST_NAME: 'Petrov',
        IS_BOT: overrides.isBot ?? 'N',
      },
    },
    ts: Date.now(),
    auth: {
      domain: 'test.bitrix24.ru',
      application_token: overrides.applicationToken ?? 'token123',
    },
  };
}

describe('parseMessageEvent', () => {
  it('parses a valid message event', () => {
    const msg = parseMessageEvent(makeEvent({ message: '[b]Hello[/b] world' }));
    expect(msg).not.toBeNull();
    expect(msg!.messageId).toBe(100);
    expect(msg!.dialogId).toBe('42');
    expect(msg!.text).toBe('**Hello** world'); // BB-code → markdown
    expect(msg!.fromUserId).toBe(42);
    expect(msg!.fromUserName).toBe('Ivan');
    expect(msg!.fromUserLastName).toBe('Petrov');
    expect(msg!.isBot).toBe(false);
    expect(msg!.chatType).toBe('P');
    expect(msg!.domain).toBe('test.bitrix24.ru');
    expect(msg!.botId).toBe(1);
    expect(msg!.botCode).toBe('openclaw_default');
  });

  it('returns null for bot messages', () => {
    const msg = parseMessageEvent(makeEvent({ isBot: 'Y' }));
    expect(msg).toBeNull();
  });

  it('includes file attachments', () => {
    const event = makeEvent({});
    event.data.PARAMS.FILES = [
      { id: 'f1', name: 'photo.jpg', size: 1024, type: 'image/jpeg' },
    ];
    const msg = parseMessageEvent(event);
    expect(msg!.files).toHaveLength(1);
    expect(msg!.files[0].name).toBe('photo.jpg');
  });
});

describe('parseV2MessageEvent', () => {
  function makeV2Event(overrides: Partial<Bitrix24V2Event> = {}): Bitrix24V2Event {
    return {
      id: 1000,
      event: 'ONIMBOTV2MESSAGEADD',
      bot: { id: 1, code: 'openclaw_default' },
      message: {
        id: 500,
        chatId: 200,
        authorId: 42,
        text: '[b]Hello[/b] from v2',
      },
      chat: {
        id: 200,
        dialogId: 'chat200',
        type: 'chat',
      },
      user: {
        id: 42,
        name: 'Ivan Petrov',
        firstName: 'Ivan',
        lastName: 'Petrov',
        bot: false,
      },
      ...overrides,
    };
  }

  it('parses ONIMBOTV2MESSAGEADD events', () => {
    const msg = parseV2MessageEvent(makeV2Event(), 'test.bitrix24.ru');
    expect(msg).not.toBeNull();
    expect(msg!.messageId).toBe(500);
    expect(msg!.dialogId).toBe('chat200');
    expect(msg!.chatId).toBe(200);
    expect(msg!.text).toBe('**Hello** from v2');
    expect(msg!.fromUserId).toBe(42);
    expect(msg!.fromUserName).toBe('Ivan');
    expect(msg!.fromUserLastName).toBe('Petrov');
    expect(msg!.chatType).toBe('C');
    expect(msg!.domain).toBe('test.bitrix24.ru');
    expect(msg!.botId).toBe(1);
    expect(msg!.botCode).toBe('openclaw_default');
  });

  it('parses Bitrix queue events with nested data payloads', () => {
    const msg = parseV2MessageEvent({
      eventId: 3,
      type: 'ONIMBOTV2MESSAGEADD',
      data: {
        bot: { id: 903, code: 'openclaw_default' },
        message: {
          id: 536103,
          chatId: 9957,
          authorId: 873,
          text: 'Ahoj Tealku',
          params: [],
        },
        chat: {
          id: 9957,
          dialogId: '873',
          type: 'private',
        },
        user: {
          id: 873,
          name: 'Zdenek Hasek',
          firstName: 'Zdenek',
          lastName: 'Hasek',
          bot: false,
        },
      },
    }, 'vjednom.bitrix24.eu');

    expect(msg).not.toBeNull();
    expect(msg!.messageId).toBe(536103);
    expect(msg!.dialogId).toBe('873');
    expect(msg!.chatId).toBe(9957);
    expect(msg!.text).toBe('Ahoj Tealku');
    expect(msg!.fromUserId).toBe(873);
    expect(msg!.fromUserName).toBe('Zdenek');
    expect(msg!.chatType).toBe('P');
    expect(msg!.botId).toBe(903);
  });

  it('parses ONIMBOTV2COMMANDADD as inbound text', () => {
    const msg = parseV2MessageEvent(makeV2Event({
      event: 'ONIMBOTV2COMMANDADD',
      message: {
        id: 501,
        chatId: 200,
        authorId: 42,
        text: '',
      },
      command: {
        command: '/ask',
        params: 'status please',
      },
    }), 'test.bitrix24.ru');

    expect(msg).not.toBeNull();
    expect(msg!.text).toBe('/ask status please');
  });

  it('returns null for bot-authored v2 messages', () => {
    const msg = parseV2MessageEvent(makeV2Event({
      user: { id: 2, name: 'Other Bot', bot: true },
    }));
    expect(msg).toBeNull();
  });
});

describe('verifyApplicationToken', () => {
  it('passes when tokens match', () => {
    expect(verifyApplicationToken(
      { auth: { application_token: 'abc' } },
      'abc',
    )).toBe(true);
  });

  it('fails when tokens differ', () => {
    expect(verifyApplicationToken(
      { auth: { application_token: 'abc' } },
      'xyz',
    )).toBe(false);
  });

  it('passes when no expected token (skip verification)', () => {
    expect(verifyApplicationToken(
      { auth: { application_token: 'abc' } },
      undefined,
    )).toBe(true);
  });
});
