// Helpers for the prod-deploy track's tests: reading the templates, a .dockerignore matcher, a check of Terraform's
// alignment rule, and whether an outside validator (docker, kustomize, terraform) is on this machine.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
export const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
export const yamlDocs = (rel) => yaml.safeLoadAll(read(rel)).filter(Boolean);
export const yamlDoc = (rel) => yaml.safeLoad(read(rel));

/** Every file under a folder of the repository, as repository paths. */
export const filesUnder = (rel) => fs.readdirSync(path.join(ROOT, rel), { recursive: true, withFileTypes: true })
  .filter((e) => e.isFile())
  .map((e) => path.relative(ROOT, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'));

/** True when `cmd --version` (or the given args) runs here. */
export function hasTool(cmd, args = ['--version']) {
  const r = spawnSync(cmd, args, { stdio: 'ignore', windowsHide: true, timeout: 20_000 });
  return r.status === 0;
}

/**
 * Whether .dockerignore leaves a repository path out of the build context: Docker's rules for the patterns used here
 * (a path matches a pattern, or sits inside a folder that does; `*` is one name; the last matching line wins; `!`
 * brings a path back).
 */
export function dockerIgnored(patterns, rel) {
  const toRegex = (p) => new RegExp(`^${p.replace(/^\/+|\/+$/g, '').split('/').map((seg) => (seg === '**' ? '.*' : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))).join('/').replace(/\.\*\//g, '(?:.*/)?')}(?:/.*)?$`);
  let ignored = false;
  for (const raw of patterns) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const negate = line.startsWith('!');
    if (toRegex(negate ? line.slice(1) : line).test(rel)) ignored = !negate;
  }
  return ignored;
}

export const dockerignorePatterns = () => read('.dockerignore').split(/\r?\n/);

/**
 * Terraform's formatter aligns the `=` of consecutive single-line arguments in a block (a line that opens a bracket it
 * does not close, a blank line, a comment line or a block header ends the run). Answers the lines that break it.
 */
export function misalignedHcl(text) {
  const lines = text.split(/\r?\n/);
  const problems = [];
  let run = [];
  const close = () => {
    if (run.length) {
      const want = Math.max(...run.map((r) => r.key.length)) + 1;
      for (const r of run) if (r.eq !== want) problems.push(`line ${r.n}: "=" at column ${r.eq}, expected ${want}`);
    }
    run = [];
  };
  const net = (s) => {
    let n = 0;
    let quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '"' && s[i - 1] !== '\\') quoted = !quoted;
      else if (!quoted && '([{'.includes(c)) n += 1;
      else if (!quoted && ')]}'.includes(c)) n -= 1;
    }
    return n;
  };
  lines.forEach((line, i) => {
    const m = /^(\s*)((?:"[^"]*"|[A-Za-z_][A-Za-z0-9_-]*))(\s*)=(?!=)(.*)$/.exec(line);
    if (!m || net(m[4]) !== 0 || /<<-?\w+\s*$/.test(m[4])) return close();
    const entry = { n: i + 1, key: `${m[1]}${m[2]}`, eq: m[1].length + m[2].length + m[3].length };
    if (run.length && run[0].key.match(/^\s*/)[0].length !== m[1].length) close();
    run.push(entry);
  });
  close();
  return problems;
}

/** Private, loopback, documentation and "any" ranges: the only IPv4 addresses a template may hold. */
export const ALLOWED_ADDRESS = /^(0\.0\.0\.0|127\.0\.0\.1|10\.0\.0\.0|172\.16\.0\.0|192\.168\.0\.0|169\.254\.0\.0|100\.64\.0\.0|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
