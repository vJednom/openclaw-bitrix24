import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface StoredPollingAccountState {
  botId?: number;
  botCode?: string;
  nextOffset?: number;
  processedEventIds?: string[];
}

export type StoredPollingState = Record<string, StoredPollingAccountState>;

function statePath(): string {
  const root = process.env.OPENCLAW_STATE_DIR?.trim() || path.join(os.homedir(), '.openclaw');
  return path.join(root, 'memory', 'bitrix24-polling-state.json');
}

export async function readPollingState(accountId: string): Promise<StoredPollingAccountState | undefined> {
  try {
    const raw = await fs.readFile(statePath(), 'utf8');
    const data = JSON.parse(raw) as StoredPollingState;
    return data[accountId];
  } catch (err: any) {
    if (err?.code === 'ENOENT') return undefined;
    throw err;
  }
}

export async function writePollingState(accountId: string, state: StoredPollingAccountState): Promise<void> {
  const file = statePath();
  await fs.mkdir(path.dirname(file), { recursive: true });

  let data: StoredPollingState = {};
  try {
    data = JSON.parse(await fs.readFile(file, 'utf8')) as StoredPollingState;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  data[accountId] = {
    ...data[accountId],
    ...state,
    processedEventIds: state.processedEventIds?.slice(-200) ?? data[accountId]?.processedEventIds,
  };

  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmp, file);
}
