import { describe, expect, it } from 'vitest';
import { resolveSessionPeerId } from '../../extensions/bitrix24/src/index.js';

describe('resolveSessionPeerId', () => {
  it('uses dialog id by default', () => {
    expect(resolveSessionPeerId({ dialogId: '873', chatId: 9977 }, {})).toBe('873');
  });

  it('can scope sessions to the concrete Bitrix chat id', () => {
    expect(resolveSessionPeerId(
      { dialogId: '873', chatId: 9977 },
      { session: { perChat: true } },
    )).toBe('chat9977');
  });

  it('can rotate session ids daily in the configured timezone', () => {
    const now = new Date('2026-06-26T22:30:00.000Z');
    expect(resolveSessionPeerId(
      { dialogId: '873', chatId: 9977 },
      { session: { perChat: true, dailyReset: true, timezone: 'Europe/Prague' } },
      now,
    )).toBe('chat9977--day-2026-06-27');
  });
});
