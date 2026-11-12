import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { Button, Card, Choices, ConfirmSheet, Field, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { COUPON_KINDS, COUPON_SCOPES, couponBody, couponForm, formatPaise } from '../orders/kit/rules.js';
import { ActionMessages, Fact, ManyChoices, NumberField, Offline, RecordView, RupeeField, useAction, useForm, useProblem, useWritable } from '../orders/kit/ui.js';

const COUPONS = ['coupons'];

/** A new coupon. */
export function NewCouponScreen() {
  return (
    <Screen testID="screen-coupon-new">
      <Offline />
      <CouponForm coupon={null} />
    </Screen>
  );
}

/** One coupon: its rules, how it did, and the way to end it. */
export default function CouponScreen({ route }) {
  const id = Number(route?.params?.id);
  const { api } = useServices();
  const coupon = useQuery({ queryKey: ['coupons', 'detail', id], queryFn: () => api.coupons.get(id), enabled: id > 0 });
  return (
    <Screen testID="screen-coupon">
      <Offline />
      <RecordView query={coupon} testID="coupon">
        {(data) => <CouponForm key={JSON.stringify(data)} coupon={data} />}
      </RecordView>
    </Screen>
  );
}

function Stats({ id }) {
  const { api } = useServices();
  const { t } = useStrings();
  const stats = useQuery({ queryKey: ['coupons', 'stats', id], queryFn: () => api.coupons.stats(id) });
  if (!stats.data) return null;
  return (
    <Card testID="coupon-stats">
      <Fact label={t('coupons.stats.orders')} value={String(stats.data.orders)} />
      <Fact label={t('coupons.stats.discount')} value={formatPaise(stats.data.discountPaise)} />
      <Fact label={t('coupons.stats.revenue')} value={formatPaise(stats.data.revenuePaise)} />
    </Card>
  );
}

/** What a coupon may be limited to: the first products or categories, by name. */
function ScopePicker({ scope, value, onChange }) {
  const { api } = useServices();
  const { t } = useStrings();
  const list = useQuery({
    queryKey: ['coupons', 'scope', scope],
    queryFn: () => (scope === 'products' ? api.products.list({ limit: 50 }) : api.categories.list({ limit: 50 })),
    enabled: scope !== 'all',
  });
  if (scope === 'all') return null;
  if (!list.data) return <Text variant="small">{t('common.loading')}</Text>;
  const items = list.data.items ?? [];
  if (!items.length) return <Text variant="small">{t(scope === 'products' ? 'coupons.scope.noProducts' : 'coupons.scope.noCategories')}</Text>;
  return <ManyChoices testID="coupon-scope-ids" value={value} onChange={onChange} options={items.map((item) => ({ value: item.id, label: item.name }))} />;
}

function CouponForm({ coupon }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const writable = useWritable();
  const form = useForm(couponForm(coupon));
  const problem = useProblem(form.problems);
  const action = useAction([COUPONS]);
  const [removing, setRemoving] = useState(false);
  const { values, set } = form;

  async function save() {
    const built = couponBody(values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    const saved = await action.run('save', () => (coupon ? api.coupons.update(coupon.id, built.body) : api.coupons.create(built.body)), { done: 'coupons.saved' });
    if (saved && !coupon) navigation.goBack();
  }

  async function remove() {
    const done = await action.run('remove', () => api.coupons.remove(coupon.id));
    setRemoving(false);
    if (done) {
      queryClient.removeQueries({ queryKey: ['coupons', 'detail', coupon.id] });
      navigation.goBack();
    }
  }

  return (
    <View style={{ gap: theme.space[4] }}>
      <Text variant="page">{coupon ? coupon.code : t('coupons.new')}</Text>
      {coupon ? <Stats id={coupon.id} /> : null}
      <Card>
        <Field testID="coupon-code" label={t('coupons.code')} hint={t('coupons.codeHint')} value={values.code} onChangeText={(text) => set('code')(text.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 40))} error={problem('code')} autoCapitalize="characters" autoCorrect={false} />
        <Choices testID="coupon-kind" label={t('coupons.kind')} value={values.kind} onChange={set('kind')} options={COUPON_KINDS.map((value) => ({ value, label: t(`coupons.kind.${value}`) }))} />
        {values.kind === 'percent' ? (
          <>
            <Field testID="coupon-percent" label={t('coupons.percent')} value={values.percent} onChangeText={set('percent')} error={problem('percent')} keyboardType="decimal-pad" maxLength={6} />
            <RupeeField testID="coupon-max-discount" label={t('coupons.maxDiscount')} hint={t('coupons.optional')} value={values.maxDiscount} onChangeText={set('maxDiscount')} error={problem('maxDiscount')} />
          </>
        ) : null}
        {values.kind === 'flat' ? <RupeeField testID="coupon-amount" label={t('coupons.amount')} value={values.amount} onChangeText={set('amount')} error={problem('amount')} /> : null}
        <RupeeField testID="coupon-min-order" label={t('coupons.minOrder')} hint={t('coupons.optional')} value={values.minOrder} onChangeText={set('minOrder')} error={problem('minOrder')} />
      </Card>
      <Section title={t('coupons.when')}>
        <Card>
          <Field testID="coupon-starts" label={t('coupons.startsOn')} hint={t('coupons.dateHint')} value={values.startsOn} onChangeText={set('startsOn')} error={problem('startsOn')} keyboardType="numbers-and-punctuation" maxLength={10} />
          <Field testID="coupon-ends" label={t('coupons.endsOn')} hint={t('coupons.dateHint')} value={values.endsOn} onChangeText={set('endsOn')} error={problem('endsOn')} keyboardType="numbers-and-punctuation" maxLength={10} />
          <NumberField testID="coupon-max-uses" label={t('coupons.maxUses')} hint={t('coupons.optional')} value={values.maxUses} onChangeText={set('maxUses')} error={problem('maxUses')} />
          <NumberField testID="coupon-max-each" label={t('coupons.maxEach')} hint={t('coupons.optional')} value={values.maxUsesPerCustomer} onChangeText={set('maxUsesPerCustomer')} error={problem('maxUsesPerCustomer')} />
          <Toggle testID="coupon-first-order" title={t('coupons.firstOrder')} value={values.firstOrderOnly} onValueChange={set('firstOrderOnly')} />
        </Card>
      </Section>
      <Section title={t('coupons.scope')}>
        <Card>
          <Choices testID="coupon-scope" label={t('coupons.scope')} value={values.scope} onChange={set('scope')} options={COUPON_SCOPES.map((value) => ({ value, label: t(`coupons.scope.${value}`) }))} />
          <ScopePicker scope={values.scope} value={values.scopeIds} onChange={set('scopeIds')} />
          {problem('scope') ? <Text variant="meta" tone="bad">{problem('scope')}</Text> : null}
        </Card>
      </Section>
      <Toggle testID="coupon-active" title={t('coupons.active')} subtitle={t('coupons.activeHint')} value={values.active} onValueChange={set('active')} />
      <ActionMessages action={action} testID="coupon-action" />
      <Button testID="coupon-save" label={t(coupon ? 'coupons.save' : 'coupons.create')} disabled={!writable} busy={action.busy === 'save'} onPress={() => { save(); }} />
      {coupon ? <Button testID="coupon-remove" kind="danger" label={t('coupons.remove')} disabled={!writable} onPress={() => setRemoving(true)} /> : null}
      {coupon ? (
        <ConfirmSheet testID="coupon-remove-confirm" visible={removing} title={t('coupons.removeTitle', { code: coupon.code })} confirmLabel={t('coupons.remove')} cancelLabel={t('coupons.keep')} busy={action.busy === 'remove'} disabled={!writable} onCancel={() => setRemoving(false)} onConfirm={() => { remove(); }}>
          {t('coupons.removeBody')}
        </ConfirmSheet>
      ) : null}
    </View>
  );
}
