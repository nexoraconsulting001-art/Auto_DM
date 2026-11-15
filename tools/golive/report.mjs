// The go-live checklist as text and as Markdown (G-15). Both read only a GoliveStatus: ids, titles, states, fixed-phrase
// details and the next step for each item (src/modules/golive/next-steps.js). No value of any setting can reach them.
import { GOLIVE_OWNERS } from '../../src/contracts/golive.js';
import { OWNER_LABELS, PHASE_LABELS, STATE_LABELS, nextStepFor } from '../../src/modules/golive/next-steps.js';

const MARK = Object.freeze({ ready: 'ready      ', missing: 'MISSING    ', unknown: 'NOT CHECKED' });
const STATE_ORDER = Object.freeze({ missing: 0, unknown: 1, ready: 2 });

/** The items shown, grouped by who must act and then by the phase they block; blocking and open ones first in a group. */
export function groups(status, { blocking = false, owner = null } = {}) {
  const shown = status.items.filter((i) => (!blocking || i.blocks) && (!owner || i.owner === owner));
  const out = [];
  for (const who of GOLIVE_OWNERS) {
    const mine = shown.filter((i) => i.owner === who && i.kind !== 'per_business');
    for (const phase of [...new Set(mine.map((i) => i.phase))].sort((a, b) => a - b)) {
      const items = mine.filter((i) => i.phase === phase)
        .sort((a, b) => Number(b.blocks) - Number(a.blocks) || STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.id.localeCompare(b.id));
      out.push({ owner: who, phase, items });
    }
  }
  const each = shown.filter((i) => i.kind === 'per_business');
  if (each.length) out.push({ owner: 'each', phase: null, items: each });
  return out;
}

const openCount = (status) => status.items.filter((i) => i.blocks && i.state !== 'ready').length;
export function verdictLine(status) {
  const open = openCount(status);
  return open ? `Not ready for go-live: ${open} blocking item${open === 1 ? '' : 's'} open.` : 'Ready for go-live: no blocking item is open.';
}

function groupTitle(group) {
  if (group.owner === 'each') return 'Done by each business (never blocks go-live)';
  return `${OWNER_LABELS[group.owner]} (${group.owner}) · ${PHASE_LABELS[group.phase] ?? `Phase ${group.phase}`}`;
}

/** The list as text: a heading per group, one line per item, its next step under it, and the verdict last. */
export function formatText(status, options = {}) {
  const lines = [];
  for (const group of groups(status, options)) {
    lines.push(`== ${groupTitle(group)} ==`);
    for (const i of group.items) {
      const mark = i.kind === 'per_business' ? 'each       ' : MARK[i.state];
      lines.push(`${mark}  ${i.blocks ? 'blocks ' : '       '} ${i.owner.padEnd(4)} ${i.id.padEnd(28)} ${i.title}${i.state === 'ready' ? '' : `  (${i.detail})`}`);
      const step = nextStepFor(i);
      if (step && i.kind !== 'per_business') lines.push(`           Next: ${step}`);
    }
    lines.push('');
  }
  if (status.signOffs?.fileProblem) lines.push('The sign-off file could not be used: it is not JSON, or not { "version": 1, "entries": [...] }.');
  else if (status.signOffs?.badEntries) lines.push(`The sign-off file has ${status.signOffs.badEntries} entr${status.signOffs.badEntries === 1 ? 'y' : 'ies'} with no valid name, role, date or item; they count for nothing.`);
  lines.push(`Not checked means the service was not asked or did not answer: it never counts as ready.`, '', verdictLine(status));
  return lines.join('\n');
}

const cell = (v) => String(v ?? '').replace(/\|/g, '\|').replace(/\r?\n/g, ' ');

/** The same report as Markdown, for a ticket or a hand-over. */
export function formatMarkdown(status, options = {}) {
  const lines = ['# Go-live checklist', '', `**${verdictLine(status)}**`, '', `Checked ${new Date(status.checkedAt).toISOString()} · DEPLOY_ENV ${cell(status.deployEnv || 'not set')}`, ''];
  for (const group of groups(status, options)) {
    lines.push(`## ${groupTitle(group)}`, '', '| State | Blocks | Item | What | Detail | Next step |', '|---|---|---|---|---|---|');
    for (const i of group.items) {
      const state = i.kind === 'per_business' ? 'Each business' : STATE_LABELS[i.state];
      lines.push(`| ${state} | ${i.blocks ? 'yes' : 'no'} | \`${i.id}\` | ${cell(i.title)} | ${i.state === 'ready' ? '' : cell(i.detail)} | ${cell(nextStepFor(i))} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
