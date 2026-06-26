import { Bitrix24Channel } from './channel.js';
import { setBitrix24Runtime, type PluginRuntime } from './runtime.js';
import { createWebhookRouter } from '../../../src/bitrix24/webhook-server.js';
import { createClientFromWebhook } from '../../../src/bitrix24/client.js';
import { parseDialogId } from '../../../src/bitrix24/targets.js';
import {
  getSetupInstructions,
  getQuickHint,
  getWelcomeMessage,
  formatConnectionSuccess,
  formatConnectionError,
  formatMissingScopes,
  isValidWebhookUrl,
} from './setup-guide.js';

export function formatDateInTimezone(date: Date, timezone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type: string) => parts.find((part) => part.type === type)?.value;
    const year = get('year');
    const month = get('month');
    const day = get('day');
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Fall through to UTC if the configured timezone is invalid.
  }

  return date.toISOString().slice(0, 10);
}

export function resolveSessionPeerId(msg: { dialogId: string; chatId?: number }, account: any, now = new Date()): string {
  const sessionConfig = account?.session ?? {};
  const basePeerId = sessionConfig.perChat && msg.chatId
    ? `chat${msg.chatId}`
    : msg.dialogId;

  if (!sessionConfig.dailyReset) return basePeerId;

  const timezone = typeof sessionConfig.timezone === 'string' && sessionConfig.timezone.trim()
    ? sessionConfig.timezone.trim()
    : 'UTC';
  return `${basePeerId}--day-${formatDateInTimezone(now, timezone)}`;
}

/**
 * OpenClaw Plugin Entry Point.
 *
 * Registers:
 *   - bitrix24 channel (messaging via imbot API)
 *   - bitrix24-webhook service (Express routes for incoming events)
 *   - /b24status command (connection diagnostics)
 *   - /b24setup command (interactive setup guide)
 */
export default function register(api: any): void {
  const channel = new Bitrix24Channel();
  const CHANNEL_ID = 'bitrix24';

  // Initialize runtime for DI
  setBitrix24Runtime({
    logger: api.logger,
    config: api.config,
    webhookBaseUrl: api.config?.gateway?.externalUrl,
    persistConfig: api.persistConfig,
  });

  // Configure channel from user's openclaw config
  const channelConfig = api.config?.channels?.bitrix24 ?? {};
  channel.configure(channelConfig);

  channel.onMessage(async (accountId, msg) => {
    const channelRuntime = api.runtime?.channel;
    if (!channelRuntime) {
      api.logger.warn('Bitrix24 inbound runtime is unavailable; dropping message');
      return;
    }

    const conversationKind = msg.chatType === 'P' ? 'direct' : 'group';
    const account = channel.resolveAccount(accountId);
    const routePeerId = resolveSessionPeerId(msg, account);
    const route = channelRuntime.routing.resolveAgentRoute({
      cfg: api.config,
      channel: CHANNEL_ID,
      accountId,
      peer: {
        kind: conversationKind,
        id: routePeerId,
      },
    });
    const sessionKey = route.sessionKey;

    let typingTimer: ReturnType<typeof setInterval> | undefined;
    const pulseTyping = () => {
      channel.sendTypingIndicator(accountId, msg.dialogId).catch((err) => {
        api.logger.debug?.(`Bitrix24 typing indicator failed: ${String(err)}`);
      });
    };

    channel.markMessageRead(accountId, msg.dialogId, msg.messageId).catch((err) => {
      api.logger.debug?.(`Bitrix24 read marker failed: ${String(err)}`);
    });
    pulseTyping();
    typingTimer = setInterval(pulseTyping, 9000);

    try {
      await channelRuntime.inbound.run({
        channel: CHANNEL_ID,
        accountId,
        raw: msg,
        adapter: {
          ingest: (incoming: typeof msg) => ({
            id: String(incoming.messageId),
            timestamp: Date.now(),
            rawText: incoming.text,
            textForAgent: incoming.text,
            textForCommands: incoming.text,
            raw: incoming,
          }),
          resolveTurn: async (input: any) => {
            const ctxPayload = channelRuntime.inbound.buildContext({
              channel: CHANNEL_ID,
              accountId,
              timestamp: input.timestamp,
              from: `${CHANNEL_ID}:${accountId}:${msg.fromUserId}`,
              sender: {
                id: String(msg.fromUserId),
                name: [msg.fromUserName, msg.fromUserLastName].filter(Boolean).join(' '),
              },
              conversation: {
                kind: conversationKind,
                id: msg.dialogId,
                label: msg.dialogId,
              },
              route: {
                agentId: route.agentId,
                accountId,
                routeSessionKey: sessionKey,
                dispatchSessionKey: sessionKey,
              },
              reply: { to: msg.dialogId },
              message: {
                rawBody: input.rawText,
                commandBody: input.textForCommands,
                bodyForAgent: input.textForAgent,
              },
              extra: {
                messageId: String(msg.messageId),
                chatId: msg.chatId ? String(msg.chatId) : undefined,
                routePeerId,
                botId: String(msg.botId),
                botCode: msg.botCode,
                domain: msg.domain,
              },
            });
            const storePath = channelRuntime.session.resolveStorePath(api.config.session?.store, {
              agentId: route.agentId,
            });

            return {
              cfg: api.config,
              channel: CHANNEL_ID,
              accountId,
              agentId: route.agentId,
              routeSessionKey: sessionKey,
              storePath,
              ctxPayload,
              recordInboundSession: channelRuntime.session.recordInboundSession,
              dispatchReplyWithBufferedBlockDispatcher:
                channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher,
              delivery: {
                durable: () => ({ to: msg.dialogId }),
                deliver: async (payload: { text?: string }) => {
                  if (!payload.text) return { visibleReplySent: false };
                  await channel.sendTextMessage(accountId, msg.dialogId, payload.text);
                  return { visibleReplySent: true };
                },
              },
              dispatcherOptions: {
                onReplyStart: pulseTyping,
              },
            };
          },
        },
      });
    } catch (err) {
      api.logger.error(`Bitrix24 inbound dispatch failed: ${String(err)}`);
      await channel.sendTextMessage(
        accountId,
        msg.dialogId,
        'Omlouvám se, teď se mi nepodařilo zpracovat zprávu.',
      ).catch(() => {});
    } finally {
      if (typingTimer) clearInterval(typingTimer);
    }
  });

  // Wire OAuth token persistence
  channel.setTokenRefreshCallback((accountId, tokens) => {
    api.logger.info(`OAuth tokens refreshed for Bitrix24 account "${accountId}"`);
    api.persistConfig?.(`channels.bitrix24.accounts.${accountId}`, {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    });
  });

  // Register the channel
  api.registerChannel({
    plugin: {
      id: 'bitrix24',
      meta: {
        id: CHANNEL_ID,
        label: 'Bitrix24',
        selectionLabel: 'Bitrix24 Messenger',
        blurb: 'Chat with your OpenClaw agent through Bitrix24 Messenger.',
        aliases: ['b24', 'bitrix'],
      },
      capabilities: { chatTypes: ['direct', 'group'] },
      config: {
        listAccountIds: () => channel.listAccountIds(),
        resolveAccount: (_cfg: any, accountId: string) => channel.resolveAccount(accountId),
      },
      messaging: {
        targetPrefixes: ['bitrix24', 'bitrix', 'b24'],
        normalizeTarget: (target: string) => target
          .trim()
          .replace(/^(?:bitrix24|bitrix|b24):/i, '')
          .trim(),
        inferTargetChatType: ({ to }: { to: string }) => {
          try {
            return parseDialogId(to).type === 'user' ? 'direct' : 'group';
          } catch {
            return undefined;
          }
        },
        targetResolver: {
          hint: '<userId|chatId|chat123>',
          looksLikeId: (raw: string, normalized?: string) => {
            const value = normalized ?? raw;
            try {
              parseDialogId(value);
              return true;
            } catch {
              return false;
            }
          },
          resolveTarget: async ({ normalized }: { normalized: string }) => {
            const parsed = parseDialogId(normalized);
            return {
              to: parsed.dialogId,
              kind: parsed.type === 'user' ? 'user' : 'group',
              display: parsed.dialogId,
              source: 'normalized',
            };
          },
        },
      },
      outbound: {
        deliveryMode: 'direct',
        sendText: async ({ accountId, to, dialogId, text, media }: {
          accountId: string;
          to?: string;
          dialogId: string;
          text: string;
          media?: any[];
        }) => {
          const resolvedDialogId = to ?? dialogId;
          if (!resolvedDialogId) throw new Error('Bitrix24 outbound target is required');
          await channel.sendTextMessage(
            accountId ?? channel.resolveDefaultAccountId(),
            resolvedDialogId,
            text,
            media,
          );
          return { ok: true };
        },
      },
    },
  });

  // Register webhook service for incoming Bitrix24 events
  const webhookRouter = createWebhookRouter({
    onMessage: (accountId, msg) => {
      channel.handleIncomingMessage(accountId, msg).catch((err) => {
        api.logger.error(`Bitrix24 webhook dispatch failed: ${String(err)}`);
      });
    },
    onWelcome: (accountId, event) => {
      if (event) {
        api.logger.info(`Bot added to chat in account "${accountId}": ${event.dialogId}`);

        // Send welcome message asynchronously (fire-and-forget)
        channel.sendTextMessage(accountId, event.dialogId, getWelcomeMessage()).catch((err) => {
          api.logger.warn(`Failed to send welcome message to ${event.dialogId}:`, err);
        });
      }
    },
    onBotDelete: (accountId, event) => {
      if (event) {
        api.logger.warn(`Bot deleted from account "${accountId}": ${event.botCode}`);
      }
    },
    getApplicationToken: (accountId) => channel.getApplicationToken(accountId),
  });

  api.registerService({
    id: 'bitrix24-events',
    router: webhookRouter,
    start: async () => {
      const accounts = channel.listEnabledAccounts();

      if (accounts.length === 0) {
        api.logger.warn(`[bitrix24] ${getQuickHint()}`);
        return;
      }

      // Startup all enabled accounts
      for (const account of accounts) {
        try {
          await channel.startupAccount(account.id);
        } catch (err) {
          api.logger.error(`Failed to start Bitrix24 account "${account.id}":`, err);
        }
      }
      api.logger.info('Bitrix24 event service started');
    },
    stop: () => {
      channel.destroy();
      api.logger.info('Bitrix24 event service stopped');
    },
  });

  // Register /b24status command
  api.registerCommand({
    name: 'b24status',
    description: 'Show Bitrix24 channel connection status',
    handler: async () => {
      const accounts = channel.listEnabledAccounts();
      if (accounts.length === 0) {
        return { text: 'No Bitrix24 accounts configured. Run /b24setup for instructions.' };
      }

      const lines: string[] = ['**Bitrix24 Accounts:**'];
      for (const acc of accounts) {
        const probe = await channel.probeAccount(acc.id);
        const status = probe.ok ? 'connected' : `error: ${probe.error}`;
        lines.push(`- **${acc.id}** (${acc.domain}): ${status}`);
      }
      return { text: lines.join('\n') };
    },
  });

  // Register /b24setup command — interactive setup guide
  api.registerCommand({
    name: 'b24setup',
    description: 'Step-by-step guide to connect Bitrix24',
    acceptsArgs: true,
    handler: async (ctx: { args?: string }) => {
      const webhookUrl = ctx.args?.trim();

      // No argument — show instructions or current status
      if (!webhookUrl) {
        const accounts = channel.listEnabledAccounts();
        if (accounts.length > 0) {
          const lines = ['Bitrix24 is already configured:'];
          for (const acc of accounts) {
            lines.push(`- **${acc.id}** (${acc.domain})`);
          }
          lines.push('', 'To add another portal, pass a webhook URL:');
          lines.push('`/b24setup https://your-portal.bitrix24.ru/rest/1/secret/`');
          return { text: lines.join('\n') };
        }
        return { text: getSetupInstructions() };
      }

      // Validate URL format
      if (!isValidWebhookUrl(webhookUrl)) {
        return {
          text: [
            'Invalid webhook URL format.',
            '',
            'Expected: `https://your-portal.bitrix24.ru/rest/{userId}/{secret}/`',
            '',
            'Run `/b24setup` without arguments for full instructions.',
          ].join('\n'),
        };
      }

      // Test connection
      const client = createClientFromWebhook(webhookUrl);
      try {
        const result = await client.verifyConnection();

        if (!result.ok && result.missingScopes) {
          return { text: formatMissingScopes(result.missingScopes) };
        }

        if (!result.ok) {
          return { text: formatConnectionError(result.error ?? 'Unknown error') };
        }

        // Save webhook URL to config
        await api.persistConfig?.('channels.bitrix24.webhookUrl', webhookUrl);

        // Reconfigure channel with new webhook
        channel.configure({ ...channelConfig, webhookUrl });

        // Start the account (register bot)
        let botRegistered = false;
        try {
          await channel.startupAccount('default');
          botRegistered = true;
        } catch (err) {
          api.logger.warn('Bot registration deferred — restart gateway to complete:', err);
        }

        return {
          text: formatConnectionSuccess({
            domain: result.domain!,
            scopes: result.scopes!,
            botRegistered,
          }),
        };
      } finally {
        client.destroy();
      }
    },
  });

  api.logger.info('Bitrix24 channel plugin registered');
}
