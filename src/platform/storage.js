import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * File storage for uploaded images and other files. One interface, three drivers (STORAGE_DRIVER):
 *   memory  tests
 *   local   a folder on the server (QA on the VM)
 *   s3      any S3-compatible object storage: AWS S3, Cloudflare R2, MinIO, Oracle (production)
 * Keys look like "t/<business id>/media/<uuid>". The database keeps only the key.
 *
 *   put(key, buffer, contentType)   get(key) -> Buffer | null   remove(key)
 */
export function createStorage(config = {}) {
  const driver = config.storageDriver || 'memory';
  if (driver === 'memory') return memoryStorage();
  if (driver === 'local') return localStorage(config.storageDir);
  if (driver === 's3') return s3Storage(config);
  throw new Error(`Unknown STORAGE_DRIVER "${driver}" (use memory, local or s3)`);
}

export function checkKey(key) {
  if (typeof key !== 'string' || !/^[a-z0-9][a-z0-9/_.-]{0,250}$/i.test(key) || key.includes('..') || key.includes('//')) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  return key;
}

function memoryStorage() {
  const files = new Map();
  return {
    driver: 'memory',
    async put(key, buffer) {
      files.set(checkKey(key), Buffer.from(buffer));
    },
    async get(key) {
      return files.get(checkKey(key)) ?? null;
    },
    async remove(key) {
      files.delete(checkKey(key));
    },
  };
}

function localStorage(dir) {
  if (!dir) throw new Error('STORAGE_DIR is required when STORAGE_DRIVER=local');
  const root = path.resolve(dir);
  const fileFor = (key) => path.join(root, ...checkKey(key).split('/'));
  return {
    driver: 'local',
    async put(key, buffer) {
      const file = fileFor(key);
      await fs.mkdir(path.dirname(file), { recursive: true });
      // Write to a temporary file first so a crash never leaves half a file under the real name.
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, buffer);
      await fs.rename(tmp, file);
    },
    async get(key) {
      try {
        return await fs.readFile(fileFor(key));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    async remove(key) {
      await fs.rm(fileFor(key), { force: true });
    },
  };
}

function s3Storage(config) {
  const { s3Bucket: bucket } = config;
  if (!bucket) throw new Error('S3_BUCKET is required when STORAGE_DRIVER=s3');
  let clientPromise;
  const client = () =>
    (clientPromise ??= import('@aws-sdk/client-s3').then((sdk) => ({
      sdk,
      s3: new sdk.S3Client({
        region: config.s3Region || 'auto',
        endpoint: config.s3Endpoint || undefined,
        forcePathStyle: Boolean(config.s3ForcePathStyle),
        credentials: config.s3AccessKeyId ? { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey } : undefined,
      }),
    })));
  return {
    driver: 's3',
    async put(key, buffer, contentType = 'application/octet-stream') {
      const { sdk, s3 } = await client();
      await s3.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: checkKey(key), Body: buffer, ContentType: contentType }));
    },
    async get(key) {
      const { sdk, s3 } = await client();
      try {
        const res = await s3.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: checkKey(key) }));
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) return null;
        throw err;
      }
    },
    async remove(key) {
      const { sdk, s3 } = await client();
      await s3.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: checkKey(key) }));
    },
  };
}
