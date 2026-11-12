import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { Banner, Button, Card, Choices, Divider, Field, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { Loadable, Page, PhotoField, Refusal, itemsOf, useConnection, usePaged } from '../products/kit.js';
import { HEX_COLOUR } from '../products/limits.js';
import { brandKitBody } from './rules.js';

export const BRAND_KIT_KEY = ['brand-kit'];

const toForm = (kit) => ({ logoUrl: kit.logoUrl, logoDarkUrl: kit.logoDarkUrl, faviconUrl: kit.faviconUrl, colors: { ...kit.colors }, headingFont: kit.headingFont, bodyFont: kit.bodyFont, replies: (kit.publicReplyVariants ?? []).join('\n') });

/**
 * The brand kit (PRD 5.3): the business's logos, colours, fonts and the public replies its automations use, everything a
 * buyer sees. The screen itself is the app's own; only the swatches show the business's colours.
 */
export default function BrandKitScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const kit = useQuery({ queryKey: [...BRAND_KIT_KEY, 'current'], queryFn: () => api.brandKit.get() });
  const presets = usePaged([...BRAND_KIT_KEY, 'presets'], (page) => api.brandKit.presets({ limit: 20, ...page }));
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (kit.data && !form) setForm(toForm(kit.data));
  }, [kit.data, form]);
  const set = (patch) => {
    setSaved(false);
    setForm((old) => ({ ...old, ...patch }));
  };
  const done = (answer) => {
    queryClient.setQueryData([...BRAND_KIT_KEY, 'current'], answer);
    queryClient.invalidateQueries({ queryKey: ['theme'] });
    setForm(toForm(answer));
    setSaved(true);
  };
  const save = useMutation({ mutationFn: (body) => api.brandKit.update(body), onSuccess: done });
  function submit() {
    const read = brandKitBody(kit.data, form);
    setErrors(read.errors ?? {});
    if (read.errors) return;
    if (!Object.keys(read.body).length) {
      setSaved(true);
      return;
    }
    save.mutate(read.body);
  }
  const looks = itemsOf(presets);
  const data = kit.data;
  return (
    <Page testID="screen-brand-kit" offline={offline}>
      <Text variant="page">{t('brand-kit.title')}</Text>
      <Text variant="small">{t('brand-kit.intro')}</Text>
      <Loadable query={kit} testID="brand-kit">
        {data && form ? (
          <>
            {looks.length ? (
              <Section title={t('brand-kit.preset')}>
                <Choices testID="brand-kit-preset" label={t('brand-kit.preset')} value={data.preset} disabled={!online || save.isPending} onChange={(preset) => save.mutate({ preset })} options={looks.map((l) => ({ value: l.code, label: l.name }))} />
              </Section>
            ) : null}
            <Card>
              <PhotoField testID="brand-kit-logo" label={t('brand-kit.logo')} urls={form.logoUrl ? [form.logoUrl] : []} max={1} disabled={!online} onChange={(urls) => set({ logoUrl: urls[0] ?? '' })} />
              <PhotoField testID="brand-kit-logo-dark" label={t('brand-kit.logoDark')} urls={form.logoDarkUrl ? [form.logoDarkUrl] : []} max={1} disabled={!online} onChange={(urls) => set({ logoDarkUrl: urls[0] ?? '' })} />
              <PhotoField testID="brand-kit-favicon" label={t('brand-kit.favicon')} urls={form.faviconUrl ? [form.faviconUrl] : []} max={1} disabled={!online} onChange={(urls) => set({ faviconUrl: urls[0] ?? '' })} />
            </Card>
            <Section title={t('brand-kit.colors')}>
              <Card>
                <Text variant="caption">{t('brand-kit.colorsHint')}</Text>
                {Object.keys(form.colors).map((slot, i) => {
                  const value = String(form.colors[slot] ?? '');
                  return (
                    <View key={slot} style={{ gap: 4 }}>
                      {i ? <Divider /> : null}
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
                        <View accessibilityElementsHidden importantForAccessibility="no" style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 1, borderColor: theme.color.line, backgroundColor: HEX_COLOUR.test(value) ? value : 'transparent' }} />
                        <View style={{ flex: 1 }}>
                          <Field testID={`brand-kit-color-${slot}`} label={t('brand-kit.colorSlot', { slot })} value={value} autoCapitalize="none" onChangeText={(v) => set({ colors: { ...form.colors, [slot]: v } })} error={errors[`color.${slot}`] ? t(errors[`color.${slot}`]) : null} />
                        </View>
                      </View>
                    </View>
                  );
                })}
              </Card>
            </Section>
            <Card>
              <Field testID="brand-kit-heading-font" label={t('brand-kit.headingFont')} value={form.headingFont} onChangeText={(headingFont) => set({ headingFont })} error={errors.headingFont ? t(errors.headingFont) : null} />
              <Field testID="brand-kit-body-font" label={t('brand-kit.bodyFont')} value={form.bodyFont} onChangeText={(bodyFont) => set({ bodyFont })} error={errors.bodyFont ? t(errors.bodyFont) : null} />
              <Field testID="brand-kit-replies" label={t('brand-kit.replies')} hint={t('brand-kit.repliesHint')} value={form.replies} onChangeText={(replies) => set({ replies })} multiline error={errors.replies ? t(errors.replies) : null} />
            </Card>
            <Refusal error={save.error} testID="brand-kit-error" />
            {saved ? <Banner tone="good" testID="brand-kit-saved">{t('brand-kit.saved')}</Banner> : null}
            <Button testID="brand-kit-save" label={t('common.save')} busy={save.isPending} disabled={!online} onPress={submit} />
            {!online ? <Text variant="caption">{t('offline.writeDisabled')}</Text> : null}
          </>
        ) : null}
      </Loadable>
    </Page>
  );
}
