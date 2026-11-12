// Runs a Maestro runScript file under node, with what Maestro gives a script: `http` (synchronous, as in Maestro),
// `json`, `output` and the flow's env as globals. Each request is made by a short-lived node process, because
// Maestro's http calls block and node's do not. Only for scripts in apps/owner/.maestro/support, against local servers.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import vm from 'node:vm';

const REQUEST = `
const [method, url, headers, body] = JSON.parse(process.argv[1]);
if (!/^http:\\/\\/(127\\.0\\.0\\.1|localhost)(:\\d+)?\\//.test(url)) throw new Error('local addresses only');
const res = await fetch(url, { method, headers, body: body ?? undefined });
const out = {};
res.headers.forEach((value, name) => { out[name] = value; });
const cookies = res.headers.getSetCookie();
if (cookies.length) out['set-cookie'] = cookies;
process.stdout.write(JSON.stringify({ ok: res.ok, status: res.status, body: await res.text(), headers: out }));
`;

function request(method, url, { headers = {}, body } = {}) {
  const text = execFileSync(process.execPath, ['--input-type=module', '-e', REQUEST, JSON.stringify([method, url, headers, body ?? null])], { encoding: 'utf8', timeout: 30_000 });
  return JSON.parse(text);
}

export const maestroHttp = Object.freeze({
  get: (url, options) => request('GET', url, options),
  post: (url, options) => request('POST', url, options),
  put: (url, options) => request('PUT', url, options),
  delete: (url, options) => request('DELETE', url, options),
  request: (url, options = {}) => request(options.method ?? 'GET', url, options),
});

/** Runs the script at `file` with `env` as globals. Answers what it put in `output`; throws what it threw. */
export function runScript(file, env) {
  const output = {};
  const context = vm.createContext({ ...env, http: maestroHttp, json: (text) => JSON.parse(text), output });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return { ...output };
}
