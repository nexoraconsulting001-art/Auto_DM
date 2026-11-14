import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { MANAGERS, OWNER_ONLY } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, Divider, ListRow, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { UpgradePrompt, usePlanError } from '../billing/UpgradePrompt.js';
import { ActionMessages, Offline, PagedList, formatWhenAt, useAction, useAllowed, usePaged } from '../orders/kit/ui.js';

export const FEED = ['team-feed'];
export const SERVICE_CODES = ['reel_management', 'reel_backlog', 'merchandising', 'catalog_management', 'performance_report'];
const FILTERS = ['all', 'draft', 'applied', 'approved', 'undone', 'rejected'];
const TONES = { draft: 'warn', applied: 'good', approved: 'good', rejected: 'neutral', undone: 'neutral' };

/** A short, plain look at a thing the team changed: its fields, secrets already masked by the server. */
export function describe(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return String(value).slice(0, 140);
  return Object.entries(value)
    .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v))
    .slice(0, 5)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 40)}`)
    .join(' · ');
}

/** What each of the team's changes did, with undo for what went live and approve or reject for what waits (PRD 5.17). */
export default function TeamFeedScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const allowed = useAllowed();
  const action = useAction([FEED]);
  const [filter, setFilter] = useState('all');
  const canManage = allowed(MANAGERS);
  const query = usePaged([...FEED, 'list', { filter }], (page) => api.teamFeed.list({ ...(filter === 'all' ? {} : { state: filter }), ...page }));
  const drafts = query.data?.pages?.[0]?.items?.filter((c) => c.state === 'draft').length ?? 0;
  const [planError, onError] = usePlanError();
  const run = (key, work, done) => { onError(null); return action.run(key, work, { done, reload: [FEED], onError }); };

  return (
    <Screen testID="screen-team-feed" title={t('team-feed.title')}>
      <Offline />
      <Text variant="small">{t('team-feed.intro')}</Text>
      <ActionMessages action={action} testID="team-feed-action" />
      <UpgradePrompt error={planError} />
      {drafts > 0 && filter === 'all' ? <Banner tone="warn" testID="team-feed-waiting">{t('team-feed.waiting', { count: drafts })}</Banner> : null}
      <Choices testID="team-feed-filter" label={t('team-feed.filter')} options={FILTERS.map((value) => ({ value, label: t(`team-feed.state.${value}`) }))} value={filter} onChange={setFilter} />
      <PagedList
        testID="team-feed-list"
        query={query}
        emptyTitle={t('team-feed.empty')}
        emptyBody={t('team-feed.emptyBody')}
        renderRow={(change) => (
          <View testID={`change-${change.id}`} style={{ gap: theme.space[1], paddingVertical: theme.space[2] }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
              <Text variant="body" style={{ flex: 1, fontFamily: theme.font.bodySemiBold }}>{t(`team-feed.service.${change.service}`)}</Text>
              <Badge testID={`change-${change.id}-state`} label={t(`team-feed.state.${change.state}`)} tone={TONES[change.state] ?? 'neutral'} />
            </View>
            <Text variant="small">{change.target}</Text>
            {change.taskRef ? <Text variant="meta">{t('team-feed.task', { ref: change.taskRef })}</Text> : null}
            {describe(change.before) ? <Text variant="meta">{t('team-feed.before', { value: describe(change.before) })}</Text> : null}
            {describe(change.after) ? <Text variant="meta">{t('team-feed.after', { value: describe(change.after) })}</Text> : null}
            <Text variant="meta">{formatWhenAt(change.createdAt, locale)}</Text>
            {canManage && change.state === 'draft' ? (
              <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
                <Button testID={`change-${change.id}-approve`} label={t('team-feed.approve')} disabled={!action.writable} busy={action.busy === `approve:${change.id}`} onPress={() => run(`approve:${change.id}`, () => api.teamFeed.approve(change.id), 'team-feed.done.approve')} />
                <Button testID={`change-${change.id}-reject`} kind="secondary" label={t('team-feed.reject')} disabled={!action.writable} busy={action.busy === `reject:${change.id}`} onPress={() => run(`reject:${change.id}`, () => api.teamFeed.reject(change.id), 'team-feed.done.reject')} />
              </View>
            ) : null}
            {canManage && change.canUndo && ['applied', 'approved'].includes(change.state) ? (
              <Button testID={`change-${change.id}-undo`} kind="secondary" label={t('team-feed.undo')} disabled={!action.writable} busy={action.busy === `undo:${change.id}`} onPress={() => run(`undo:${change.id}`, () => api.teamFeed.undo(change.id), 'team-feed.done.undo')} />
            ) : null}
            {['applied', 'approved'].includes(change.state) && !change.canUndo ? <Text variant="meta">{t('team-feed.cannotUndo')}</Text> : null}
          </View>
        )}
      />
      <ServiceModes />
    </Screen>
  );
}

/** How each of the team's services works in this business: live at once, or waiting for the owner's OK first. */
function ServiceModes() {
  const { api } = useServices();
  const { t } = useStrings();
  const allowed = useAllowed();
  const action = useAction([['services']]);
  const query = useQuery({ queryKey: ['services'], queryFn: () => api.services.settings() });
  const items = (query.data?.items ?? []).filter((s) => s.active || s.mode);
  if (!query.data || items.length === 0) return null;
  const owner = allowed(OWNER_ONLY);
  return (
    <Section title={t('team-feed.modes.title')}>
      <ActionMessages action={action} testID="team-feed-modes-action" />
      <Card testID="team-feed-modes">
        {items.map((s, i) => (
          <View key={`${s.service}:${s.scope}`}>
            {i > 0 ? <Divider /> : null}
            <ListRow title={t(`team-feed.service.${s.service}`)} subtitle={s.active ? t('team-feed.modes.active') : t('team-feed.modes.inactive')} />
            <Choices
              testID={`team-feed-mode-${s.service}`}
              label={t(`team-feed.service.${s.service}`)}
              disabled={!owner || !action.writable}
              value={s.mode}
              onChange={(mode) => action.run(`mode:${s.service}`, () => api.services.saveSettings({ service: s.service, mode }), { done: 'team-feed.done.mode', reload: [['services']] })}
              options={[{ value: 'direct', label: t('team-feed.modes.direct') }, { value: 'approve_first', label: t('team-feed.modes.approve_first') }]}
            />
          </View>
        ))}
        <Text variant="meta">{t('team-feed.modes.note')}</Text>
      </Card>
    </Section>
  );
}
