import { AccountManager, type RawChannelConfig } from '../../../src/bitrix24/accounts.js';
import { registerBot, registerBotV2, unregisterBot, updateBotV2 } from '../../../src/bitrix24/bot.js';
import { sendMessage, sendTyping } from '../../../src/bitrix24/send.js';
import { downloadFile } from '../../../src/bitrix24/files.js';
import { Bitrix24EventPoller } from '../../../src/bitrix24/poller.js';
import { readPollingState, writePollingState } from '../../../src/bitrix24/polling-state.js';
import type { IncomingMessage, MediaAttachment } from '../../../src/bitrix24/types.js';
import { getBitrix24Runtime } from './runtime.js';

/**
 * Bitrix24 Channel Plugin — implements the OpenClaw ChannelPlugin interface.
 *
 * Provides the same UX as Telegram and Slack channels:
 *   - One-command setup via CLI
 *   - Multi-account support
 *   - Bidirectional text + file messaging
 *   - Typing indicators
 */
export class Bitrix24Channel {
  private accountManager = new AccountManager();
  private messageCallback: ((accountId: string, msg: IncomingMessage) => void | Promise<void>) | null = null;
  private pollers = new Map<string, Bitrix24EventPoller>();

  /**
   * Initialize from OpenClaw config.
   */
  configure(rawConfig: RawChannelConfig): void {
    this.accountManager.loadFromConfig(rawConfig);
  }

  // ── Account management ───────────────────────────────────────────────────

  listEnabledAccounts(): Array<{ id: string; domain: string }> {
    return this.accountManager.listEnabledAccounts().map((a) => ({
      id: a.id,
      domain: a.domain,
    }));
  }

  listAccountIds(): string[] {
    return this.accountManager.listAccountIds();
  }

  resolveDefaultAccountId(): string {
    return this.accountManager.resolveDefaultAccountId();
  }

  resolveAccount(id: string) {
    return this.accountManager.getAccount(id);
  }

  // ── Messaging ────────────────────────────────────────────────────────────

  /**
   * Send a message from the agent to a Bitrix24 dialog.
   */
  async sendTextMessage(
    accountId: string,
    dialogId: string,
    text: string,
    media?: MediaAttachment[],
  ): Promise<void> {
    const account = this.accountManager.getAccount(accountId);
    if (!account || !account.botId || !account.bot.clientId) {
      throw new Error(`Account "${accountId}" not configured, bot not registered, or bot CLIENT_ID missing`);
    }

    const client = this.accountManager.getClient(accountId);
    await sendMessage(client, {
      botId: account.botId,
      botClientId: account.bot.clientId,
      dialogId,
      text,
      media,
    }, {
      textChunkLimit: account.textChunkLimit,
    });
  }

  /**
   * Send a typing indicator while the agent is preparing a response.
   */
  async sendTypingIndicator(accountId: string, dialogId: string): Promise<void> {
    const account = this.accountManager.getAccount(accountId);
    if (!account || !account.botId || !account.bot.clientId) return;

    const client = this.accountManager.getClient(accountId);
    await sendTyping(client, account.botId, account.bot.clientId, dialogId);
  }

  /**
   * Register callback for incoming messages.
   */
  onMessage(callback: (accountId: string, msg: IncomingMessage) => void | Promise<void>): void {
    this.messageCallback = callback;
  }

  /**
   * Called by webhook server when a message arrives.
   */
  async handleIncomingMessage(accountId: string, msg: IncomingMessage): Promise<void> {
    await this.messageCallback?.(accountId, msg);
  }

  /**
   * Download a file attachment from an incoming message.
   */
  async downloadAttachment(accountId: string, fileId: string): Promise<MediaAttachment> {
    const client = this.accountManager.getClient(accountId);
    return downloadFile(client, fileId);
  }

  /**
   * Set callback for persisting refreshed OAuth tokens.
   */
  setTokenRefreshCallback(
    cb: (accountId: string, tokens: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    }) => void | Promise<void>,
  ): void {
    this.accountManager.setTokenRefreshCallback(cb);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start an account: register the bot and prepare for messaging.
   */
  async startupAccount(accountId: string): Promise<void> {
    const runtime = getBitrix24Runtime();
    const account = this.accountManager.getAccount(accountId);
    if (!account) throw new Error(`Account "${accountId}" not found`);

    const client = this.accountManager.getClient(accountId);
    const storedState = await readPollingState(accountId).catch((err) => {
      runtime.logger.warn(`Failed to read Bitrix24 polling state for "${accountId}": ${err}`);
      return undefined;
    });
    if (storedState?.botId && !account.botId) {
      this.accountManager.setBotInfo(accountId, storedState.botId, storedState.botCode ?? `openclaw_${accountId}`);
      account.botId = storedState.botId;
      account.botCode = storedState.botCode ?? `openclaw_${accountId}`;
    }
    if (typeof storedState?.nextOffset === 'number') {
      this.accountManager.setPollingState(
        accountId,
        storedState.nextOffset,
        storedState.processedEventIds ?? account.processedEventIds,
      );
      account.nextOffset = storedState.nextOffset;
      account.processedEventIds = storedState.processedEventIds ?? account.processedEventIds;
    }

    if (account.eventMode === 'webhook' && (!runtime.webhookBaseUrl || !/^https:\/\//i.test(runtime.webhookBaseUrl))) {
      throw new Error('Bitrix24 inbound requires gateway.externalUrl to be a publicly reachable HTTPS URL');
    }

    // Check if bot is already registered
    if (account.botId) {
      runtime.logger.info(`Bitrix24 bot already registered for "${accountId}" (ID: ${account.botId})`);
      if (account.eventMode === 'fetch') {
        await updateBotV2(client, account.botId, account.bot, {
          eventMode: 'fetch',
          botToken: account.botToken,
        }).catch((err) => {
          runtime.logger.warn(`Failed to update Bitrix24 bot to fetch mode for "${accountId}": ${err}`);
        });
        this.startPoller(accountId);
      }
      return;
    }

    // Register bot
    runtime.logger.info(`Registering Bitrix24 bot for "${accountId}" on ${account.domain}...`);
    const { botId, botCode } = account.eventMode === 'fetch'
      ? await registerBotV2(client, accountId, account.bot, {
        eventMode: 'fetch',
        botToken: account.botToken,
      })
      : await registerBot(
        client,
        accountId,
        runtime.webhookBaseUrl!,
        account.bot,
      );

    this.accountManager.setBotInfo(accountId, botId, botCode);
    await writePollingState(accountId, { botId, botCode }).catch((err) => {
      runtime.logger.warn(`Failed to persist Bitrix24 bot state for "${accountId}": ${err}`);
    });
    runtime.logger.info(`Bitrix24 bot registered: ${botCode} (ID: ${botId})`);

    if (account.eventMode === 'fetch') {
      this.startPoller(accountId);
    }
  }

  private startPoller(accountId: string): void {
    const runtime = getBitrix24Runtime();
    if (this.pollers.has(accountId)) return;

    const account = this.accountManager.getAccount(accountId);
    if (!account?.botId || account.eventMode !== 'fetch') return;
    if (account.auth.type === 'webhook' && !account.botToken) {
      runtime.logger.warn(`Cannot start Bitrix24 fetch poller for "${accountId}": botToken is missing`);
      return;
    }

    const client = this.accountManager.getClient(accountId);
    const poller = new Bitrix24EventPoller({
      account,
      client,
      logger: runtime.logger,
      onMessage: (msg) => this.handleIncomingMessage(accountId, msg),
      onState: async (state) => {
        this.accountManager.setPollingState(accountId, state.nextOffset, state.processedEventIds);
        await writePollingState(accountId, {
          botId: account.botId,
          botCode: account.botCode,
          nextOffset: state.nextOffset,
          processedEventIds: state.processedEventIds,
        });
        await Promise.resolve(runtime.persistConfig?.(`channels.bitrix24.accounts.${accountId}`, {
          nextOffset: state.nextOffset,
          processedEventIds: state.processedEventIds,
        })).catch((err: any) => {
          runtime.logger.debug?.(`Bitrix24 config offset persistence skipped for "${accountId}": ${String(err)}`);
        });
      },
      onJoinChat: (event) => {
        runtime.logger.info(`Bitrix24 bot joined chat in account "${accountId}": ${event.chat?.dialogId ?? event.chat?.id ?? 'unknown'}`);
      },
      onBotDelete: (event) => {
        runtime.logger.warn(`Bitrix24 bot deleted in account "${accountId}": ${event.bot?.code ?? event.bot?.id ?? 'unknown'}`);
      },
    });

    this.pollers.set(accountId, poller);
    poller.start();
  }

  /**
   * Stop an account: unregister the bot.
   */
  async logoutAccount(accountId: string): Promise<void> {
    const runtime = getBitrix24Runtime();
    const account = this.accountManager.getAccount(accountId);
    if (!account?.botId) return;
    if (!account.bot.clientId) {
      runtime.logger.warn(`Cannot unregister Bitrix24 bot for "${accountId}": bot CLIENT_ID is missing`);
      return;
    }

    try {
      const client = this.accountManager.getClient(accountId);
      await unregisterBot(client, account.botId, account.bot.clientId);
      runtime.logger.info(`Bitrix24 bot unregistered for "${accountId}"`);
    } catch (err) {
      runtime.logger.warn(`Failed to unregister bot for "${accountId}": ${err}`);
    }
  }

  /**
   * Check account health.
   */
  async probeAccount(accountId: string): Promise<{ ok: boolean; error?: string }> {
    return this.accountManager.probeAccount(accountId);
  }

  // ── Directory ────────────────────────────────────────────────────────────

  /**
   * Get application token for webhook verification.
   */
  getApplicationToken(accountId: string): string | undefined {
    // Application tokens are stored after ONAPPINSTALL;
    // for webhook-based auth they're not used
    return undefined;
  }

  /**
   * Cleanup.
   */
  destroy(): void {
    for (const poller of this.pollers.values()) {
      poller.stop();
    }
    this.pollers.clear();
    this.accountManager.destroy();
  }
}
