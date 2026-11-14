import React, { useEffect, useRef, useState } from 'react';
import { AppState, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { OWNER_APP_CALLBACK, useStrings } from '@bhava/app-core';
import { MANAGERS, OWNER_ONLY } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, Divider, Field, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { UpgradePrompt, usePlanError } from '../billing/UpgradePrompt.js';
import { ActionMessages, Offline, PagedList, RecordView, formatWhenAt, useAction, useAllowed, usePaged } from '../orders/kit/ui.js';
import { blankDraft, fromDraft, parseReturn, signupUrl, toDraft } from './rules.js';

export const WA = ['whatsapp'];

/**
 * The WhatsApp add-on (PRD 6.12: A-61 to A-66): connect the business's own number through Meta's sign-up in the system
 * browser, the keywords that answer with a reel or a link, and who opted in. Nothing here shows a phone number or a token.
 */
export default function WhatsappScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const allowed = useAllowed();
  const manager = allowed(MANAGERS);
  const owner = allowed(OWNER_ONLY);
  const action = useAction([WA]);
  const [planError, onError] = usePlanError();
  const status = useQuery({ queryKey: [...WA, 'status'], queryFn: () => api.whatsapp.status(), enabled: manager });
  const run = (key, work, done) => { onError(null); return action.run(key, work, { done, reload: [WA], onError }); };

  return (
    <Screen testID="screen-whatsapp" title={t('whatsapp.title')}>
      <Offline />
      <ActionMessages action={action} testID="whatsapp-action" />
      <UpgradePrompt error={planError} />
      {manager ? (
        <RecordView query={status} testID="whatsapp-status">
          {(data) => <Connection data={data} owner={owner} action={action} run={run} />}
        </RecordView>
      ) : <Text variant="small" testID="whatsapp-manager-only">{t('whatsapp.managerOnly')}</Text>}
      <Keywords run={run} action={action} />
      {manager ? <Optins /> : null}
    </Screen>
  );
}

function Connection({ data, owner, action, run }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const [away, setAway] = useState(false);
  const reread = useRef(() => {});
  reread.current = () => queryClient.invalidateQueries({ queryKey: WA });

  useEffect(() => {
    if (!away) return undefined;
    const subscription = AppState.addEventListener?.('change', (next) => {
      if (next === 'active') {
        setAway(false);
        reread.current();
      }
    });
    return () => subscription?.remove?.();
  }, [away]);

  const connect = () => run('connect', async () => {
    const start = await api.whatsapp.connectStart();
    const url = signupUrl(start);
    if (!url) throw Object.assign(new Error('Sign-up is not set up'), { status: 502 });
    setAway(true);
    const result = WebBrowser.openAuthSessionAsync ? await WebBrowser.openAuthSessionAsync(url, OWNER_APP_CALLBACK) : await WebBrowser.openBrowserAsync(url);
    const back = result?.url ? parseReturn(result.url) : null;
    if (back) {
      setAway(false);
      return api.whatsapp.connectFinish(back);
    }
    return { returned: true };
  }, 'whatsapp.done.connect');

  const tone = data.connected ? (data.status === 'active' ? 'good' : 'warn') : 'neutral';
  return (
    <Card testID="whatsapp-card">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <Text variant="title" style={{ flex: 1 }}>{data.connected ? (data.displayName || t('whatsapp.yourNumber')) : t('whatsapp.notConnected')}</Text>
        <Badge testID="whatsapp-badge" label={t(data.connected ? `whatsapp.status.${data.status ?? 'active'}` : 'whatsapp.status.none')} tone={tone} />
      </View>
      {data.connected ? <Text variant="small">{data.displayNumber}</Text> : <Text variant="small">{t('whatsapp.about')}</Text>}
      {data.connected && data.connectedAt ? <Text variant="meta">{t('whatsapp.since', { date: formatWhenAt(data.connectedAt, locale) })}</Text> : null}
      {!data.signupReady ? <Banner tone="info" testID="whatsapp-not-ready">{t('whatsapp.notReady')}</Banner> : null}
      {owner && (!data.connected || data.status !== 'active') ? (
        <Button testID="whatsapp-connect" label={t(data.connected ? 'whatsapp.reconnect' : 'whatsapp.connect')} disabled={!action.writable || !data.signupReady} busy={action.busy === 'connect'} accessibilityHint={t('whatsapp.browserHint')} onPress={connect} />
      ) : null}
      {!owner && !data.connected ? <Text variant="meta">{t('whatsapp.askOwner')}</Text> : null}
      {owner && data.connected ? <Button testID="whatsapp-disconnect" kind="danger" label={t('whatsapp.disconnect')} disabled={!action.writable} onPress={() => setAsking(true)} /> : null}
      <Text variant="meta">{t('whatsapp.promise')}</Text>
      <ConfirmSheet
        testID="whatsapp-disconnect-sheet"
        visible={asking}
        title={t('whatsapp.disconnectTitle')}
        confirmLabel={t('whatsapp.disconnect')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setAsking(false)}
        onConfirm={async () => {
          await run('disconnect', () => api.whatsapp.disconnect(), 'whatsapp.done.disconnect');
          setAsking(false);
        }}
      >
        {t('whatsapp.disconnectBody')}
      </ConfirmSheet>
    </Card>
  );
}

/** Keywords that answer a WhatsApp message with a reel's link or a link of the seller's own. Saved as the whole list, in priority order. */
function Keywords({ run, action }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const allowed = useAllowed();
  const query = useQuery({ queryKey: [...WA, 'keywords'], queryFn: () => api.whatsapp.keywords() });
  const [drafts, setDrafts] = useState(null);
  const [problems, setProblems] = useState({});
  const items = query.data?.items;
  useEffect(() => {
    if (items) setDrafts(items.map(toDraft));
  }, [items]);

  const edit = (index, patch) => setDrafts((list) => list.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  const dirty = drafts && JSON.stringify(drafts) !== JSON.stringify((items ?? []).map(toDraft));
  const save = async () => {
    const built = drafts.map(fromDraft);
    const found = {};
    built.forEach((b, i) => { if (b.problems) found[i] = b.problems; });
    setProblems(found);
    if (Object.keys(found).length) return;
    await run('keywords', () => api.whatsapp.saveKeywords({ items: built.map((b) => b.body) }), 'whatsapp.done.keywords');
  };

  return (
    <Section title={t('whatsapp.keywords.title')} testID="whatsapp-keywords">
      <Text variant="small">{t('whatsapp.keywords.intro')}</Text>
      <RecordView query={query} testID="whatsapp-keywords-read">
        {() => (
          <View style={{ gap: theme.space[3] }}>
            {drafts?.length === 0 ? <Text variant="small" testID="whatsapp-keywords-empty">{t('whatsapp.keywords.empty')}</Text> : null}
            {(drafts ?? []).map((draft, i) => (
              <Card key={draft.id ?? `new-${i}`} testID={`keyword-set-${i}`}>
                <Field testID={`keyword-set-${i}-keywords`} label={t('whatsapp.keywords.words')} hint={t('whatsapp.keywords.wordsHint')} value={draft.keywords} error={problems[i]?.keywords ? t(problems[i].keywords) : undefined} maxLength={800} onChangeText={(keywords) => edit(i, { keywords })} autoCapitalize="none" />
                <Choices testID={`keyword-set-${i}-target`} label={t('whatsapp.keywords.target')} value={draft.target} onChange={(target) => edit(i, { target })} options={[{ value: 'link', label: t('whatsapp.keywords.link') }, { value: 'reel', label: t('whatsapp.keywords.reel') }]} />
                {draft.target === 'link'
                  ? <Field testID={`keyword-set-${i}-link`} label={t('whatsapp.keywords.linkLabel')} value={draft.linkUrl} error={problems[i]?.linkUrl ? t(problems[i].linkUrl) : undefined} autoCapitalize="none" keyboardType="url" maxLength={2000} onChangeText={(linkUrl) => edit(i, { linkUrl })} />
                  : <Field testID={`keyword-set-${i}-reel`} label={t('whatsapp.keywords.reelLabel')} value={draft.reelId} error={problems[i]?.reelId ? t(problems[i].reelId) : undefined} keyboardType="number-pad" maxLength={12} onChangeText={(reelId) => edit(i, { reelId: reelId.replace(/\D/g, '') })} />}
                <Field testID={`keyword-set-${i}-message`} label={t('whatsapp.keywords.message')} hint={t('whatsapp.keywords.messageHint')} value={draft.message} multiline maxLength={1000} onChangeText={(message) => edit(i, { message })} />
                <Toggle testID={`keyword-set-${i}-active`} title={t('whatsapp.keywords.active')} value={draft.active} onValueChange={(active) => edit(i, { active })} />
                <Button testID={`keyword-set-${i}-remove`} kind="quiet" label={t('whatsapp.keywords.remove')} onPress={() => setDrafts((list) => list.filter((_, at) => at !== i))} />
              </Card>
            ))}
            <Button testID="keyword-add" kind="secondary" label={t('whatsapp.keywords.add')} onPress={() => setDrafts((list) => [...(list ?? []), blankDraft()])} />
            <Button testID="keyword-save" label={t('common.save')} disabled={!action.writable || !dirty} busy={action.busy === 'keywords'} onPress={save} />
          </View>
        )}
      </RecordView>
    </Section>
  );
}

/** Who opted in to WhatsApp messages, without who they are: the number is kept only as a hash and is never shown. */
function Optins() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const [purpose, setPurpose] = useState('all');
  const query = usePaged([...WA, 'optins', { purpose }], (page) => api.whatsapp.optins({ ...(purpose === 'all' ? {} : { purpose }), ...page }));
  return (
    <Section title={t('whatsapp.optins.title')}>
      <Text variant="small">{t('whatsapp.optins.intro')}</Text>
      <Choices testID="whatsapp-optin-filter" label={t('whatsapp.optins.title')} value={purpose} onChange={setPurpose} options={['all', 'marketing', 'order_updates'].map((value) => ({ value, label: t(`whatsapp.purpose.${value}`) }))} />
      <PagedList
        testID="whatsapp-optins"
        query={query}
        emptyTitle={t('whatsapp.optins.empty')}
        emptyBody={t('whatsapp.optins.emptyBody')}
        renderRow={(row) => (
          <View style={{ gap: 2, paddingVertical: 8 }} testID={`optin-${row.id}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Text variant="body" style={{ flex: 1 }}>{t(`whatsapp.purpose.${row.purpose}`)}</Text>
              <Badge label={t(row.withdrawnAt ? 'whatsapp.optins.withdrawn' : 'whatsapp.optins.active')} tone={row.withdrawnAt ? 'neutral' : 'good'} />
            </View>
            <Text variant="meta">{t('whatsapp.optins.via', { source: t(`whatsapp.source.${row.source}`), date: formatWhenAt(row.optedInAt, locale) })}</Text>
            {row.withdrawnAt ? <Text variant="meta">{t('whatsapp.optins.stopped', { date: formatWhenAt(row.withdrawnAt, locale) })}</Text> : null}
          </View>
        )}
      />
      <Divider />
    </Section>
  );
}
