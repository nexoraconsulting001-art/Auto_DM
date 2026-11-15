// G-08: the Kubernetes manifests. Their structure is read here; `kustomize build` and `kubeconform -strict` run when
// those tools are on this machine and otherwise in the prod workflow's templates job.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { SECRET_SETTINGS } from '../../../src/config.js';
import { METRICS } from '../../../src/contracts/metrics.js';
import { STEPS } from '../../../scripts/move-to-cloud.js';
import { ROOT, filesUnder, hasTool, read, yamlDoc, yamlDocs } from './support.js';

const K = 'deploy/prod/k8s';
const base = yamlDoc(`${K}/base/kustomization.yaml`);
const docs = base.resources.flatMap((file) => yamlDocs(`${K}/base/${file}`));
const find = (kind, name) => docs.find((d) => d.kind === kind && d.metadata.name === name);
const web = find('Deployment', 'bhava-web');
const worker = find('Deployment', 'bhava-worker');
const job = yamlDoc(`${K}/jobs/migrate/job.yaml`);
const cron = find('CronJob', 'bhava-backup');
const podSpecs = [['web', web.spec.template.spec], ['worker', worker.spec.template.spec], ['migrate', job.spec.template.spec], ['backup', cron.spec.jobTemplate.spec.template.spec]];
const config = find('ConfigMap', 'bhava-config');

test('G-08 web and worker: probes on the three health endpoints, a pre-stop drain, requests and limits', () => {
  for (const [deployment, port, portName] of [[web, 3000, 'http'], [worker, 3001, 'health']]) {
    const spec = deployment.spec.template.spec;
    const [c] = spec.containers;
    assert.equal(c.ports.find((p) => p.name === portName).containerPort, port);
    assert.deepEqual([c.startupProbe.httpGet.path, c.livenessProbe.httpGet.path, c.readinessProbe.httpGet.path], ['/startupz', '/healthz', '/readyz']);
    for (const probe of [c.startupProbe, c.livenessProbe, c.readinessProbe]) assert.equal(probe.httpGet.port, portName);
    const pause = Number(c.lifecycle.preStop.exec.command.at(-1));
    assert.ok(pause > 0);
    assert.ok(spec.terminationGracePeriodSeconds > pause + Number(config.data.SHUTDOWN_SECONDS), 'the grace period outlasts the pause and the drain');
    for (const key of ['cpu', 'memory']) assert.ok(c.resources.requests[key] && c.resources.limits[key], `${deployment.metadata.name}: ${key}`);
    assert.deepEqual(c.envFrom, [{ configMapRef: { name: 'bhava-config' } }]);
  }
  assert.equal(config.data.WORKER_HEALTH_HOST, '0.0.0.0', 'the kubelet can reach the worker\'s health port');
  assert.equal(config.data.WORKER_HEALTH_PORT, '3001');
  assert.ok(web.spec.replicas >= 2);
  assert.equal(web.spec.strategy.rollingUpdate.maxUnavailable, 0, 'old pods keep serving until new ones are ready');
});

test('G-01 G-04 every pod: non-root, read-only root, /tmp writable, nothing extra, secrets mounted from the cluster store', () => {
  for (const [name, spec] of podSpecs) {
    assert.equal(spec.securityContext.runAsNonRoot, true, name);
    assert.equal(spec.securityContext.seccompProfile.type, 'RuntimeDefault', name);
    assert.equal(spec.automountServiceAccountToken, false, name);
    for (const c of spec.containers) {
      assert.equal(c.securityContext.readOnlyRootFilesystem, true, name);
      assert.equal(c.securityContext.allowPrivilegeEscalation, false, name);
      assert.deepEqual(c.securityContext.capabilities.drop, ['ALL'], name);
      assert.ok(c.resources.requests && c.resources.limits, `${name}: requests and limits`);
      assert.equal(c.volumeMounts.find((m) => m.mountPath === '/tmp').name, 'tmp', name);
      const secrets = c.volumeMounts.find((m) => m.mountPath === '/run/secrets');
      assert.equal(secrets.readOnly, true, name);
      for (const e of c.env ?? []) assert.ok(!(e.name in SECRET_SETTINGS), `${name}: ${e.name} is a mounted file, not an environment value`);
    }
    assert.ok(spec.volumes.find((v) => v.name === 'tmp').emptyDir, name);
    assert.equal(spec.volumes.find((v) => v.name === 'secrets').secret.secretName, 'bhava-secrets', name);
  }
  assert.equal(config.data.SECRETS_DRIVER, 'file');
  assert.equal(config.data.SECRETS_DIR, '/run/secrets');
  for (const name of Object.keys(config.data)) assert.ok(!(name in SECRET_SETTINGS), `the ConfigMap holds no secret: ${name}`);
  const all = filesUnder(K).filter((f) => f.endsWith('.yaml')).flatMap((f) => yamlDocs(f));
  assert.deepEqual(all.filter((d) => d.kind === 'Secret'), [], 'no manifest holds a Secret');
  assert.equal(config.data.DEPLOY_ENV, undefined, 'DEPLOY_ENV=production is the overlay\'s, not the base\'s');
  assert.equal(yamlDoc(`${K}/overlays/production/config.yaml`).data.DEPLOY_ENV, 'production');
});

test('G-08 autoscaling on load and on queue depth, disruption budgets, a backup CronJob', () => {
  const webHpa = find('HorizontalPodAutoscaler', 'bhava-web');
  assert.equal(webHpa.spec.scaleTargetRef.name, 'bhava-web');
  assert.ok(webHpa.spec.minReplicas >= 2);
  assert.ok(webHpa.spec.metrics.some((m) => m.type === 'Resource' && m.resource.name === 'cpu'));
  const workerHpa = find('HorizontalPodAutoscaler', 'bhava-worker');
  const queue = workerHpa.spec.metrics.find((m) => m.type === 'External');
  assert.equal(queue.external.metric.name, 'queue_jobs');
  assert.ok(METRICS.queue_jobs && METRICS.queue_jobs.labels.includes('status'), 'the queue metric is in the catalogue, with its status label');
  assert.deepEqual(Object.keys(queue.external.metric.selector.matchLabels), ['status']);
  assert.equal(find('PodDisruptionBudget', 'bhava-web').spec.minAvailable, 1);
  assert.equal(find('PodDisruptionBudget', 'bhava-worker').spec.maxUnavailable, 1);
  assert.equal(cron.spec.concurrencyPolicy, 'Forbid');
  assert.deepEqual(cron.spec.jobTemplate.spec.template.spec.containers[0].command, ['node', 'scripts/backup.js']);
  assert.equal(config.data.BACKUP_STORAGE_DRIVER, 's3');
});

test('G-08 the migration Job runs on its own before a rollout, with the new image and only the database logins', () => {
  assert.equal(base.resources.some((r) => /migrat/i.test(r)), false, 'the Job is not in the base every rollout re-applies');
  assert.equal(docs.some((d) => d.kind === 'Job'), false);
  const [c] = job.spec.template.spec.containers;
  assert.deepEqual(c.command, ['node', 'scripts/move-to-cloud.js', 'schema']);
  assert.ok(STEPS.includes('schema'));
  assert.equal(c.image, 'bhava-web');
  assert.equal(job.spec.backoffLimit, 0, 'a failing migration fails once and stops the release');
  assert.equal(job.spec.template.spec.restartPolicy, 'Never');
  const prodMigrate = yamlDoc(`${K}/overlays/production-migrate/kustomization.yaml`);
  const prod = yamlDoc(`${K}/overlays/production/kustomization.yaml`);
  assert.deepEqual(prodMigrate.resources, ['../../jobs/migrate']);
  assert.equal(prodMigrate.images[0].newTag, prod.images.find((i) => i.name === 'bhava-web').newTag, 'the Job and the rollout name the same image');
  assert.equal(prodMigrate.namespace, prod.namespace);
});

test('G-08 the network policy denies by default and keeps the database private', () => {
  const policies = docs.filter((d) => d.kind === 'NetworkPolicy');
  const deny = policies.find((p) => p.metadata.name === 'bhava-default-deny');
  assert.deepEqual(deny.spec.podSelector, {});
  assert.deepEqual(deny.spec.policyTypes, ['Ingress', 'Egress']);
  const egress = policies.find((p) => p.metadata.name === 'bhava-data-egress');
  assert.deepEqual(egress.spec.podSelector.matchLabels, { 'bhava.app/data-client': 'true' });
  assert.deepEqual(egress.spec.egress.slice(0, 4).map((r) => r.ports.map((p) => p.port)), [[5432], [6379], [8123, 8443], [443]], 'the order the Terraform patch relies on');
  const internet = egress.spec.egress[4];
  assert.equal(internet.to[0].ipBlock.cidr, '0.0.0.0/0');
  assert.ok(internet.to[0].ipBlock.except.includes('10.0.0.0/8'), 'the open egress reaches no private address');
  assert.deepEqual(internet.ports.map((p) => p.port), [443]);
  // Every policy that lets anything reach 5432 lets only the app's pods.
  for (const p of policies) {
    for (const rule of p.spec.ingress ?? []) {
      if (!(rule.ports ?? []).some((port) => port.port === 5432)) continue;
      assert.deepEqual(rule.from, [{ podSelector: { matchLabels: { 'bhava.app/data-client': 'true' } } }], p.metadata.name);
    }
  }
  const labelled = podSpecs.length;
  assert.equal([web, worker, job, { spec: { template: cron.spec.jobTemplate.spec.template } }].filter((d) => d.spec.template.metadata.labels['bhava.app/data-client'] === 'true').length, labelled);
});

test('G-08 the overlay sets the image, the hosts and DEPLOY_ENV; the examples are marked and outside every build', () => {
  const prod = yamlDoc(`${K}/overlays/production/kustomization.yaml`);
  assert.deepEqual(prod.resources, ['../../base']);
  assert.deepEqual(prod.images.map((i) => i.name).sort(), ['bhava-web', 'bhava-worker']);
  const ingress = yamlDoc(`${K}/overlays/production/ingress.yaml`);
  assert.ok(ingress.spec.rules.every((r) => r.host.endsWith('example.com')), 'hosts are placeholders');
  for (const file of filesUnder(`${K}/examples`)) assert.match(read(file), /^# EXAMPLE ONLY/, file);
  const referenced = [base, prod, yamlDoc(`${K}/jobs/migrate/kustomization.yaml`)].flatMap((k) => k.resources);
  assert.equal(referenced.some((r) => r.includes('examples')), false);
  assert.equal(JSON.stringify(docs).includes('"region"'), false, 'no region in the base');
});

test('G-08 kustomize builds the overlay and kubeconform accepts it (needs kustomize or kubectl, and kubeconform)', (t) => {
  const kustomize = hasTool('kustomize', ['version']) ? ['kustomize', ['build']] : hasTool('kubectl', ['version', '--client']) ? ['kubectl', ['kustomize']] : null;
  if (!kustomize) return t.skip('kustomize is not available here: the prod workflow\'s templates job runs kustomize build and kubeconform -strict');
  for (const overlay of ['overlays/production', 'overlays/production-migrate']) {
    const built = spawnSync(kustomize[0], [...kustomize[1], path.join(ROOT, K, overlay)], { encoding: 'utf8' });
    assert.equal(built.status, 0, built.stderr);
    if (!hasTool('kubeconform', ['-v'])) continue;
    const checked = spawnSync('kubeconform', ['-strict', '-summary', '-'], { input: built.stdout, encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stdout + checked.stderr);
  }
});
