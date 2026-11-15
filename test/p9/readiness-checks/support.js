// Helpers for the readiness-checks tests: a small S3-compatible store on this machine (what MinIO is in CI), a Postgres on this
// machine, and a runner for the check scripts as their own processes.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
export const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Decodes the body of an aws-chunked upload (the SDK sends one for some checksums); a plain body comes back as it is. */
function unchunk(buffer, headers) {
  const encoding = String(headers['content-encoding'] ?? '');
  const streaming = String(headers['x-amz-content-sha256'] ?? '').startsWith('STREAMING');
  if (!encoding.includes('aws-chunked') && !streaming) return buffer;
  const out = [];
  let at = 0;
  while (at < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', at);
    if (lineEnd < 0) break;
    const size = parseInt(buffer.subarray(at, lineEnd).toString('latin1').split(';')[0], 16);
    if (!Number.isFinite(size) || size === 0) break;
    out.push(buffer.subarray(lineEnd + 2, lineEnd + 2 + size));
    at = lineEnd + 2 + size + 2;
  }
  return Buffer.concat(out);
}

/**
 * An S3-compatible store in memory, path style: CreateBucket, DeleteBucket, HeadBucket, Put/Get/Head/DeleteObject and ListObjectsV2.
 * `store.buckets` is Map(bucket -> Map(key -> Buffer)), so a test can see what a check left behind.
 */
export async function startFakeS3() {
  const buckets = new Map();
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = unchunk(Buffer.concat(chunks), req.headers);
    const url = new URL(req.url, 'http://x');
    const [bucket, ...rest] = decodeURIComponent(url.pathname).replace(/^\//, '').split('/');
    const key = rest.join('/');
    requests.push(`${req.method} ${bucket ? 'bucket' : 'service'}${key ? '/key' : ''}`);
    const send = (status, text = '', headers = {}) => {
      res.writeHead(status, { 'content-type': 'application/xml', ...headers });
      res.end(text);
    };
    const error = (status, code) => send(status, `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${code}</Message></Error>`);
    if (!bucket) return send(200, '<?xml version="1.0"?><ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>');
    if (!key) {
      if (req.method === 'PUT') {
        if (buckets.has(bucket)) return error(409, 'BucketAlreadyOwnedByYou');
        buckets.set(bucket, new Map());
        return send(200, '', { location: `/${bucket}` });
      }
      if (!buckets.has(bucket)) return error(404, 'NoSuchBucket');
      if (req.method === 'HEAD') return send(200);
      if (req.method === 'DELETE') {
        if (buckets.get(bucket).size) return error(409, 'BucketNotEmpty');
        buckets.delete(bucket);
        return send(204);
      }
      if (req.method === 'GET') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...buckets.get(bucket).keys()].filter((k) => k.startsWith(prefix)).sort();
        const items = keys.map((k) => `<Contents><Key>${xml(k)}</Key><Size>${buckets.get(bucket).get(k).length}</Size></Contents>`).join('');
        return send(200, `<?xml version="1.0"?><ListBucketResult><Name>${xml(bucket)}</Name><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${items}</ListBucketResult>`);
      }
      return error(405, 'MethodNotAllowed');
    }
    if (!buckets.has(bucket)) return error(404, 'NoSuchBucket');
    const objects = buckets.get(bucket);
    if (req.method === 'PUT') {
      objects.set(key, body);
      return send(200, '', { etag: `"${crypto.createHash('md5').update(body).digest('hex')}"` });
    }
    if (req.method === 'DELETE') {
      objects.delete(key);
      return send(204);
    }
    if (!objects.has(key)) return error(404, 'NoSuchKey');
    const data = objects.get(key);
    const headers = { 'content-type': 'application/octet-stream', 'content-length': String(data.length), etag: `"${crypto.createHash('md5').update(data).digest('hex')}"` };
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    buckets,
    requests,
    keys: { accessKeyId: 'fakeaccesskey1', secretAccessKey: 'fakesecretkey-zq91' },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}

/** A Postgres on this machine (the load test's embedded one), as the server a check is pointed at. */
export async function startPostgres() {
  const { loadBudgets, startPostgres: start } = await import('../../../tools/load/stack.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-chk-pg-'));
  const pg = await start({ dir: path.join(dir, 'pg'), budgets: loadBudgets(), appLogin: false });
  return {
    url: pg.ownerUrl,
    async close() {
      await pg.stop().catch(() => {});
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Runs a node script as its own process; answers { code, stdout, stderr, timedOut }. */
export function runNode(args, { env = {}, timeoutMs = 120_000, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const basics = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'ComSpec', 'COMSPEC'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
    const child = spawn(process.execPath, args, { cwd, env: { ...basics, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** The names of the databases and roles that start with `prefix` on a server, to see that a check left none behind. */
export async function leftovers(adminUrl, prefix = 'bhava_chk_') {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const dbs = (await client.query('SELECT datname FROM pg_database')).rows.map((r) => r.datname).filter((n) => n.startsWith(prefix) || n.startsWith('bhava_r0'));
    const roles = (await client.query('SELECT rolname FROM pg_roles')).rows.map((r) => r.rolname).filter((n) => n.startsWith(prefix) || n.startsWith('bhava_r0'));
    return { databases: dbs, roles };
  } finally {
    await client.end();
  }
}
