/** Pure rules of sign-up: which step the server's record says a person is on, and what must be filled before the first call. */

const reached = (status, step) => (status?.steps ?? []).some((s) => s.step === step);

/**
 * 'type' (pick Creator or Seller), 'instagram', 'automation', 'finish' or 'done'. Instagram counts as connected when the server's
 * own record says so or the live connection is active: the person has just come back from Meta's page.
 */
export function stageOf(status, connection) {
  if (reached(status, 'finished')) return 'done';
  if (!status?.tenantId || !reached(status, 'account_type')) return 'type';
  if (reached(status, 'automation_live')) return 'finish';
  if (reached(status, 'instagram_connected') || connection?.status === 'active') return 'automation';
  return 'instagram';
}

/** Problems by field, as string keys; an empty object when the first call can be made. */
export function readyToStart({ name, mode, invite }) {
  const problems = {};
  if (!String(name ?? '').trim()) problems.name = 'signup.needName';
  if (mode === 'invite' && !String(invite ?? '').trim()) problems.invite = 'signup.needInvite';
  return problems;
}

/** 2 min 41 s from milliseconds. */
export function formatElapsed(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes ? `${minutes} min ${seconds} s` : `${seconds} s`;
}
