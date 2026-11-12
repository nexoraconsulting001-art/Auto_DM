/**
 * What the buying screens share: the store calls, the device's bag and session as things a screen can watch, the way an amount
 * is drawn (always the server's whole paise), and one place where a failed call becomes words. Every query here is kept out of
 * the offline copy (meta offline false) and under the key 'buy', so signing out can remove all of it at once.
 */
import React, { useMemo, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core/strings';
import { formatPaise } from '@bhava/store-client';
import { Banner, Button, ErrorState, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { failure } from '../../shell/parts.js';
import { createBuy } from './buy.js';

export const BUY = 'buy';

export function useBuy() {
  const services = useServices();
  const buy = useMemo(() => createBuy(services.client, { ready: () => services.session?.start() }), [services]);
  return { services, buy };
}

/** Reads from the store. Never kept on the device, and never answered from a copy made for someone else. */
export function useStoreQuery(key, read, options = {}) {
  const { session } = useServices();
  return useQuery({ queryKey: [BUY, ...key], queryFn: async () => { await session?.start(); return read(); }, meta: { offline: false }, networkMode: 'online', retry: false, staleTime: 0, ...options });
}

const NEVER = () => () => {};
const NONE = Object.freeze([]);
const STARTING = Object.freeze({ status: 'starting', shopper: null });

/** The bag, redrawn when it changes. */
export function useBag() {
  const { cart } = useServices();
  const lines = useSyncExternalStore(cart ? cart.subscribe : NEVER, () => (cart ? cart.lines : NONE), () => NONE);
  return { cart, lines };
}

/** Who is signed in: { status: 'starting' | 'guest' | 'signedIn', shopper }. */
export function useSessionState() {
  const { session } = useServices();
  return useSyncExternalStore(session ? session.subscribe : NEVER, () => (session ? session.getState() : STARTING), () => STARTING);
}

export const Amount = ({ paise, testID, variant = 'body', tone }) => <Text testID={testID} variant={variant} tone={tone}>{formatPaise(paise)}</Text>;

function Row({ label, value, testID, strong = false, tone }) {
  const theme = useTheme();
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: theme.space[3] }}>
      <Text variant={strong ? 'title' : 'body'}>{label}</Text>
      <Text testID={testID} variant={strong ? 'title' : 'body'} tone={tone}>{value}</Text>
    </View>
  );
}

/** The server's totals, line for line. Nothing is added up here: a line the server did not send is not shown. */
export function Totals({ totals, mode, testID = 'totals' }) {
  const { t } = useStrings();
  const theme = useTheme();
  const money = (paise) => formatPaise(paise);
  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      <Row label={t('cart.subtotal')} value={money(totals.subtotalPaise)} testID={`${testID}-subtotal`} />
      {totals.discountPaise > 0 ? <Row label={t('cart.discount')} value={`-${money(totals.discountPaise)}`} tone="good" testID={`${testID}-discount`} /> : null}
      {totals.loyaltyPaise > 0 ? <Row label={t('cart.points')} value={`-${money(totals.loyaltyPaise)}`} tone="good" testID={`${testID}-points`} /> : null}
      <Row label={t('cart.shipping')} value={totals.shippingPaise > 0 ? money(totals.shippingPaise) : t('cart.free')} testID={`${testID}-shipping`} />
      {totals.codFeePaise > 0 ? <Row label={t('cart.codFee')} value={money(totals.codFeePaise)} testID={`${testID}-cod-fee`} /> : null}
      {totals.taxPaise > 0 ? <Row label={t('cart.tax')} value={money(totals.taxPaise)} testID={`${testID}-tax`} /> : null}
      <Row strong label={t('cart.total')} value={money(totals.totalPaise)} testID={`${testID}-total`} />
      {mode === 'part_advance' && totals.advancePaise > 0 ? (
        <>
          <Row label={t('cart.advance')} value={money(totals.advancePaise)} testID={`${testID}-advance`} />
          <Row label={t('cart.balance')} value={money(totals.balancePaise)} testID={`${testID}-balance`} />
        </>
      ) : null}
    </View>
  );
}

/** A failed read or write, in the server's own words or plain ones. `inline` makes a banner for a form. */
export function Problem({ error, onRetry, inline = false, testID = 'problem' }) {
  const { t } = useStrings();
  if (!error) return null;
  const why = failure(error, t);
  if (inline) return <Banner testID={testID} tone="bad" title={why.title}>{why.body}</Banner>;
  return <ErrorState testID={testID} title={why.title} onRetry={onRetry} retryLabel={t('home.common.retry')}>{why.body}</ErrorState>;
}

/** Shown where a screen needs a signed-in shopper (orders, rewards, wishlist, account). */
export function NeedSignIn({ go, testID = 'need-sign-in', reason }) {
  const { t } = useStrings();
  return (
    <View testID={testID} style={{ gap: 12, alignItems: 'stretch' }}>
      <Text variant="title">{t('cart.signInTitle')}</Text>
      <Text variant="body">{reason ?? t('cart.signInBody')}</Text>
      <Button testID="go-sign-in" label={t('cart.signInButton')} onPress={() => go('sign-in.index')} />
    </View>
  );
}
