import type { Bitrix24Client } from './client.js';
import type { BotConfig, BotRegistrationResult } from './types.js';

/**
 * Register an OpenClaw chatbot in a Bitrix24 portal.
 */
export async function registerBot(
  client: Bitrix24Client,
  accountId: string,
  webhookBaseUrl: string,
  config: BotConfig,
): Promise<BotRegistrationResult> {
  if (!config.clientId) {
    throw new Error('Bot CLIENT_ID is required for imbot.register');
  }

  const code = `openclaw_${accountId}`;
  const base = webhookBaseUrl.replace(/\/$/, '');

  const result = await client.callMethod('imbot.register', {
    CLIENT_ID: config.clientId,
    CODE: code,
    TYPE: 'B',
    EVENT_MESSAGE_ADD: `${base}/webhook/bitrix24/${accountId}/message`,
    EVENT_WELCOME_MESSAGE: `${base}/webhook/bitrix24/${accountId}/welcome`,
    EVENT_BOT_DELETE: `${base}/webhook/bitrix24/${accountId}/delete`,
    PROPERTIES: {
      NAME: config.name,
      LAST_NAME: config.lastName ?? '',
      COLOR: config.color ?? 'PURPLE',
      WORK_POSITION: config.workPosition ?? 'AI Assistant',
      EMAIL: config.email ?? `openclaw-${accountId}@openclaw.bot`,
      PERSONAL_PHOTO: config.avatar,
    },
  });

  // Bitrix24 returns BOT_ID as a plain number or as { BOT_ID: n }
  const botId = typeof result === 'number' ? result : result?.BOT_ID ?? result;

  return { botId: Number(botId), botCode: code };
}

/**
 * Register an imbot.v2 chatbot using either fetch or webhook event delivery.
 */
export async function registerBotV2(
  client: Bitrix24Client,
  accountId: string,
  config: BotConfig,
  options: {
    eventMode: 'fetch' | 'webhook';
    webhookBaseUrl?: string;
    botToken?: string;
  },
): Promise<BotRegistrationResult> {
  const code = `openclaw_${accountId}`;
  const fields: Record<string, any> = {
    code,
    type: 'bot',
    eventMode: options.eventMode,
    properties: {
      name: config.name,
      lastName: config.lastName ?? '',
      color: config.color ?? 'PURPLE',
      workPosition: config.workPosition ?? 'AI Assistant',
      email: config.email ?? `openclaw-${accountId}@openclaw.bot`,
      personalPhoto: config.avatar,
    },
  };

  if (options.botToken) fields.botToken = options.botToken;

  if (options.eventMode === 'webhook') {
    if (!options.webhookBaseUrl) {
      throw new Error('Bitrix24 webhook mode requires gateway.externalUrl to be a publicly reachable HTTPS URL');
    }
    fields.webhookUrl = `${options.webhookBaseUrl.replace(/\/$/, '')}/webhook/bitrix24/${accountId}/v2`;
  }

  const result = await client.callMethod<any>('imbot.v2.Bot.register', { fields });
  const botId = result?.bot?.id ?? result?.id ?? result?.BOT_ID ?? result;
  const botCode = result?.bot?.code ?? result?.code ?? code;

  return { botId: Number(botId), botCode };
}

/**
 * Update imbot.v2 bot event delivery/properties when the bot already exists.
 */
export async function updateBotV2(
  client: Bitrix24Client,
  botId: number,
  config: Partial<BotConfig>,
  options: {
    eventMode?: 'fetch' | 'webhook';
    webhookBaseUrl?: string;
    botToken?: string;
    accountId?: string;
  } = {},
): Promise<void> {
  const fields: Record<string, any> = {};

  if (config.name !== undefined || config.lastName !== undefined || config.color !== undefined
    || config.workPosition !== undefined || config.avatar !== undefined) {
    fields.properties = {};
    if (config.name !== undefined) fields.properties.name = config.name;
    if (config.lastName !== undefined) fields.properties.lastName = config.lastName;
    if (config.color !== undefined) fields.properties.color = config.color;
    if (config.workPosition !== undefined) fields.properties.workPosition = config.workPosition;
    if (config.avatar !== undefined) fields.properties.personalPhoto = config.avatar;
  }

  if (options.eventMode) fields.eventMode = options.eventMode;
  if (options.botToken) fields.botToken = options.botToken;

  if (options.eventMode === 'webhook') {
    if (!options.webhookBaseUrl || !options.accountId) {
      throw new Error('Bitrix24 webhook mode requires gateway.externalUrl and accountId');
    }
    fields.webhookUrl = `${options.webhookBaseUrl.replace(/\/$/, '')}/webhook/bitrix24/${options.accountId}/v2`;
  }

  if (Object.keys(fields).length === 0) return;

  await client.callMethod('imbot.v2.Bot.update', {
    botId,
    fields,
  });
}

/**
 * Update bot properties (name, avatar, etc.).
 */
export async function updateBot(
  client: Bitrix24Client,
  botId: number,
  botClientId: string,
  config: Partial<BotConfig>,
): Promise<void> {
  const fields: Record<string, any> = {};
  if (config.name !== undefined) fields.NAME = config.name;
  if (config.lastName !== undefined) fields.LAST_NAME = config.lastName;
  if (config.color !== undefined) fields.COLOR = config.color;
  if (config.workPosition !== undefined) fields.WORK_POSITION = config.workPosition;
  if (config.avatar !== undefined) fields.PERSONAL_PHOTO = config.avatar;

  if (Object.keys(fields).length === 0) return;

  await client.callMethod('imbot.update', {
    CLIENT_ID: botClientId,
    BOT_ID: botId,
    FIELDS: fields,
  });
}

/**
 * Unregister (delete) the bot from Bitrix24.
 */
export async function unregisterBot(
  client: Bitrix24Client,
  botId: number,
  botClientId: string,
): Promise<void> {
  await client.callMethod('imbot.unregister', {
    CLIENT_ID: botClientId,
    BOT_ID: botId,
  });
}
