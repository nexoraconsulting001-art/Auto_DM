/**
 * The services a check runs on, each made fresh for the run and removed at the end. A check never touches a database,
 * a bucket or a Redis it did not make itself:
 *
 *   provisionPostgres({ adminUrl, cleanup })   a new database with the owner login and a new restricted app login
 *   provisionBucket({ env, cleanup })          a new bucket on the S3-compatible store
 *   claimRedis({ url, cleanup })               refuses a Redis that already holds keys; clears it at the end
 *   provisionClickhouse({ url, cleanup })      a new analytics database
 *   s3Settings(env, bucket)                    the S3_* settings the app reads, for a child process
 *
 * Names are random per run ("bhava_chk_..."). Passwords are made up for the run and never printed.
 */
import crypto from 'node:crypto';
import { CheckRefused } from './guard.mjs';

const rand = (n = 5) => crypto.randomBytes(n).toString('hex');
const quoteIdent = (name) => `"${String(name).replace(/"/g, '""')}"`;

async function withClient(url, fn) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end().catch(() => {});
  }
}

/** A new database on the server `adminUrl` names, the owner login (the admin's) and a restricted app login that is made when the app first starts. */
export async function provisionPostgres({ adminUrl, cleanup, label = 'chk' }) {
  const database = `bhava_${label}_${rand()}`;
  const appRole = `bhava_${label}_app_${rand(4)}`;
  const appPassword = crypto.randomBytes(16).toString('hex');
  const roleBefore = await withClient(adminUrl, async (c) => {
    await c.query(`CREATE DATABASE ${quoteIdent(database)}`);
    return (await c.query(`SELECT 1 FROM pg_roles WHERE rolname = 'bhava_app'`)).rowCount > 0;
  });
  cleanup.add(`database ${database}`, async () => {
    await withClient(adminUrl, async (c) => {
      await c.query(`DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`);
      await c.query(`DROP ROLE IF EXISTS ${quoteIdent(appRole)}`);
      // The shared role the migrations make is dropped only when this run is what made it.
      if (!roleBefore) await c.query('DROP ROLE IF EXISTS bhava_app').catch(() => {});
    });
  }, { data: true });
  const owner = new URL(adminUrl);
  owner.pathname = `/${database}`;
  const app = new URL(owner.href);
  app.username = appRole;
  app.password = appPassword;
  return { database, ownerUrl: owner.href, appUrl: app.href, appRole, appPassword };
}

/** The S3_* settings of a child process: the store, the bucket and the keys the check was given. Path-style addressing, as a local store needs. */
export function s3Settings(env, bucket) {
  return {
    STORAGE_DRIVER: 's3',
    S3_ENDPOINT: env.S3_ENDPOINT,
    S3_BUCKET: bucket,
    S3_REGION: env.S3_REGION || 'us-east-1',
    S3_FORCE_PATH_STYLE: '1',
    ...(env.S3_ACCESS_KEY_ID ? { S3_ACCESS_KEY_ID: env.S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: env.S3_SECRET_ACCESS_KEY ?? '' } : {}),
  };
}

export async function s3Client(env) {
  const sdk = await import('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    region: env.S3_REGION || 'us-east-1',
    endpoint: env.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' } : undefined,
  });
  return { sdk, client };
}

/** A new bucket, emptied and removed at the end. Answers helpers to list, read and write its objects. */
export async function provisionBucket({ env, cleanup, label = 'chk' }) {
  const bucket = `bhava-${label}-${rand(6)}`;
  const { sdk, client } = await s3Client(env);
  await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
  const keys = async () => {
    const out = [];
    let token;
    do {
      const page = await client.send(new sdk.ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
      for (const item of page.Contents ?? []) out.push(item.Key);
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return out;
  };
  cleanup.add(`bucket ${bucket}`, async () => {
    for (const Key of await keys()) await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key }));
    await client.send(new sdk.DeleteBucketCommand({ Bucket: bucket }));
    client.destroy();
  }, { data: true });
  return {
    bucket,
    keys,
    async read(Key) {
      const res = await client.send(new sdk.GetObjectCommand({ Bucket: bucket, Key }));
      return Buffer.from(await res.Body.transformToByteArray());
    },
    async write(Key, Body, ContentType = 'application/octet-stream') {
      await client.send(new sdk.PutObjectCommand({ Bucket: bucket, Key, Body, ContentType }));
    },
  };
}

/** Connects to Redis, refuses it when it holds any key (they are not this run's), and flushes it at the end. */
export async function claimRedis({ url, cleanup }) {
  const { default: Redis } = await import('ioredis');
  const redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 4000, retryStrategy: () => null });
  redis.on('error', () => {});
  try {
    await redis.connect();
    const size = await redis.dbsize();
    if (size > 0) {
      throw new CheckRefused(`REDIS_URL names a Redis that already holds ${size} keys that this check did not make, so it is refused: start an empty one.`);
    }
  } catch (err) {
    redis.disconnect();
    throw err;
  }
  cleanup.add('redis keys', async () => {
    await redis.flushdb();
    redis.disconnect();
  }, { data: true });
  return { size: async () => redis.dbsize(), ping: async () => redis.ping() };
}

const chRequest = async (url, sql, { method = 'POST' } = {}) => {
  const base = new URL(url);
  const auth = base.username ? `Basic ${Buffer.from(`${decodeURIComponent(base.username)}:${decodeURIComponent(base.password)}`).toString('base64')}` : undefined;
  base.username = '';
  base.password = '';
  if (sql) base.searchParams.set('query', sql);
  const res = await fetch(base, { method, headers: auth ? { authorization: auth } : {}, signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`the analytics database answered ${res.status}`);
  return text;
};

/** A new analytics database, dropped at the end. The app is told its name through CLICKHOUSE_DB. */
export async function provisionClickhouse({ url, cleanup, label = 'chk' }) {
  const database = `bhava_${label}_${rand()}`;
  await chRequest(url, `CREATE DATABASE ${database}`);
  cleanup.add(`analytics database ${database}`, () => chRequest(url, `DROP DATABASE IF EXISTS ${database}`), { data: true });
  return { database, ping: () => chRequest(url, '', { method: 'GET' }) };
}

/** One word per service that answers; throws naming the first that does not. */
export async function pingServices({ env, bucket, redis, clickhouse }) {
  const answered = [];
  await withClient(env.TEST_DATABASE_URL, (c) => c.query('SELECT 1'));
  answered.push('postgres');
  if (redis) {
    await redis.ping();
    answered.push('redis');
  }
  if (clickhouse) {
    await clickhouse.ping();
    answered.push('analytics');
  }
  if (bucket) {
    await bucket.keys();
    answered.push('object storage');
  }
  return answered;
}

export { withClient };
