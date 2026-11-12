import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { formatWhen, useStrings } from '@bhava/app-core';
import { MANAGERS } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, Divider, Field, ListRow, Section, Text, Toggle } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { FileButton, Loadable, MoreButton, Page, Refusal, itemsOf, useCan, useConnection, usePaged } from '../products/kit.js';
import { CONSENT_CHANNELS, LEAD_SOURCES, LEAD_SURFACES } from '../products/limits.js';

export const LEADS_KEY = ['leads'];
const live = (lead) => (lead.consents ?? []).filter((c) => !c.withdrawnAt);
const DOWNLOAD_TONES = { queued: 'neutral', ready: 'good', failed: 'bad', expired: 'neutral' };

/** Lead files (8.15): a CSV or Excel file of this business's leads, made in the background; every one is in the audit log. */
function Downloads() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();
  const { online } = useConnection();
  const [format, setFormat] = useState('xlsx');
  const list = usePaged([...LEADS_KEY, 'downloads'], (page) => api.leadDownloads.list({ limit: 10, ...page }), { refetchInterval: (q) => (itemsOf({ data: q.state.data }).some((d) => d.status === 'queued') ? 5000 : false) });
  const create = useMutation({ mutationFn: () => api.leadDownloads.create({ format }), onSuccess: () => queryClient.invalidateQueries({ queryKey: [...LEADS_KEY, 'downloads'] }) });
  const files = itemsOf(list);
  return (
    <Section title={t('leads.downloads.title')}>
      <Card>
        <Text variant="small">{t('leads.downloads.intro')}</Text>
        <Choices testID="leads-download-format" label={t('leads.downloads.format')} value={format} onChange={setFormat} options={[{ value: 'xlsx', label: 'Excel' }, { value: 'csv', label: 'CSV' }]} />
        <Button testID="leads-download-create" kind="secondary" label={t('leads.downloads.make')} busy={create.isPending} disabled={!online} onPress={() => create.mutate()} />
        <Refusal error={create.error} testID="leads-download-error" />
        <Loadable query={list} empty={!files.length} testID="leads-downloads" emptyTitle={t('leads.downloads.none')}>
          {files.map((file, i) => (
            <View key={file.id} testID={`leads-download-${file.id}`} style={{ gap: 4 }}>
              {i ? <Divider /> : null}
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Badge label={t(`leads.downloads.status.${file.status}`)} tone={DOWNLOAD_TONES[file.status] ?? 'neutral'} />
                <Text variant="caption">{t('leads.downloads.rows', { count: file.rowCount, when: formatWhen(t, file.createdAt, { locale }) })}</Text>
              </View>
              {file.status === 'ready' ? <FileButton url={file.fileUrl} testID={`leads-download-${file.id}-open`} /> : null}
            </View>
          ))}
          <MoreButton query={list} testID="leads-downloads-more" />
        </Loadable>
      </Card>
    </Section>
  );
}

/**
 * Leads (PRD 8.15): the people who signed up on a landing page, the creator page or the store, with what they agreed
 * to be contacted on. Only this business's leads; none can be imported from elsewhere. Contact details are not kept on
 * the phone for offline use.
 */
export default function LeadsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const navigation = useNavigation();
  const can = useCan();
  const { offline } = useConnection();
  const [source, setSource] = useState('all');
  const [consent, setConsent] = useState('all');
  const list = usePaged([...LEADS_KEY, 'list', source, consent], (page) => api.leads.list({ source, consent, limit: 30, ...page }), { meta: { offline: false } });
  const leads = itemsOf(list);
  return (
    <Page testID="screen-leads" offline={offline}>
      <Text variant="page">{t('leads.title')}</Text>
      {can(MANAGERS) ? <Button testID="leads-open-form" kind="secondary" label={t('leads.form.title')} onPress={() => navigation.navigate('leads.form')} /> : null}
      <Choices testID="leads-source" label={t('leads.sourceLabel')} value={source} onChange={setSource} options={['all', ...LEAD_SOURCES].map((s) => ({ value: s, label: t(`leads.source.${s}`) }))} />
      <Choices testID="leads-consent" label={t('leads.consentLabel')} value={consent} onChange={setConsent} options={['all', 'active', 'withdrawn'].map((c) => ({ value: c, label: t(`leads.consent.${c}`) }))} />
      <Loadable query={list} empty={!leads.length} testID="leads-list" emptyTitle={t('leads.empty')} emptyBody={t('leads.emptyBody')}>
        <Card>
          {leads.map((lead, i) => (
            <View key={lead.id}>
              {i ? <Divider /> : null}
              <ListRow
                testID={`lead-${lead.id}`}
                title={lead.firstName || t('leads.noName')}
                subtitle={`${t(`leads.source.${lead.source}`)} · ${formatWhen(t, lead.createdAt, { locale })}`}
                end={live(lead).length ? <Badge label={t('leads.channels', { count: live(lead).length })} tone="good" /> : <Badge label={t('leads.withdrawn')} />}
                onPress={() => navigation.navigate('leads.detail', { id: String(lead.id) })}
              />
            </View>
          ))}
        </Card>
        <MoreButton query={list} testID="leads-more" />
      </Loadable>
      {can(MANAGERS) ? <Downloads /> : null}
    </Page>
  );
}

/** One lead: how to reach them, what they agreed to and when, recording a withdrawal, and deleting them (managers). */
export function LeadScreen({ route }) {
  const id = String(route?.params?.id ?? '');
  const { api } = useServices();
  const { t, locale } = useStrings();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const can = useCan();
  const { online, offline } = useConnection();
  const lead = useQuery({ queryKey: [...LEADS_KEY, 'one', id], queryFn: () => api.leads.get(id), meta: { offline: false } });
  const [confirm, setConfirm] = useState(null); // 'revoke' | 'remove'
  const revoke = useMutation({
    mutationFn: (channels) => api.leads.revokeConsent(id, channels ? { channels } : {}),
    onSuccess: (answer) => {
      setConfirm(null);
      queryClient.setQueryData([...LEADS_KEY, 'one', id], answer);
      queryClient.invalidateQueries({ queryKey: [...LEADS_KEY, 'list'] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.leads.remove(id),
    onSuccess: () => {
      setConfirm(null);
      queryClient.removeQueries({ queryKey: [...LEADS_KEY, 'one', id] });
      queryClient.invalidateQueries({ queryKey: [...LEADS_KEY, 'list'] });
      navigation.goBack();
    },
  });
  const data = lead.data;
  return (
    <Page testID="screen-lead" offline={offline}>
      <Text variant="page">{data?.firstName || t('leads.one')}</Text>
      <Loadable query={lead} testID="lead">
        {data ? (
          <>
            <Card>
              {data.phone ? <Text variant="small" testID="lead-phone" selectable>{data.phone}</Text> : null}
              {data.email ? <Text variant="small" testID="lead-email" selectable>{data.email}</Text> : null}
              <Text variant="caption">{t('leads.from', { source: t(`leads.source.${data.source}`), when: formatWhen(t, data.createdAt, { locale }) })}</Text>
              {data.utmCampaign ? <Text variant="caption">{t('leads.campaign', { name: data.utmCampaign })}</Text> : null}
            </Card>
            <Section title={t('leads.consents', { version: data.consentVersion })}>
              <Card>
                {data.consents.map((c) => (
                  <View key={c.channel} testID={`lead-consent-${c.channel}`} style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <Text variant="small">{t(`leads.channel.${c.channel}`)}</Text>
                    <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center' }}>
                      <Badge label={c.withdrawnAt ? t('leads.withdrawnOn', { when: formatWhen(t, c.withdrawnAt, { locale }) }) : t('leads.agreed')} tone={c.withdrawnAt ? 'neutral' : 'good'} />
                      {!c.withdrawnAt ? <Button testID={`lead-consent-${c.channel}-revoke`} kind="quiet" label={t('leads.stop')} disabled={!online || revoke.isPending} onPress={() => revoke.mutate([c.channel])} /> : null}
                    </View>
                  </View>
                ))}
                {live(data).length ? <Button testID="lead-revoke-all" kind="secondary" label={t('leads.stopAll')} disabled={!online} onPress={() => setConfirm('revoke')} /> : <Text variant="caption" testID="lead-all-withdrawn">{t('leads.allWithdrawn')}</Text>}
                <Refusal error={revoke.error} testID="lead-revoke-error" />
              </Card>
            </Section>
            {can(MANAGERS) ? <Button testID="lead-remove" kind="danger" label={t('leads.remove')} disabled={!online} onPress={() => setConfirm('remove')} /> : null}
            <Refusal error={remove.error} testID="lead-remove-error" />
            {!online ? <Text variant="caption">{t('offline.writeDisabled')}</Text> : null}
            <ConfirmSheet
              testID="lead-confirm"
              visible={Boolean(confirm)}
              title={t(confirm === 'remove' ? 'leads.removeConfirm.title' : 'leads.stopConfirm.title')}
              confirmLabel={t(confirm === 'remove' ? 'leads.removeConfirm.action' : 'leads.stopConfirm.action')}
              cancelLabel={t('common.cancel')}
              onCancel={() => setConfirm(null)}
              onConfirm={() => (confirm === 'remove' ? remove.mutate() : revoke.mutate(null))}
              busy={remove.isPending || revoke.isPending}
              disabled={!online}
            >
              {t(confirm === 'remove' ? 'leads.removeConfirm.body' : 'leads.stopConfirm.body')}
            </ConfirmSheet>
          </>
        ) : null}
      </Loadable>
    </Page>
  );
}

/**
 * The sign-up form (8.15): where it shows, the line that offers something for signing up, and the ways people can agree
 * to be contacted. A new set of ways makes a new numbered consent wording; leads keep the one they agreed to.
 */
export function LeadFormScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const forms = useQuery({ queryKey: [...LEADS_KEY, 'forms'], queryFn: () => api.leadForms.get() });
  const [lines, setLines] = useState({});
  const [channels, setChannels] = useState(null);
  const done = (answer) => queryClient.setQueryData([...LEADS_KEY, 'forms'], answer);
  const update = useMutation({ mutationFn: (body) => api.leadForms.update(body), onSuccess: done });
  const consent = useMutation({ mutationFn: (list) => api.leadForms.setConsent({ channels: list }), onSuccess: (answer) => { done(answer); setChannels(null); } });
  const data = forms.data;
  useEffect(() => setLines({}), [data?.items?.length]);
  const current = channels ?? data?.consent?.channels ?? [];
  return (
    <Page testID="screen-lead-form" offline={offline}>
      <Text variant="page">{t('leads.form.title')}</Text>
      <Loadable query={forms} testID="lead-form">
        {data ? (
          <>
            {!data.available ? <Banner tone="warn" testID="lead-form-unavailable" title={t('leads.form.unavailable')}>{t('leads.form.unavailableBody')}</Banner> : null}
            {LEAD_SURFACES.map((surface) => {
              const item = data.items.find((i) => i.surface === surface) ?? { surface, enabled: false, offerLine: '' };
              const line = lines[surface] ?? item.offerLine;
              return (
                <Card key={surface} testID={`lead-form-${surface}`}>
                  <Toggle testID={`lead-form-${surface}-enabled`} title={t(`leads.surface.${surface}`)} value={item.enabled} disabled={!online || !data.available || update.isPending} onValueChange={(enabled) => update.mutate({ surface, enabled })} />
                  <Field testID={`lead-form-${surface}-offer`} label={t('leads.form.offer')} hint={t('leads.form.offerHint')} value={line} onChangeText={(v) => setLines({ ...lines, [surface]: v })} maxLength={160} editable={data.available} />
                  {lines[surface] !== undefined && lines[surface] !== item.offerLine ? <Button testID={`lead-form-${surface}-save`} kind="secondary" label={t('common.save')} disabled={!online} busy={update.isPending} onPress={() => update.mutate({ surface, offerLine: line.trim() })} /> : null}
                </Card>
              );
            })}
            <Section title={t('leads.form.consent')}>
              <Card>
                {data.consent ? <Text variant="small" testID="lead-form-consent-text">{t('leads.form.version', { version: data.consent.version, body: data.consent.body })}</Text> : null}
                {CONSENT_CHANNELS.map((c) => (
                  <Toggle key={c} testID={`lead-form-channel-${c}`} title={t(`leads.channel.${c}`)} value={current.includes(c)} disabled={!data.available} onValueChange={(on) => setChannels(on ? [...current, c] : current.filter((x) => x !== c))} />
                ))}
                {channels && !channels.length ? <Text variant="caption" tone="bad">{t('leads.form.pickOne')}</Text> : null}
                {channels ? <Button testID="lead-form-consent-save" label={t('leads.form.newVersion')} disabled={!online || !channels.length} busy={consent.isPending} onPress={() => consent.mutate(channels)} /> : null}
                <Refusal error={consent.error} testID="lead-form-consent-error" />
              </Card>
            </Section>
            <Refusal error={update.error} testID="lead-form-error" />
            {!online ? <Text variant="caption">{t('offline.writeDisabled')}</Text> : null}
          </>
        ) : null}
      </Loadable>
    </Page>
  );
}
