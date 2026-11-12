import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { formatWhen, useReauth, useStrings } from '@bhava/app-core';
import { MANAGERS, OWNER_ONLY } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, Divider, Field, ListRow, Section, Text, Toggle } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { FileButton, Loadable, MoreButton, Page, Refusal, itemsOf, useCan, useConnection, usePaged } from '../products/kit.js';
import { DOWNLOAD_FORMATS, FIXED_DOWNLOADS, REPORT_FREQUENCIES, REPORT_KINDS } from '../products/limits.js';
import { formatDay, formatHour } from '../insights/figures.js';

export const REPORTS_KEY = ['reports'];
const RUN_TONES = { building: 'neutral', sent: 'good', failed: 'bad', skipped: 'neutral' };
const FILE_TONES = { queued: 'neutral', running: 'primary', ready: 'good', failed: 'bad', expired: 'neutral' };
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const isEmail = (v) => {
  const s = String(v ?? '').trim();
  const at = s.indexOf('@');
  return s.length <= 254 && !/\s/.test(s) && at > 0 && at === s.lastIndexOf('@') && s.indexOf('.', at + 2) > 0 && !s.endsWith('.');
};

/** Summary files (7.12): the fixed sheets, made on the server; explore, funnel and cohort files start from their own screens. */
function Downloads() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();
  const { online } = useConnection();
  const [source, setSource] = useState(FIXED_DOWNLOADS[0]);
  const [format, setFormat] = useState('csv');
  const list = usePaged([...REPORTS_KEY, 'downloads'], (page) => api.downloads.list({ limit: 10, ...page }), { refetchInterval: (q) => (itemsOf({ data: q.state.data }).some((d) => d.status === 'queued' || d.status === 'running') ? 5000 : false) });
  const create = useMutation({ mutationFn: () => api.downloads.create({ source, format }), onSuccess: () => queryClient.invalidateQueries({ queryKey: [...REPORTS_KEY, 'downloads'] }) });
  const files = itemsOf(list);
  return (
    <Section title={t('reports.downloads.title')}>
      <Card>
        <Choices testID="reports-download-source" label={t('reports.downloads.what')} value={source} onChange={setSource} options={FIXED_DOWNLOADS.map((s) => ({ value: s, label: t(`reports.source.${s}`) }))} />
        <Choices testID="reports-download-format" label={t('reports.downloads.format')} value={format} onChange={setFormat} options={DOWNLOAD_FORMATS.map((f) => ({ value: f, label: f === 'csv' ? 'CSV' : 'Excel' }))} />
        <Button testID="reports-download-create" kind="secondary" label={t('reports.downloads.make')} busy={create.isPending} disabled={!online} onPress={() => create.mutate()} />
        <Refusal error={create.error} testID="reports-download-error" />
        <Loadable query={list} empty={!files.length} testID="reports-downloads" emptyTitle={t('reports.downloads.none')}>
          {files.map((file, i) => (
            <View key={file.id} testID={`reports-download-${file.id}`} style={{ gap: 4 }}>
              {i ? <Divider /> : null}
              <View style={{ flexDirection: 'row', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                <Text variant="small">{t(`reports.source.${file.source}`)}</Text>
                <Badge label={t(`reports.file.${file.status}`)} tone={FILE_TONES[file.status] ?? 'neutral'} />
              </View>
              <Text variant="caption">{file.rowCount === null ? formatWhen(t, file.createdAt, { locale }) : t('reports.downloads.rows', { count: file.rowCount, when: formatWhen(t, file.createdAt, { locale }) })}</Text>
              {file.status === 'ready' ? <FileButton url={file.fileUrl} testID={`reports-download-${file.id}-open`} /> : null}
            </View>
          ))}
          <MoreButton query={list} testID="reports-downloads-more" />
        </Loadable>
      </Card>
    </Section>
  );
}

/**
 * Reports (PRD 7.9, 7.12): the weekly and monthly reports sent to the owner, whether they come, and summary files.
 * Every figure in them is from the server's summaries; nothing here names one visitor.
 */
export default function ReportsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const can = useCan();
  const { online, offline } = useConnection();
  const [kind, setKind] = useState('all');
  const prefs = useQuery({ queryKey: [...REPORTS_KEY, 'preferences'], queryFn: () => api.reports.preferences() });
  const setPrefs = useMutation({ mutationFn: (body) => api.reports.updatePreferences(body), onSuccess: (answer) => queryClient.setQueryData([...REPORTS_KEY, 'preferences'], answer) });
  const runs = usePaged([...REPORTS_KEY, 'runs', kind], (page) => api.reports.list({ kind, limit: 20, ...page }));
  const list = itemsOf(runs);
  const p = prefs.data;
  return (
    <Page testID="screen-reports" offline={offline}>
      <Text variant="page">{t('reports.title')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        {can(MANAGERS) ? <Button testID="reports-open-scheduled" kind="secondary" label={t('reports.scheduled.title')} onPress={() => navigation.navigate('reports.scheduled')} /> : null}
        {can(OWNER_ONLY) ? <Button testID="reports-open-keys" kind="quiet" label={t('reports.keys.title')} onPress={() => navigation.navigate('reports.keys')} /> : null}
      </View>
      <Loadable query={prefs} testID="reports-preferences">
        {p ? (
          <Card>
            <Toggle testID="reports-weekly" title={t('reports.prefs.weekly')} subtitle={t('reports.prefs.weeklyHint')} value={p.weekly} disabled={!online || setPrefs.isPending} onValueChange={(weekly) => setPrefs.mutate({ weekly })} />
            {p.monthlyAvailable ? (
              <Toggle testID="reports-monthly" title={t('reports.prefs.monthly')} subtitle={t('reports.prefs.monthlyHint')} value={p.monthly} disabled={!online || setPrefs.isPending} onValueChange={(monthly) => setPrefs.mutate({ monthly })} />
            ) : <Text variant="caption" testID="reports-monthly-unavailable">{t('reports.prefs.monthlyUnavailable')}</Text>}
            <Refusal error={setPrefs.error} testID="reports-preferences-error" />
          </Card>
        ) : null}
      </Loadable>
      <Section title={t('reports.sent')}>
        <Choices testID="reports-kind" label={t('reports.kindLabel')} value={kind} onChange={setKind} options={['all', ...REPORT_KINDS].map((k) => ({ value: k, label: t(`reports.kind.${k}`) }))} />
        <Loadable query={runs} empty={!list.length} testID="reports-runs" emptyTitle={t('reports.none')} emptyBody={t('reports.noneBody')}>
          <Card>
            {list.map((run, i) => (
              <View key={run.id}>
                {i ? <Divider /> : null}
                <ListRow
                  testID={`report-${run.id}`}
                  title={t(`reports.kind.${run.kind}`)}
                  subtitle={t('reports.period', { from: formatDay(run.periodStart), to: formatDay(run.periodEnd) })}
                  end={<Badge label={t(`reports.run.${run.status}`)} tone={RUN_TONES[run.status] ?? 'neutral'} />}
                  onPress={() => navigation.navigate('reports.detail', { id: String(run.id) })}
                />
              </View>
            ))}
          </Card>
          <MoreButton query={runs} testID="reports-runs-more" />
        </Loadable>
      </Section>
      <Downloads />
    </Page>
  );
}

/** One report as sent: its period, whether it went, and its file. The link a "Your weekly report" notice opens. */
export function ReportScreen({ route }) {
  const id = String(route?.params?.id ?? '');
  const { api } = useServices();
  const { t, locale } = useStrings();
  const { offline } = useConnection();
  const run = useQuery({ queryKey: [...REPORTS_KEY, 'run', id], queryFn: () => api.reports.get(id) });
  const data = run.data;
  return (
    <Page testID="screen-report" offline={offline}>
      <Text variant="page">{data ? t(`reports.kind.${data.kind}`) : t('reports.title')}</Text>
      <Loadable query={run} testID="report">
        {data ? (
          <Card>
            <Text variant="small" testID="report-period">{t('reports.period', { from: formatDay(data.periodStart), to: formatDay(data.periodEnd) })}</Text>
            <Badge testID="report-status" label={t(`reports.run.${data.status}`)} tone={RUN_TONES[data.status] ?? 'neutral'} />
            {data.sentAt ? <Text variant="caption">{t('reports.sentAt', { when: formatWhen(t, data.sentAt, { locale }) })}</Text> : null}
            {data.fileUrl ? <FileButton url={data.fileUrl} testID="report-open" /> : <Text variant="caption" testID="report-no-file">{t('reports.noFile')}</Text>}
          </Card>
        ) : null}
      </Loadable>
    </Page>
  );
}

/** Pure: a new schedule from the form: the saved view, how often, the hour, and the weekday or day of the month. */
export function scheduleBody({ viewId, frequency, hourOfDay, weekday, dayOfMonth, format }) {
  if (!viewId) return { error: 'reports.scheduled.pickView' };
  const body = { viewId: Number(viewId), frequency, hourOfDay: Number(hourOfDay), format };
  if (frequency === 'weekly') body.weekday = Number(weekday);
  if (frequency === 'monthly') {
    const day = Number(dayOfMonth);
    if (!Number.isInteger(day) || day < 1 || day > 28) return { error: 'reports.scheduled.dayBad' };
    body.dayOfMonth = day;
  }
  return { body };
}

/**
 * Scheduled reports (7.12): a saved view sent as a file on a schedule, to the team and, if the owner adds them, to
 * outside addresses. Managers set schedules; only the owner adds or removes an outside address.
 */
export function ScheduledReportsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();
  const can = useCan();
  const { online, offline } = useConnection();
  const schedules = usePaged([...REPORTS_KEY, 'scheduled'], (page) => api.scheduledReports.list({ limit: 20, ...page }));
  const views = useQuery({ queryKey: ['traffic', 'views', 'all'], queryFn: () => api.savedViews.list({ limit: 50 }) });
  const [form, setForm] = useState({ viewId: null, frequency: 'weekly', hourOfDay: 9, weekday: 1, dayOfMonth: '1', format: 'csv' });
  const [emails, setEmails] = useState({});
  const refresh = () => queryClient.invalidateQueries({ queryKey: [...REPORTS_KEY, 'scheduled'] });
  const create = useMutation({ mutationFn: (body) => api.scheduledReports.create(body), onSuccess: refresh });
  const update = useMutation({ mutationFn: ({ id, body }) => api.scheduledReports.update(id, body), onSuccess: refresh });
  const remove = useMutation({ mutationFn: (id) => api.scheduledReports.remove(id), onSuccess: refresh });
  const addRecipient = useMutation({ mutationFn: ({ id, email }) => api.scheduledReports.addRecipient(id, { email }), onSuccess: (_a, { id }) => { setEmails({ ...emails, [id]: '' }); refresh(); } });
  const removeRecipient = useMutation({ mutationFn: (id) => api.scheduledReports.removeRecipient(id), onSuccess: refresh });
  const read = scheduleBody(form);
  const list = itemsOf(schedules);
  const viewItems = views.data?.items ?? [];
  const owner = can(OWNER_ONLY);
  return (
    <Page testID="screen-reports-scheduled" offline={offline}>
      <Text variant="page">{t('reports.scheduled.title')}</Text>
      <Loadable query={schedules} empty={!list.length} testID="reports-scheduled" emptyTitle={t('reports.scheduled.none')}>
        {list.map((s) => (
          <Card key={s.id} testID={`schedule-${s.id}`}>
            <Text variant="title">{s.viewName}</Text>
            <Text variant="small">{t(`reports.frequency.${s.frequency}`, { hour: formatHour(s.hourOfDay), weekday: s.weekday === null ? '' : t(`reports.weekday.${WEEKDAYS[s.weekday]}`), day: s.dayOfMonth ?? '' })}</Text>
            <Text variant="caption">{t('reports.scheduled.next', { when: formatWhen(t, s.nextRunAt, { locale }) })}</Text>
            <Toggle testID={`schedule-${s.id}-enabled`} title={t('reports.scheduled.on')} value={s.enabled} disabled={!online || update.isPending} onValueChange={(enabled) => update.mutate({ id: s.id, body: { enabled } })} />
            <Text variant="meta">{t('reports.scheduled.recipients')}</Text>
            {s.recipients.map((r) => (
              <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <Text variant="small" style={{ flex: 1 }}>{r.email}</Text>
                {r.kind === 'outside' && owner ? <Button testID={`recipient-${r.id}-remove`} kind="quiet" label={t('products.remove')} disabled={!online} onPress={() => removeRecipient.mutate(r.id)} /> : <Badge label={t(`reports.recipient.${r.kind}`)} />}
              </View>
            ))}
            {owner ? (
              <View style={{ gap: 6 }}>
                <Field testID={`schedule-${s.id}-email`} label={t('reports.scheduled.addEmail')} value={emails[s.id] ?? ''} onChangeText={(v) => setEmails({ ...emails, [s.id]: v })} autoCapitalize="none" keyboardType="email-address" error={(emails[s.id] ?? '') && !isEmail(emails[s.id]) ? t('reports.scheduled.emailBad') : null} />
                <Button testID={`schedule-${s.id}-add`} kind="secondary" label={t('reports.scheduled.add')} disabled={!online || !isEmail(emails[s.id])} busy={addRecipient.isPending} onPress={() => addRecipient.mutate({ id: s.id, email: emails[s.id].trim() })} />
              </View>
            ) : null}
            <Button testID={`schedule-${s.id}-remove`} kind="danger" label={t('reports.scheduled.remove')} disabled={!online} onPress={() => remove.mutate(s.id)} />
          </Card>
        ))}
        <MoreButton query={schedules} testID="reports-scheduled-more" />
      </Loadable>
      <Refusal error={update.error ?? remove.error ?? addRecipient.error ?? removeRecipient.error} testID="reports-scheduled-error" />
      <Section title={t('reports.scheduled.new')}>
        <Card>
          {viewItems.length ? (
            <Choices testID="schedule-view" label={t('reports.scheduled.view')} value={form.viewId} onChange={(viewId) => setForm({ ...form, viewId })} options={viewItems.map((v) => ({ value: v.id, label: v.name }))} />
          ) : <Text variant="small" testID="schedule-no-views">{t('reports.scheduled.noViews')}</Text>}
          <Choices testID="schedule-frequency" label={t('reports.scheduled.how')} value={form.frequency} onChange={(frequency) => setForm({ ...form, frequency })} options={REPORT_FREQUENCIES.map((f) => ({ value: f, label: t(`reports.often.${f}`) }))} />
          <Choices testID="schedule-hour" label={t('reports.scheduled.hour')} value={form.hourOfDay} onChange={(hourOfDay) => setForm({ ...form, hourOfDay })} options={[7, 9, 12, 18, 21].map((h) => ({ value: h, label: formatHour(h) }))} />
          {form.frequency === 'weekly' ? <Choices testID="schedule-weekday" label={t('reports.scheduled.weekday')} value={form.weekday} onChange={(weekday) => setForm({ ...form, weekday })} options={WEEKDAYS.map((d, i) => ({ value: i, label: t(`reports.weekday.${d}`) }))} /> : null}
          {form.frequency === 'monthly' ? <Field testID="schedule-day" label={t('reports.scheduled.day')} hint={t('reports.scheduled.dayHint')} value={String(form.dayOfMonth)} onChangeText={(dayOfMonth) => setForm({ ...form, dayOfMonth })} keyboardType="number-pad" /> : null}
          <Choices testID="schedule-format" label={t('reports.downloads.format')} value={form.format} onChange={(format) => setForm({ ...form, format })} options={DOWNLOAD_FORMATS.map((f) => ({ value: f, label: f === 'csv' ? 'CSV' : 'Excel' }))} />
          {read.error && form.viewId ? <Text variant="caption" tone="bad">{t(read.error)}</Text> : null}
          <Refusal error={create.error} testID="schedule-create-error" />
          <Button testID="schedule-create" label={t('reports.scheduled.create')} busy={create.isPending} disabled={!online || Boolean(read.error)} onPress={() => create.mutate(read.body)} />
        </Card>
      </Section>
    </Page>
  );
}

/**
 * Reporting API keys (7.13): read-only keys for the business's own tools, owner only. Making or revoking one needs a
 * fresh sign-in check. A new key is shown once, here, and never again; it is not kept on the phone.
 */
export function ApiKeysScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const { runFresh } = useReauth();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const keys = usePaged([...REPORTS_KEY, 'keys'], (page) => api.apiKeys.list({ limit: 20, ...page }));
  const [name, setName] = useState('');
  const [shown, setShown] = useState(null);
  const [revoking, setRevoking] = useState(null);
  const create = useMutation({
    mutationFn: () => runFresh(() => api.apiKeys.create({ name: name.trim() })),
    onSuccess: (answer) => {
      setShown({ name: answer.name, key: answer.key });
      setName('');
      queryClient.invalidateQueries({ queryKey: [...REPORTS_KEY, 'keys'] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id) => runFresh(() => api.apiKeys.revoke(id)),
    onSuccess: () => {
      setRevoking(null);
      queryClient.invalidateQueries({ queryKey: [...REPORTS_KEY, 'keys'] });
    },
  });
  const list = itemsOf(keys);
  return (
    <Page testID="screen-api-keys" offline={offline}>
      <Text variant="page">{t('reports.keys.title')}</Text>
      <Text variant="small">{t('reports.keys.intro')}</Text>
      {shown ? (
        <Banner tone="warn" testID="api-key-shown" title={t('reports.keys.once', { name: shown.name })} action={<Button kind="secondary" label={t('common.done')} onPress={() => setShown(null)} />}>
          {shown.key}
        </Banner>
      ) : null}
      <Card>
        <Field testID="api-key-name" label={t('reports.keys.name')} value={name} onChangeText={setName} maxLength={60} />
        <Refusal error={create.error} testID="api-key-create-error" />
        <Button testID="api-key-create" label={t('reports.keys.create')} busy={create.isPending} disabled={!online || !name.trim()} onPress={() => create.mutate()} />
        {!online ? <Text variant="caption">{t('offline.writeDisabled')}</Text> : null}
      </Card>
      <Loadable query={keys} empty={!list.length} testID="api-keys" emptyTitle={t('reports.keys.none')}>
        <Card>
          {list.map((key, i) => (
            <View key={key.id}>
              {i ? <Divider /> : null}
              <ListRow
                testID={`api-key-${key.id}`}
                title={key.name}
                subtitle={`${key.prefix}… · ${key.lastUsedAt ? t('reports.keys.used', { when: formatWhen(t, key.lastUsedAt, { locale }) }) : t('reports.keys.unused')}`}
                end={key.revokedAt ? <Badge label={t('reports.keys.revoked')} /> : <Button testID={`api-key-${key.id}-revoke`} kind="quiet" label={t('reports.keys.revoke')} disabled={!online} onPress={() => setRevoking(key)} />}
              />
            </View>
          ))}
        </Card>
        <MoreButton query={keys} testID="api-keys-more" />
      </Loadable>
      <Refusal error={revoke.error} testID="api-key-revoke-error" />
      <ConfirmSheet testID="api-key-revoke-confirm" visible={Boolean(revoking)} title={revoking ? t('reports.keys.revokeTitle', { name: revoking.name }) : ''} confirmLabel={t('reports.keys.revoke')} cancelLabel={t('common.cancel')} onCancel={() => setRevoking(null)} onConfirm={() => revoke.mutate(revoking.id)} busy={revoke.isPending} disabled={!online}>
        {t('reports.keys.revokeBody')}
      </ConfirmSheet>
    </Page>
  );
}

/** "Stop these emails" from a report email, opened in the app: the token in the link says whose and which. */
export function UnsubscribeScreen({ route }) {
  const token = String(route?.params?.token ?? '');
  const { api } = useServices();
  const { t } = useStrings();
  const { online, offline } = useConnection();
  const [report, setReport] = useState('all');
  const stop = useMutation({ mutationFn: () => api.reports.unsubscribe({ token, report }) });
  return (
    <Page testID="screen-reports-unsubscribe" offline={offline}>
      <Text variant="page">{t('reports.unsubscribe.title')}</Text>
      <Choices testID="unsubscribe-which" label={t('reports.unsubscribe.which')} value={report} onChange={setReport} options={['weekly', 'monthly', 'all'].map((r) => ({ value: r, label: t(`reports.unsubscribe.${r}`) }))} />
      <Refusal error={stop.error} testID="unsubscribe-error" />
      {stop.data?.ok ? <Banner tone="good" testID="unsubscribe-done">{t('reports.unsubscribe.done')}</Banner> : null}
      {stop.data && !stop.data.ok ? <Banner tone="warn" testID="unsubscribe-not">{t('reports.unsubscribe.not')}</Banner> : null}
      <Button testID="unsubscribe-confirm" label={t('reports.unsubscribe.action')} busy={stop.isPending} disabled={!online || !token || Boolean(stop.data?.ok)} onPress={() => stop.mutate()} />
    </Page>
  );
}
