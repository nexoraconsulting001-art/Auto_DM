import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useFeedback } from '../../components/feedback.jsx';
import { Avatar, Badge, Banner, Button, FieldGroup, Loadable, PageHeader, Panel, Sheet, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate } from '../../lib/format.js';
import { useSession } from '../../lib/session.jsx';
import { isCancelled, useFresh } from './fresh.jsx';
import { workspace } from './live.js';
import { useSignInOptions } from './options.js';
import { CODE_DIGITS, googleStartUrl, isCode, keepDeletion, maskOwnPhone, maskPhone, pkcePair, toE164 } from './signin.js';
import './account.css';

const ROLE_NAMES = { owner: 'Owner', manager: 'Manager', staff: 'Staff' };
const KIND_NAMES = { phone: 'WhatsApp number', google: 'Google', apple: 'Apple' };
const LINK_VERIFIER = 'bhava.link-verifier';
const ACCOUNT_PATH = '/admin/settings/account';

function tabStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function AboutYou() {
  const { session } = useSession();
  const phone = maskOwnPhone(session.user.phone);
  return (
    <Panel title="You">
      <dl className="acct-facts">
        <div>
          <dt>Name</dt>
          <dd>{session.user.name || 'Not set'}</dd>
        </div>
        <div>
          <dt>WhatsApp number</dt>
          <dd>{phone || 'None yet'}</dd>
        </div>
        <div>
          <dt>Here you are</dt>
          <dd>{`${ROLE_NAMES[session.user.role] ?? session.user.role} at ${session.business.name}`}</dd>
        </div>
      </dl>
    </Panel>
  );
}

/** The business switcher (PRD 10.3; P-09, P-10): exactly the businesses this person works at. The logo is workspace identity only. */
function Businesses() {
  const { session } = useSession();
  const { toast } = useFeedback();
  const navigate = useNavigate();
  const list = useQuery({ queryKey: ['auth-businesses'], queryFn: api.auth.businesses });
  const [problem, setProblem] = useState('');
  const change = useMutation({
    mutationFn: (business) => workspace.choose(business.id, api.auth.me),
    onSuccess: (now, business) => {
      if (now?.business?.id !== business.id) {
        setProblem(`You no longer work at ${business.name}, so you’re still in ${now?.business?.name ?? 'your business'}.`);
        return;
      }
      toast(`Now working in ${business.name}.`);
      navigate('/');
    },
    onError: (error) => setProblem(error.message),
  });

  return (
    <Panel title="Your businesses">
      {problem && <Banner tone="bad">{problem}</Banner>}
      <Loadable query={list} label="Loading your businesses" errorTitle="We couldn’t load your businesses">
        {({ businesses }) => (
          <>
            <div className="acct-rows switcher">
              {businesses.map((business) => {
                const current = business.id === session.business.id;
                return (
                  <div key={business.id} className="acct-row">
                    <Avatar name={business.name} src={business.logoUrl || undefined} />
                    <span className="acct-row-main">
                      <span className="acct-row-title">{business.name}</span>
                      <span className="acct-row-meta">{ROLE_NAMES[business.role] ?? business.role}</span>
                    </span>
                    <span className="acct-row-actions">
                      {current ? (
                        <Badge tone="good">Working here</Badge>
                      ) : (
                        <Button variant="soft" loading={change.isPending && change.variables?.id === business.id} disabled={change.isPending} onClick={() => { setProblem(''); change.mutate(business); }} aria-label={`Switch to ${business.name}`}>
                          Switch
                        </Button>
                      )}
                    </span>
                  </div>
                );
              })}
            </div>
            {businesses.length <= 1 && <p className="acct-footnote">When someone invites you to their business, it shows here and you can switch to it.</p>}
          </>
        )}
      </Loadable>
    </Panel>
  );
}

/** Adding a WhatsApp number: the number, then the code that went to it. */
function AddPhone({ sheet, fresh, onLinked }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState('number');
  const [problem, setProblem] = useState('');
  const link = useMutation({
    mutationFn: (body) => fresh.run(() => api.auth.linkIdentity(body)),
    onSuccess: (answer) => {
      if (answer.pending) {
        setStep('code');
        return;
      }
      sheet.current?.close();
      onLinked(answer.identities);
    },
    onError: (error) => {
      if (!isCancelled(error)) setProblem(error.fields?.code ?? error.fields?.phone ?? error.message);
    },
  });

  function submit(event) {
    event.preventDefault();
    setProblem('');
    const e164 = toE164(phone);
    if (!e164) {
      setProblem('Enter a mobile number, such as 98765 43210, or with its country code.');
      return;
    }
    if (step === 'number') {
      link.mutate({ kind: 'phone', phone: e164 });
      return;
    }
    if (!isCode(code)) {
      setProblem(`Enter the ${CODE_DIGITS}-digit code from WhatsApp.`);
      return;
    }
    link.mutate({ kind: 'phone', phone: e164, code });
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      {problem && <Banner tone="bad">{problem}</Banner>}
      {step === 'code' && <p className="sheet-text">{`We sent a code on WhatsApp to ${maskPhone(toE164(phone))}.`}</p>}
      <FieldGroup>
        <TextField label="WhatsApp number to add" name="link-phone" type="tel" inputMode="tel" autoComplete="tel" readOnly={step === 'code'} value={phone} onChange={(e) => setPhone(e.target.value)} />
        {step === 'code' && (
          <TextField label="Code from WhatsApp" name="link-code" inputMode="numeric" autoComplete="one-time-code" maxLength={CODE_DIGITS} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
        )}
      </FieldGroup>
      <div className="sheet-actions">
        <Button variant="outline" onClick={() => sheet.current?.close()}>Cancel</Button>
        <Button type="submit" loading={link.isPending}>{step === 'number' ? 'Send code' : 'Add number'}</Button>
      </div>
    </form>
  );
}

/**
 * Ways to sign in (PRD 5.11): one account can have both Google and a phone, and either opens it. Linking needs a fresh
 * check. Google comes back here from its own page with a single-use code, which only this tab's verifier can spend.
 */
function WaysIn({ google, fresh }) {
  const { session } = useSession();
  const [params, setParams] = useSearchParams();
  const sheet = useRef(null);
  const [identities, setIdentities] = useState(null);
  const [adding, setAdding] = useState(false);
  const [problem, setProblem] = useState('');
  const [note, setNote] = useState('');
  const finishing = useRef(false);

  const linkGoogle = useMutation({
    mutationFn: async () => {
      await fresh.run(async () => {});
      const { verifier, challenge } = await pkcePair();
      tabStorage()?.setItem(LINK_VERIFIER, verifier);
      window.location.assign(googleStartUrl({ purpose: 'link', challenge, next: ACCOUNT_PATH }));
    },
    onError: (error) => {
      if (!isCancelled(error)) setProblem(error.message);
    },
  });

  // Back from Google with a hand-off code: spend it now, with this tab's verifier.
  const linkCode = params.get('linkCode');
  useEffect(() => {
    if (!linkCode || finishing.current) return;
    finishing.current = true;
    const verifier = tabStorage()?.getItem(LINK_VERIFIER) ?? '';
    tabStorage()?.removeItem(LINK_VERIFIER);
    setParams((current) => {
      const next = new URLSearchParams(current);
      next.delete('linkCode');
      return next;
    }, { replace: true });
    if (!verifier) {
      setProblem('That Google sign-in was started somewhere else, so it wasn’t added. Try again from here.');
      return;
    }
    fresh.run(() => api.auth.linkIdentity({ kind: 'google', code: linkCode, verifier }))
      .then((answer) => {
        setIdentities(answer.identities);
        setNote('Google is linked. You can now sign in with either.');
      })
      .catch((error) => {
        if (isCancelled(error)) return;
        setProblem(error.code === 'conflict' ? 'That Google account already belongs to another Bhava account, so it wasn’t added.' : (error.fields?.code ? 'That took too long or was already used. Try linking Google again.' : error.message));
      });
  }, [linkCode, fresh, setParams]);

  function linked(list) {
    setIdentities(list);
    setNote('Added. You can now sign in with any of these.');
  }

  const phone = maskOwnPhone(session.user.phone);
  const shown = identities ?? (phone ? [{ kind: 'phone', label: phone }] : []);
  const hasGoogle = identities?.some((identity) => identity.kind === 'google');

  return (
    <Panel title="Ways to sign in">
      <p className="muted">Add another way in, so you can still sign in if you lose one. Each opens the same account.</p>
      {note && <Banner tone="good">{note}</Banner>}
      {problem && <Banner tone="bad">{problem}</Banner>}
      {shown.length === 0 && <p className="acct-footnote">This account has no WhatsApp number yet. Add one, so a code can always reach you.</p>}
      {shown.length > 0 && (
        <div className="acct-rows">
          {shown.map((identity) => (
            <div key={`${identity.kind}:${identity.label}`} className="acct-row">
              <span className="acct-row-main">
                <span className="acct-row-title">{KIND_NAMES[identity.kind] ?? identity.kind}</span>
                <span className="acct-row-meta">{[identity.label, identity.verifiedAt && `added ${formatDate(identity.verifiedAt)}`].filter(Boolean).join(' · ')}</span>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="row-actions">
        <Button variant="soft" onClick={() => { setProblem(''); setAdding(true); requestAnimationFrame(() => sheet.current?.showModal()); }}>Add a WhatsApp number</Button>
        {google && !hasGoogle && <Button variant="soft" loading={linkGoogle.isPending} onClick={() => { setProblem(''); linkGoogle.mutate(); }}>Link Google</Button>}
      </div>
      <Sheet ref={sheet} title="Add a WhatsApp number" onClose={() => setAdding(false)}>
        {adding && <AddPhone sheet={sheet} fresh={fresh} onLinked={linked} />}
      </Sheet>
    </Panel>
  );
}

/** Delete my account (PRD 10.6, Apple 5.1.1(v); P-26): typed confirmation, a fresh check, then the timeline on the sign-in page. */
function DeleteAccount({ fresh }) {
  const sheet = useRef(null);
  const [typed, setTyped] = useState('');
  const [problem, setProblem] = useState('');
  const remove = useMutation({
    mutationFn: () => fresh.run(() => api.auth.deleteAccount({ confirm: 'DELETE' })),
    onSuccess: (timeline) => {
      keepDeletion(tabStorage(), timeline);
      sheet.current?.close();
      // Every session of this person ended with the request, this one too.
      workspace.deleted();
    },
    onError: (error) => {
      if (!isCancelled(error)) setProblem(error.message);
    },
  });

  function submit(event) {
    event.preventDefault();
    setProblem('');
    if (typed.trim() !== 'DELETE') {
      setProblem('Type DELETE to confirm');
      return;
    }
    remove.mutate();
  }

  return (
    <Panel title="Delete my account" className="acct-danger">
      <p className="muted">Your account and your ways of signing in are deleted 30 days after you ask, and you’re signed out everywhere at once. Signing in again before then cancels it. Records the law needs a business to keep, such as invoices, stay with that business.</p>
      <p className="muted">If you’re the only owner of a business, make someone else an owner first, or that business can’t be run without you.</p>
      <Button variant="danger" onClick={() => { setTyped(''); setProblem(''); sheet.current?.showModal(); }}>Delete my account</Button>
      <Sheet ref={sheet} title="Delete your account?">
        <form className="stack" onSubmit={submit} noValidate>
          <p className="sheet-text">This signs you out of every phone and browser now. After 30 days your account is gone for good.</p>
          {problem && <Banner tone="bad">{problem}</Banner>}
          <FieldGroup>
            <TextField label="Type DELETE to confirm" name="confirm-delete" autoComplete="off" autoCapitalize="characters" value={typed} onChange={(e) => setTyped(e.target.value)} />
          </FieldGroup>
          <div className="sheet-actions">
            <Button variant="outline" onClick={() => sheet.current?.close()}>Keep my account</Button>
            <Button type="submit" variant="danger" loading={remove.isPending}>Yes, delete my account</Button>
          </div>
        </form>
      </Sheet>
    </Panel>
  );
}

/** Settings > Your account (PRD 5.11, 10.3, 10.6): who you are here, your businesses, your ways in, and deleting the account. */
export default function AccountPage() {
  const options = useSignInOptions();
  const google = Boolean(options.data?.google);
  const fresh = useFresh({ google });
  return (
    <>
      <PageHeader eyebrow="Settings" title="Your account" />
      <AboutYou />
      <Businesses />
      <WaysIn google={google} fresh={fresh} />
      <DeleteAccount fresh={fresh} />
      {fresh.sheet}
    </>
  );
}
