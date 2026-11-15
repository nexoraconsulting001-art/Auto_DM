// What every template and runbook of this track must hold: no secret, no account id, no real address, no cloud named
// outside the region notes and the marked examples, and a runbook for each thing a person does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanText } from '../../../tools/secret-scan.mjs';
import { ALLOWED_ADDRESS, filesUnder, read } from './support.js';

const OWNED = ['Dockerfile', '.dockerignore', ...['compose', 'k8s', 'terraform', 'runbooks'].flatMap((d) => filesUnder(`deploy/prod/${d}`)), 'scripts/move-to-cloud.js', 'scripts/copy-files.js'];
const CLOUDS = /\b(aws|amazon|ec2|eks|gcp|gke|google cloud|azure|aks|oracle cloud|oci|digitalocean|linode|akamai|ibm cloud|alibaba|hetzner|vultr|jio cloud)\b/i;
/** Where a cloud may be named: the marked examples, and the region notes (a section of the Terraform README). */
/** The S3 client package the repository already uses for any S3-compatible store is a package name, not a choice of cloud. */
const cloudFree = (file, text) => (file.includes('/examples/') ? '' : file === 'deploy/prod/terraform/README.md' ? text.replace(/## The region list[\s\S]*?(?=\n## |$)/, '') : text).replaceAll('@aws-sdk/client-s3', '');

test('G-08 no template or runbook holds a secret, an account id or the VM\'s address', () => {
  const findings = OWNED.flatMap((file) => scanText(file, read(file)));
  assert.deepEqual(findings, []);
  for (const file of OWNED) {
    const text = read(file);
    assert.doesNotMatch(text, /\b\d{12}\b/, `${file}: no account id`);
    assert.doesNotMatch(text, /arn:|projects\/[a-z][a-z0-9-]+\/|subscriptions\/[0-9a-f-]{36}|ocid1\./i, `${file}: no provider resource id`);
    for (const m of text.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g)) assert.match(m[1], ALLOWED_ADDRESS, `${file}: ${m[1]} is not a placeholder or private range`);
    for (const m of text.matchAll(/[\w.+-]+@([a-z0-9-]+\.[a-z.]+)/gi)) assert.match(m[1], /^(example\.com|anthropic\.com)$/, `${file}: an email address`);
    // <user>:<password> is how a runbook names the parts; anything else before an @ is a real login.
    assert.doesNotMatch(text, /:\/\/[^\s/'"`<>]+:[^\s@/'"`<>]{3,}@/, `${file}: a login inside an address`);
  }
});

test('G-08 nothing names one cloud except the region notes and the marked examples', () => {
  for (const file of OWNED) assert.doesNotMatch(cloudFree(file, read(file)), CLOUDS, file);
  const notes = read('deploy/prod/terraform/README.md');
  assert.match(notes, /## The region list/);
  assert.match(notes, /Cloudflare/, 'the note on Cloudflare in front');
});

const RUNBOOKS = {
  'first-deploy.md': [/move-to-cloud\.js schema|overlays\/production-migrate/, /bhava-secrets/, /terraform/i],
  'rollout-and-rollback.md': [/production-migrate/, /kubectl -n bhava wait --for=condition=complete/, /rollout undo/, /roll back/i],
  'database-changes.md': [/expand/i, /contract/i, /old code/i, /advisory lock/i],
  'restore.md': [/restore --dump/, /verify --fingerprint/, /npm run check:r07/],
  'rotate-master-key.md': [/DATA_KEY_OLD/, /secret-rotation/],
  'dns-and-cutover.md': [/Full \(strict\)/, /\/tls\/ask/, /\/webhook\b/, /\/webhooks\/razorpay/, /\/webhooks\/courier/, /\/webhooks\/whatsapp/, /\/webhooks\/billing\/razorpay/, /go back/i, /TTL/],
  'move-from-vm.md': [/fingerprint --out/, /copy-files\.js/, /restore --dump/, /rollups/, /verify --fingerprint/, /--verify/],
  'scaling.md': [/\b50\b/, /1,000/, /queue_jobs/, /max_connections|connection/i],
};

test('G-08 a runbook in plain steps for each thing a person does', () => {
  for (const [file, needles] of Object.entries(RUNBOOKS)) {
    const text = read(`deploy/prod/runbooks/${file}`);
    assert.ok((text.match(/^\d+\. /gm) ?? []).length >= 4, `${file}: numbered steps`);
    for (const needle of needles) assert.match(text, needle, `${file}: ${needle}`);
  }
  const index = read('deploy/prod/runbooks/README.md');
  for (const file of Object.keys(RUNBOOKS)) assert.ok(index.includes(file), `the runbook index lists ${file}`);
});
