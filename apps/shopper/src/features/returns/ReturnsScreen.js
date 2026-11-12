/** Asking to return items from an order, with a photo or short video as proof (S-57, S-80). The server decides what can be returned. */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { Banner, Button, Choices, Field, ListRow, LoadingRows, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { NeedSignIn, Problem, useBuy, useSessionState, useStoreQuery } from '../cart/ui.js';
import { PROOF_MAX_FILES, formWith, pickFiles } from './proof.js';

export default function ReturnsScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const orderNumber = String(useRoute().params?.orderNumber ?? '');
  const { buy } = useBuy();
  const services = useServices();
  const signedIn = useSessionState().status === 'signedIn';
  const order = useStoreQuery(['order', orderNumber], () => buy.call('appOrder', { params: { orderNumber } }), { enabled: signedIn && orderNumber !== '' });
  const [picked, setPicked] = useState({});
  const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState('refund');
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [done, setDone] = useState(false);
  const [tried, setTried] = useState(false);

  // The order's lines carry the id the server's return form names them by.
  const lines = (order.data?.lines ?? []).map((line, i) => ({ ...line, key: String(line.orderItemId ?? line.id ?? i), orderItemId: line.orderItemId ?? line.id }));
  const chosen = lines.filter((line) => (picked[line.key] ?? 0) > 0);
  const setQty = (line, qty) => setPicked((now) => ({ ...now, [line.key]: Math.max(0, Math.min(line.qty, qty)) }));

  async function addFiles() {
    const more = await pickFiles({ picker: services.imagePicker ?? require('expo-image-picker'), limit: PROOF_MAX_FILES - files.length, video: true });
    setFiles((now) => [...now, ...more].slice(0, PROOF_MAX_FILES));
  }

  async function send() {
    setTried(true);
    if (!chosen.length || !files.length) return;
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      const items = chosen.map((line) => ({ orderItemId: line.orderItemId, qty: picked[line.key] }));
      await buy.call('returnCreate', { params: { orderNumber }, form: formWith({ items: JSON.stringify(items), reason: reason.trim(), resolution }, 'proof', files) });
      setDone(true);
    } catch (failed) {
      setError(failed);
      setFieldErrors(failed.fields ?? {});
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) {
    return (
      <Screen testID="screen-returns" title={t('returns.title')}>
        <NeedSignIn go={(name) => navigation.navigate(name)} />
      </Screen>
    );
  }
  if (done) {
    return (
      <Screen testID="screen-returns" title={t('returns.title')}>
        <Banner testID="return-sent" tone="good">{t('returns.sent')}</Banner>
        <Button testID="return-done" label={t('returns.back')} onPress={() => navigation.navigate('orders.order', { orderNumber })} />
      </Screen>
    );
  }
  return (
    <Screen testID="screen-returns" title={t('returns.title')}>
      {order.isError && !order.data ? <Problem error={order.error} onRetry={() => order.refetch()} /> : null}
      {order.isPending ? <LoadingRows rows={3} label={t('home.common.loading')} testID="returns-loading" /> : null}
      <Problem inline error={error} testID="return-error" />
      {order.data ? (
        <>
          <Section title={t('returns.which')}>
            {lines.map((line) => (
              <View key={line.key} testID={`return-line-${line.key}`} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
                <View style={{ flex: 1 }}><ListRow title={line.name} subtitle={[line.option, `× ${line.qty}`].filter(Boolean).join(' · ')} /></View>
                <Button testID={`return-less-${line.key}`} kind="secondary" label="−" accessibilityHint={t('returns.less')} onPress={() => setQty(line, (picked[line.key] ?? 0) - 1)} />
                <Text variant="title" testID={`return-qty-${line.key}`}>{picked[line.key] ?? 0}</Text>
                <Button testID={`return-more-${line.key}`} kind="secondary" label="+" accessibilityHint={t('returns.more')} onPress={() => setQty(line, (picked[line.key] ?? 0) + 1)} />
              </View>
            ))}
            {tried && !chosen.length ? <Text variant="meta" tone="bad" accessibilityRole="alert">{t('returns.pickOne')}</Text> : null}
          </Section>
          <Choices testID="return-resolution" label={t('returns.want')} value={resolution} onChange={setResolution} options={[{ value: 'refund', label: t('returns.refund') }, { value: 'exchange', label: t('returns.exchange') }]} />
          <Field testID="return-reason" label={t('returns.reason')} value={reason} onChangeText={setReason} multiline maxLength={500} error={fieldErrors.reason} />
          <Section title={t('returns.proof')}>
            <Text variant="small">{t('returns.proofHint')}</Text>
            {files.map((file, i) => <ListRow key={`${file.uri}-${i}`} testID={`proof-${i}`} title={file.name} subtitle={file.type} end={<Button kind="quiet" label={t('returns.removeFile')} onPress={() => setFiles((now) => now.filter((_, j) => j !== i))} />} />)}
            {files.length < PROOF_MAX_FILES ? <Button testID="proof-add" kind="secondary" label={t('returns.addProof')} onPress={addFiles} /> : null}
            {tried && !files.length ? <Text variant="meta" tone="bad" accessibilityRole="alert">{fieldErrors.proof || t('returns.needProof')}</Text> : null}
          </Section>
          <Button testID="return-send" label={t('returns.send')} busy={busy} onPress={send} />
        </>
      ) : null}
    </Screen>
  );
}
