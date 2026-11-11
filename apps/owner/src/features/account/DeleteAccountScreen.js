import React, { useState } from 'react';
import { View } from 'react-native';
import Check from 'lucide-react-native/icons/check';
import { OfflineBanner, formatDate, useOnline, useReauth, useStrings } from '@bhava/app-core';
import { Banner, Button, Card, Field, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { signOutEverywhere } from '../../shell/sign-out.js';

/** Days before a deletion is carried out: DELETION_GRACE_DAYS in src/contracts/accounts.js, and the server's dueAt is what is shown. */
const GRACE_DAYS = 30;

/** One step of what happens next, done or still to come. */
function Step({ done, title, body, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} accessible accessibilityLabel={`${title}. ${body}`} style={{ flexDirection: 'row', gap: theme.space[3], minHeight: theme.tap.min }}>
      <View style={{ width: 24, height: 24, borderRadius: theme.radius.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: done ? theme.color.goodTint : theme.color.surfaceSunken }}>
        {done ? <Check color={theme.color.goodText} size={14} /> : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" style={{ fontFamily: theme.font.bodySemiBold }}>{title}</Text>
        <Text variant="small">{body}</Text>
      </View>
    </View>
  );
}

/**
 * Delete my account (PRD 10.6, P-26; Apple 5.1.1(v)). The person types DELETE, proves it is them (the re-auth sheet:
 * fingerprint or a WhatsApp code), and the server records the request, tells the team and answers when it is due.
 * The timeline shows that, then Done signs this phone out and wipes what it held. Needs a connection.
 */
export default function DeleteAccountScreen() {
  const { api, session, store } = useServices();
  const { offline } = useSession();
  const online = useOnline() && !offline;
  const { runFresh } = useReauth();
  const { t, locale } = useStrings();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [request, setRequest] = useState(null);
  const [doneFailed, setDoneFailed] = useState(false);

  async function done() {
    setDoneFailed(false);
    try {
      await signOutEverywhere({ session, store, reason: 'account_deleted' });
    } catch {
      setDoneFailed(true);
    }
  }

  // Pressed, not awaited: the fresh check it may open is answered by more presses.
  async function confirm() {
    setBusy(true);
    setFailed(false);
    try {
      setRequest(await runFresh(() => api.auth.deleteAccount({ confirm: 'DELETE' })));
    } catch (error) {
      if (error?.code !== 'cancelled') setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  if (request) {
    return (
      <Screen testID="screen-account-delete" title={t('account.delete.title')}>
        <Section title={t('account.delete.timeline')} testID="deletion-timeline">
          <Card>
            <Step testID="deletion-requested" done title={t('account.delete.requested', { date: formatDate(request.requestedAt, { locale }) })} body={t('account.delete.requestedBody')} />
            <Step testID="deletion-signed-out" done={false} title={t('account.delete.signedOut')} body={t('account.delete.signedOutBody')} />
            <Step testID="deletion-due" done={false} title={t('account.delete.due', { date: formatDate(request.dueAt, { locale }) })} body={t('account.delete.dueBody')} />
          </Card>
        </Section>
        {doneFailed ? <Banner tone="bad" testID="deletion-sign-out-failed">{t('account.signOutFailed')}</Banner> : null}
        <Button testID="deletion-done" label={t('common.done')} onPress={() => { done(); }} />
      </Screen>
    );
  }

  return (
    <Screen testID="screen-account-delete" title={t('account.delete.title')}>
      <OfflineBanner offline={!online} />
      <Text variant="body">{t('account.delete.body', { days: GRACE_DAYS })}</Text>
      <Banner tone="warn">{t('account.delete.owner')}</Banner>
      {failed ? <Banner tone="bad" testID="deletion-failed">{t('account.delete.failed')}</Banner> : null}
      <Field testID="deletion-confirm" label={t('account.delete.typeLabel')} value={typed} onChangeText={setTyped} autoCapitalize="characters" autoCorrect={false} maxLength={10} />
      <Button testID="deletion-submit" kind="danger" label={t('account.delete.action')} busy={busy} disabled={!online || typed.trim() !== 'DELETE'} onPress={() => { confirm(); }} />
    </Screen>
  );
}
