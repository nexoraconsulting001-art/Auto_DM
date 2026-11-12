/**
 * Checkout as a guest by default (P-28): where to, how to pay, codes. Prepaid asks for no code; cash on delivery asks for a
 * WhatsApp code to the phone on the order. Every amount drawn here is the server's quote, and placing the order sends no amount:
 * only what was chosen, with one idempotency key per attempt so a double tap makes one order.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { keepPreviousData } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core/strings';
import { formatPaise } from '@bhava/store-client';
import { Banner, Button, Card, Field, ListRow, LoadingRows, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { useBootstrap } from '../../shell/data.js';
import { AddressForm } from '../addresses/AddressForm.js';
import { EMPTY_ADDRESS, addressProblems } from '../addresses/states.js';
import { Problem, Totals, useBag, useBuy, useSessionState, useStoreQuery } from '../cart/ui.js';
import { consentBody, placeExtra } from './placing.js';

const MODES = ['prepaid', 'cod', 'part_advance'];
const digits = (phone) => String(phone ?? '').replace(/\D/g, '').slice(-10);

export default function CheckoutScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const { services, buy } = useBuy();
  const { cart, lines } = useBag();
  const state = useSessionState();
  const bootstrap = useBootstrap();
  const signedIn = state.status === 'signedIn';
  const attempt = services.checkout.attempt;

  const saved = useStoreQuery(['addresses'], () => buy.call('addresses'), { enabled: signedIn });
  const rewards = useStoreQuery(['rewards'], () => buy.call('appRewards'), { enabled: signedIn });
  const [picked, setPicked] = useState(null);
  const [address, setAddress] = useState(EMPTY_ADDRESS);
  const [email, setEmail] = useState('');
  const [mode, setMode] = useState('prepaid');
  const [couponInput, setCouponInput] = useState('');
  const [couponCode, setCouponCode] = useState('');
  const [couponNote, setCouponNote] = useState(null);
  const [usePoints, setUsePoints] = useState(false);
  const [referralCode, setReferralCode] = useState(services.checkout.preferred.referralCode ?? '');
  const [terms, setTerms] = useState(false);
  const [updates, setUpdates] = useState(true);
  const [saveDetails, setSaveDetails] = useState(false);
  const [tried, setTried] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [verifiedFor, setVerifiedFor] = useState('');
  const [codeBusy, setCodeBusy] = useState(false);
  const [codeError, setCodeError] = useState(null);

  const savedItems = saved.data?.items ?? [];
  // A signed-in shopper starts on their default saved address; anyone can type a new one instead.
  useEffect(() => {
    if (picked === null && savedItems.length) setPicked((savedItems.find((a) => a.id === services.checkout.preferred.addressId) ?? savedItems.find((a) => a.isDefault) ?? savedItems[0]).id);
  }, [savedItems, picked, services]);
  const chosen = picked ? savedItems.find((a) => a.id === picked) : null;
  const addressOk = chosen ? true : Object.keys(addressProblems(address)).length === 0;
  const phone = chosen ? chosen.phone : address.phone;

  const pointsBalance = rewards.data?.enabled ? rewards.data.pointsBalance : 0;
  const draft = useMemo(() => ({
    lines,
    ...(chosen ? { addressId: chosen.id } : addressOk ? { address } : {}),
    paymentMode: mode,
    email: email.trim(),
    couponCode,
    redeemPoints: usePoints ? pointsBalance : 0,
    referralCode: referralCode.trim(),
    phone,
  }), [lines, chosen, addressOk, address, mode, email, couponCode, usePoints, pointsBalance, referralCode, phone]);

  const quote = useStoreQuery(['quote', 'checkout', JSON.stringify(buyShape(draft))], () => buy.quote(draft), { enabled: lines.length > 0, placeholderData: keepPreviousData });
  const data = quote.data;
  const modes = data?.paymentModes ?? MODES.map((m) => ({ mode: m, available: m === 'prepaid', reason: '' }));

  // If the chosen way of paying stops being offered (a cash on delivery limit, a new address), the first one on offer takes its place.
  useEffect(() => {
    if (data && !modes.find((m) => m.mode === mode)?.available) {
      const first = modes.find((m) => m.available);
      if (first) setMode(first.mode);
    }
  }, [data, modes, mode]);

  // Cash on delivery always asks for a code to the phone on the order; prepaid never does.
  const needsCode = mode === 'cod' && verifiedFor !== digits(phone);
  const blocked = !terms || !addressOk || !data || data.serviceable === false || (needsCode && addressOk) || placing;

  async function applyCoupon() {
    setCouponNote(null);
    try {
      const result = await buy.checkCoupon({ code: couponInput.trim(), lines });
      setCouponNote(result);
      setCouponCode(result.applied ? result.code : '');
    } catch (failed) {
      setCouponNote({ applied: false, message: failed.message });
    }
  }

  async function sendCode() {
    setCodeBusy(true);
    setCodeError(null);
    try {
      await buy.sendCodFor({ phone, checkoutKey: attempt.keyFor(draft) });
      setCodeSent(true);
    } catch (failed) {
      setCodeError(failed);
    } finally {
      setCodeBusy(false);
    }
  }

  async function verifyCode() {
    setCodeBusy(true);
    setCodeError(null);
    try {
      await buy.verifyCodFor({ phone, code, checkoutKey: attempt.keyFor(draft) });
      setVerifiedFor(digits(phone));
    } catch (failed) {
      setCodeError(failed);
    } finally {
      setCodeBusy(false);
    }
  }

  async function place() {
    setTried(true);
    if (blocked || attempt.busy) return;
    setPlacing(true);
    setError(null);
    setFieldErrors({});
    try {
      const consent = consentBody({ noticeVersion: bootstrap.data?.noticeVersion, whatsappUpdates: updates });
      const placed = await attempt.place(draft, (key) => buy.place(draft, placeExtra({ key, consent, saveDetails: signedIn && saveDetails })));
      if (placed.next === 'verify_phone') {
        setVerifiedFor('');
        setCodeSent(false);
        setError({ code: 'verify_phone', message: t('checkout.needCode') });
      } else if (placed.next === 'done') {
        // Placed and nothing to pay now (cash on delivery): the bag is done.
        await cart.clear();
        navigation.replace('orders.byToken', { token: placed.token, justPlaced: true });
      } else {
        // Payment next. The bag stays until the server says the order is paid or placed.
        navigation.replace('payment.index', { token: placed.token, orderNumber: placed.orderNumber, gateway: placed.gateway });
      }
    } catch (failed) {
      setError(failed);
      setFieldErrors(failed.fields ?? {});
    } finally {
      setPlacing(false);
    }
  }

  if (!lines.length) {
    return (
      <Screen testID="screen-checkout" title={t('checkout.title')}>
        <Banner testID="checkout-empty" tone="info">{t('checkout.empty')}</Banner>
        <Button testID="go-cart" label={t('checkout.backToCart')} onPress={() => navigation.navigate('cart.index')} />
      </Screen>
    );
  }
  return (
    <Screen testID="screen-checkout" title={t('checkout.title')}>
      <Problem inline error={error} testID="checkout-error" />
      <Section title={t('checkout.deliverTo')}>
        {savedItems.map((a) => (
          <ListRow key={a.id} testID={`saved-${a.id}`} title={a.name} subtitle={`${a.line1}, ${a.city} ${a.pincode}`} onPress={() => setPicked(a.id)} end={<Text variant="meta" tone="primary">{picked === a.id ? t('checkout.chosen') : ''}</Text>} />
        ))}
        {savedItems.length ? <ListRow testID="new-address" title={t('checkout.newAddress')} onPress={() => setPicked(0)} end={<Text variant="meta" tone="primary">{picked === 0 ? t('checkout.chosen') : ''}</Text>} /> : null}
        {!chosen ? <AddressForm value={address} onChange={setAddress} errors={fieldErrors} showProblems={tried} withKind={false} /> : null}
        <Field testID="checkout-email" label={t('checkout.email')} hint={t('checkout.emailHint')} value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" error={fieldErrors.email} />
      </Section>

      <Section title={t('checkout.items')}>
        {!data ? <LoadingRows rows={2} label={t('home.common.loading')} testID="checkout-loading" /> : null}
        {data?.lines.map((line) => (
          <ListRow key={`${line.productId}:${line.variantId ?? ''}`} testID={`item-${line.productId}`} title={line.name} subtitle={[line.option, `× ${line.qty}`].filter(Boolean).join(' · ')} end={<Text variant="body">{formatPaise(line.linePaise)}</Text>} />
        ))}
        {data?.notices.map((notice) => <Banner key={notice} testID="checkout-notice" tone="warn">{notice}</Banner>)}
        {data && data.serviceable === false ? <Banner testID="not-serviceable" tone="bad">{t('checkout.notServiceable')}</Banner> : null}
      </Section>

      <Section title={t('checkout.pay')}>
        {modes.filter((m) => MODES.includes(m.mode)).map((m) => (
          <ListRow
            key={m.mode}
            testID={`mode-${m.mode}`}
            title={t(`checkout.mode.${m.mode}`)}
            subtitle={m.available ? t(`checkout.mode.${m.mode}.sub`) : m.reason}
            disabled={!m.available}
            onPress={() => setMode(m.mode)}
            end={<Text variant="meta" tone="primary" testID={`mode-${m.mode}-state`}>{mode === m.mode ? t('checkout.chosen') : ''}</Text>}
          />
        ))}
        {mode === 'cod' ? (
          <Card testID="cod-code">
            <View style={{ gap: theme.space[3] }}>
              <Text variant="small">{t('checkout.codWhy')}</Text>
              {verifiedFor === digits(phone) ? <Text testID="cod-verified" variant="small" tone="good">{t('checkout.codVerified')}</Text> : (
                <>
                  <Problem inline error={codeError} testID="cod-error" />
                  {codeSent ? (
                    <>
                      <Field testID="cod-code-input" label={t('checkout.code')} value={code} onChangeText={(v) => setCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" autoComplete="sms-otp" maxLength={6} />
                      <Button testID="cod-verify" label={t('checkout.verify')} busy={codeBusy} disabled={code.length !== 6} onPress={verifyCode} />
                    </>
                  ) : (
                    <Button testID="cod-send" kind="secondary" label={t('checkout.sendCode')} busy={codeBusy} disabled={!addressOk} onPress={sendCode} />
                  )}
                </>
              )}
            </View>
          </Card>
        ) : null}
      </Section>

      <Section title={t('checkout.codes')}>
        <Field testID="coupon-input" label={t('checkout.coupon')} value={couponInput} onChangeText={setCouponInput} autoCapitalize="characters" />
        <Button testID="coupon-apply" kind="secondary" label={t('checkout.apply')} disabled={!couponInput.trim()} onPress={applyCoupon} />
        {couponNote ? <Banner testID="coupon-note" tone={couponNote.applied ? 'good' : 'warn'}>{couponNote.message}</Banner> : null}
        {pointsBalance > 0 ? <Toggle testID="use-points" title={t('checkout.usePoints', { points: pointsBalance })} value={usePoints} onValueChange={setUsePoints} /> : null}
        <Field testID="referral-input" label={t('checkout.referral')} value={referralCode} onChangeText={setReferralCode} autoCapitalize="characters" />
      </Section>

      {data ? <Card><Totals totals={data} mode={mode} /></Card> : null}

      <Section title={t('checkout.agree')}>
        <Toggle testID="agree-terms" title={t('checkout.terms')} subtitle={t('checkout.termsSub')} value={terms} onValueChange={setTerms} />
        <Toggle testID="agree-updates" title={t('checkout.updates')} subtitle={t('checkout.updatesSub')} value={updates} onValueChange={setUpdates} />
        {signedIn ? <Toggle testID="save-details" title={t('checkout.saveDetails')} value={saveDetails} onValueChange={setSaveDetails} /> : null}
      </Section>
      {tried && !terms ? <Text variant="meta" tone="bad" accessibilityRole="alert">{t('checkout.needTerms')}</Text> : null}
      <Button testID="place-order" label={data ? t('checkout.place', { total: formatPaise(data.totalPaise) }) : t('checkout.placeShort')} busy={placing} disabled={placing || !data} onPress={place} />
    </Screen>
  );
}

/** What a quote is asked: the draft without the phone, which only the order needs. */
function buyShape(draft) {
  const { phone, ...rest } = draft;
  return rest;
}
