import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { OWNER_ONLY } from '@bhava/app-core/access';
import { Banner, Button, Card, Choices, ConfirmSheet, ListRow, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { shopifyConnectBody } from '../orders/kit/forms.js';
import { ActionMessages, CopyLine, Fact, KeyForm, Offline, PagedList, RecordView, StatusBadge, formatWhenAt, useAction, useAllowed, usePaged, useWritable } from '../orders/kit/ui.js';

const SHOPIFY = ['shopify'];
const MODES = ['source', 'two_way'];

/**
 * Shopify sync (PRD 9.11, 10.4; P-17): Shopify as the source with orders sent to it, or both ways with the latest change
 * winning and each conflict logged. The Admin API token and the webhook secret are typed into write-only fields after a
 * fresh check, are never shown again, and are replaced by connecting again.
 */
export default function ShopifyScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const shop = useQuery({ queryKey: SHOPIFY, queryFn: () => api.shopify.get() });
  return (
    <Screen testID="screen-shopify" title={t('shopify.title')}>
      <Offline />
      <RecordView query={shop} testID="shopify">
        {(data) => (data.connected ? <Connected shop={data} /> : <NotConnected />)}
      </RecordView>
    </Screen>
  );
}

function ModeChoice({ value, onChange, disabled }) {
  const { t } = useStrings();
  return (
    <View style={{ gap: 8 }}>
      <Choices testID="shopify-mode" label={t('shopify.how')} value={value} onChange={onChange} disabled={disabled} options={MODES.map((mode) => ({ value: mode, label: t(`shopify.mode.${mode}`) }))} />
      <Text variant="small">{t(`shopify.mode.${value}.note`)}</Text>
    </View>
  );
}

/** Connecting, or connecting again with new keys. Owner only. */
function ConnectForm({ testID = 'shopify-connect', initialMode = 'source', saved = false }) {
  const { api } = useServices();
  const { t } = useStrings();
  const [mode, setMode] = useState(initialMode);
  return (
    <View style={{ gap: 12 }}>
      <ModeChoice value={mode} onChange={setMode} />
      <KeyForm
        testID={testID}
        intro={t('shopify.connectIntro')}
        fields={[
          { name: 'shopDomain', label: t('shopify.domain'), hint: t('shopify.domainHint'), keyboardType: 'url' },
          { name: 'accessToken', label: t('shopify.token'), secret: true, saved },
          { name: 'webhookSecret', label: t('shopify.webhookSecret'), secret: true, saved },
        ]}
        build={(values) => shopifyConnectBody({ ...values, mode })}
        save={(body) => api.shopify.connect(body)}
        submitLabel={t(saved ? 'shopify.replace' : 'shopify.connect')}
        doneKey={saved ? 'shopify.replaced' : 'shopify.connected'}
        reload={[SHOPIFY]}
      />
    </View>
  );
}

function NotConnected() {
  const { t } = useStrings();
  const allowed = useAllowed();
  return (
    <Card testID="shopify-not-connected">
      <Text variant="title">{t('shopify.connectTitle')}</Text>
      {allowed(OWNER_ONLY) ? <ConnectForm /> : <Text variant="small" testID="shopify-owner-only">{t('shopify.ownerConnects')}</Text>}
    </Card>
  );
}

function Connected({ shop }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const allowed = useAllowed();
  const writable = useWritable();
  const owner = allowed(OWNER_ONLY);
  const action = useAction([SHOPIFY]);
  const [disconnecting, setDisconnecting] = useState(false);
  const [replacing, setReplacing] = useState(false);
  return (
    <View style={{ gap: theme.space[4] }}>
      <Card testID="shopify-connected">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
          <Text variant="title" style={{ flex: 1 }}>{shop.shopDomain}</Text>
          <StatusBadge group="shopify" status={shop.status} testID="shopify-status" />
        </View>
        {shop.status === 'reconnect' ? <Banner tone="bad" testID="shopify-reconnect">{t('shopify.reconnectBody')}</Banner> : null}
        <Fact label={t('shopify.lastCheck')} value={shop.lastReconciledAt ? formatWhenAt(shop.lastReconciledAt, locale) : t('shopify.notYet')} />
        <Fact label={t('shopify.pending')} value={String(shop.pendingOrders)} />
        <Fact label={t('shopify.failed')} value={String(shop.failedOrders)} />
        <CopyLine testID="shopify-webhook" label={t('shopify.webhook')} value={shop.webhookUrl} />
        <ActionMessages action={action} testID="shopify-action" />
        <ModeChoice value={shop.mode} disabled={!owner || !writable || Boolean(action.busy)} onChange={(mode) => action.run('mode', () => api.shopify.setMode({ mode }), { done: 'shopify.modeSaved' })} />
        <Button testID="shopify-reconcile" kind="secondary" label={t('shopify.reconcile')} disabled={!writable} busy={action.busy === 'reconcile'} onPress={() => action.run('reconcile', () => api.shopify.reconcile(), { done: 'shopify.reconciling' })} />
        {owner ? (
          <>
            <Button testID="shopify-pause" kind="secondary" label={t(shop.status === 'paused' ? 'shopify.resume' : 'shopify.pause')} disabled={!writable} busy={action.busy === 'pause'} onPress={() => action.run('pause', () => api.shopify.setMode({ paused: shop.status !== 'paused' }), { done: shop.status === 'paused' ? 'shopify.resumed' : 'shopify.paused' })} />
            <Button testID="shopify-replace-open" kind="quiet" label={t(replacing ? 'shopify.replaceHide' : 'shopify.replaceShow')} onPress={() => setReplacing((on) => !on)} />
            {replacing || shop.status === 'reconnect' ? <ConnectForm testID="shopify-replace" initialMode={shop.mode} saved /> : null}
            <Button testID="shopify-disconnect" kind="danger" label={t('shopify.disconnect')} disabled={!writable} onPress={() => setDisconnecting(true)} />
          </>
        ) : <Text variant="meta" testID="shopify-owner-only">{t('shopify.ownerOnly')}</Text>}
      </Card>
      {shop.mode === 'two_way' ? <Conflicts /> : null}
      <ConfirmSheet testID="shopify-disconnect-confirm" visible={disconnecting} title={t('shopify.disconnectTitle')} confirmLabel={t('shopify.disconnect')} cancelLabel={t('shopify.keep')} busy={action.busy === 'disconnect'} disabled={!writable} onCancel={() => setDisconnecting(false)}
        onConfirm={async () => {
          await action.run('disconnect', () => api.shopify.disconnect(), { fresh: true, done: 'shopify.disconnected' });
          setDisconnecting(false);
        }}
      >
        {t('shopify.disconnectBody')}
      </ConfirmSheet>
    </View>
  );
}

function Conflicts() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const query = usePaged(['shopify', 'conflicts'], (page) => api.shopify.conflicts(page));
  return (
    <Section title={t('shopify.conflicts')} testID="shopify-conflicts">
      <PagedList
        testID="shopify-conflicts-list"
        query={query}
        emptyTitle={t('shopify.conflictsNone')}
        renderRow={(conflict) => (
          <ListRow
            testID={`conflict-${conflict.id}`}
            title={`${conflict.kind} ${conflict.localId}: ${conflict.field}`}
            subtitle={[t('shopify.conflictValues', { here: conflict.localValue, there: conflict.remoteValue }), t(conflict.winner === 'local' ? 'shopify.keptHere' : 'shopify.tookShopify'), formatWhenAt(conflict.at, locale)].join(' · ')}
          />
        )}
      />
    </Section>
  );
}
