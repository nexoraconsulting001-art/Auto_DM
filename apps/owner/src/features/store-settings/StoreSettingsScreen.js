import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { matchPath, useStrings } from '@bhava/app-core';
import { OWNER_ONLY, staffWith } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, Divider, Field, ListRow, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink, useShellNav } from '../../shell/context.js';
import { ALERT_EVENTS, alertSettingsBody, alertSettingsForm, whatsappConnectBody } from '../orders/kit/forms.js';
import { formatPaise } from '../orders/kit/rules.js';
import { ActionMessages, Fact, KeyForm, ManyChoices, Offline, PagedList, RecordView, formatWhenAt, useAction, useAllowed, useForm, useProblem, usePaged, useWritable } from '../orders/kit/ui.js';

/** Every store setting, one tap away. A row shows only when this person may open the screen it leads to. */
const LINKS = Object.freeze([
  ['/payments', 'payments'],
  ['/shipping', 'shipping'],
  ['/invoices/settings', 'gst'],
  ['/returns/settings', 'returns'],
  ['/inventory', 'stock'],
  ['/loyalty/settings', 'loyalty'],
  ['/store-settings/messages', 'messages'],
  ['/privacy/policies', 'policies'],
  ['/privacy/notice', 'notice'],
  ['/shopify', 'shopify'],
]);

/** Store setup (PRD 9.5 to 9.22): the list of the store's settings. */
export default function StoreSettingsScreen() {
  const { t } = useStrings();
  const openLink = useOpenLink();
  const nav = useShellNav();
  const links = LINKS.filter(([path]) => !nav.screens.length || matchPath(path, nav.screens));
  return (
    <Screen testID="screen-store-settings" title={t('store-settings.title')}>
      <Offline />
      <Card>
        {links.map(([path, key], i) => (
          <View key={path}>
            {i > 0 ? <Divider /> : null}
            <ListRow testID={`store-link-${key}`} title={t(`store-settings.link.${key}`)} subtitle={t(`store-settings.link.${key}.meta`)} onPress={() => openLink(path)} />
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const ALERTS = ['store-settings', 'alerts'];
const WHATSAPP = ['store-settings', 'whatsapp'];
const TEMPLATES = ['store-settings', 'templates'];
const REMINDERS = ['store-settings', 'reminders'];
const FAILED = ['store-settings', 'failed'];

/**
 * Messages to shoppers (PRD 9.15, 9.16): order updates by WhatsApp and email only (there is no SMS), the business's own
 * WhatsApp number with its access token written once and never read back (P-17), the message templates, cart reminders,
 * and the order updates that didn't go.
 */
export function MessagesScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const allowed = useAllowed();
  const alerts = useQuery({ queryKey: ALERTS, queryFn: () => api.alertSettings.get() });
  return (
    <Screen testID="screen-messages" title={t('store-settings.messages')}>
      <Offline />
      <Section title={t('store-settings.updates')} testID="messages-updates">
        <RecordView query={alerts} testID="messages-alerts">
          {(data) => <AlertsForm key={JSON.stringify(data)} settings={data} />}
        </RecordView>
      </Section>
      <WhatsappPanel />
      <Reminders />
      {allowed(staffWith('orders')) ? <FailedUpdates /> : null}
    </Screen>
  );
}

function AlertsForm({ settings }) {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const form = useForm(alertSettingsForm(settings));
  const problem = useProblem(form.problems);
  const action = useAction([ALERTS]);
  const { values, set } = form;
  const domain = String(settings.emailFromAddress ?? '').split('@')[1] ?? '';

  async function save() {
    const built = alertSettingsBody(values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    await action.run('save', () => api.alertSettings.update(built.body), { done: 'store-settings.updatesSaved' });
  }

  return (
    <Card testID="messages-alerts-form">
      <Toggle testID="messages-whatsapp" title={t('store-settings.byWhatsapp')} value={values.whatsapp} onValueChange={set('whatsapp')} disabled={!settings.channels.includes('whatsapp')} subtitle={settings.channels.includes('whatsapp') ? undefined : t('store-settings.whatsappNotSet')} />
      <Toggle testID="messages-email" title={t('store-settings.byEmail')} value={values.email} onValueChange={set('email')} />
      <Text variant="title">{t('store-settings.when')}</Text>
      <ManyChoices testID="messages-events" value={values.events} onChange={set('events')} options={ALERT_EVENTS.map((value) => ({ value, label: t(`orders.alerts.event.${value}`) }))} />
      <Choices testID="messages-from" label={t('store-settings.from')} value={values.emailFrom} onChange={set('emailFrom')} options={[{ value: 'own', label: t('store-settings.from.own') }, { value: 'neutral', label: t('store-settings.from.neutral') }]} />
      <Field testID="messages-from-local" label={t('store-settings.fromLocal')} hint={domain ? t('store-settings.sentAs', { address: `${values.emailFromLocal || '…'}@${domain}` }) : undefined} value={values.emailFromLocal} onChangeText={set('emailFromLocal')} error={problem('emailFromLocal')} autoCapitalize="none" autoCorrect={false} maxLength={40} />
      <Field testID="messages-reply-to" label={t('store-settings.replyTo')} value={values.emailReplyTo} onChangeText={set('emailReplyTo')} error={problem('emailReplyTo')} keyboardType="email-address" autoCapitalize="none" maxLength={120} />
      <Text variant="meta">{t('store-settings.onceEach')}</Text>
      <View style={{ gap: 4 }}>
        <Text variant="small">{t('store-settings.cost')}</Text>
        {['utility', 'authentication', 'marketing'].map((kind) => <Fact key={kind} label={t(`store-settings.cost.${kind}`)} value={settings.whatsappCostPaise?.[kind] === null || settings.whatsappCostPaise?.[kind] === undefined ? t('store-settings.costUnknown') : formatPaise(settings.whatsappCostPaise[kind])} />)}
        <Text variant="meta">{t('store-settings.costNote')}</Text>
      </View>
      <ActionMessages action={action} testID="messages-alerts-action" />
      <Button testID="messages-save" label={t('store-settings.saveUpdates')} disabled={!writable} busy={action.busy === 'save'} onPress={() => { save(); }} />
    </Card>
  );
}

function WhatsappPanel() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const allowed = useAllowed();
  const writable = useWritable();
  const owner = allowed(OWNER_ONLY);
  const account = useQuery({ queryKey: WHATSAPP, queryFn: () => api.whatsappAccount.get() });
  const templates = useQuery({ queryKey: TEMPLATES, queryFn: () => api.whatsappTemplates.all() });
  const action = useAction([WHATSAPP, TEMPLATES, ALERTS]);
  const [disconnecting, setDisconnecting] = useState(false);
  const data = account.data;
  const connectForm = (
    <KeyForm
      testID="whatsapp-connect"
      fields={[
        { name: 'wabaId', label: t('store-settings.wabaId'), keyboardType: 'number-pad' },
        { name: 'phoneNumberId', label: t('store-settings.phoneNumberId'), keyboardType: 'number-pad' },
        { name: 'accessToken', label: t('store-settings.accessToken'), secret: true, saved: Boolean(data?.connected) },
        { name: 'displayNumber', label: t('store-settings.displayNumber'), keyboardType: 'phone-pad' },
      ]}
      build={whatsappConnectBody}
      save={(body) => api.whatsappAccount.connect(body)}
      submitLabel={t('store-settings.connectWhatsapp')}
      doneKey="store-settings.whatsappConnected"
      reload={[WHATSAPP, TEMPLATES, ALERTS]}
    />
  );
  return (
    <Section title={t('store-settings.whatsapp')} testID="messages-whatsapp-panel">
      <RecordView query={account} testID="whatsapp-account">
        {(acc) => (
          <Card>
            <ActionMessages action={action} testID="whatsapp-action" />
            {acc.connected ? (
              <>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <Text variant="body" style={{ flex: 1 }}>{acc.displayNumber || t('store-settings.connected')}</Text>
                  <Badge testID="whatsapp-status" tone={acc.status === 'active' ? 'good' : 'warn'} label={t(`store-settings.wa.${acc.status}`)} />
                </View>
                {acc.status === 'reconnect' && owner ? <Banner tone="warn">{t('store-settings.reconnectWhatsapp')}</Banner> : null}
                {acc.status === 'reconnect' && owner ? connectForm : null}
                {owner ? <Button testID="whatsapp-disconnect" kind="danger" label={t('store-settings.disconnect')} disabled={!writable} onPress={() => setDisconnecting(true)} /> : null}
              </>
            ) : owner ? (
              <>
                <Text variant="small">{t('store-settings.whatsappIntro')}</Text>
                {connectForm}
              </>
            ) : <Text variant="small" testID="whatsapp-owner-only">{t('store-settings.whatsappOwner')}</Text>}
          </Card>
        )}
      </RecordView>
      <Card testID="whatsapp-templates">
        <Text variant="title">{t('store-settings.templates')}</Text>
        <Text variant="small">{t('store-settings.templatesIntro')}</Text>
        {(templates.data?.items ?? []).map((template) => (
          <ListRow key={template.id} testID={`template-${template.id}`} title={template.name} subtitle={[t(`store-settings.category.${template.category}`), template.language, template.checkedAt ? formatWhenAt(template.checkedAt, locale) : null].filter(Boolean).join(' · ')} end={<Badge tone={template.status === 'approved' ? 'good' : template.status === 'rejected' ? 'bad' : 'warn'} label={t(`store-settings.template.${template.status}`)} />} />
        ))}
        {templates.data && !templates.data.items?.length ? <Text variant="small">{t('store-settings.templatesNone')}</Text> : null}
        <Button testID="whatsapp-templates-sync" kind="secondary" label={t('store-settings.templatesSync')} disabled={!writable || !data?.connected} busy={action.busy === 'sync'} onPress={() => action.run('sync', () => api.whatsappTemplates.sync(), { done: 'store-settings.templatesSynced' })} />
      </Card>
      <ConfirmSheet testID="whatsapp-disconnect-confirm" visible={disconnecting} title={t('store-settings.disconnectTitle')} confirmLabel={t('store-settings.disconnect')} cancelLabel={t('store-settings.keep')} busy={action.busy === 'disconnect'} disabled={!writable} onCancel={() => setDisconnecting(false)}
        onConfirm={async () => {
          await action.run('disconnect', () => api.whatsappAccount.disconnect(), { fresh: true, done: 'store-settings.disconnected' });
          setDisconnecting(false);
        }}
      >
        {t('store-settings.disconnectBody')}
      </ConfirmSheet>
    </Section>
  );
}

function Reminders() {
  const { api } = useServices();
  const { t } = useStrings();
  const allowed = useAllowed();
  const writable = useWritable();
  const reminders = useQuery({ queryKey: REMINDERS, queryFn: () => api.cartReminders.get() });
  const stats = useQuery({ queryKey: [...REMINDERS, 'stats'], queryFn: () => api.cartReminders.stats({ days: 30 }), enabled: allowed(staffWith('analytics')) });
  const action = useAction([REMINDERS]);
  if (!reminders.data) return null;
  const data = reminders.data;
  return (
    <Section title={t('store-settings.reminders')} testID="messages-reminders">
      <Card>
        <Toggle testID="reminders-enabled" title={t('store-settings.remindersOn')} subtitle={t('store-settings.remindersHint')} value={data.enabled} disabled={!writable || Boolean(action.busy)} onValueChange={(on) => action.run('reminders', () => api.cartReminders.update({ enabled: on }), { done: on ? 'store-settings.remindersStarted' : 'store-settings.remindersStopped' })} />
        {data.channels.includes('whatsapp') && data.templateStatus !== 'approved' ? <Banner tone="warn" testID="reminders-template">{t('store-settings.remindersTemplate', { status: t(`store-settings.template.${data.templateStatus === 'none' ? 'pending' : data.templateStatus}`) })}</Banner> : null}
        <ActionMessages action={action} testID="reminders-action" />
        {stats.data ? (
          <View testID="reminders-stats" style={{ gap: 4 }}>
            <Text variant="small">{t('store-settings.remindersLast', { days: stats.data.days })}</Text>
            <Fact label={t('store-settings.sent')} value={String(stats.data.sent)} />
            <Fact label={t('store-settings.clicked')} value={String(stats.data.clicked)} />
            <Fact label={t('store-settings.ordered')} value={String(stats.data.ordered)} />
            <Fact label={t('store-settings.revenue')} value={formatPaise(stats.data.revenuePaise)} />
          </View>
        ) : null}
      </Card>
    </Section>
  );
}

/** Order updates that didn't go, with a retry. Each is about one of this business's orders. */
function FailedUpdates() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const openLink = useOpenLink();
  const writable = useWritable();
  const query = usePaged(FAILED, (page) => api.orderAlerts.list({ status: 'failed', ...page }));
  const action = useAction([FAILED]);
  return (
    <Section title={t('store-settings.failed')} testID="messages-failed">
      <ActionMessages action={action} testID="messages-failed-action" />
      <PagedList
        testID="failed-updates"
        query={query}
        emptyTitle={t('store-settings.failedNone')}
        renderRow={(alert) => (
          <ListRow
            testID={`failed-${alert.id}`}
            title={`${alert.orderNumber} · ${t(`orders.alerts.event.${alert.event}`)} · ${t(`orders.alerts.channel.${alert.channel}`)}`}
            subtitle={formatWhenAt(alert.createdAt, locale)}
            onPress={() => openLink(`/orders/${alert.orderId}`)}
            end={<Button kind="quiet" testID={`failed-${alert.id}-retry`} label={t('common.retry')} disabled={!writable} busy={action.busy === `retry:${alert.id}`} onPress={() => action.run(`retry:${alert.id}`, () => api.orderAlerts.retry(alert.id), { done: 'orders.alerts.retried' })} />}
          />
        )}
      />
    </Section>
  );
}
