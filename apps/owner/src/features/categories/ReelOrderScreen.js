import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, Choices, Divider, Field, ListRow, Section, Sheet, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { Loadable, Page, Refusal, Thumb, useConnection } from '../products/kit.js';
import { RULE_MATCHES } from '../products/limits.js';
import { SortableRow } from './sortable.js';
import { HIDDEN_KEYS, arrange, optimistic, pin, reorder, saveBody, splitSequence, unpin } from './sequence.js';
import { CATEGORIES_KEY } from './CategoriesScreen.js';

const reelsKey = (id) => [...CATEGORIES_KEY, 'reels', String(id)];
const rulesKey = (id) => [...CATEGORIES_KEY, 'rules', String(id)];

/** "2026-11-05" typed on the phone as the start of that day where the phone is, as the API's ISO time; '' is none. */
export function dayToIso(text) {
  const value = String(text ?? '').trim();
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return undefined;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (date.getMonth() !== Number(match[2]) - 1) return undefined;
  return date.toISOString();
}
/** An ISO time as the day it falls on where the phone is, for the field. */
export function isoToDay(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** The window a reel shows in, in this category only (K-46). Both empty clears it. */
function ScheduleSheet({ item, categoryId, onClose, onSaved }) {
  const { api } = useServices();
  const { t } = useStrings();
  const { online } = useConnection();
  const [from, setFrom] = useState(isoToDay(item?.startsAt));
  const [to, setTo] = useState(isoToDay(item?.endsAt));
  const startsAt = dayToIso(from);
  const endsAt = dayToIso(to);
  const bad = startsAt === undefined || endsAt === undefined;
  const backwards = !bad && startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt);
  const save = useMutation({ mutationFn: () => api.categories.schedule(categoryId, { pageId: item.pageId, startsAt, endsAt }), onSuccess: onSaved });
  return (
    <Sheet testID="reel-schedule" visible={Boolean(item)} onClose={onClose} title={t('categories.schedule.title')} closeLabel={t('common.close')} dismissable={!save.isPending}>
      <Text variant="small">{t('categories.schedule.intro')}</Text>
      <Field testID="reel-schedule-from" label={t('categories.schedule.from')} hint={t('categories.schedule.format')} value={from} onChangeText={setFrom} error={startsAt === undefined ? t('categories.schedule.bad') : null} />
      <Field testID="reel-schedule-to" label={t('categories.schedule.to')} hint={t('categories.schedule.format')} value={to} onChangeText={setTo} error={endsAt === undefined ? t('categories.schedule.bad') : backwards ? t('categories.schedule.backwards') : null} />
      <Refusal error={save.error} testID="reel-schedule-error" />
      <Button testID="reel-schedule-save" label={t('common.save')} busy={save.isPending} disabled={!online || bad || Boolean(backwards)} onPress={() => save.mutate()} />
    </Sheet>
  );
}

/** Reels and posts with a landing page that are not in this category yet, to add at the top or the bottom. */
function AddReel({ categoryId, have, onAdded, disabled }) {
  const { api } = useServices();
  const { t } = useStrings();
  const [at, setAt] = useState('bottom');
  const pages = useQuery({ queryKey: ['pages', 'list', 'all', 'picker'], queryFn: () => api.pages.list({ limit: 50 }) });
  const add = useMutation({ mutationFn: (pageId) => api.categories.addReel(categoryId, { pageId, at }), onSuccess: onAdded });
  const choices = (pages.data?.items ?? []).filter((p) => !have.has(p.id));
  return (
    <Section title={t('categories.add.title')}>
      <Card>
        <Choices testID="reel-add-at" label={t('categories.add.at')} value={at} onChange={setAt} options={[{ value: 'top', label: t('categories.join.top') }, { value: 'bottom', label: t('categories.join.bottom') }]} />
        <Loadable query={pages} empty={!choices.length} testID="reel-add-choices" emptyTitle={t('categories.add.none')}>
          {choices.slice(0, 20).map((page) => (
            <ListRow key={page.id} testID={`reel-add-${page.id}`} start={<Thumb uri={page.thumbnailUrl} size={40} label={page.headline || page.slug} />} title={page.headline || page.slug} subtitle={t(`categories.kind.${page.kind}`)} disabled={disabled || add.isPending} onPress={() => add.mutate(page.id)} />
          ))}
        </Loadable>
        <Refusal error={add.error} testID="reel-add-error" />
      </Card>
    </Section>
  );
}

/** Auto-join rules (8.13): new reels that match join at the top or the bottom; "Apply now" adds the ones already posted. */
function Rules({ categoryId, onApplied }) {
  const { api } = useServices();
  const { t } = useStrings();
  const { online } = useConnection();
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: rulesKey(categoryId), queryFn: () => api.categories.rules(categoryId) });
  const categories = useQuery({ queryKey: [...CATEGORIES_KEY, 'list', 'all'], queryFn: () => api.categories.list({ limit: 100 }) });
  const [match, setMatch] = useState('hashtag');
  const [value, setValue] = useState('');
  const [productCategoryId, setProductCategoryId] = useState(null);
  const [joinAt, setJoinAt] = useState('top');
  const refresh = () => queryClient.invalidateQueries({ queryKey: rulesKey(categoryId) });
  const add = useMutation({
    mutationFn: () => api.categories.addRule(categoryId, match === 'product_category' ? { match, productCategoryId, joinAt } : { match, value: value.trim(), joinAt }),
    onSuccess: () => {
      setValue('');
      refresh();
    },
  });
  const update = useMutation({ mutationFn: ({ id, body }) => api.categoryRules.update(id, body), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id) => api.categoryRules.remove(id), onSuccess: refresh });
  const apply = useMutation({ mutationFn: (id) => api.categoryRules.apply(id), onSuccess: onApplied });
  const items = rules.data?.items ?? [];
  const others = (categories.data?.items ?? []).filter((c) => String(c.id) !== String(categoryId));
  const describe = (rule) => (rule.match === 'product_category' ? t('categories.rule.product_category.text', { name: others.find((c) => c.id === rule.productCategoryId)?.name ?? '' }) : t(`categories.rule.${rule.match}.text`, { value: rule.value }));
  const ready = match === 'product_category' ? productCategoryId !== null : value.trim().length > 0;
  return (
    <Section title={t('categories.rules.title')}>
      <Loadable query={rules} empty={false} testID="category-rules">
        <Card>
          {!items.length ? <Text variant="small" testID="category-rules-empty">{t('categories.rules.empty')}</Text> : null}
          {items.map((rule, i) => (
            <View key={rule.id} testID={`rule-${rule.id}`} style={{ gap: 6 }}>
              {i ? <Divider /> : null}
              <Toggle testID={`rule-${rule.id}-active`} title={describe(rule)} subtitle={t(`categories.join.${rule.joinAt}`)} value={rule.active} disabled={!online || update.isPending} onValueChange={(active) => update.mutate({ id: rule.id, body: { active } })} />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                <Button testID={`rule-${rule.id}-apply`} kind="secondary" label={t('categories.rules.apply')} busy={apply.isPending && apply.variables === rule.id} disabled={!online || !rule.active} onPress={() => apply.mutate(rule.id)} />
                <Button testID={`rule-${rule.id}-remove`} kind="quiet" label={t('categories.rules.remove')} disabled={!online} onPress={() => remove.mutate(rule.id)} />
              </View>
            </View>
          ))}
          {apply.data ? <Text variant="caption" testID="rules-applied">{t('categories.rules.applied', { count: apply.data.added })}</Text> : null}
          <Refusal error={update.error ?? remove.error ?? apply.error} testID="rules-error" />
          <Divider />
          <Text variant="title">{t('categories.rules.new')}</Text>
          <Choices testID="rule-match" label={t('categories.rules.match')} value={match} onChange={setMatch} options={RULE_MATCHES.map((m) => ({ value: m, label: t(`categories.rule.${m}`) }))} />
          {match === 'product_category' ? (
            <Choices testID="rule-product-category" label={t('categories.rule.product_category')} value={productCategoryId} onChange={setProductCategoryId} options={others.map((c) => ({ value: c.id, label: c.name }))} />
          ) : (
            <Field testID="rule-value" label={t(`categories.rule.${match}.label`)} value={value} onChangeText={setValue} autoCapitalize="none" maxLength={100} />
          )}
          <Choices testID="rule-join" label={t('categories.add.at')} value={joinAt} onChange={setJoinAt} options={[{ value: 'top', label: t('categories.join.top') }, { value: 'bottom', label: t('categories.join.bottom') }]} />
          <Refusal error={add.error} testID="rule-add-error" />
          <Button testID="rule-add" kind="secondary" label={t('categories.rules.add')} busy={add.isPending} disabled={!online || !ready} onPress={() => add.mutate()} />
        </Card>
      </Loadable>
    </Section>
  );
}

/**
 * A category's reel order (PRD 8.13, Reel order in the design): pinned reels first in their own order, then the rest.
 * Drag a row or use its arrows to move it within its group; pin or unpin with the pin button (an unpinned reel goes
 * back to the place it kept). Every change shows at once and is saved; if the save fails or the phone is offline, the
 * list goes back to how it was and says why. A reel that shows nowhere right now keeps its place, with why.
 */
export default function ReelOrderScreen({ route }) {
  const id = String(route?.params?.id ?? '');
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const sequence = useQuery({ queryKey: reelsKey(id), queryFn: () => api.categories.reels(id) });
  const category = useQuery({ queryKey: [...CATEGORIES_KEY, 'one', id], queryFn: () => api.categories.get(id) });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState(null);
  const [scheduling, setScheduling] = useState(null);
  const shown = arrange(sequence.data?.items ?? []);
  const { pinned } = splitSequence(shown);
  const setShown = (data) => queryClient.setQueryData(reelsKey(id), data);
  const reload = (answer) => {
    if (answer?.items) setShown(answer);
    else queryClient.invalidateQueries({ queryKey: reelsKey(id) });
  };

  /** Shows `items` at once, sends the change, and keeps the server's answer; a failure puts back what was there. */
  async function change(items, send) {
    if (busy) return;
    if (!online) {
      setFailure({ code: 'offline' });
      return;
    }
    setFailure(null);
    setBusy(true);
    try {
      const answer = await optimistic({ read: () => queryClient.getQueryData(reelsKey(id)), write: setShown, next: { ...sequence.data, items }, send });
      reload(answer);
    } catch (error) {
      setFailure(error);
    } finally {
      setBusy(false);
    }
  }
  const move = (from, to) => {
    const next = reorder(shown, from, to);
    change(next, () => api.categories.setReels(id, saveBody(next)));
  };
  const togglePin = (item) => (item.pinned ? change(unpin(shown, item.pageId), () => api.categories.unpin(id, { pageId: item.pageId })) : change(pin(shown, item.pageId), () => api.categories.pin(id, { pageId: item.pageId })));
  const removeReel = (item) => change(shown.filter((i) => i.pageId !== item.pageId), () => api.categories.removeReel(id, { pageId: item.pageId }));

  return (
    <Page testID="screen-reel-order" offline={offline}>
      <Text variant="page">{t('categories.reels.title')}</Text>
      {category.data ? <Text variant="small" testID="reel-order-category">{t('categories.reels.intro', { name: category.data.name, count: shown.length })}</Text> : null}
      {failure ? (
        <Banner tone="bad" testID="reel-order-failed" title={t('categories.reorderFailed')}>
          {failure.code === 'offline' ? t('offline.writeDisabled') : null}
        </Banner>
      ) : null}
      {failure && failure.code !== 'offline' ? <Refusal error={failure} testID="reel-order-error" /> : null}
      <Loadable query={sequence} empty={!shown.length} testID="reel-order" emptyTitle={t('categories.reels.empty')} emptyBody={t('categories.reels.emptyBody')}>
        <Card>
          {shown.map((item, i) => {
            const inPinned = i < pinned.length;
            const groupIndex = inPinned ? i : i - pinned.length;
            const groupCount = inPinned ? pinned.length : shown.length - pinned.length;
            const offset = inPinned ? 0 : pinned.length;
            const title = item.headline || item.slug;
            const window = item.startsAt || item.endsAt;
            return (
              <View key={item.pageId}>
                {i ? <Divider /> : null}
                {i === pinned.length && pinned.length ? <Text variant="caption" style={{ paddingTop: theme.space[2] }}>{t('categories.reels.rest')}</Text> : null}
                <SortableRow
                  testID={`reel-${item.pageId}`}
                  index={groupIndex}
                  count={groupCount}
                  // Within its own group only: crossing the line is pinning, which has its own button.
                  onMove={(from, to) => move(from + offset, to + offset)}
                  disabled={busy || !online}
                  labels={{ up: t('categories.moveUp', { name: title }), down: t('categories.moveDown', { name: title }) }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
                    <Text variant="caption" testID={`reel-${item.pageId}-position`} accessibilityLabel={t('categories.reels.position', { number: i + 1 })}>{String(i + 1)}</Text>
                    <Thumb uri={item.thumbnailUrl} size={40} label={title} />
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text variant="small" numberOfLines={1}>{title}</Text>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                        {item.pinned ? <Badge testID={`reel-${item.pageId}-pinned`} label={t('categories.reels.pinned')} tone="primary" /> : null}
                        {!item.live ? <Badge testID={`reel-${item.pageId}-hidden`} label={t(HIDDEN_KEYS[item.hiddenReason] ?? 'categories.hidden.inactive')} tone="warn" /> : null}
                        {item.joinedBy === 'rule' ? <Badge label={t('categories.reels.byRule')} /> : null}
                        {window ? <Badge label={t('categories.reels.window', { from: isoToDay(item.startsAt) || '…', to: isoToDay(item.endsAt) || '…' })} /> : null}
                      </View>
                    </View>
                  </View>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }}>
                    <Button testID={`reel-${item.pageId}-pin`} kind="quiet" label={t(item.pinned ? 'categories.reels.unpin' : 'categories.reels.pin')} disabled={busy || !online} onPress={() => togglePin(item)} />
                    <Button testID={`reel-${item.pageId}-schedule`} kind="quiet" label={t('categories.schedule.title')} disabled={busy || !online} onPress={() => setScheduling(item)} />
                    <Button testID={`reel-${item.pageId}-remove`} kind="quiet" label={t('categories.reels.remove')} disabled={busy || !online} onPress={() => removeReel(item)} />
                  </View>
                </SortableRow>
              </View>
            );
          })}
        </Card>
        <Text variant="caption">{t('categories.reels.everywhere')}</Text>
      </Loadable>
      <AddReel categoryId={id} have={new Set(shown.map((i) => i.pageId))} disabled={!online || busy} onAdded={reload} />
      <Rules categoryId={id} onApplied={() => queryClient.invalidateQueries({ queryKey: reelsKey(id) })} />
      {scheduling ? (
        <ScheduleSheet
          item={scheduling}
          categoryId={id}
          onClose={() => setScheduling(null)}
          onSaved={(answer) => {
            setScheduling(null);
            reload(answer);
          }}
        />
      ) : null}
    </Page>
  );
}
