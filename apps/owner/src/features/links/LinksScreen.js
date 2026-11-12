import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, Divider, Field, ListRow, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { PagedState, Refusal, usePaged, useWritable } from '../compliance/kit.js';
import { describeReason } from '../compliance/reasons.js';

export const TAPS_KEY = ['links', 'taps'];
export const TRACKING_KEY = ['links', 'tracking'];
export const MEASUREMENT_KINDS = Object.freeze(['amazon_tag', 'affiliate_sub_id', 'discount_code']);

/** A whole web address, as the checker needs it. Pure. */
export const isFullLink = (text) => /^https?:\/\/\S+$/i.test(String(text ?? '').trim());

/**
 * The checker: the exact address a shopper will open, with its tags (links.preview), and whether it opens right now
 * (links.check). It is always the address itself: a DM link is never a redirect or a short link of ours (PRD 4.11).
 */
function Checker({ writable }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const [url, setUrl] = useState('');
  const [problem, setProblem] = useState('');
  const preview = useMutation({ mutationFn: (link) => api.links.preview({ url: link }) });
  const check = useMutation({ mutationFn: (link) => api.links.check({ url: link }) });
  function run() {
    const link = url.trim();
    if (!isFullLink(link)) {
      setProblem(t('links.fullLink'));
      return;
    }
    setProblem('');
    preview.mutate(link);
    check.mutate(link);
  }
  const shown = preview.data;
  return (
    <Section title={t('links.checkTitle')}>
      <Card>
        <Text variant="small">{t('links.checkIntro')}</Text>
        <Field testID="links-url" label={t('links.url')} value={url} onChangeText={setUrl} placeholder="https://" autoCapitalize="none" autoCorrect={false} keyboardType="url" error={problem || undefined} editable={writable} />
        <Button testID="links-run" label={t('links.run')} busy={preview.isPending || check.isPending} disabled={!writable || !url.trim()} onPress={run} />
        <Refusal error={preview.error ?? check.error} testID="links-refusal" />
        {shown ? (
          <View testID="links-preview" style={{ gap: theme.space[1] }}>
            <Text variant="meta">{t('links.peopleOpen')}</Text>
            <Text variant="body" selectable testID="links-final-url">{shown.finalUrl}</Text>
            {shown.allowed ? <Badge testID="links-allowed" label={t('links.allowed')} tone="good" /> : (
              <Banner testID="links-not-allowed" tone="bad" title={t('links.notAllowed')}>
                {`${describeReason(t, shown.reason) || t('links.notAllowedBody')}${shown.reason ? `\n${shown.reason}` : ''}`}
              </Banner>
            )}
            {shown.warnings.map((warning) => <Banner key={warning.code} tone="warn">{warning.message}</Banner>)}
          </View>
        ) : null}
        {check.data ? (
          check.data.ok
            ? <Badge testID="links-opens" label={t('links.opens')} tone="good" />
            : <Banner testID="links-broken" tone="warn" title={t('links.broken')}>{`${describeReason(t, check.data.reason) || t('links.brokenBody')}${check.data.httpStatus ? ` (${check.data.httpStatus})` : ''}`}</Banner>
        ) : null}
      </Card>
    </Section>
  );
}

/** Taps per automation: people counts each person once per reel, taps counts every tap (PRD 6.13). */
function Taps() {
  const { api } = useServices();
  const { t } = useStrings();
  const openLink = useOpenLink();
  const taps = usePaged(TAPS_KEY, (query) => api.links.taps(query), { limit: 30 });
  return (
    <Section title={t('links.tapsTitle')}>
      <Card>
        <PagedState query={taps} testID="links-taps" emptyTitle={t('links.tapsEmpty')} emptyBody={t('links.tapsEmptyBody')}>
          {taps.items.map((row, i) => (
            <View key={`${row.automationId}-${row.channel}-${row.mediaId}`}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                testID={`tap-${row.automationId}-${row.mediaId || 'all'}`}
                title={t('links.tapsRow', { id: row.automationId })}
                subtitle={t('links.tapsLine', { people: row.people, taps: row.taps, channel: t(row.channel === 'facebook' ? 'links.facebook' : 'links.instagram') })}
                onPress={() => openLink(`/automations/${row.automationId}`)}
              />
            </View>
          ))}
        </PagedState>
      </Card>
    </Section>
  );
}

function TrackingRow({ row, writable, onSave, onRemove, saving }) {
  const { t } = useStrings();
  const theme = useTheme();
  const [value, setValue] = useState(row.value);
  return (
    <View testID={`tracking-${row.id}`} style={{ gap: theme.space[2], paddingVertical: theme.space[2] }}>
      <Text variant="meta">{`${t(`links.kind.${row.kind}`)} · ${t('links.post', { id: row.mediaId })}`}</Text>
      <Field testID={`tracking-${row.id}-value`} label={t(`links.kind.${row.kind}`)} value={value} onChangeText={setValue} maxLength={120} autoCapitalize="none" editable={writable} />
      <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
        <Button testID={`tracking-${row.id}-save`} kind="secondary" label={t('common.save')} busy={saving} disabled={!writable || !value.trim() || value.trim() === row.value} onPress={() => onSave(row, value.trim())} />
        <Button testID={`tracking-${row.id}-remove`} kind="danger" label={t('links.remove')} disabled={!writable} onPress={() => onRemove(row)} />
      </View>
    </View>
  );
}

/** Per-reel tracking ids: Amazon tags, affiliate sub ids and discount codes, so earnings and orders split by reel (PRD 6.6). */
function Tracking({ writable }) {
  const { api } = useServices();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const [mediaId, setMediaId] = useState('');
  const [kind, setKind] = useState(MEASUREMENT_KINDS[0]);
  const [value, setValue] = useState('');
  const [removing, setRemoving] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const rows = usePaged(TRACKING_KEY, (query) => api.measurementIds.list(query), { limit: 50 });
  const refresh = () => queryClient.invalidateQueries({ queryKey: TRACKING_KEY });
  const create = useMutation({
    mutationFn: () => api.measurementIds.create({ mediaId: mediaId.trim(), kind, value: value.trim() }),
    onSuccess: async (saved) => { setWarnings(saved?.warnings ?? []); setValue(''); setMediaId(''); await refresh(); },
  });
  const update = useMutation({ mutationFn: ({ row, next }) => api.measurementIds.update(row.id, { value: next }), onSuccess: async (saved) => { setWarnings(saved?.warnings ?? []); await refresh(); } });
  const remove = useMutation({ mutationFn: (row) => api.measurementIds.remove(row.id), onSuccess: async () => { setRemoving(null); await refresh(); } });
  return (
    <Section title={t('links.trackingTitle')}>
      <Text variant="small">{t('links.trackingIntro')}</Text>
      <Refusal error={create.error ?? update.error ?? remove.error} testID="tracking-refusal" />
      {warnings.map((warning) => <Banner key={warning.code} tone="warn" testID={`tracking-warning-${warning.code}`}>{warning.message}</Banner>)}
      <Card>
        <PagedState query={rows} testID="tracking" emptyTitle={t('links.trackingEmpty')}>
          {rows.items.map((row, i) => (
            <View key={row.id}>
              {i > 0 ? <Divider /> : null}
              <TrackingRow row={row} writable={writable} saving={update.isPending && update.variables?.row.id === row.id} onSave={(r, next) => update.mutate({ row: r, next })} onRemove={setRemoving} />
            </View>
          ))}
        </PagedState>
      </Card>
      <Card>
        <Text variant="title">{t('links.trackingAdd')}</Text>
        <Field testID="tracking-media" label={t('links.mediaId')} hint={t('links.mediaIdHint')} value={mediaId} onChangeText={setMediaId} keyboardType="number-pad" maxLength={80} editable={writable} />
        <Choices testID="tracking-kind" label={t('links.kindLabel')} value={kind} onChange={setKind} options={MEASUREMENT_KINDS.map((code) => ({ value: code, label: t(`links.kind.${code}`) }))} disabled={!writable} />
        <Field testID="tracking-value" label={t(`links.kind.${kind}`)} value={value} onChangeText={setValue} maxLength={120} autoCapitalize="none" editable={writable} />
        <Button testID="tracking-add" kind="secondary" label={t('links.trackingSave')} busy={create.isPending} disabled={!writable || !mediaId.trim() || !value.trim()} onPress={() => create.mutate()} />
      </Card>
      <ConfirmSheet
        testID="tracking-remove-confirm"
        visible={Boolean(removing)}
        title={t('links.removeTitle')}
        confirmLabel={t('links.remove')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setRemoving(null)}
        onConfirm={() => remove.mutate(removing)}
        busy={remove.isPending}
        disabled={!writable}
      >
        {t('links.removeBody')}
      </ConfirmSheet>
    </Section>
  );
}

/** Links: check a link before it goes in a DM, see the taps each automation's links got, and keep per-reel tracking ids. */
export default function LinksScreen() {
  const { t } = useStrings();
  const writable = useWritable();
  return (
    <Screen testID="screen-links" title={t('links.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('links.intro')}</Text>
      <Checker writable={writable} />
      <Taps />
      <Tracking writable={writable} />
    </Screen>
  );
}
