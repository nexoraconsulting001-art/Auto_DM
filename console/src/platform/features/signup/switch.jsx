import { useState } from 'react';
import { Badge, Button, Panel, SelectField, TextAreaField, TextField } from '../../../design/index.jsx';
import { ActionSheet, Can, Facts, QueryState, When, useAct, useOne } from '../../kit.jsx';
import { word } from '../../lib/rules.js';
import { api } from '../../api.js';

const MODES = ['closed', 'invite', 'public'];

/** Who can sign up, beside the checklist. Public may be refused with the open items; a super admin may then force it. */
export function SignupSwitch({ blockingIds = [], note = null, facts = () => [] }) {
  const act = useAct();
  const query = useOne(['signup'], () => api.signup());
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('invite');
  const [cap, setCap] = useState('');
  const [refused, setRefused] = useState(null);
  const [forceReason, setForceReason] = useState('');
  const capText = cap.trim();
  const capValue = capText === '' ? undefined : /^\d{1,6}$/.test(capText) ? Number(capText) : Number.NaN;
  const capOk = capValue === undefined || (Number.isInteger(capValue) && capValue >= 1 && capValue <= 100000);
  const forcing = Array.isArray(refused);

  function start(signup) {
    setMode(signup.mode);
    setCap(signup.dailyCap ? String(signup.dailyCap) : '');
    setRefused(null);
    setForceReason('');
    setOpen(true);
  }

  async function submit(reason) {
    const body = { mode, reason, ...(capValue !== undefined ? { dailyCap: capValue } : {}), ...(forcing ? { force: true, forceReason: forceReason.trim() } : {}) };
    try {
      await act(() => api.setSignupMode({ body }), forcing ? 'Sign-up is open to the public. The open items are on record.' : 'Who can sign up is changed.');
    } catch (failure) {
      if (failure?.code === 'conflict' && !forcing) {
        setRefused(String(failure.fields?.golive ?? '').split(' ').filter(Boolean));
        throw new Error('The checklist has blocking items open, so public sign-up is refused. Give a second reason to open it anyway.');
      }
      throw failure;
    }
  }

  return (
    <QueryState query={query} label="Loading sign-up">
      {(signup) => (
        <Panel title="Who can sign up" action={<Badge tone={signup.mode === 'public' ? 'warn' : 'good'}>{word('signup', signup.mode)}</Badge>}>
          <div className="stack">
            {note?.[signup.mode] && <p>{note[signup.mode]}</p>}
            <Facts rows={[
              ['Sign-up is', word('signup', signup.mode)],
              ['New businesses a day', signup.dailyCap === null || signup.dailyCap === undefined ? 'No cap' : String(signup.dailyCap)],
              ['Changed', <When key="u" value={signup.updatedAt} />],
              ...facts(signup),
            ]} />
            {signup.mode !== 'public' && blockingIds.length > 0 && (
              <p className="gl-detail">Opening to the public waits for {blockingIds.length} blocking item{blockingIds.length === 1 ? '' : 's'} on the checklist.</p>
            )}
            <Can route="platform.setSignupMode" fallback={<p className="gl-detail">Only a super admin can change who can sign up.</p>}>
              <Button variant="outline" onClick={() => start(signup)}>Change who can sign up</Button>
              <ActionSheet
                open={open}
                title={forcing ? 'Open sign-up anyway' : 'Change who can sign up'}
                intro={forcing
                  ? 'These blocking items are open. Opening now is recorded as forced, with both reasons and the open items.'
                  : 'Invite codes are made on the Sign-up screen. A daily cap limits how many businesses sign-up makes in a day, India time.'}
                submitLabel={forcing ? 'Open anyway' : 'Change'}
                tone={forcing ? 'danger' : 'primary'}
                valid={capOk && (!forcing || forceReason.trim().length >= 3)}
                onClose={() => setOpen(false)}
                onSubmit={submit}
              >
                {forcing && <ul className="gl-missing-list" data-testid="golive-refused">{refused.map((id) => <li key={id}>{id}</li>)}</ul>}
                <SelectField label="Sign-up is" value={mode} disabled={forcing} onChange={(event) => setMode(event.target.value)}>
                  {MODES.map((item) => <option key={item} value={item}>{word('signup', item)}</option>)}
                </SelectField>
                <TextField label="New businesses a day" inputMode="numeric" hint="Empty keeps the cap as it is." value={cap} disabled={forcing} onChange={(event) => setCap(event.target.value)} error={capOk ? undefined : 'Enter a whole number from 1 to 100000'} />
                {forcing && <TextAreaField label="Second reason: why open with these items open" rows={3} maxLength={500} value={forceReason} onChange={(event) => setForceReason(event.target.value)} required />}
              </ActionSheet>
            </Can>
          </div>
        </Panel>
      )}
    </QueryState>
  );
}
