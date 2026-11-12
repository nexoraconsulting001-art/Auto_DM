/**
 * Step 7, report: what happened, per platform, as data and as a few lines. It runs after a failure too, so a run that stopped
 * at "validate" still says where and names the field. Nothing personal and nothing secret is in it: ids, build numbers and file
 * names only.
 *
 * In:  the whole state, and the error that stopped the run (or null)
 * Out: { report: { ok, tenantId, name, appVersion, step, field, code, message, problems, brandFile, builds, submissions } }
 */
import fs from 'node:fs';
import path from 'node:path';

export const name = 'report';

export function makeReport(state, error = null) {
  const builds = state.builds ?? [];
  const submissions = state.submissions ?? [];
  const failedBuild = builds.find((b) => b.status === 'failed');
  const failedSubmission = submissions.find((s) => s.status === 'failed');
  return {
    ok: !error && !failedBuild && !failedSubmission,
    tenantId: state.brand?.tenantId ?? null,
    name: state.brand?.name ?? null,
    appVersion: state.brand?.appVersion ?? null,
    step: error?.step ?? (failedBuild ? 'build' : failedSubmission ? 'submit' : null),
    field: error?.field ?? null,
    code: error?.code ?? (failedBuild ? 'build_failed' : failedSubmission ? 'submit_failed' : null),
    message: error?.message ?? failedBuild?.detail ?? failedSubmission?.detail ?? null,
    problems: error?.problems ?? [],
    brandFile: state.brandFile ?? null,
    builds,
    submissions,
  };
}

export const reportLines = (report) => [
  `build-brand: ${report.name ?? 'this brand'}: ${report.ok ? 'done' : `stopped at ${report.step}`}`,
  ...(report.ok ? [] : [`  ${report.field ? `${report.field}: ` : ''}${report.message}`]),
  ...report.builds.map((b) => `  ${b.platform} build ${b.buildNumber ?? '?'}: ${b.status}${b.artifact ? ` (${path.basename(b.artifact)})` : ''}`),
  ...report.submissions.map((s) => `  ${s.platform} submission: ${s.status}`),
];

export async function run(state, { options, log, error = null }) {
  const report = makeReport(state, error);
  for (const line of reportLines(report)) log(line);
  if (options.reportFile) {
    const file = path.resolve(options.cwd, options.reportFile);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  }
  return { report };
}
