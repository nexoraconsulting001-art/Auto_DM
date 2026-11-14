import React, { useRef, useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { errorKey, formatDate, useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, Divider, ErrorState, ListRow, LoadingRows, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { ActionMessages, Fact, Offline, formatPaise, openOutside, useAction } from '../orders/kit/ui.js';
import { useBillingActions } from './actions.js';
import { FEATURE_KEYS, STORE_FEATURE, groupDigits, meterView, newRequestKey, planLabel, planRank, priceOf } from './rules.js';

export const BILLING = ['billing'];
const read = (name, fn) => ({ queryKey: ['billing', name], queryFn: fn });

/** One read of the screen: a spinner, a failure with a retry (or the saved copy), or the data. */
export function Block({ query, testID, children }) {
  const { t } = useStrings();
  if (query.isPending) return <LoadingRows testID={`${testID}-loading`} label={t('common.loading')} />;
  if (!query.data) return <ErrorState testID={`${testID}-error`} title={t('error.title')} onRetry={() => query.refetch()} retryLabel={t('common.retry')}>{t(errorKey(query.error))}</ErrorState>;
  return children(query.data);
}

function Meter({ usage, plan, actions, onPack, packs, writable }) {
  const { t, locale } = useStrings();
  const theme = useTheme();
  const meter = meterView(usage.meters.find((m) => m.meter === 'dms'));
  if (!meter) return null;
  const bar = meter.state === 'over' ? theme.color.badText : meter.state === 'near' ? theme.color.accent : theme.color.primary;
  return (
    <Card testID="billing-usage">
      <Text variant="title">{t('billing.usage.title')}</Text>
      <Text variant="body" testID="billing-usage-count">
        {meter.unlimited ? t('billing.usage.unlimited', { used: groupDigits(meter.used) }) : t('billing.usage.count', { used: groupDigits(meter.used), allowance: groupDigits(meter.allowance), percent: meter.percent })}
      </Text>
      {!meter.unlimited ? (
        <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: 100, now: meter.percent }} style={{ height: 10, borderRadius: 5, backgroundColor: theme.color.line, overflow: 'hidden' }}>
          <View style={{ width: `${meter.percent}%`, height: 10, backgroundColor: bar }} />
        </View>
      ) : null}
      {meter.packUnits > 0 ? <Text variant="meta">{t('billing.usage.packs', { units: groupDigits(meter.packUnits) })}</Text> : null}
      <Text variant="meta">{t('billing.usage.resets', { date: formatDate(usage.resetsAt, { locale }) })}</Text>
      {meter.state === 'near' ? <Banner tone="warn" testID="billing-usage-near">{t('billing.usage.near', { left: groupDigits(meter.left ?? 0) })}</Banner> : null}
      {meter.state === 'over' ? <Banner tone="bad" testID="billing-usage-over">{t('billing.usage.over')}</Banner> : null}
      {usage.heldDms > 0 ? <Banner tone="warn" testID="billing-usage-held">{t('billing.usage.held', { count: groupDigits(usage.heldDms) })}</Banner> : null}
      {actions && usage.canBuyPacks
        ? packs.map((pack) => (
          <Button
            key={pack.code}
            testID={`billing-pack-${pack.code}`}
            kind={meter.state === 'ok' ? 'secondary' : 'primary'}
            label={t('billing.pack.button', { units: groupDigits(pack.units ?? 0), price: formatPaise(pack.pricePaise) })}
            disabled={!writable || !pack.available}
            onPress={() => onPack(pack)}
          />
        ))
        : null}
      {actions && !usage.canBuyPacks && meter.state !== 'ok' ? <Text variant="small" testID="billing-usage-upgrade">{t('billing.usage.upgrade', { plan: planLabel(plan) })}</Text> : null}
    </Card>
  );
}

export default function BillingScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const { business } = useSession();
  const actions = useBillingActions();
  const action = useAction([BILLING]);
  const [cycle, setCycle] = useState('monthly');
  const [asking, setAsking] = useState(null);
  const keys = useRef({});

  const plan = useQuery(read('plan', () => api.billing.plan()));
  const usage = useQuery(read('usage', () => api.billing.usage()));
  const features = useQuery(read('features', () => api.billing.features()));
  const catalog = useQuery({ ...read('catalog', () => api.billing.catalog()), enabled: actions });
  const creator = business?.accountType === 'creator';
  const writable = action.writable;

  const keyFor = (signature) => (keys.current[signature] ??= newRequestKey());

  const confirm = async () => {
    const ask = asking;
    if (!ask) return;
    const signature = `${ask.kind}:${ask.code ?? ask.id}:${ask.kind === 'plan' ? cycle : ''}`;
    let work;
    if (ask.kind === 'plan') work = () => api.billing.change({ plan: ask.code, ...(ask.code === 'free' ? {} : { cycle }), requestKey: keyFor(signature) });
    else if (ask.kind === 'remove') work = () => api.billing.removeItem(ask.id);
    else work = () => api.billing.addItem({ code: ask.code, quantity: 1, requestKey: keyFor(signature) });
    const result = await action.run(signature, work, { done: ask.kind === 'remove' ? 'billing.done.removed' : null, reload: [BILLING] });
    setAsking(null);
    if (!result) return;
    delete keys.current[signature];
    if (result.checkoutUrl) await openOutside(result.checkoutUrl);
  };

  const current = plan.data?.plan ?? business?.plan ?? 'free';
  const catalogPlans = catalog.data?.plans ?? [];
  const allAddons = catalog.data?.addons ?? [];
  const packs = allAddons.filter((a) => a.kind === 'pack');
  const addons = allAddons.filter((a) => a.kind !== 'pack' && (!creator || !(a.feature && STORE_FEATURE.test(a.feature))));
  const items = plan.data?.items ?? [];
  const pickPlan = (p) => setAsking({ kind: 'plan', code: p.code, name: p.name, price: priceOf(p, cycle), later: planRank(p.code) < planRank(current) });

  return (
    <Screen testID="screen-billing" title={t('billing.title')}>
      <Offline />
      <ActionMessages action={action} testID="billing-action" />
      <Block query={plan} testID="billing-plan">
        {(data) => (
          <Card testID="billing-current">
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
              <Text variant="title" style={{ flex: 1 }}>{data.planName}</Text>
              <Badge testID="billing-status" label={t(`billing.status.${data.status}`)} tone={data.status === 'active' ? 'good' : data.status === 'cancelled' ? 'neutral' : 'warn'} />
            </View>
            {data.plan !== 'free' ? <Text variant="small">{t(`billing.billed.${data.cycle}`)}</Text> : <Text variant="small">{t('billing.free.body')}</Text>}
            {data.nextChargePaise > 0 && data.periodEnd ? <Fact testID="billing-next" label={t('billing.next', { date: formatDate(data.periodEnd, { locale }) })} value={formatPaise(data.nextChargePaise)} /> : null}
            {data.nextPlan ? <Text variant="small" testID="billing-switching">{t('billing.switching', { plan: planLabel(data.nextPlan), date: data.periodEnd ? formatDate(data.periodEnd, { locale }) : '' })}</Text> : null}
            {data.graceUntil ? <Banner tone="bad" testID="billing-grace">{t('billing.grace', { date: formatDate(data.graceUntil, { locale }) })}</Banner> : null}
            {data.offer ? <Text variant="small" testID="billing-offer">{t('billing.offer')}</Text> : null}
          </Card>
        )}
      </Block>

      <Block query={usage} testID="billing-meter">
        {(data) => <Meter usage={data} plan={current} actions={actions} packs={packs} writable={writable} onPack={(pack) => setAsking({ kind: 'pack', code: pack.code, name: pack.name, price: pack.pricePaise })} />}
      </Block>

      {items.length > 0 ? (
        <Section title={t('billing.items.title')}>
          <Card testID="billing-items">
            {items.map((item, i) => (
              <View key={item.id}>
                {i > 0 ? <Divider /> : null}
                <ListRow
                  testID={`billing-item-${item.id}`}
                  title={item.quantity > 1 ? `${item.name} × ${item.quantity}` : item.name}
                  subtitle={`${formatPaise(item.unitPricePaise)} · ${t(`billing.itemCycle.${item.cycle}`)}`}
                  end={actions && item.endsAt === null ? <Button testID={`billing-item-${item.id}-remove`} kind="quiet" label={t('billing.remove')} disabled={!writable} onPress={() => setAsking({ kind: 'remove', id: item.id, name: item.name })} /> : null}
                />
              </View>
            ))}
          </Card>
        </Section>
      ) : null}

      <Block query={features} testID="billing-features">
        {(data) => {
          const shown = Object.entries(FEATURE_KEYS).filter(([code]) => data.features[code] && (!creator || !STORE_FEATURE.test(code)));
          return shown.length ? (
            <Section title={t('billing.features.title')}>
              <Card testID="billing-feature-list">
                {shown.map(([code, key], i) => (
                  <View key={code}>
                    {i > 0 ? <Divider /> : null}
                    <ListRow
                      title={t(key)}
                      subtitle={data.features[code].on ? (data.features[code].limit ? t('billing.features.limit', { limit: data.features[code].limit }) : t('billing.features.on')) : t('billing.features.off')}
                      end={<Badge label={t(data.features[code].on ? 'billing.features.badgeOn' : 'billing.features.badgeOff')} tone={data.features[code].on ? 'good' : 'neutral'} />}
                    />
                  </View>
                ))}
              </Card>
            </Section>
          ) : null;
        }}
      </Block>

      {actions ? (
        <Section title={t('billing.plans.title')}>
          <Choices testID="billing-cycle" label={t('billing.cycle.label')} options={[{ value: 'monthly', label: t('billing.cycle.monthly') }, { value: 'yearly', label: t('billing.cycle.yearly') }]} value={cycle} onChange={setCycle} />
          <Block query={catalog} testID="billing-catalog">
            {(data) => (
              <Card testID="billing-plans">
                {catalogPlans.map((p, i) => {
                  const yours = p.code === current || p.current;
                  return (
                    <View key={p.code}>
                      {i > 0 ? <Divider /> : null}
                      <ListRow
                        testID={`billing-plan-${p.code}`}
                        title={p.name}
                        subtitle={`${priceOf(p, cycle) === 0 ? t('billing.plans.free') : t(`billing.plans.price.${cycle}`, { price: formatPaise(priceOf(p, cycle)) })} · ${p.includedDms === null ? t('billing.plans.noLimit') : t('billing.plans.dms', { count: groupDigits(p.includedDms) })}`}
                        end={yours ? <Badge label={t('billing.plans.yours')} tone="good" /> : <Text variant="meta">{t(planRank(p.code) < planRank(current) ? 'billing.plans.switch' : 'billing.plans.choose')}</Text>}
                        emphasis={yours}
                        disabled={!writable || yours}
                        onPress={yours ? undefined : () => pickPlan(p)}
                        accessibilityHint={t('billing.plans.hint')}
                      />
                    </View>
                  );
                })}
                <Text variant="meta">{t('billing.plans.gst', { rate: (data.taxRateBp / 100).toFixed(data.taxRateBp % 100 ? 1 : 0) })}</Text>
                {cycle === 'yearly' ? <Text variant="meta">{t('billing.plans.twoFree')}</Text> : null}
              </Card>
            )}
          </Block>
          {addons.length > 0 ? (
            <Card testID="billing-addons">
              <Text variant="title">{t('billing.addons.title')}</Text>
              {addons.map((a, i) => (
                <View key={a.code}>
                  {i > 0 ? <Divider /> : null}
                  <ListRow
                    testID={`billing-addon-${a.code}`}
                    title={a.name}
                    subtitle={a.available ? `${formatPaise(a.pricePaise)} · ${t(`billing.itemCycle.${a.cycle}`)}` : t(`billing.addons.${a.unavailable ?? 'needs_plan'}`, { plan: planLabel(a.minPlan) })}
                    end={a.available ? <Text variant="meta">{t('billing.addons.add')}</Text> : null}
                    disabled={!writable || !a.available}
                    onPress={a.available ? () => setAsking({ kind: 'addon', code: a.code, name: a.name, price: a.pricePaise }) : undefined}
                  />
                </View>
              ))}
            </Card>
          ) : null}
        </Section>
      ) : null}

      {actions && plan.data?.hasPaymentMethod ? <PaymentMethod action={action} api={api} /> : null}

      <Section title={t('billing.records.title')}>
        <Card>
          <ListRow testID="billing-invoices-link" title={t('billing.invoices.title')} subtitle={t('billing.invoices.sub')} onPress={() => navigation.navigate('billing.invoices')} />
          {!creator ? <Divider /> : null}
          {!creator ? <ListRow testID="billing-statements-link" title={t('billing.statements.title')} subtitle={t('billing.statements.sub')} onPress={() => navigation.navigate('billing.statements')} /> : null}
        </Card>
      </Section>
      {actions ? <Text variant="meta" testID="billing-no-cards">{t('billing.noCards')}</Text> : null}

      <ConfirmSheet
        testID="billing-confirm"
        visible={Boolean(asking)}
        tone={asking?.kind === 'remove' ? 'danger' : 'primary'}
        title={asking ? t(`billing.confirm.${asking.kind}`, { name: asking.name ?? '' }) : ''}
        confirmLabel={t('billing.confirm.yes')}
        cancelLabel={t('common.cancel')}
        busy={Boolean(action.busy)}
        disabled={!writable}
        onConfirm={confirm}
        onCancel={() => setAsking(null)}
      >
        {asking ? (
          <View style={{ gap: theme.space[2] }}>
            {asking.kind !== 'remove' ? (
              <Text variant="body" testID="billing-confirm-price">
                {asking.kind === 'plan' ? (asking.price === 0 ? t('billing.plans.free') : t(`billing.plans.price.${cycle}`, { price: formatPaise(asking.price) })) : formatPaise(asking.price)}
              </Text>
            ) : null}
            {asking.kind === 'plan' ? <Text variant="small">{t(asking.later ? 'billing.confirm.later' : 'billing.confirm.now')}</Text> : null}
            {asking.kind !== 'remove' ? <Text variant="small">{t('billing.confirm.gst')}</Text> : null}
            {asking.kind !== 'remove' ? <Text variant="small">{t('billing.confirm.hosted')}</Text> : null}
            <Text variant="small">{t('billing.confirm.fresh')}</Text>
          </View>
        ) : null}
      </ConfirmSheet>
    </Screen>
  );
}

/** The card is changed on the payment provider's own page, in the browser; this app never shows a card field. */
function PaymentMethod({ action, api }) {
  const { t } = useStrings();
  return (
    <Card testID="billing-method">
      <Text variant="small">{t('billing.method.body')}</Text>
      <Button
        testID="billing-method-open"
        kind="secondary"
        label={t('billing.method.open')}
        disabled={!action.writable}
        busy={action.busy === 'method'}
        onPress={async () => {
          const page = await action.run('method', () => api.billing.paymentMethod());
          if (page?.url) await openOutside(page.url);
        }}
      />
    </Card>
  );
}
