import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { matchPath, useStrings } from '@bhava/app-core';
import { OWNER_ONLY } from '@bhava/app-core/access';
import { Badge, Button, Card, ConfirmSheet, Divider, Field, ListRow, Screen, Section, Sheet, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink, useShellNav } from '../../shell/context.js';
import { storeSettingsBody, storeSettingsForm } from '../orders/kit/forms.js';
import { ActionMessages, CopyLine, Fact, Offline, PagedList, RecordView, RupeeField, formatWhenAt, useAction, useAllowed, useForm, useProblem, usePaged, useWritable } from '../orders/kit/ui.js';

const SETTINGS = ['settings', 'store'];
/** Settings of the person and this phone, kept by other features; a row shows only when its screen can be opened. */
const MORE = Object.freeze([['/settings/account', 'account'], ['/settings/devices', 'devices'], ['/notifications/settings', 'notifications'], ['/team', 'team'], ['/settings/api-keys', 'apiKeys'], ['/audit-log', 'audit']]);

/**
 * General settings (PRD 10.4): the store's name and words, delivery fees, support contacts, how the Instagram
 * connection stands, and the way to the rest of the settings.
 */
export default function SettingsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const openLink = useOpenLink();
  const nav = useShellNav();
  const allowed = useAllowed();
  const settings = useQuery({ queryKey: SETTINGS, queryFn: () => api.settings.get() });
  // API keys share this feature, but only the owner may list them.
  const links = MORE.filter(([path, key]) => (!nav.screens.length || matchPath(path, nav.screens)) && (key !== 'apiKeys' || allowed(OWNER_ONLY)));
  return (
    <Screen testID="screen-settings" title={t('settings.title')}>
      <Offline />
      {links.length ? (
        <Card>
          {links.map(([path, key], i) => (
            <View key={path}>
              {i > 0 ? <Divider /> : null}
              <ListRow testID={`settings-link-${key}`} title={t(`settings.link.${key}`)} onPress={() => openLink(path)} />
            </View>
          ))}
        </Card>
      ) : null}
      <Setup />
      <RecordView query={settings} testID="settings-store">
        {(data) => <StoreForm key={JSON.stringify(data)} settings={data} />}
      </RecordView>
    </Screen>
  );
}

function Setup() {
  const { api } = useServices();
  const { t } = useStrings();
  const setup = useQuery({ queryKey: ['settings', 'setup'], queryFn: () => api.settings.setup() });
  if (!setup.data) return null;
  const { instagram, storeUrl, testMode } = setup.data;
  return (
    <Section title={t('settings.instagram')} testID="settings-setup">
      <Card>
        <Fact label={t('settings.account')} value={instagram?.connected ? `@${instagram.username}` : t('settings.notConnected')} />
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text variant="small" style={{ flex: 1 }}>{t('settings.sending')}</Text>
          <Badge testID="settings-test-mode" tone={testMode ? 'warn' : 'good'} label={t(testMode ? 'settings.testMode' : 'settings.live')} />
        </View>
        <CopyLine testID="settings-store-url" label={t('settings.storeUrl')} value={storeUrl} />
      </Card>
    </Section>
  );
}

function StoreForm({ settings }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const writable = useWritable();
  const form = useForm(storeSettingsForm(settings));
  const problem = useProblem(form.problems);
  const action = useAction([SETTINGS]);
  const { values, set } = form;
  const field = (name, extra = {}) => <Field testID={`settings-${name}`} label={t(`settings.field.${name}`)} value={values[name]} onChangeText={set(name)} error={problem(name)} {...extra} />;

  async function save() {
    const built = storeSettingsBody(values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    await action.run('save', () => api.settings.update(built.body), { done: 'settings.saved' });
  }

  return (
    <View style={{ gap: theme.space[4] }}>
      <Section title={t('settings.store')}>
        <Card>
          {field('storeName', { maxLength: 120 })}
          {field('tagline', { maxLength: 400 })}
          {field('instagramHandle', { maxLength: 60, autoCapitalize: 'none' })}
          <Text variant="meta">{t('settings.brandKit')}</Text>
        </Card>
      </Section>
      <Section title={t('settings.pages')}>
        <Card>
          {field('heroKicker')}
          {field('heroTitle')}
          {field('heroSubtitle', { multiline: true })}
          {field('trustPoints', { multiline: true, hint: t('settings.trustHint') })}
          {field('bulkTitle')}
          {field('bulkText')}
          {field('aboutText', { multiline: true, hint: t('settings.aboutHint') })}
          {field('gstin', { maxLength: 20, autoCapitalize: 'characters', hint: t('settings.gstinHint') })}
        </Card>
      </Section>
      <Section title={t('settings.delivery')}>
        <Card>
          <RupeeField testID="settings-shippingFee" label={t('settings.field.shippingFee')} value={values.shippingFee} onChangeText={set('shippingFee')} error={problem('shippingFee')} />
          <RupeeField testID="settings-freeShippingAbove" label={t('settings.field.freeShippingAbove')} hint={t('settings.freeHint')} value={values.freeShippingAbove} onChangeText={set('freeShippingAbove')} error={problem('freeShippingAbove')} />
        </Card>
      </Section>
      <Section title={t('settings.support')}>
        <Card>
          {field('supportWhatsapp', { keyboardType: 'phone-pad', maxLength: 20 })}
          {field('supportEmail', { keyboardType: 'email-address', autoCapitalize: 'none', maxLength: 120 })}
        </Card>
      </Section>
      <ActionMessages action={action} testID="settings-action" />
      <Button testID="settings-save" label={t('settings.save')} disabled={!writable} busy={action.busy === 'save'} onPress={() => { save(); }} />
    </View>
  );
}

const KEYS = ['settings', 'api-keys'];

/**
 * API keys (PRD 7.13): read-only keys for the business's own analytics tools. A new key is shown once, here, and never
 * again: it is held in this screen's memory only. Making or revoking one needs a fresh check. Owner only.
 */
export function ApiKeysScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const allowed = useAllowed();
  const writable = useWritable();
  const query = usePaged(KEYS, (page) => api.apiKeys.list(page));
  const action = useAction([KEYS]);
  const [name, setName] = useState('');
  const [made, setMade] = useState(null);
  const [revoking, setRevoking] = useState(null);

  async function create() {
    const label = name.trim();
    if (!label) return;
    const key = await action.run('create', () => api.apiKeys.create({ name: label.slice(0, 60) }), { fresh: true });
    if (key?.key) {
      setMade({ name: key.name, key: key.key });
      setName('');
    }
  }

  return (
    <Screen testID="screen-api-keys" title={t('settings.apiKeys')}>
      <Offline />
      <Text variant="small">{t('settings.apiKeysIntro')}</Text>
      {allowed(OWNER_ONLY) ? (
        <Card>
          <Field testID="api-key-name" label={t('settings.apiKeyName')} value={name} onChangeText={setName} maxLength={60} />
          <Text variant="meta">{t('settings.secret.fresh')}</Text>
          <Button testID="api-key-create" label={t('settings.apiKeyCreate')} disabled={!writable || !name.trim()} busy={action.busy === 'create'} onPress={() => { create(); }} />
        </Card>
      ) : null}
      <ActionMessages action={action} testID="api-keys-action" />
      <PagedList
        testID="api-keys"
        query={query}
        emptyTitle={t('settings.apiKeysEmpty')}
        renderRow={(key) => (
          <ListRow
            testID={`api-key-${key.id}`}
            title={`${key.name} · ${key.prefix}…`}
            subtitle={[t('settings.apiKeyMade', { when: formatWhenAt(key.createdAt, locale) }), key.lastUsedAt ? t('settings.apiKeyUsed', { when: formatWhenAt(key.lastUsedAt, locale) }) : t('settings.apiKeyUnused')].join(' · ')}
            end={key.revokedAt ? <Badge label={t('settings.apiKeyRevoked')} /> : allowed(OWNER_ONLY) ? <Button kind="quiet" testID={`api-key-${key.id}-revoke`} label={t('settings.apiKeyRevoke')} disabled={!writable} onPress={() => setRevoking(key)} /> : null}
          />
        )}
      />
      <Sheet testID="api-key-made" visible={Boolean(made)} onClose={() => setMade(null)} closeLabel={t('common.done')} title={t('settings.apiKeyShown', { name: made?.name ?? '' })}>
        <CopyLine testID="api-key-value" label={t('settings.apiKeyOnce')} value={made?.key} />
      </Sheet>
      <ConfirmSheet testID="api-key-revoke-confirm" visible={Boolean(revoking)} title={t('settings.apiKeyRevokeTitle', { name: revoking?.name ?? '' })} confirmLabel={t('settings.apiKeyRevoke')} cancelLabel={t('common.cancel')} busy={action.busy === 'revoke'} disabled={!writable} onCancel={() => setRevoking(null)}
        onConfirm={async () => {
          await action.run('revoke', () => api.apiKeys.revoke(revoking.id), { fresh: true, done: 'settings.apiKeyRevokedDone' });
          setRevoking(null);
        }}
      >
        {t('settings.apiKeyRevokeBody')}
      </ConfirmSheet>
    </Screen>
  );
}
