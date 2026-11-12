/** Saved addresses: add, change, remove, and make one the default. Needs a signed-in shopper; checkout works without. */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core/strings';
import { Badge, Button, Card, ConfirmSheet, EmptyState, LoadingRows, Screen, Sheet, Text, useTheme } from '@bhava/ui';
import { NeedSignIn, Problem, useBuy, useSessionState, useStoreQuery } from '../cart/ui.js';
import { AddressForm } from './AddressForm.js';
import { EMPTY_ADDRESS, addressProblems, stateName } from './states.js';

const FIELDS = ['name', 'phone', 'line1', 'line2', 'landmark', 'city', 'stateCode', 'pincode', 'kind', 'isDefault'];
const bodyOf = (a) => Object.fromEntries(FIELDS.map((f) => [f, a[f]]).filter(([, v]) => v !== undefined));

export default function AddressesScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { buy } = useBuy();
  const state = useSessionState();
  const signedIn = state.status === 'signedIn';
  const list = useStoreQuery(['addresses'], () => buy.call('addresses'), { enabled: signedIn });
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [fieldErrors, setFieldErrors] = useState({});
  const [tried, setTried] = useState(false);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['buy', 'addresses'] });
  const open = (address) => { setEditing(address); setError(null); setFieldErrors({}); setTried(false); };

  async function save() {
    setTried(true);
    if (Object.keys(addressProblems(editing)).length) return;
    setBusy(true);
    setError(null);
    try {
      if (editing.id) await buy.call('addressUpdate', { params: { id: editing.id }, body: bodyOf(editing) });
      else await buy.call('addressCreate', { body: bodyOf(editing) });
      setEditing(null);
      await refresh();
    } catch (failed) {
      setError(failed);
      setFieldErrors(failed.fields ?? {});
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await buy.call('addressRemove', { params: { id: removing.id } });
      setRemoving(null);
      await refresh();
    } catch (failed) {
      setError(failed);
    } finally {
      setBusy(false);
    }
  }

  if (!signedIn) {
    return (
      <Screen testID="screen-addresses" title={t('addresses.title')}>
        <NeedSignIn go={(name) => navigation.navigate(name)} />
      </Screen>
    );
  }
  const items = list.data?.items ?? [];
  return (
    <Screen testID="screen-addresses" title={t('addresses.title')}>
      {list.isError ? <Problem error={list.error} onRetry={() => list.refetch()} /> : null}
      {list.isPending ? <LoadingRows rows={2} label={t('home.common.loading')} testID="addresses-loading" /> : null}
      {list.data && items.length === 0 ? <EmptyState testID="addresses-empty" title={t('addresses.emptyTitle')}>{t('addresses.emptyBody')}</EmptyState> : null}
      {items.map((a) => (
        <Card key={a.id} testID={`address-${a.id}`}>
          <View style={{ gap: theme.space[1] }}>
            <View style={{ flexDirection: 'row', gap: theme.space[2], alignItems: 'center' }}>
              <Text variant="title">{a.name}</Text>
              {a.isDefault ? <Badge tone="primary" label={t('addresses.default')} /> : null}
            </View>
            <Text variant="body">{[a.line1, a.line2, a.landmark, a.city, a.state || stateName(a.stateCode), a.pincode].filter(Boolean).join(', ')}</Text>
            <Text variant="small">{a.phone}</Text>
          </View>
          <View style={{ flexDirection: 'row', gap: theme.space[2], marginTop: theme.space[3], flexWrap: 'wrap' }}>
            <Button testID={`address-edit-${a.id}`} kind="secondary" label={t('addresses.edit')} onPress={() => open({ ...EMPTY_ADDRESS, ...a })} />
            <Button testID={`address-remove-${a.id}`} kind="quiet" label={t('addresses.remove')} onPress={() => setRemoving(a)} />
          </View>
        </Card>
      ))}
      <Button testID="address-add" label={t('addresses.add')} onPress={() => open({ ...EMPTY_ADDRESS, isDefault: items.length === 0 })} />
      <Sheet visible={Boolean(editing)} onClose={() => setEditing(null)} dismissable={!busy} title={editing?.id ? t('addresses.edit') : t('addresses.add')} closeLabel={t('addresses.close')} testID="address-sheet">
        {editing ? (
          <View style={{ gap: theme.space[3] }}>
            <Problem inline error={error} />
            <AddressForm value={editing} onChange={setEditing} errors={fieldErrors} showProblems={tried} />
            <Button testID="address-save" label={t('addresses.save')} busy={busy} onPress={save} />
          </View>
        ) : null}
      </Sheet>
      <ConfirmSheet visible={Boolean(removing)} title={t('addresses.removeTitle')} confirmLabel={t('addresses.remove')} cancelLabel={t('addresses.close')} busy={busy} onConfirm={remove} onCancel={() => setRemoving(null)} testID="address-remove-sheet">
        {t('addresses.removeBody')}
      </ConfirmSheet>
    </Screen>
  );
}
