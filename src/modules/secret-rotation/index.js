import { REWRAP_JOB } from '../../contracts/secrets.js';

/**
 * Master-key rotation (PRD 5.15, F-66; Phase 9). Track: secrets.
 *
 * Owns secret_rewraps (migration 900): the platform's, reached through db.platform. The job walks every column of
 * SECRET_COLUMNS (src/contracts/secrets.js) by its primary key, REWRAP_BATCH rows a step, each step its own short
 * transaction, and writes each value again with platform.secrets.rewrap(): the wrapped data key changes, the value's
 * ciphertext does not, and a v1 value becomes v2. Readers never wait: both keys decrypt throughout. A row is skipped
 * when it is NULL or '', and when it is already under the current key. The place it reached is secret_rewraps.last_id,
 * so a stopped job carries on and two workers never redo a step. When every column is `done` for the current key, the
 * old key may leave DATA_KEY_OLD (oldKeysRetirable).
 *
 * It logs and counts ids and numbers only (secret_rewrap_rows_total): never a value, a key or a business.
 *
 *   createSecretRotation(ctx).start()      -> makes the secret_rewraps rows for the current key and enqueues the job
 *   createSecretRotation(ctx).step()       -> one batch; answers { table, column, done, finished }
 *   createSecretRotation(ctx).progress()   -> RewrapProgress
 *
 * Nothing here is built yet: the job is registered so its name is taken, never scheduled, and fails when run.
 */
const notBuilt = (what) => () => {
  throw Object.assign(new Error(`${what} is not built yet`), { code: 'not_implemented' });
};

export function createSecretRotation(_ctx) {
  return { start: notBuilt('secret rotation'), step: notBuilt('secret rotation'), progress: notBuilt('secret rotation') };
}

export const secretRotation = {
  name: 'secret-rotation',
  owns: { migrations: ['900_secrets_envelope.sql'], tables: ['secret_rewraps'], api: [], store: [], platform: [], jobs: [REWRAP_JOB] },
  jobs(ctx) {
    const rotation = createSecretRotation(ctx);
    ctx.platform.queue.work(REWRAP_JOB, () => rotation.step());
  },
};
