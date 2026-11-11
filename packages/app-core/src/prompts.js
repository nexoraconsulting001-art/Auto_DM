/**
 * Two things an app asks the person in the middle of something else:
 *
 *   LockOffer      after the first sign-in on a phone that can do it: "Open the app with fingerprint or face unlock?"
 *                  (F-110, P-68). Yes turns the lock on and keeps the device's unlock secret; either answer is final
 *                  until the next sign-in.
 *   ReauthProvider a sheet for the fresh check a sensitive change needs (P-17): the device's own unlock first when it
 *                  can, a WhatsApp code otherwise. Screens call `useReauth().runFresh(() => api.x.update(...))`.
 *
 * The app's name is passed in, so nothing here names a brand. A code typed here goes to the server and nowhere else.
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Banner, Button, Field, Sheet, Text } from '@bhava/ui';
import { createReauth, enrollDeviceUnlock } from './reauth.js';
import { methodLabel } from './screens.js';
import { useStrings } from './strings/index.js';

/** Asks once whether to turn on fingerprint or face unlock. Renders nothing on a phone that cannot, or once answered. */
export function LockOffer({ lock, api, store, appName, onAnswered }) {
  const { t } = useStrings();
  const [visible, setVisible] = useState(false);
  const [kind, setKind] = useState(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([lock.shouldOffer(), lock.kind()])
      .then(([offer, found]) => {
        if (!live) return;
        setKind(found);
        setVisible(Boolean(offer));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [lock]);

  const method = methodLabel(t, kind);
  const finish = useCallback(async (answer) => {
    await lock.markOffered();
    setVisible(false);
    onAnswered?.(answer);
  }, [lock, onAnswered]);

  async function accept() {
    setBusy(true);
    setFailed(false);
    const result = await lock.enable(t('lock.prompt', { app: appName }), { cancelLabel: t('common.cancel') });
    if (result.ok) {
      await enrollDeviceUnlock({ api, store });
      setBusy(false);
      await finish('on');
      return;
    }
    setBusy(false);
    if (result.reason === 'cancelled') return; // still deciding: the sheet stays
    setFailed(true);
  }

  return (
    <Sheet
      testID="lock-offer"
      visible={visible}
      onClose={() => finish('later')}
      closeLabel={t('common.notNow')}
      dismissable={!busy}
      title={t('lock.offer.title', { app: appName, method })}
      footer={
        <>
          <Button testID="lock-offer-yes" label={t('lock.offer.yes')} onPress={accept} busy={busy} />
          <Button testID="lock-offer-no" kind="quiet" label={t('common.notNow')} onPress={() => finish('later')} disabled={busy} />
        </>
      }
    >
      <Text variant="small">{t('lock.offer.body', { method })}</Text>
      {failed ? <Banner tone="warn" testID="lock-offer-failed">{t('lock.offer.failed')}</Banner> : null}
    </Sheet>
  );
}

const ReauthContext = createContext(null);

/** `const { ensureFresh, runFresh } = useReauth()`. Needs the ReauthProvider the app's shell sets up. */
export function useReauth() {
  const value = useContext(ReauthContext);
  if (!value) throw new Error('useReauth needs the ReauthProvider that the shell sets up');
  return value;
}

const cancelled = () => Object.assign(new Error('Not confirmed'), { code: 'cancelled' });

export function ReauthProvider({ session, store, lock, appName, children }) {
  const { t } = useStrings();
  const reauth = useMemo(() => createReauth({ session, store, lock }), [session, store, lock]);
  const waiting = useRef(null);
  const [open, setOpen] = useState(false);
  const [device, setDevice] = useState(false);
  const [kind, setKind] = useState(null);
  const [step, setStep] = useState('choose'); // choose, code
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');

  const settle = useCallback((ok) => {
    const resolve = waiting.current;
    waiting.current = null;
    setOpen(false);
    setCode('');
    setBusy('');
    resolve?.(ok);
  }, []);

  /** Resolves true once the session is fresh (at once if it already is), false if the person closes the sheet. */
  const ensureFresh = useCallback(async ({ force = false } = {}) => {
    if (!force && reauth.isFresh()) return true;
    if (waiting.current) waiting.current(false); // a second ask replaces the first
    const [canDevice, found] = await Promise.all([reauth.canUseDevice(), lock.kind()]);
    setDevice(canDevice);
    setKind(found);
    setStep('choose');
    setProblem('');
    setCode('');
    setOpen(true);
    return new Promise((resolve) => {
      waiting.current = resolve;
    });
  }, [reauth, lock]);

  /** Runs a change that needs a fresh check: asks first when needed, and once more if the server still says so. */
  const runFresh = useCallback(async (work) => {
    if (!(await ensureFresh())) throw cancelled();
    try {
      return await work();
    } catch (error) {
      if (error?.code !== 'reauth_required') throw error;
      if (!(await ensureFresh({ force: true }))) throw cancelled();
      return work();
    }
  }, [ensureFresh]);

  const method = methodLabel(t, kind);

  async function confirmWithDevice() {
    setBusy('device');
    setProblem('');
    const result = await reauth.withDevice(t('lock.prompt', { app: appName }), { cancelLabel: t('common.cancel') });
    setBusy('');
    if (result.ok) return settle(true);
    if (result.reason === 'refused') {
      setDevice(false);
      setProblem('reauth.refused');
    } else if (result.reason === 'network') setProblem('error.network');
    else if (result.reason !== 'cancelled') setProblem('lock.failed');
  }

  async function sendCode() {
    setBusy('send');
    setProblem('');
    try {
      const answer = await reauth.start();
      if (answer?.sent === false) setProblem('reauth.noPhone');
      else setStep('code');
    } catch (error) {
      setProblem(error?.status === 0 ? 'error.network' : 'error.body');
    } finally {
      setBusy('');
    }
  }

  async function confirmCode() {
    setBusy('verify');
    setProblem('');
    try {
      await reauth.withCode(code);
      settle(true);
    } catch (error) {
      setBusy('');
      setProblem(error?.status === 0 ? 'error.network' : 'reauth.failed');
    }
  }

  const value = useMemo(() => ({ ensureFresh, runFresh }), [ensureFresh, runFresh]);
  return (
    <ReauthContext.Provider value={value}>
      {children}
      <Sheet testID="reauth" visible={open} onClose={() => settle(false)} closeLabel={t('common.cancel')} dismissable={!busy} title={t('reauth.title')}>
        <Text variant="small">{t('reauth.body')}</Text>
        {problem ? <Banner tone={problem === 'reauth.noPhone' ? 'warn' : 'bad'} testID="reauth-problem">{t(problem, { method })}</Banner> : null}
        {step === 'choose' ? (
          <>
            {device ? <Button testID="reauth-device" label={t('reauth.device', { method })} onPress={confirmWithDevice} busy={busy === 'device'} disabled={Boolean(busy)} /> : null}
            <Button testID="reauth-send" kind={device ? 'secondary' : 'primary'} label={t('reauth.sendCode')} onPress={sendCode} busy={busy === 'send'} disabled={Boolean(busy)} />
          </>
        ) : (
          <>
            <Text variant="small" testID="reauth-sent">{t('reauth.sent')}</Text>
            <Field testID="reauth-code" label={t('reauth.code')} value={code} onChangeText={(text) => setCode(text.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" autoComplete="one-time-code" textContentType="oneTimeCode" maxLength={6} />
            <Button testID="reauth-verify" label={t('reauth.verify')} onPress={confirmCode} busy={busy === 'verify'} disabled={code.length < 6 || Boolean(busy)} />
          </>
        )}
      </Sheet>
    </ReauthContext.Provider>
  );
}
