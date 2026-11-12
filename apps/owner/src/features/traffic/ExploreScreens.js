import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core';
import { MANAGERS, isAllowed } from '@bhava/app-core/access';
import { Badge, Button, Card, Choices, ConfirmSheet, Divider, Field, ListRow, Section, Text } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { LinkRow, Loadable, Page, RangePicker, Refusal, SourceTag, useConnection } from '../products/kit.js';
import { figureText, formatCount, formatRate, moneyText, rangeQuery } from '../insights/figures.js';
import { TRAFFIC_KEY } from './TrafficScreen.js';

const MONEY_METRICS = ['revenue_paise', 'revenue_per_session'];

/** One Explore cell as text: a rate as a percent, money by the revenue rule, "low volume" when its base is under 20. */
export function cellText(t, user, column, cell) {
  if (!cell) return t('insights.figure.notAvailable');
  if (cell.lowVolume) return t('insights.figure.lowVolume');
  if (MONEY_METRICS.includes(column.metric)) return moneyText(t, user, cell.value, cell.value === null ? 'not_available' : 'ok');
  if (column.isRate) return figureText(t, cell.value, 'ok', (v) => formatRate(v, 1));
  return figureText(t, cell.value);
}

/**
 * Explore (7.11): one metric by one breakdown over a period, from the catalogue the server allows (a metric the plan
 * or role doesn't include says why and can't be picked). Views can be saved for the team, pinned to the dashboard,
 * and removed. Nothing here can name one visitor.
 */
export function ExploreScreen() {
  const { api } = useServices();
  const { user } = useSession();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const catalog = useQuery({ queryKey: [...TRAFFIC_KEY, 'explore', 'catalog'], queryFn: () => api.explore.catalog() });
  const views = useQuery({ queryKey: [...TRAFFIC_KEY, 'views'], queryFn: () => api.savedViews.list() });
  const cards = useQuery({ queryKey: [...TRAFFIC_KEY, 'dashboard'], queryFn: () => api.dashboard.cards() });
  const [metric, setMetric] = useState('sessions');
  const [dimension, setDimension] = useState('source');
  const [range, setRange] = useState('28');
  const [name, setName] = useState('');
  const [removing, setRemoving] = useState(null);
  const definition = { metrics: [metric], dimensions: dimension ? [dimension] : [], ...rangeQuery(range) };
  const result = useQuery({ queryKey: [...TRAFFIC_KEY, 'explore', 'query', metric, dimension, range], queryFn: () => api.explore.query(definition), enabled: Boolean(catalog.data) });
  const refreshViews = () => {
    queryClient.invalidateQueries({ queryKey: [...TRAFFIC_KEY, 'views'] });
    queryClient.invalidateQueries({ queryKey: [...TRAFFIC_KEY, 'dashboard'] });
  };
  const create = useMutation({ mutationFn: () => api.savedViews.create({ name: name.trim(), visibility: 'private', definition }), onSuccess: () => { setName(''); refreshViews(); } });
  const pin = useMutation({ mutationFn: (view) => (view.pinned ? api.savedViews.unpin(view.id) : api.savedViews.pin(view.id)), onSuccess: refreshViews });
  const share = useMutation({ mutationFn: (view) => api.savedViews.update(view.id, { visibility: view.visibility === 'team' ? 'private' : 'team' }), onSuccess: refreshViews });
  const remove = useMutation({ mutationFn: (view) => api.savedViews.remove(view.id), onSuccess: () => { setRemoving(null); refreshViews(); } });
  const open = async (view) => {
    const full = await queryClient.fetchQuery({ queryKey: [...TRAFFIC_KEY, 'view', view.id], queryFn: () => api.savedViews.get(view.id) });
    const def = full.definition ?? {};
    if (Array.isArray(def.metrics) && def.metrics[0]) setMetric(def.metrics[0]);
    setDimension(Array.isArray(def.dimensions) ? def.dimensions[0] ?? '' : '');
    if (['7', '28', '90'].includes(String(def.range))) setRange(String(def.range));
  };
  const metrics = catalog.data?.metrics ?? [];
  const dims = catalog.data?.dimensions ?? [];
  const data = result.data;
  const column = data?.columns?.[0];
  const viewList = views.data?.items ?? [];
  const cardList = cards.data?.items ?? [];

  return (
    <Page testID="screen-traffic-explore" offline={offline}>
      <Text variant="page">{t('traffic.explore.title')}</Text>
      <Loadable query={catalog} testID="explore-catalog">
        <Card>
          <Text variant="meta">{t('traffic.explore.show')}</Text>
          <Choices testID="explore-metric" label={t('traffic.explore.show')} value={metric} onChange={setMetric} options={metrics.filter((m) => m.available).map((m) => ({ value: m.name, label: m.label }))} />
          {metrics.filter((m) => !m.available).map((m) => (
            <Text key={m.name} variant="caption" testID={`explore-unavailable-${m.name}`}>{`${m.label}: ${m.reason ?? t('insights.figure.notAvailable')}`}</Text>
          ))}
          <Text variant="meta">{t('traffic.explore.by')}</Text>
          <Choices testID="explore-dimension" label={t('traffic.explore.by')} value={dimension} onChange={setDimension} options={[{ value: '', label: t('traffic.explore.noBreakdown') }, ...dims.map((d) => ({ value: d.name, label: d.label }))]} />
          <RangePicker value={range} onChange={setRange} testID="explore-range" />
        </Card>
      </Loadable>
      <Loadable query={result} empty={Boolean(data) && !data.rows.length} testID="explore-result" emptyTitle={t('insights.figure.noData')}>
        {data && column ? (
          <Card testID="explore-table">
            {data.rows.slice(0, 50).map((row, i) => (
              <View key={i} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
                <Text variant="small" style={{ flex: 1 }}>{Object.values(row.dimensions).join(' · ') || t('traffic.explore.total')}</Text>
                <Text variant="small" testID={`explore-cell-${i}`}>{cellText(t, user, column, row.metrics[column.metric])}</Text>
              </View>
            ))}
            <Divider />
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Text variant="small">{t('traffic.explore.total')}</Text>
              <Text variant="small" testID="explore-total">{cellText(t, user, column, data.totals[column.metric])}</Text>
            </View>
            {data.hiddenMetrics.length ? <Text variant="caption">{t('traffic.explore.hidden')}</Text> : null}
            <SourceTag code={column.source} testID="explore-source" />
          </Card>
        ) : null}
      </Loadable>
      <Card>
        <Field testID="explore-name" label={t('traffic.explore.saveName')} value={name} onChangeText={setName} maxLength={80} editable={online} />
        <Button testID="explore-save" kind="secondary" label={t('traffic.explore.save')} busy={create.isPending} disabled={!online || !name.trim()} onPress={() => create.mutate()} />
        <Refusal error={create.error} testID="explore-save-error" />
      </Card>
      <Section title={t('traffic.explore.views')}>
        <Loadable query={views} empty={!viewList.length} testID="explore-views" emptyTitle={t('traffic.explore.noViews')}>
          <Card>
            {viewList.map((view, i) => (
              <View key={view.id} testID={`explore-view-${view.id}`}>
                {i ? <Divider /> : null}
                <ListRow title={view.name} subtitle={t(view.visibility === 'team' ? 'traffic.explore.team' : 'traffic.explore.private')} onPress={() => open(view)} end={view.pinned ? <Badge label={t('traffic.explore.pinned')} tone="primary" /> : null} />
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  <Button testID={`explore-view-${view.id}-pin`} kind="quiet" label={t(view.pinned ? 'traffic.explore.unpin' : 'traffic.explore.pin')} disabled={!online} onPress={() => pin.mutate(view)} />
                  {view.mine ? <Button testID={`explore-view-${view.id}-share`} kind="quiet" label={t(view.visibility === 'team' ? 'traffic.explore.makePrivate' : 'traffic.explore.share')} disabled={!online} onPress={() => share.mutate(view)} /> : null}
                  {view.mine ? <Button testID={`explore-view-${view.id}-remove`} kind="quiet" label={t('products.remove')} disabled={!online} onPress={() => setRemoving(view)} /> : null}
                </View>
              </View>
            ))}
          </Card>
          <Refusal error={pin.error ?? share.error} testID="explore-views-error" />
        </Loadable>
      </Section>
      <Section title={t('traffic.explore.dashboard')}>
        <Loadable query={cards} empty={!cardList.length} testID="explore-cards" emptyTitle={t('traffic.explore.noCards')}>
          <Card>
            {cardList.map((card) => {
              const col = card.result.columns[0];
              return <ListRow key={card.view.id} testID={`explore-card-${card.view.id}`} title={card.view.name} subtitle={col ? `${col.label}: ${cellText(t, user, col, card.result.totals[col.metric])}` : ''} />;
            })}
          </Card>
        </Loadable>
      </Section>
      <ConfirmSheet testID="explore-remove" visible={Boolean(removing)} title={t('traffic.explore.removeTitle', { name: removing?.name ?? '' })} confirmLabel={t('products.remove')} cancelLabel={t('common.cancel')} onCancel={() => setRemoving(null)} onConfirm={() => remove.mutate(removing)} busy={remove.isPending} disabled={!online}>
        {t('traffic.explore.removeBody')}
      </ConfirmSheet>
    </Page>
  );
}

/** Custom funnels (7.12): the business's own step lists. Managers make and change them; anyone with analytics reads them. */
export function FunnelsScreen() {
  const { api } = useServices();
  const { user } = useSession();
  const { t } = useStrings();
  const navigation = useNavigation();
  const { offline } = useConnection();
  const funnels = useQuery({ queryKey: [...TRAFFIC_KEY, 'funnels'], queryFn: () => api.funnels.list() });
  const items = funnels.data?.items ?? [];
  return (
    <Page testID="screen-traffic-funnels" offline={offline}>
      <Text variant="page">{t('traffic.funnels.title')}</Text>
      {isAllowed(user, MANAGERS) ? <Button testID="funnels-new" kind="secondary" label={t('traffic.funnels.new')} onPress={() => navigation.navigate('traffic.funnelEdit', {})} /> : null}
      <Loadable query={funnels} empty={!items.length} testID="funnels" emptyTitle={t('traffic.funnels.empty')}>
        <Card>
          {items.map((funnel) => (
            <LinkRow key={funnel.id} testID={`funnel-${funnel.id}`} title={funnel.name} subtitle={t('traffic.funnels.steps', { count: funnel.steps.length })} onPress={() => navigation.navigate('traffic.funnel', { id: String(funnel.id) })} />
          ))}
        </Card>
      </Loadable>
    </Page>
  );
}

export function FunnelResultsScreen({ route }) {
  const { api } = useServices();
  const { user } = useSession();
  const { t } = useStrings();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const id = String(route?.params?.id ?? '');
  const [range, setRange] = useState('28');
  const [confirm, setConfirm] = useState(false);
  const funnel = useQuery({ queryKey: [...TRAFFIC_KEY, 'funnel', id], queryFn: () => api.funnels.get(id), enabled: Boolean(id) });
  const results = useQuery({ queryKey: [...TRAFFIC_KEY, 'funnel', id, 'results', range], queryFn: () => api.funnels.results(id, rangeQuery(range)), enabled: Boolean(id) });
  const remove = useMutation({
    mutationFn: () => api.funnels.remove(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [...TRAFFIC_KEY, 'funnels'] });
      navigation.goBack();
    },
  });
  const manager = isAllowed(user, MANAGERS);
  const steps = results.data?.steps ?? [];
  return (
    <Page testID="screen-traffic-funnel" offline={offline}>
      <Text variant="page">{funnel.data?.name ?? t('traffic.funnels.one')}</Text>
      <RangePicker value={range} onChange={setRange} testID="funnel-range" />
      <Loadable query={results} empty={!steps.length} testID="funnel-results" emptyTitle={t('insights.figure.noData')}>
        <Card>
          {steps.map((step, i) => (
            <View key={`${step.kind}-${i}`} testID={`funnel-step-${i}`}>
              {i ? <Divider /> : null}
              <Text variant="small">{t(`traffic.step.${step.kind}`)}{step.page ? ` · ${step.page}` : ''}</Text>
              {step.unavailable ? (
                <Text variant="small" testID={`funnel-step-${i}-na`}>{step.message ?? t('insights.figure.notAvailable')}</Text>
              ) : (
                <Text variant="title" testID={`funnel-step-${i}-count`}>{formatCount(step.count)}{step.stepRate === null ? '' : ` · ${formatRate(step.stepRate, 0)}`}</Text>
              )}
            </View>
          ))}
          <SourceTag code={results.data?.source} testID="funnel-source" />
        </Card>
      </Loadable>
      {manager ? (
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <Button testID="funnel-edit" kind="secondary" label={t('traffic.funnels.edit')} disabled={!online} onPress={() => navigation.navigate('traffic.funnelEdit', { id })} />
          <Button testID="funnel-remove" kind="danger" label={t('products.remove')} disabled={!online} onPress={() => setConfirm(true)} />
        </View>
      ) : null}
      <Refusal error={remove.error} testID="funnel-remove-error" />
      <ConfirmSheet testID="funnel-remove-confirm" visible={confirm} title={t('traffic.funnels.removeTitle')} confirmLabel={t('products.remove')} cancelLabel={t('common.cancel')} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate()} busy={remove.isPending} disabled={!online}>
        {t('traffic.funnels.removeBody')}
      </ConfirmSheet>
    </Page>
  );
}

const STEP_KINDS = ['landing_view', 'category_view', 'product_view', 'product_tap', 'outbound_click', 'whatsapp_tap', 'add_to_cart', 'checkout_started', 'payment_success', 'page_view'];

/** Make or change a funnel: 2 to 8 steps, in order. A page view needs the page. */
export function FunnelEditScreen({ route }) {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const id = route?.params?.id ? String(route.params.id) : null;
  const existing = useQuery({ queryKey: [...TRAFFIC_KEY, 'funnel', id], queryFn: () => api.funnels.get(id), enabled: Boolean(id) });
  const [name, setName] = useState('');
  const [steps, setSteps] = useState([]);
  const [countBy, setCountBy] = useState('session');
  const [loaded, setLoaded] = useState(!id);
  useEffect(() => {
    if (!loaded && existing.data) {
      setName(existing.data.name);
      setSteps(existing.data.steps.map((s) => ({ kind: s.kind, page: s.page ?? '' })));
      setCountBy(existing.data.countBy);
      setLoaded(true);
    }
  }, [existing.data, loaded]);
  const save = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), countBy, steps: steps.map((s) => (s.kind === 'page_view' ? { kind: s.kind, page: s.page.trim() } : { kind: s.kind })) };
      return id ? api.funnels.update(id, body) : api.funnels.create(body);
    },
    onSuccess: (saved) => {
      queryClient.invalidateQueries({ queryKey: [...TRAFFIC_KEY, 'funnels'] });
      queryClient.invalidateQueries({ queryKey: [...TRAFFIC_KEY, 'funnel', String(saved.id)] });
      navigation.goBack();
    },
  });
  const ready = name.trim() && steps.length >= 2 && steps.length <= 8 && steps.every((s) => s.kind !== 'page_view' || s.page.trim());
  return (
    <Page testID="screen-traffic-funnel-edit" offline={offline}>
      <Text variant="page">{t(id ? 'traffic.funnels.edit' : 'traffic.funnels.new')}</Text>
      {id && !loaded ? <Loadable query={existing} testID="funnel-edit-load" /> : (
        <>
          <Field testID="funnel-name" label={t('traffic.funnels.name')} value={name} onChangeText={setName} maxLength={80} />
          <Choices testID="funnel-count-by" label={t('traffic.funnels.countBy')} value={countBy} onChange={setCountBy} options={[{ value: 'session', label: t('traffic.funnels.bySession') }, { value: 'visitor', label: t('traffic.funnels.byVisitor') }]} />
          <Card testID="funnel-steps">
            {steps.map((step, i) => (
              <View key={i} style={{ gap: 4 }}>
                <ListRow testID={`funnel-edit-step-${i}`} title={`${i + 1}. ${t(`traffic.step.${step.kind}`)}`} end={<Button kind="quiet" label={t('products.remove')} onPress={() => setSteps(steps.filter((_, at) => at !== i))} />} />
                {step.kind === 'page_view' ? <Field testID={`funnel-edit-step-${i}-page`} label={t('traffic.funnels.page')} value={step.page} onChangeText={(v) => setSteps(steps.map((s, at) => (at === i ? { ...s, page: v } : s)))} /> : null}
              </View>
            ))}
            {steps.length < 8 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {STEP_KINDS.map((kind) => <Button key={kind} testID={`funnel-add-${kind}`} kind="quiet" label={`+ ${t(`traffic.step.${kind}`)}`} onPress={() => setSteps([...steps, { kind, page: '' }])} />)}
              </View>
            ) : null}
            <Text variant="caption">{t('traffic.funnels.stepRule')}</Text>
          </Card>
          <Button testID="funnel-save" label={t('common.save')} busy={save.isPending} disabled={!online || !ready} onPress={() => save.mutate()} />
          <Refusal error={save.error} testID="funnel-save-error" />
        </>
      )}
    </Page>
  );
}

/** Cohorts (7.12): counts only, never who. A small group says "low volume" and shows no rates (N-59). */
export function CohortsScreen() {
  const { api } = useServices();
  const { user } = useSession();
  const { t } = useStrings();
  const { offline } = useConnection();
  const [kind, setKind] = useState('visitors');
  const [groupBy, setGroupBy] = useState('first_week');
  const [range, setRange] = useState('90');
  const cohorts = useQuery({ queryKey: [...TRAFFIC_KEY, 'cohorts', kind, groupBy, range], queryFn: () => api.cohorts.get({ kind, groupBy, ...rangeQuery(range) }) });
  const rows = cohorts.data?.cohorts ?? [];
  return (
    <Page testID="screen-traffic-cohorts" offline={offline}>
      <Text variant="page">{t('traffic.cohorts.title')}</Text>
      <Choices testID="cohorts-kind" label={t('traffic.cohorts.kind')} value={kind} onChange={setKind} options={['visitors', 'buyers'].map((k) => ({ value: k, label: t(`traffic.cohorts.${k}`) }))} />
      <Choices testID="cohorts-group" label={t('traffic.cohorts.group')} value={groupBy} onChange={setGroupBy} options={['first_week', 'first_month', 'first_source'].map((g) => ({ value: g, label: t(`traffic.cohorts.${g}`) }))} />
      <RangePicker value={range} onChange={setRange} testID="cohorts-range" />
      <Loadable query={cohorts} empty={!rows.length} testID="cohorts" emptyTitle={t('insights.figure.noData')}>
        <Card>
          {rows.map((row, i) => (
            <View key={row.key} testID={`cohort-${i}`}>
              {i ? <Divider /> : null}
              <Text variant="small">{`${row.key} · ${t('traffic.cohorts.size', { count: formatCount(row.size) })}`}</Text>
              <Text variant="small" testID={`cohort-${i}-rates`}>
                {row.lowVolume ? t('insights.figure.lowVolume') : row.rates.map((r) => (r === null ? '–' : formatRate(r, 0))).join('  ')}
              </Text>
              {kind === 'buyers' && !row.lowVolume ? (
                <Text variant="caption">{t('traffic.cohorts.perBuyer', { amount: moneyText(t, user, row.revenuePerBuyerPaise) })}</Text>
              ) : null}
            </View>
          ))}
          <SourceTag code="bhava" />
        </Card>
      </Loadable>
    </Page>
  );
}
