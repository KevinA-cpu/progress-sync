import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import {
  RECOVERY_DATABASE, RECOVERY_DATABASE_VERSION, RECOVERY_STORAGE_PREFIX, RECOVERY_STORE, RECOVERY_TEXT,
} from '../constants/recovery';
import type { DestinationTarget } from '../destination/schemas';
import { parseRecovery, RecoveryFault, recoveryStateSchema, type RecoveryState } from './schemas';

interface RecoveryDatabase extends DBSchema {
  [RECOVERY_STORE]: { key: string; value: RecoveryState };
}

let database: Promise<IDBPDatabase<RecoveryDatabase>> | undefined;
function connection() {
  database ??= openDB<RecoveryDatabase>(RECOVERY_DATABASE, RECOVERY_DATABASE_VERSION, {
    upgrade(db) { db.createObjectStore(RECOVERY_STORE); },
  });
  return database;
}

export function recoveryCacheKey(target: DestinationTarget): string {
  return RECOVERY_STORAGE_PREFIX + JSON.stringify([
    target.userId, target.clientId, target.installationId, target.appId, target.repositoryId, target.branch,
  ]);
}

export async function readRecoveryCache(target: DestinationTarget): Promise<RecoveryState | null> {
  const value: unknown = await (await connection()).get(RECOVERY_STORE, recoveryCacheKey(target));
  if (value === undefined) return null;
  const state = parseRecovery(value, recoveryStateSchema, RECOVERY_TEXT.storedInvalid);
  if (recoveryCacheKey(state.target) !== recoveryCacheKey(target)) throw new RecoveryFault(RECOVERY_TEXT.storedInvalid);
  return state;
}

export async function writeRecoveryCache(state: RecoveryState): Promise<void> {
  const parsed = parseRecovery(state, recoveryStateSchema, RECOVERY_TEXT.storedInvalid);
  await (await connection()).put(RECOVERY_STORE, parsed, recoveryCacheKey(parsed.target));
}
