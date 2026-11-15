// G-01 and G-08: the image and the production templates. Static checks read the files; the checks that need a container tool
// (docker, kustomize, kubeconform, terraform) run when the tool is on the PATH and are reported as needing CI otherwise.
// Attack cases: a template that holds a secret, a real address or a region outside India; a container that runs as root or
// with a writable file system; a probe on the wrong path; a grace period shorter than the drain; a region variable that
// accepts anything; the same checks under the validators' own words.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import yaml from 'js-yaml';
import { ROOT, exists, hasTool, json, needsCi, read, runNode } from './support.js';

const PROD = 'deploy/prod';
const walk = (dir) => (exists(dir) ? fs.readdirSync(path.join(ROOT, dir), { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)).split(path.sep).join('/')) : []);
const YAML = /\.ya?ml$/;
const docsOf = (file) => yaml.loadAll(read(file)).filter(Boolean);
const run = (cmd, args, { timeoutMs = 540_000, cwd = ROOT } = {}) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd, shell: false });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const timer = setTimeout(() => child.kill(), timeoutMs);
  child.on('error', (e) => resolve({ code: -1, out: e.message }));
  child.on('close', (code) => {
    clearTimeout(timer);
    resolve({ code, out });
  });
});
const seconds = (v) => {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(String(v));
  return m ? Number(m[1]) * ({ ms: 0.001, s: 1, m: 60, h: 3600 }[m[2] ?? 's']) : NaN;
};
const SHUTDOWN = 25; // the default of SHUTDOWN_SECONDS: a template that sets another must say so

// ---- G-01: the image -----------------------------------------------------------------------------------------------------

const dockerfile = () => read('Dockerfile');
const stages = () => [...dockerfile().matchAll(/^FROM\s+(\S+)(?:\s+AS\s+(\S+))?/gim)].map((m) => ({ image: m[1], name: m[2] }));

test('G-01: the Dockerfile has a target for the web server and one for the worker, each ending as a non-root user with a health check', () => {
  const text = dockerfile();
  const names = stages().map((s) => s.name);
  assert.ok(names.includes('web') && names.includes('worker'), `targets: ${names.join(', ')}`);
  for (const target of ['web', 'worker']) {
    const at = text.search(new RegExp(`^FROM\\s+\\S+\\s+AS\\s+${target}\\b`, 'im'));
    const rest = text.slice(at).split(/^FROM\s/im)[1] ?? '';
    const block = `FROM ${rest}`;
    const user = [...block.matchAll(/^USER\s+(\S+)/gim)].at(-1)?.[1];
    assert.ok(user && !/^(root|0)(:|$)/.test(user), `${target}: the last USER is ${user}`);
    assert.match(block, /^HEALTHCHECK\b/im, `${target}: a health check`);
    assert.match(block, new RegExp(target === 'web' ? 'src/server\\.js' : 'src/worker\\.js'), `${target}: its own command`);
  }
});

test('G-01: the base images are pinned, nothing is copied that holds a secret, and the production image carries no dev tools or simulators', () => {
  const text = dockerfile();
  for (const s of stages()) {
    if (stages().some((x) => x.name === s.image)) continue;
    assert.ok(!/:latest$/.test(s.image) && /:/.test(s.image), `${s.image}: a version or digest`);
  }
  assert.doesNotMatch(text, /COPY[^\n]*\.env(\s|$)/, 'no env file');
  assert.match(text, /(npm ci[^\n]*--omit=dev|--production|NODE_ENV=production)/, 'production dependencies only');
  const ignore = exists('.dockerignore') ? read('.dockerignore') : '';
  for (const name of ['.env', 'node_modules', '.git', 'test', 'e2e', 'apps']) assert.ok(new RegExp(`^/?${name.replace('.', '\\.')}/?\\*{0,2}$`, 'm').test(ignore), `.dockerignore leaves out ${name}`);
  assert.ok(!/ENV\s+[A-Z_]*(SECRET|PASSWORD|TOKEN|KEY)[A-Z_]*=\S+/.test(text), 'no secret in an ENV line');
  assert.match(text, /(tini|dumb-init|--init|init\b)/i, 'a signal-forwarding init so SIGTERM reaches node');
});

for (const target of ['web', 'worker']) {
  test(`G-01: the ${target} image runs as a non-root user on a read-only file system with /tmp writable, and stays up`, { skip: hasTool('docker') ? false : needsCi('docker'), timeout: 600_000 }, async () => {
    const tag = `bhava-spec-${target}:${process.pid}`;
    const build = await run('docker', ['build', '--target', target, '-t', tag, '.']);
    assert.equal(build.code, 0, build.out.slice(-600));
    try {
      const id = await run('docker', ['run', '--rm', '--read-only', '--tmpfs', '/tmp', '--entrypoint', 'id', tag, '-u']);
      assert.equal(id.code, 0, id.out);
      assert.notEqual(id.out.trim(), '0', 'runs as root');
      const write = await run('docker', ['run', '--rm', '--read-only', '--tmpfs', '/tmp', '--entrypoint', 'sh', tag, '-c', 'touch /app/x 2>/dev/null && echo WRITABLE || echo READONLY; touch /tmp/x && echo TMPOK']);
      assert.match(write.out, /READONLY/);
      assert.match(write.out, /TMPOK/);
    } finally {
      await run('docker', ['rmi', '-f', tag]);
    }
  });
}

test('G-01: the same image is built for arm64 and amd64 in CI', () => {
  const workflow = read('.github/workflows/prod.yml');
  assert.ok(workflow.includes('amd64') && workflow.includes('arm64'));
  assert.match(workflow, /--read-only/);
});

// ---- G-08: compose -------------------------------------------------------------------------------------------------------

const composeFile = () => walk(`${PROD}/compose`).find((f) => /compose\.ya?ml$/.test(f) && !/\.ci\./.test(f));

test('G-08: the compose file has two web servers, a worker and a balancer, each app container locked down, with probes and a grace period longer than the drain', () => {
  const file = composeFile();
  assert.ok(file, 'no compose.yaml under deploy/prod/compose');
  const doc = docsOf(file)[0];
  const services = doc.services ?? {};
  for (const name of ['web-1', 'web-2', 'worker', 'lb']) assert.ok(services[name], `service ${name}`);
  for (const name of ['web-1', 'web-2', 'worker']) {
    const s = services[name];
    assert.equal(s.read_only, true, `${name}: read_only`);
    assert.ok(JSON.stringify(s.tmpfs ?? '').includes('/tmp'), `${name}: tmpfs /tmp`);
    assert.ok(s.user && !/^(root|0)/.test(String(s.user)), `${name}: a non-root user`);
    assert.ok(JSON.stringify(s.cap_drop ?? []).includes('ALL'), `${name}: cap_drop ALL`);
    assert.ok(JSON.stringify(s.security_opt ?? []).includes('no-new-privileges'), `${name}: no-new-privileges`);
    assert.ok(s.healthcheck, `${name}: a health check`);
    assert.ok(s.mem_limit || s.deploy?.resources?.limits?.memory, `${name}: a memory limit`);
    const env = Array.isArray(s.environment) ? Object.fromEntries(s.environment.map((e) => String(e).split(/=(.*)/s).slice(0, 2))) : s.environment ?? {};
    assert.equal(String(env.DEPLOY_ENV), 'production', `${name}: DEPLOY_ENV`);
    assert.equal(String(env.SECRETS_DRIVER), 'file', `${name}: secrets from files`);
    assert.ok(seconds(s.stop_grace_period) > Number(env.SHUTDOWN_SECONDS ?? SHUTDOWN), `${name}: the grace period is longer than SHUTDOWN_SECONDS`);
    assert.ok(JSON.stringify(s.secrets ?? []).length > 2, `${name}: secrets are mounted`);
  }
  for (const name of ['postgres', 'redis', 'clickhouse', 'minio', 'db']) assert.equal(name in services, false, `${name} is an outside address, not a service of this file`);
  const webHealth = JSON.stringify(services['web-1'].healthcheck);
  assert.match(webHealth, /healthz|readyz/);
});

test('G-08: the balancer is health-checked on readiness and has no session stickiness', () => {
  const file = composeFile();
  assert.ok(file, 'no compose file');
  const all = walk(`${PROD}/compose`).filter((f) => !/\.ci\./.test(f)).map(read).join('\n');
  assert.match(all, /readyz/);
  assert.doesNotMatch(all, /(ip_hash|sticky|stick-table|cookie\s+SERVERID|hash\s+\$)/i, 'sticky sessions hide a server that keeps state locally');
});

test('G-08: the CI override adds the services for the readiness checks and the main file does not', () => {
  const ci = walk(`${PROD}/compose`).find((f) => /compose\.ci\.ya?ml$/.test(f));
  assert.ok(ci, 'compose.ci.yaml');
  const services = Object.keys(docsOf(ci)[0].services ?? {});
  for (const need of ['postgres', 'redis']) assert.ok(services.some((s) => s.includes(need)), `a ${need} service`);
});

test('G-08: docker compose accepts the file', { skip: hasTool('docker') ? false : needsCi('docker') }, async () => {
  const file = composeFile();
  assert.ok(file);
  const res = await run('docker', ['compose', '-f', file, 'config', '-q'], { timeoutMs: 120_000 });
  assert.equal(res.code, 0, res.out.slice(-600));
});

// ---- G-08: Kubernetes ----------------------------------------------------------------------------------------------------

const k8sDocs = () => walk(`${PROD}/k8s`).filter((f) => YAML.test(f)).flatMap((f) => docsOf(f).map((d) => ({ file: f, ...d })));
const podSpec = (d) => d.spec?.template?.spec ?? {};
const containers = (d) => podSpec(d).containers ?? [];

test('G-08: the manifests hold a web and a worker deployment, each pod hardened, with probes on the three health paths and a grace period longer than the drain', () => {
  const docs = k8sDocs();
  assert.ok(docs.length > 0, 'no manifests under deploy/prod/k8s');
  const deployments = docs.filter((d) => d.kind === 'Deployment');
  const web = deployments.find((d) => /web/.test(d.metadata?.name));
  const worker = deployments.find((d) => /worker/.test(d.metadata?.name));
  assert.ok(web && worker, 'a web and a worker deployment');
  assert.ok(web.spec.replicas >= 2, 'two web replicas or more');
  for (const d of [web, worker]) {
    const spec = podSpec(d);
    assert.ok(Number(spec.terminationGracePeriodSeconds) > SHUTDOWN, `${d.metadata.name}: a grace period longer than SHUTDOWN_SECONDS`);
    assert.ok(spec.securityContext?.runAsNonRoot === true || containers(d).every((c) => c.securityContext?.runAsNonRoot === true), `${d.metadata.name}: runAsNonRoot`);
    assert.ok(JSON.stringify(spec.volumes ?? []).includes('emptyDir'), `${d.metadata.name}: an emptyDir`);
    for (const c of containers(d)) {
      assert.equal(c.securityContext?.readOnlyRootFilesystem, true, `${c.name}: read-only root`);
      assert.equal(c.securityContext?.allowPrivilegeEscalation, false, `${c.name}: no privilege escalation`);
      assert.ok(JSON.stringify(c.securityContext?.capabilities?.drop ?? []).includes('ALL'), `${c.name}: capabilities dropped`);
      assert.ok(c.resources?.requests && c.resources?.limits, `${c.name}: requests and limits`);
      assert.ok((c.volumeMounts ?? []).some((m) => m.mountPath === '/tmp'), `${c.name}: /tmp mounted`);
      assert.equal((spec.securityContext?.seccompProfile ?? c.securityContext?.seccompProfile)?.type, 'RuntimeDefault', `${c.name}: seccomp`);
      assert.equal(c.startupProbe?.httpGet?.path, '/startupz', `${c.name}: startup probe`);
      assert.equal(c.livenessProbe?.httpGet?.path, '/healthz', `${c.name}: liveness probe`);
      assert.equal(c.readinessProbe?.httpGet?.path, '/readyz', `${c.name}: readiness probe`);
      assert.doesNotMatch(JSON.stringify(c), /"image":"[^"]*:latest"/, `${c.name}: a pinned image`);
    }
  }
  const workerPort = JSON.stringify(containers(worker)[0].readinessProbe.httpGet.port);
  assert.ok(/3001|WORKER_HEALTH|worker-health|health/i.test(workerPort + JSON.stringify(containers(worker)[0].ports ?? [])), 'the worker probes its own port');
});

test('G-08: the manifests also hold a disruption budget, an autoscaler, a network policy and a service account that mounts no token, and no Secret with a value', () => {
  const docs = k8sDocs();
  const kinds = new Set(docs.map((d) => d.kind));
  for (const kind of ['PodDisruptionBudget', 'HorizontalPodAutoscaler', 'NetworkPolicy', 'ServiceAccount', 'Service', 'Ingress', 'ConfigMap']) assert.ok(kinds.has(kind), kind);
  assert.equal(docs.find((d) => d.kind === 'ServiceAccount').automountServiceAccountToken, false);
  for (const secret of docs.filter((d) => d.kind === 'Secret')) {
    const filled = Object.values({ ...(secret.data ?? {}), ...(secret.stringData ?? {}) }).filter((v) => String(v).length > 0);
    assert.deepEqual(filled, [], `Secret ${secret.metadata?.name} holds a value`);
  }
  const text = walk(`${PROD}/k8s`).filter((f) => YAML.test(f)).map(read).join('\n');
  assert.match(text, /DEPLOY_ENV/);
  assert.match(text, /production/);
});

test('G-08: kustomize builds the base and the production overlay, and kubeconform accepts the result', { skip: hasTool('kustomize') && hasTool('kubeconform') ? false : needsCi('kustomize and kubeconform') }, async () => {
  const overlays = walk(`${PROD}/k8s/overlays`).filter((f) => /kustomization\.ya?ml$/.test(f)).map((f) => path.dirname(f));
  assert.ok(overlays.length > 0);
  for (const dir of [`${PROD}/k8s/base`, ...overlays]) {
    const built = await run('kustomize', ['build', dir]);
    assert.equal(built.code, 0, built.out.slice(-600));
    const file = path.join(ROOT, 'node_modules', '.cache-spec-k8s.yaml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, built.out);
    const checked = await run('kubeconform', ['-strict', '-summary', file]);
    fs.rmSync(file, { force: true });
    assert.equal(checked.code, 0, checked.out.slice(-600));
  }
});

// ---- G-08: Terraform -----------------------------------------------------------------------------------------------------

const tfFiles = () => walk(`${PROD}/terraform`).filter((f) => /\.tf$/.test(f));
const tfText = () => tfFiles().map(read).join('\n');

test('G-08: the Terraform has one region variable that accepts exactly the India regions of regions.json, with no default outside them', () => {
  assert.ok(tfFiles().length > 0, 'no .tf files');
  const text = tfText();
  const block = /variable\s+"region"\s*\{([\s\S]*?)\n\}/.exec(text);
  assert.ok(block, 'a variable "region"');
  assert.match(block[1], /validation\s*\{/, 'a validation block');
  const india = json(`${PROD}/regions.json`).india;
  const listed = [...block[1].matchAll(/"([a-z0-9-]+)"/g)].map((m) => m[1]).filter((v) => v !== 'region' && v !== 'india');
  const names = new Set(listed);
  assert.deepEqual(india.filter((r) => !names.has(r) && !/regions\.json|jsondecode|file\(/.test(block[1])), [], 'every India region is accepted');
  assert.deepEqual(listed.filter((r) => !india.includes(r) && /-\d$|^[a-z]+-[a-z]+$/.test(r) && !['the', 'must'].includes(r)).filter((r) => /^(us|eu|ap|sa|ca|me|af)-/.test(r)), [], 'a region outside India');
  const def = /default\s*=\s*"([^"]+)"/.exec(block[1])?.[1];
  if (def) assert.ok(india.includes(def), `the default ${def} is not an India region`);
  assert.equal([...text.matchAll(/variable\s+"([^"]*region[^"]*)"/gi)].map((m) => m[1]).filter((n) => n !== 'region').length, 0, 'only one variable may hold a region');
});

test('G-08: the Terraform is provider-neutral, has no backend, marks secret references sensitive, and holds no value', () => {
  const text = tfText();
  assert.doesNotMatch(text, /provider\s+"(aws|azurerm|google|oci|alicloud|digitalocean|hcloud)"/, 'a cloud provider');
  assert.doesNotMatch(text, /\b(aws|azurerm|google|oci|alicloud)_[a-z_]+\s+"/, 'a cloud resource');
  assert.doesNotMatch(text, /backend\s+"/, 'no state backend in the repository');
  assert.match(text, /kubernetes/);
  for (const m of text.matchAll(/variable\s+"([a-z_]*(secret|token|password|key|credential)[a-z_]*)"\s*\{([\s\S]*?)\n\}/gi)) assert.match(m[3], /sensitive\s*=\s*true/, `${m[1]} is sensitive`);
  assert.doesNotMatch(text, /(AKIA[0-9A-Z]{16}|-----BEGIN|postgres:\/\/[^:\s"]+:[^@\s"$]{4,}@)/, 'a secret value');
  const example = walk(`${PROD}/terraform`).find((f) => /terraform\.tfvars\.example$/.test(f));
  assert.ok(example, 'terraform.tfvars.example');
  assert.doesNotMatch(read(example), /(AKIA|-----BEGIN|:\/\/[^\s"]*:[^\s"@]{6,}@)/);
});

test('G-08: terraform validates with no backend, and a region outside India is refused by the variable itself', { skip: hasTool('terraform') ? false : needsCi('terraform'), timeout: 600_000 }, async () => {
  const dir = path.join(ROOT, PROD, 'terraform');
  const init = await run('terraform', [`-chdir=${dir}`, 'init', '-backend=false', '-input=false']);
  assert.equal(init.code, 0, init.out.slice(-600));
  const valid = await run('terraform', [`-chdir=${dir}`, 'validate']);
  assert.equal(valid.code, 0, valid.out.slice(-600));
  const fmt = await run('terraform', [`-chdir=${dir}`, 'fmt', '-check', '-recursive']);
  assert.equal(fmt.code, 0, `terraform fmt: ${fmt.out.slice(-300)}`);
  for (const region of ['us-east-1', 'eu-west-1', 'ap-southeast-1', 'eastus', 'europe-west1', '', 'India', 'anywhere']) {
    const plan = await run('terraform', [`-chdir=${dir}`, 'plan', '-input=false', '-refresh=false', '-lock=false', `-var=region=${region}`]);
    assert.notEqual(plan.code, 0, `region "${region}" was accepted`);
    assert.match(plan.out, /region/i, `region "${region}": the refusal names the variable`);
  }
});

// ---- all templates -------------------------------------------------------------------------------------------------------

test('G-08: no template holds a secret, a private key, a public address or a person, and none names a cloud provider\'s service', () => {
  const files = walk(PROD).filter((f) => !/README\.md$/.test(f));
  assert.ok(files.length > 3, 'there are templates');
  const problems = [];
  for (const file of files) {
    const text = read(file);
    const ips = [...text.matchAll(/(?<![d.])(d{1,3}.d{1,3}.d{1,3}.d{1,3})(?![d.])/g)].map((m) => m[1]).filter((ip) => !['0.0.0.0', '127.0.0.1'].includes(ip) && !/^(10.|192.168.|172.(1[6-9]|2d|3[01]).)/.test(ip));
    if (ips.length) problems.push(`${file}: an address ${ips[0]}`);
    if (/AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|xox[bp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}/.test(text)) problems.push(`${file}: a key`);
    if (/(password|secret|token)\s*[:=]\s*["']?(?!\$\{|<|\{\{|changeme|CHANGE|REPLACE|example|placeholder|file:|\/run\/|\/var\/|""|''|$)[A-Za-z0-9+/_-]{16,}/i.test(text.replace(/^\s*#.*$/gm, ''))) problems.push(`${file}: a value beside a secret name`);
    if (/\b(amazonaws\.com|azure\.com|googleapis\.com|oraclecloud\.com|digitaloceanspaces\.com|rds\.|elasticache\.)/i.test(text)) problems.push(`${file}: a cloud address`);
    if (/\b[6-9]\d{9}\b/.test(text)) problems.push(`${file}: a phone number`);
  }
  assert.deepEqual(problems, []);
});

test('G-08: DEPLOY_ENV=production is set by these templates and by nothing else in the repository\'s other deploy folders', () => {
  const others = walk('deploy').filter((f) => !f.startsWith(`${PROD}/`) && !/\.md$/.test(f));
  for (const file of others) assert.doesNotMatch(read(file), /DEPLOY_ENV\s*[:=]\s*["']?production/, file);
  assert.match(walk(PROD).filter((f) => !/\.md$/.test(f)).map(read).join('\n'), /DEPLOY_ENV\s*[:=]\s*["']?production/);
  assert.ok(exists('deploy/bhava'), 'the QA compose folder is left as it is');
});

test('G-08: `npm run prod:validate` runs every validator, and a run without the tools says so instead of passing', async (t) => {
  const res = await runNode(['tools/readiness/index.mjs', 'validate', '--json'], { timeoutMs: 580_000 });
  if (res.code === 2) return t.skip(needsCi(`the validators or the check itself (${(res.stderr || res.stdout).split('\n')[0].slice(0, 120)})`));
  const report = JSON.parse(res.stdout);
  assert.equal(report.check, 'validate');
  assert.ok(Array.isArray(report.steps) && report.steps.length >= 5);
  for (const step of report.steps) assert.equal(typeof step.ok, 'boolean', step.name);
  const skipped = report.steps.filter((s) => s.ok === true && /skip|not run|not installed|missing tool/i.test(s.detail ?? ''));
  assert.deepEqual(skipped.map((s) => s.name), [], 'a step that did not run is not a pass');
  assert.equal(res.code, report.ok ? 0 : 1);
  assert.equal(JSON.stringify(report).includes('postgres://'), false);
});
