/** One delivery address to fill in. Used by Addresses and by checkout. `errors` are the server's words by field, when it refused. */
import React, { useState } from 'react';
import { View } from 'react-native';
import { useStrings } from '@bhava/app-core/strings';
import { Choices, Field, ListRow, Sheet, Text, useTheme } from '@bhava/ui';
import { STATES, addressProblems, stateName } from './states.js';

export function AddressForm({ value, onChange, errors = {}, showProblems = false, withKind = true }) {
  const { t } = useStrings();
  const theme = useTheme();
  const [picking, setPicking] = useState(false);
  const own = showProblems ? addressProblems(value) : {};
  const say = (field) => errors[field] || (own[field] ? t(`addresses.bad.${field}`) : undefined);
  const set = (field) => (text) => onChange({ ...value, [field]: text });
  return (
    <View style={{ gap: theme.space[3] }} testID="address-form">
      <Field testID="addr-name" label={t('addresses.name')} value={value.name} onChangeText={set('name')} error={say('name')} autoComplete="name" textContentType="name" />
      <Field testID="addr-phone" label={t('addresses.phone')} value={value.phone} onChangeText={set('phone')} error={say('phone')} keyboardType="phone-pad" autoComplete="tel" textContentType="telephoneNumber" />
      <Field testID="addr-line1" label={t('addresses.line1')} value={value.line1} onChangeText={set('line1')} error={say('line1')} autoComplete="street-address" textContentType="streetAddressLine1" />
      <Field testID="addr-line2" label={t('addresses.line2')} value={value.line2} onChangeText={set('line2')} error={errors.line2} textContentType="streetAddressLine2" />
      <Field testID="addr-landmark" label={t('addresses.landmark')} value={value.landmark} onChangeText={set('landmark')} error={errors.landmark} />
      <Field testID="addr-pincode" label={t('addresses.pincode')} value={value.pincode} onChangeText={(v) => set('pincode')(v.replace(/\D/g, '').slice(0, 6))} error={say('pincode')} keyboardType="number-pad" autoComplete="postal-code" textContentType="postalCode" maxLength={6} />
      <Field testID="addr-city" label={t('addresses.city')} value={value.city} onChangeText={set('city')} error={say('city')} textContentType="addressCity" />
      <View>
        <ListRow testID="addr-state" title={t('addresses.state')} subtitle={stateName(value.stateCode) || t('addresses.pickState')} onPress={() => setPicking(true)} />
        {say('stateCode') ? <Text variant="meta" tone="bad" accessibilityRole="alert">{say('stateCode')}</Text> : null}
      </View>
      {withKind ? (
        <Choices
          testID="addr-kind"
          label={t('addresses.kind')}
          value={value.kind}
          onChange={(kind) => onChange({ ...value, kind })}
          options={[{ value: 'home', label: t('addresses.home') }, { value: 'work', label: t('addresses.work') }, { value: 'other', label: t('addresses.other') }]}
        />
      ) : null}
      <Sheet visible={picking} onClose={() => setPicking(false)} title={t('addresses.state')} closeLabel={t('addresses.close')} testID="state-sheet">
        {STATES.map((state) => (
          <ListRow key={state.code} testID={`state-${state.code}`} title={state.name} onPress={() => { onChange({ ...value, stateCode: state.code }); setPicking(false); }} />
        ))}
      </Sheet>
    </View>
  );
}
