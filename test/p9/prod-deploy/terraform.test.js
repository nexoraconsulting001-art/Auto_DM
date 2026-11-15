// G-08: the Terraform module. Read as text here; `terraform fmt -check`, `init -backend=false`, `validate` and a plan
// with a region outside India run when Terraform is on this machine, and otherwise in the prod workflow.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SECRET_SETTINGS } from '../../../src/config.js';
import { ROOT, filesUnder, hasTool, misalignedHcl, read, yamlDoc } from './support.js';

const TF = 'deploy/prod/terraform';
const tfFiles = filesUnder(TF).filter((f) => f.endsWith('.tf'));
const all = tfFiles.map(read).join('\n');
const variables = [...read(`${TF}/variables.tf`).matchAll(/^variable "([a-z_]+)" \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1], body: m[2] }));
const regions = JSON.parse(read('deploy/prod/regions.json'));

test('G-08 one region variable, accepting exactly the India regions of regions.json', () => {
  const region = variables.find((v) => v.name === regions.variable);
  assert.ok(region, 'a variable named region');
  assert.match(region.body, /condition\s+= contains\(jsondecode\(file\("\$\{path\.module\}\/\.\.\/regions\.json"\)\)\.india, var\.region\)/);
  assert.doesNotMatch(region.body, /default\s*=/, 'no default region');
  assert.deepEqual(variables.filter((v) => v.name !== 'region' && /region/.test(v.name)).map((v) => v.name), [], 'no other variable names a region');
  // The validation's own rule, applied to names on and off the list.
  const accepts = (value) => regions.india.includes(value);
  for (const r of regions.india) assert.equal(accepts(r), true, r);
  for (const outside of ['us-east-1', 'eu-west-1', 'ap-southeast-1', 'eastus', 'europe-west1', '', 'India', 'ap-south-1 ']) assert.equal(accepts(outside), false, outside);
  assert.match(all, /S3_REGION\s+= var\.region/);
  assert.match(all, /BACKUP_S3_REGION\s+= var\.region/);
});

test('G-08 provider-neutral: only the Kubernetes API, no backend, no secret value, secret references sensitive', () => {
  const providers = [...all.matchAll(/^\s+source\s+= "([^"]+)"/gm)].map((m) => m[1]).sort();
  assert.deepEqual(providers, ['hashicorp/kubernetes', 'kbst/kustomization']);
  assert.doesNotMatch(all, /^\s*backend\s+"/m, 'no state backend in the repository');
  assert.doesNotMatch(all, /^provider "(aws|google|azurerm|oci|digitalocean|linode|ibm|alicloud|helm)"/m);
  assert.match(read(`${TF}/variables.tf`), /variable "secrets" \{[\s\S]*?sensitive = true/);
  for (const v of variables) {
    const def = /default\s+= (.*)/.exec(v.body)?.[1] ?? '';
    assert.doesNotMatch(def, /:\/\/[^"]*@|password|secret_key|AKIA/i, `${v.name}: no credential default`);
  }
  for (const name of Object.keys(SECRET_SETTINGS)) assert.equal(new RegExp(`\\b${name}\\s+=`).test(all), false, `${name} is never a Terraform value`);
  assert.match(all, /required_version = ">= 1\.9\.0"/, 'variable validation that reads a file needs 1.9');
});

test('G-08 the migration Job runs and is waited for before the rest of the release is applied', () => {
  const main = read(`${TF}/main.tf`);
  assert.match(main, /resource "kubernetes_job_v1" "migrate"[\s\S]*command = \["node", "scripts\/move-to-cloud\.js", "schema"\][\s\S]*wait_for_completion = true/);
  assert.match(main, /resource "kustomization_resource" "p1" \{[\s\S]*?depends_on = \[[^\]]*kubernetes_job_v1\.migrate/);
  assert.match(main, /migrate_job\s+= "bhava-migrate-\$\{substr\(sha256\(var\.web_image\), 0, 10\)\}"/, 'a new image gets a new Job');
  assert.match(main, /resources = \["\$\{path\.module\}\/\.\.\/k8s\/base"\]/, 'it installs the same base the kustomize overlay does');
  // The settings it merges are the ones the overlay sets, so the two ways to deploy agree.
  const overlay = Object.keys(yamlDoc('deploy/prod/k8s/overlays/production/config.yaml').data).sort();
  const block = /config = \{([\s\S]*?)\n  \}/.exec(main)[1];
  const keys = [...block.matchAll(/^\s+([A-Z0-9_]+)\s+=/gm)].map((m) => m[1]).sort();
  assert.deepEqual(keys, overlay);
});

test('G-08 the files follow terraform fmt\'s alignment, and the example holds placeholders only', () => {
  for (const file of tfFiles) assert.deepEqual(misalignedHcl(read(file)), [], file);
  const example = read(`${TF}/terraform.tfvars.example`);
  assert.match(example, /region = "set-me"/);
  assert.doesNotMatch(example, /:\/\/[^"\s]*@/, 'no login in an address');
  for (const host of example.matchAll(/"https?:\/\/([^/":]+)/g)) assert.match(host[1], /example\.com$/, host[1]);
});

test('G-08 terraform fmt, init -backend=false and validate pass, and a region outside India is refused (needs Terraform)', { timeout: 300_000 }, (t) => {
  if (!hasTool('terraform', ['version'])) return t.skip('Terraform is not available here: the prod workflow\'s templates job runs fmt, init -backend=false and validate');
  // A copy of deploy/prod, so .terraform and the lock file never land in the repository.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bhava-tf-'));
  fs.cpSync(path.join(ROOT, 'deploy/prod'), dir, { recursive: true });
  const cwd = path.join(dir, 'terraform');
  const run = (...args) => spawnSync('terraform', args, { cwd, encoding: 'utf8', timeout: 240_000 });
  try {
    assert.equal(run('fmt', '-check', '-recursive').status, 0, 'terraform fmt -check');
    const init = run('init', '-backend=false', '-input=false');
    if (init.status !== 0) return t.skip('terraform init could not fetch the providers here (no network): CI runs it');
    assert.equal(run('validate').status, 0, 'terraform validate');
    const plan = run('plan', '-input=false', '-refresh=false', '-var-file=terraform.tfvars.example', '-var=region=us-east-1');
    assert.notEqual(plan.status, 0);
    assert.match(plan.stdout + plan.stderr, /must be an India region/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
