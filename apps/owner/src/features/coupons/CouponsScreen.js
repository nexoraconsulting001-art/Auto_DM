import React, { useState } from 'react';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core';
import { Badge, Button, Choices, Field, ListRow, Screen } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { formatPaise } from '../orders/kit/rules.js';
import { Offline, PagedList, usePaged, useWritable } from '../orders/kit/ui.js';

const SHOW = ['all', 'active', 'ended'];

/** What a coupon takes off, in words: "20% off, up to ₹200", "₹100 off", "Free delivery". */
export function couponValue(t, coupon) {
  if (coupon.kind === 'percent') {
    const percent = (coupon.percentBp ?? 0) / 100;
    return coupon.maxDiscountPaise ? t('coupons.value.percentMax', { percent, max: formatPaise(coupon.maxDiscountPaise) }) : t('coupons.value.percent', { percent });
  }
  if (coupon.kind === 'flat') return t('coupons.value.flat', { amount: formatPaise(coupon.amountPaise) });
  return t('coupons.value.free_shipping');
}

/** Coupons (PRD 9.14): every code, whether it is running, and how often it was used. */
export default function CouponsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const writable = useWritable();
  const [show, setShow] = useState('all');
  const [typed, setTyped] = useState('');
  const [search, setSearch] = useState('');
  const query = usePaged(['coupons', 'list', { show, search }], (page) => api.coupons.list({ show, ...(search ? { search } : {}), ...page }));
  return (
    <Screen testID="screen-coupons" title={t('coupons.title')}>
      <Offline />
      <Button testID="coupons-new" label={t('coupons.new')} disabled={!writable} onPress={() => navigation.navigate('coupons.new')} />
      <Field testID="coupons-search" label={t('coupons.search')} value={typed} onChangeText={setTyped} onSubmitEditing={() => setSearch(typed.trim().toUpperCase().slice(0, 40))} autoCapitalize="characters" returnKeyType="search" autoCorrect={false} />
      <Choices testID="coupons-show" label={t('coupons.show')} value={show} onChange={setShow} options={SHOW.map((value) => ({ value, label: t(`coupons.show.${value}`) }))} />
      <PagedList
        testID="coupons-list"
        query={query}
        emptyTitle={t('coupons.empty')}
        renderRow={(coupon) => (
          <ListRow
            testID={`coupon-${coupon.id}`}
            title={`${coupon.code} · ${couponValue(t, coupon)}`}
            subtitle={coupon.maxUses ? t('coupons.usedOf', { used: coupon.usedCount, max: coupon.maxUses }) : t('coupons.used', { used: coupon.usedCount })}
            end={<Badge tone={coupon.active ? 'good' : 'neutral'} label={t(coupon.active ? 'coupons.on' : 'coupons.off')} />}
            onPress={() => navigation.navigate('coupons.edit', { id: coupon.id })}
          />
        )}
      />
    </Screen>
  );
}
