/**
 * Copies the files of local storage (STORAGE_DRIVER=local on the VM) into object storage (PRD 11, R-07; G-12), with a
 * checksum for every file and a state file to resume from. runbooks/move-from-vm.md says when to run it.
 *
 *   node scripts/copy-files.js --from <local storage folder> --state <file> [--dry-run]
 *   node scripts/copy-files.js --from <folder> --state <file> --verify
 *   (--to-dir <folder> copies into a local folder instead of the object storage the settings name: drills and tests)
 *
 * - The source is only read: mount it read-only. The state file may not be inside it.
 * - The target is the object storage the settings name (STORAGE_DRIVER=s3 and S3_*, through the secret source). A first
 *   run refuses a target that holds any object. A run with a state file resumes: what it copied and checked is skipped,
 *   and the target may hold nothing the state file and the source do not account for.
 * - Every file is read back from the target after it is written, and its SHA-256 compared with the source's; a
 *   difference stops the copy and names the key. Keys are storage keys (t/<business id>/...), never a file's content.
 * - --verify reads every object back again, hashes the source again, and compares both with the state file: per
 *   business counts, bytes and checksums. Exit 1 and every difference named when anything differs.
 *
 * The state file is JSON lines: a header, one line per file copied and checked, and a last line when the copy is done.
 * Exit code: 0 done, 1 a difference or a failed copy, 2 a bad argument or a target refused before anything was copied.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkKey, createStorage } from '../src/platform/storage.js';

export const STATE_FORMAT = 'bhava-copy-files';

export class CopyError extends Error {
  constructor(message, code, exitCode = 1) {
    super(message);
    this.name = 'CopyError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');
const hashOf = (text) => sha256(Buffer.from(String(text))).slice(0, 16);
/** The business a key belongs to: t/<id>/... is that business; anything else is the platform's. */
export const businessOf = (key) => /^t\/(\d+)\//.exec(key)?.[1] ?? 'platform';
// local storage writes <name>.<pid>.tmp first and renames it: such a file is a write that never finished.
const PARTIAL = /\.\d+\.tmp$/;

/** Every file under `dir` as { key, file }, in key order. Keys that local storage could never have written are refused. */
export function sourceFiles(dir) {
  const root = path.resolve(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new CopyError('The source folder does not exist.', 'no_source', 2);
  const out = [];
  const bad = [];
  for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || PARTIAL.test(entry.name)) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    const key = path.relative(root, file).split(path.sep).join('/');
    try {
      checkKey(key);
      out.push({ key, file });
    } catch {
      bad.push(key);
    }
  }
  if (bad.length) throw new CopyError(`${bad.length} files have names that are not storage keys (first: ${bad.slice(0, 3).map((k) => JSON.stringify(k.slice(0, 80))).join(', ')}). Move them out of the source first.`, 'bad_keys', 2);
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A storage with list(): object storage through the settings, or a local folder. `identity` names it without a credential. */
export function targetStore(config, { dir = '' } = {}) {
  if (dir) {
    const root = path.resolve(dir);
    const storage = createStorage({ storageDriver: 'local', storageDir: root });
    const list = async () => {
      fs.mkdirSync(root, { recursive: true });
      return sourceFiles(root).map((f) => f.key);
    };
    return { ...storage, identity: `local:${hashOf(root)}`, list };
  }
  if (config.storageDriver !== 's3') throw new CopyError('The target must be object storage: set STORAGE_DRIVER=s3 and the S3_* settings (or --to-dir for a drill).', 'not_configured', 2);
  const storage = createStorage(config);
  return {
    ...storage,
    identity: `s3:${hashOf(`${config.s3Endpoint}|${config.s3Bucket}`)}`,
    async list() {
      const sdk = await import('@aws-sdk/client-s3');
      const s3 = new sdk.S3Client({
        region: config.s3Region || 'auto',
        endpoint: config.s3Endpoint || undefined,
        forcePathStyle: Boolean(config.s3ForcePathStyle),
        credentials: config.s3AccessKeyId ? { accessKeyId: config.s3AccessKeyId, secretAccessKey: config.s3SecretAccessKey } : undefined,
      });
      const keys = [];
      let token;
      do {
        const page = await s3.send(new sdk.ListObjectsV2Command({ Bucket: config.s3Bucket, ContinuationToken: token }));
        for (const item of page.Contents ?? []) keys.push(item.Key);
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return keys;
    },
  };
}

/** The state file: { header, done: Map(key -> { sha256, bytes }), finished }. A last line cut short by a crash is ignored. */
export function readState(statePath) {
  if (!fs.existsSync(statePath)) return null;
  const lines = fs.readFileSync(statePath, 'utf8').split('\n').filter(Boolean);
  const parsed = [];
  for (const [i, line] of lines.entries()) {
    try {
      parsed.push(JSON.parse(line));
    } catch {
      if (i !== lines.length - 1) throw new CopyError('The state file is damaged in the middle: start again with a new state file and an empty target.', 'bad_state', 2);
    }
  }
  const [header, ...rest] = parsed;
  if (header?.format !== STATE_FORMAT || header.version !== 1) throw new CopyError('That file is not a state file made by this script.', 'bad_state', 2);
  const done = new Map();
  let finished = null;
  for (const entry of rest) {
    if (entry.done) finished = entry;
    else if (typeof entry.key === 'string' && /^[0-9a-f]{64}$/.test(entry.sha256)) done.set(entry.key, { sha256: entry.sha256, bytes: entry.bytes });
  }
  return { header, done, finished };
}

const summarise = (entries) => {
  const perBusiness = {};
  for (const [key, { bytes }] of entries) {
    const b = (perBusiness[businessOf(key)] ??= { files: 0, bytes: 0 });
    b.files += 1;
    b.bytes += bytes;
  }
  return perBusiness;
};

/**
 * Copies `sourceDir` into `store` (put, get, list, identity). Answers { copied, skipped, files, bytes, perBusiness }.
 * `dryRun` answers what it would do and writes nothing anywhere.
 */
export async function copyFiles({ sourceDir, store, statePath, dryRun = false, say = () => {}, now = () => new Date() }) {
  const source = path.resolve(sourceDir);
  const stateFile = path.resolve(statePath);
  if (stateFile === source || stateFile.startsWith(`${source}${path.sep}`)) throw new CopyError('The state file may not be inside the source folder: the source is only read.', 'state_in_source', 2);
  const files = sourceFiles(source);
  const sourceKeys = new Set(files.map((f) => f.key));
  const state = readState(stateFile);
  const header = { format: STATE_FORMAT, version: 1, target: store.identity, source: hashOf(source) };
  if (state && (state.header.target !== header.target || state.header.source !== header.source)) {
    throw new CopyError('The state file is for another source or target: name a new state file.', 'state_mismatch', 2);
  }
  const existing = new Set(await store.list());
  if (!state && existing.size) throw new CopyError(`The target is not empty (${existing.size} objects). Copy only into an empty bucket, or resume with the state file of the copy that filled it.`, 'target_not_empty', 2);
  if (state) {
    const foreign = [...existing].filter((k) => !state.done.has(k) && !sourceKeys.has(k));
    if (foreign.length) throw new CopyError(`The target holds ${foreign.length} objects this copy did not write. Copy only into an empty bucket.`, 'target_has_foreign_objects', 2);
  }
  if (dryRun) {
    const pending = files.filter((f) => !(state?.done.has(f.key) && existing.has(f.key)));
    return { dryRun: true, files: files.length, pending: pending.length, copied: 0, skipped: files.length - pending.length };
  }
  if (!state) fs.writeFileSync(stateFile, `${JSON.stringify({ ...header, startedAt: now().toISOString() })}\n`, { flag: 'wx' });
  const done = state?.done ?? new Map();
  let copied = 0;
  let skipped = 0;
  for (const { key, file } of files) {
    const data = fs.readFileSync(file);
    const sum = sha256(data);
    const prior = done.get(key);
    if (prior && prior.sha256 === sum && existing.has(key)) {
      skipped += 1;
      continue;
    }
    await store.put(key, data, 'application/octet-stream');
    const back = await store.get(key);
    if (!back || sha256(back) !== sum) throw new CopyError(`The copy of ${key} reads back with a different checksum: stopped. Re-run to resume once the target is healthy.`, 'checksum_mismatch');
    done.set(key, { sha256: sum, bytes: data.length });
    fs.appendFileSync(stateFile, `${JSON.stringify({ key, sha256: sum, bytes: data.length })}\n`);
    copied += 1;
    if (copied % 500 === 0) say(`copy-files: ${copied} copied`);
  }
  const entries = [...done].filter(([key]) => sourceKeys.has(key));
  const bytes = entries.reduce((s, [, e]) => s + e.bytes, 0);
  fs.appendFileSync(stateFile, `${JSON.stringify({ done: true, files: entries.length, bytes, at: now().toISOString() })}\n`);
  return { copied, skipped, files: entries.length, bytes, perBusiness: summarise(entries) };
}

/**
 * Checks a finished copy: every object of the state file read back from `store` and hashed, nothing missing or extra in
 * the target, and, with `sourceDir`, the source hashed again (a file changed or added since the copy is a difference).
 * Answers { ok, files, perBusiness, problems }.
 */
export async function verifyCopy({ manifest, store, sourceDir = '' }) {
  const state = readState(manifest);
  if (!state) throw new CopyError('The state file does not exist.', 'no_state', 2);
  const problems = [];
  if (!state.finished) problems.push('files: the copy has not finished: run copy-files again to resume it');
  if (state.header.target !== store.identity) problems.push('files: the state file is for another target');
  for (const [key, entry] of state.done) {
    const back = await store.get(key);
    if (!back) problems.push(`files, business ${businessOf(key)}: ${key} is missing from the target`);
    else if (back.length !== entry.bytes || sha256(back) !== entry.sha256) problems.push(`files, business ${businessOf(key)}: ${key} differs in the target (checksum)`);
  }
  const extra = (await store.list()).filter((k) => !state.done.has(k));
  if (extra.length) problems.push(`files: the target holds ${extra.length} objects the copy did not write`);
  if (sourceDir) {
    for (const { key, file } of sourceFiles(sourceDir)) {
      const entry = state.done.get(key);
      if (!entry) problems.push(`files, business ${businessOf(key)}: ${key} is in the source but was never copied`);
      else if (sha256(fs.readFileSync(file)) !== entry.sha256) problems.push(`files, business ${businessOf(key)}: ${key} changed in the source after it was copied`);
    }
  }
  return { ok: problems.length === 0, files: state.done.size, perBusiness: summarise(state.done), problems: problems.slice(0, 200) };
}

export function parseArgs(argv) {
  const options = { from: '', state: '', toDir: '', dryRun: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--verify') options.verify = true;
    else if (['--from', '--state', '--to-dir'].includes(arg) && argv[i + 1] && !argv[i + 1].startsWith('--')) options[arg === '--to-dir' ? 'toDir' : arg.slice(2)] = argv[++i];
    else throw new CopyError(`Unknown or incomplete argument: ${arg}`, 'bad_argument', 2);
  }
  if (!options.from || !options.state) throw new CopyError('Name --from <local storage folder> and --state <file>.', 'bad_argument', 2);
  if (options.dryRun && options.verify) throw new CopyError('Use --dry-run or --verify, not both.', 'bad_argument', 2);
  return options;
}

async function main(argv, say) {
  const options = parseArgs(argv);
  let config = {};
  if (!options.toDir) {
    const loaded = await import('../src/config.js');
    await loaded.loadSecrets(loaded.config);
    config = loaded.config;
  }
  const store = targetStore(config, { dir: options.toDir });
  if (options.verify) {
    const report = await verifyCopy({ manifest: path.resolve(options.state), store, sourceDir: options.from });
    for (const line of report.problems) say(`DIFFERENT  ${line}`);
    for (const [business, b] of Object.entries(report.perBusiness)) say(`business ${business}: ${b.files} files, ${b.bytes} bytes`);
    say(`copy-files: ${report.files} files checked: ${report.ok ? 'everything matches' : `${report.problems.length} differences`}`);
    return report.ok ? 0 : 1;
  }
  const report = await copyFiles({ sourceDir: options.from, store, statePath: options.state, dryRun: options.dryRun, say });
  if (report.dryRun) say(`copy-files (dry run): ${report.files} files, ${report.pending} to copy, ${report.skipped} already copied; nothing written`);
  else say(`copy-files: ${report.copied} copied, ${report.skipped} already there, ${report.files} files, ${report.bytes} bytes, ${Object.keys(report.perBusiness).length} owners`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const say = (line) => process.stderr.write(`${line}\n`);
  main(process.argv.slice(2), say).then(
    (code) => process.exit(code),
    (err) => {
      say(err instanceof CopyError ? err.message : `Failed: ${String(err.message).split('\n')[0].slice(0, 200)}`);
      process.exit(err instanceof CopyError ? err.exitCode : 1);
    },
  );
}
