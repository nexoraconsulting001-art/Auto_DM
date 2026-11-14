import React, { useState } from 'react';
import { AppState, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import * as WebBrowser from 'expo-web-browser';
import { useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, Choices, Field, ListRow, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { ActionMessages, Offline, PagedList, RecordView, useAction, usePaged } from '../orders/kit/ui.js';
import { IG_KEY, useBrowserConnect } from '../connect/ConnectScreen.js';
import { stageOf, readyToStart, formatElapsed } from './rules.js';

export const SIGNUP = ['signup'];

/**
 * Sign-up in the app (PRD 5.20: F-121, F-122; 10.3, 10.4). One screen that follows the server's own record of where this
 * person is: pick Creator or Seller, connect Instagram in the system browser, pick a reel with a keyword and a link, and go live.
 * The link and the message pass the same rules as any automation before it goes live, and the server's reasons are shown by field.
 * Free needs no card and no password; nothing about plans or paying is on this screen.
 */
export default function SignupScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const action = useAction([SIGNUP]);
  const [runToken, setRunToken] = useState('');
  const [finished, setFinished] = useState(null);
  const status = useQuery({ queryKey: [...SIGNUP, 'status', runToken], queryFn: () => api.signup.status(runToken ? { runToken } : {}) });
  const connection = useQuery({
    queryKey: IG_KEY,
    queryFn: () => api.instagram.connection(),
    enabled: Boolean(status.data?.tenantId),
    retry: false,
  });
  const stage = finished ? 'done' : status.data ? stageOf(status.data, connection.data) : 'type';
  const token = runToken || status.data?.runToken || '';

  return (
    <Screen testID="screen-signup" title={t('signup.title')}>
      <Offline />
      <ActionMessages action={action} testID="signup-action" />
      <RecordView query={status} testID="signup">
        {(data) => (
          <View style={{ gap: theme.space[3] }}>
            <Steps stage={stage} />
            {!data.open && stage === 'type' && data.mode === 'closed' ? <Banner tone="warn" testID="signup-closed">{t('signup.closed')}</Banner> : null}
            {stage === 'type' ? <TypeStep mode={data.mode} open={data.open} action={action} token={token} onStarted={(started) => setRunToken(started.runToken)} /> : null}
            {stage === 'instagram' ? <InstagramStep connection={connection.data} action={action} /> : null}
            {stage === 'automation' ? <AutomationStep token={token} action={action} onLive={() => {}} onFinish={(done) => setFinished(done)} /> : null}
            {stage === 'finish' ? <FinishStep token={token} action={action} onFinish={(done) => setFinished(done)} /> : null}
            {stage === 'done' ? <DoneStep finished={finished} /> : null}
          </View>
        )}
      </RecordView>
    </Screen>
  );
}

const STAGES = ['type', 'instagram', 'automation', 'finish'];

function Steps({ stage }) {
  const { t } = useStrings();
  const at = stage === 'done' ? STAGES.length : STAGES.indexOf(stage);
  return (
    <Card testID="signup-steps">
      {STAGES.map((name, i) => (
        <View key={name} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 32 }} testID={`signup-step-${name}`}>
          <Badge label={String(i + 1)} tone={i < at ? 'good' : i === at ? 'primary' : 'neutral'} />
          <Text variant="body" style={{ flex: 1 }}>{t(`signup.step.${name}`)}</Text>
          {i < at ? <Text variant="meta">{t('signup.stepDone')}</Text> : null}
        </View>
      ))}
    </Card>
  );
}

function TypeStep({ mode, open, action, token, onStarted }) {
  const { api } = useServices();
  const { t } = useStrings();
  const [accountType, setAccountType] = useState('creator');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState('');
  const [referral, setReferral] = useState('');
  const [problems, setProblems] = useState({});
  const start = async () => {
    const found = readyToStart({ name, mode, invite });
    setProblems(found);
    if (Object.keys(found).length) return;
    const started = await action.run('start', () => api.signup.start({ accountType, name: name.trim(), inviteCode: invite.trim(), referralCode: referral.trim(), runToken: token }), { done: 'signup.done.started', reload: [SIGNUP] });
    if (started && started.runToken) onStarted(started);
  };
  return (
    <Card testID="signup-type">
      <Text variant="title">{t('signup.type.title')}</Text>
      <Choices testID="signup-account-type" label={t('signup.type.title')} value={accountType} onChange={setAccountType} options={[{ value: 'creator', label: t('signup.type.creator') }, { value: 'seller', label: t('signup.type.seller') }]} />
      <Text variant="small" testID="signup-type-about">{t(`signup.type.${accountType}Body`)}</Text>
      <Field testID="signup-name" label={t(`signup.name.${accountType}`)} value={name} error={problems.name ? t(problems.name) : undefined} maxLength={120} onChangeText={setName} />
      {mode === 'invite' ? <Field testID="signup-invite" label={t('signup.invite')} value={invite} error={problems.invite ? t(problems.invite) : undefined} autoCapitalize="none" maxLength={80} onChangeText={setInvite} /> : null}
      <Field testID="signup-referral" label={t('signup.referral')} hint={t('signup.referralHint')} value={referral} autoCapitalize="none" maxLength={40} onChangeText={setReferral} />
      <Button testID="signup-start" label={t('signup.type.go')} disabled={!action.writable || (!open && mode !== 'invite')} busy={action.busy === 'start'} onPress={start} />
      <Text variant="meta">{t('signup.free')}</Text>
    </Card>
  );
}

function InstagramStep({ connection, action }) {
  const { api } = useServices();
  const { t } = useStrings();
  const connect = useBrowserConnect((body) => api.instagram.connect(body), { browser: WebBrowser, appState: AppState, keys: [IG_KEY, SIGNUP] });
  const lost = connection && connection.status !== 'not_connected' && connection.status !== 'active';
  return (
    <Card testID="signup-instagram">
      <Text variant="title">{t('signup.instagram.title')}</Text>
      <Text variant="small">{t('signup.instagram.body')}</Text>
      {lost ? <Banner tone="warn">{t('signup.instagram.reconnect')}</Banner> : null}
      <Button testID="signup-instagram-connect" label={t('signup.instagram.connect')} disabled={!action.writable} busy={connect.isPending} accessibilityHint={t('signup.instagram.hint')} onPress={() => connect.mutate()} />
      {connect.isSuccess ? <Text variant="meta" testID="signup-instagram-returned">{t('signup.instagram.returned')}</Text> : null}
      {connect.error ? <Banner tone="bad" testID="signup-instagram-problem">{t('signup.instagram.failed')}</Banner> : null}
      <Text variant="meta">{t('signup.instagram.promise')}</Text>
    </Card>
  );
}

function AutomationStep({ token, action, onFinish }) {
  const { api } = useServices();
  const { t } = useStrings();
  const [mediaId, setMediaId] = useState('');
  const [keyword, setKeyword] = useState('');
  const [link, setLink] = useState('');
  const [problems, setProblems] = useState({});
  const [reasons, setReasons] = useState([]);
  const media = usePaged([...SIGNUP, 'media'], (page) => api.instagram.media({ type: 'reel', ...page }), { limit: 12 });
  const submit = async () => {
    const found = {};
    if (!mediaId) found.mediaId = 'signup.auto.needReel';
    if (!keyword.trim()) found.keyword = 'signup.auto.needKeyword';
    if (!/^https:\/\/\S+$/i.test(link.trim())) found.link = 'signup.auto.needLink';
    setProblems(found);
    setReasons([]);
    if (Object.keys(found).length) return;
    const result = await action.run('automation', () => api.signup.firstAutomation({ runToken: token, mediaId, keyword: keyword.trim(), link: link.trim() }), { reload: [SIGNUP] });
    if (!result || typeof result !== 'object') return;
    if (result.live) {
      const done = await action.run('finish', () => api.signup.finish({ runToken: token }), { done: 'signup.done.live', reload: [SIGNUP] });
      if (done && typeof done === 'object') onFinish(done);
    } else setReasons(result.problems ?? []);
  };
  return (
    <View style={{ gap: 12 }}>
      <Section title={t('signup.auto.reel')}>
        <PagedList
          testID="signup-reels"
          query={media}
          emptyTitle={t('signup.auto.noReels')}
          emptyBody={t('signup.auto.noReelsBody')}
          renderRow={(item) => (
            <ListRow
              testID={`signup-reel-${item.id}`}
              title={item.caption ? item.caption.slice(0, 60) : t('signup.auto.reelUntitled')}
              subtitle={item.type}
              emphasis={mediaId === item.id}
              end={mediaId === item.id ? <Badge label={t('signup.auto.picked')} tone="good" /> : null}
              onPress={() => setMediaId(item.id)}
            />
          )}
        />
        {problems.mediaId ? <Text variant="meta" tone="bad" accessibilityRole="alert">{t(problems.mediaId)}</Text> : null}
      </Section>
      <Card testID="signup-auto">
        <Field testID="signup-keyword" label={t('signup.auto.keyword')} hint={t('signup.auto.keywordHint')} value={keyword} error={problems.keyword ? t(problems.keyword) : undefined} maxLength={40} autoCapitalize="none" onChangeText={setKeyword} />
        <Field testID="signup-link" label={t('signup.auto.link')} hint={t('signup.auto.linkHint')} value={link} error={problems.link ? t(problems.link) : undefined} maxLength={1000} autoCapitalize="none" keyboardType="url" onChangeText={setLink} />
        {reasons.map((r) => <Banner key={`${r.field}:${r.reason}`} tone="warn" testID={`signup-reason-${r.field}`}>{r.message}</Banner>)}
        <Button testID="signup-go-live" label={t('signup.auto.live')} disabled={!action.writable} busy={action.busy === 'automation' || action.busy === 'finish'} onPress={submit} />
        <Text variant="meta">{t('signup.auto.rules')}</Text>
      </Card>
    </View>
  );
}

function FinishStep({ token, action, onFinish }) {
  const { api } = useServices();
  const { t } = useStrings();
  return (
    <Card testID="signup-finish">
      <Text variant="title">{t('signup.finish.title')}</Text>
      <Button testID="signup-finish-go" label={t('signup.finish.go')} disabled={!action.writable} busy={action.busy === 'finish'} onPress={async () => {
        const done = await action.run('finish', () => api.signup.finish({ runToken: token }), { done: 'signup.done.live', reload: [SIGNUP] });
        if (done && typeof done === 'object') onFinish(done);
      }} />
    </Card>
  );
}

function DoneStep({ finished }) {
  const { t } = useStrings();
  return (
    <Card testID="signup-done">
      <Text variant="title">{t('signup.done.title')}</Text>
      <Text variant="small">{t('signup.done.body')}</Text>
      {finished?.elapsedMs ? <Text variant="meta" testID="signup-elapsed">{t(finished.withinTarget ? 'signup.done.fast' : 'signup.done.time', { time: formatElapsed(finished.elapsedMs) })}</Text> : null}
    </Card>
  );
}
