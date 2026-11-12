import React, { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatWhen, useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, Divider, Field, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { Loadable, Page, Refusal, itemsOf, useConnection, usePaged } from '../products/kit.js';
import { HEX_COLOUR, THEME_TEXT } from '../products/limits.js';

export const THEME_KEY = ['theme'];

/** A colour from the server, only when it is a plain #RRGGBB: anything else is not drawn. */
const swatch = (value) => (typeof value === 'string' && HEX_COLOUR.test(value) ? value : null);

/**
 * A look drawn small: the preset's own ground, hero and accent colours, its name in its own words, what it is made for
 * (m-ThemePicker). The card is the seller's choice, so it is the only place a buyer-side colour shows in the app.
 */
function LookCard({ look, chosen, onPick, disabled, testID }) {
  const theme = useTheme();
  const { t } = useStrings();
  const colors = look.colors ?? {};
  const ground = swatch(colors.ground) ?? theme.color.surfaceSunken;
  const hero = swatch(colors.hero) ?? swatch(colors.primary) ?? theme.color.ink2;
  const accent = swatch(colors.accent) ?? theme.color.line;
  return (
    <Pressable
      testID={testID}
      onPress={disabled ? undefined : onPick}
      disabled={disabled}
      accessibilityRole="radio"
      accessibilityLabel={`${look.name}, ${look.madeFor}`}
      accessibilityState={{ checked: chosen, disabled }}
      style={{ flexDirection: 'row', gap: theme.space[3], alignItems: 'center', padding: theme.space[3], borderRadius: theme.radius.card, borderWidth: chosen ? 2 : 1, borderColor: chosen ? theme.color.primary : theme.color.line, backgroundColor: theme.color.surface, opacity: disabled ? 0.6 : 1 }}
    >
      <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden style={{ width: 72, height: 108, borderRadius: theme.radius.tile, backgroundColor: ground, padding: 6, gap: 6, borderWidth: 1, borderColor: theme.color.lineSoft }}>
        <View style={{ height: 44, borderRadius: Math.min(look.slots?.radius ?? 8, 20), backgroundColor: hero }} />
        <View style={{ flexDirection: 'row', gap: 4 }}>
          <View style={{ flex: 1, height: 22, borderRadius: 4, backgroundColor: accent }} />
          <View style={{ flex: 1, height: 22, borderRadius: 4, backgroundColor: hero, opacity: 0.6 }} />
        </View>
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="title">{look.name}</Text>
        <Text variant="small">{look.madeFor}</Text>
        <Text variant="caption">{t('themes.fonts', { heading: look.headingFont, body: look.bodyFont })}</Text>
        {chosen ? <Badge testID={`${testID}-current`} label={t('themes.current')} tone="primary" /> : null}
      </View>
    </Pressable>
  );
}

/** The seal and the moving strip on buyer pages, in the seller's own words; empty uses the look's (F-106). */
function ThemeText({ current }) {
  const { api } = useServices();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const { online } = useConnection();
  const [seal, setSeal] = useState(current.sealText);
  const [ticker, setTicker] = useState(current.tickerItems.join('\n'));
  const items = ticker.split('\n').map((s) => s.trim()).filter(Boolean);
  const problem = seal.length > THEME_TEXT.sealMax ? t('themes.text.sealLong', { max: THEME_TEXT.sealMax })
    : items.length > THEME_TEXT.tickerItems ? t('themes.text.tooMany', { max: THEME_TEXT.tickerItems })
      : items.some((i) => i.length > THEME_TEXT.tickerItemLength) ? t('themes.text.itemLong', { max: THEME_TEXT.tickerItemLength })
        : /[<>{}]/.test(seal + ticker) ? t('themes.text.markup') : null;
  const save = useMutation({ mutationFn: () => api.themes.updateText({ sealText: seal.trim(), tickerItems: items }), onSuccess: (answer) => queryClient.setQueryData([...THEME_KEY, 'current'], answer) });
  return (
    <Section title={t('themes.text.title')}>
      <Card>
        <Field testID="theme-seal" label={t('themes.text.seal')} hint={t('themes.text.sealHint')} value={seal} onChangeText={setSeal} />
        <Field testID="theme-ticker" label={t('themes.text.ticker')} hint={t('themes.text.tickerHint')} value={ticker} onChangeText={setTicker} multiline />
        {problem ? <Text variant="caption" tone="bad" testID="theme-text-problem">{problem}</Text> : null}
        <Refusal error={save.error} testID="theme-text-error" />
        {save.isSuccess ? <Text variant="caption" tone="good" testID="theme-text-saved">{t('themes.saved')}</Text> : null}
        <Button testID="theme-text-save" kind="secondary" label={t('common.save')} busy={save.isPending} disabled={!online || Boolean(problem)} onPress={() => save.mutate()} />
      </Card>
    </Section>
  );
}

/** Reading the look of the seller's own website (8.9): our team checks a read before it is used; applying saves it to the brand kit. */
function SiteReads() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const queryClient = useQueryClient();
  const { online } = useConnection();
  const [website, setWebsite] = useState('');
  const reads = usePaged([...THEME_KEY, 'reads'], (page) => api.themes.siteReads({ limit: 10, ...page }));
  const read = useMutation({ mutationFn: () => api.themes.readSite({ website: website.trim() }), onSuccess: () => queryClient.invalidateQueries({ queryKey: [...THEME_KEY, 'reads'] }) });
  const apply = useMutation({ mutationFn: (id) => api.themes.applySiteRead(id), onSuccess: (answer) => queryClient.setQueryData([...THEME_KEY, 'current'], answer) });
  const list = itemsOf(reads);
  return (
    <Section title={t('themes.site.title')}>
      <Card>
        <Text variant="small">{t('themes.site.intro')}</Text>
        <Field testID="theme-site" label={t('themes.site.website')} value={website} onChangeText={setWebsite} autoCapitalize="none" keyboardType="url" />
        <Button testID="theme-site-read" kind="secondary" label={t('themes.site.read')} busy={read.isPending} disabled={!online || website.trim().length < 4} onPress={() => read.mutate()} />
        <Refusal error={read.error} testID="theme-site-error" />
        <Loadable query={reads} empty={!list.length} testID="theme-reads" emptyTitle={t('themes.site.none')}>
          {list.map((r, i) => (
            <View key={r.id} testID={`theme-read-${r.id}`} style={{ gap: 4 }}>
              {i ? <Divider /> : null}
              <Text variant="small">{r.website}</Text>
              <View style={{ flexDirection: 'row', gap: 4, flexWrap: 'wrap' }}>
                <Badge label={t(`themes.site.status.${r.status}`)} tone={r.status === 'read' ? 'good' : r.status === 'script_only' ? 'warn' : 'bad'} />
                {Object.values(r.colors ?? {}).map(swatch).filter(Boolean).slice(0, 5).map((c) => <View key={c} accessibilityElementsHidden importantForAccessibility="no" style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: c }} />)}
              </View>
              {r.notes?.length ? <Text variant="caption">{r.notes.join(' ')}</Text> : null}
              <Text variant="caption">{r.appliedAt ? t('themes.site.applied', { when: formatWhen(t, r.appliedAt, { locale }) }) : formatWhen(t, r.createdAt, { locale })}</Text>
              {r.status === 'read' && !r.appliedAt ? <Button testID={`theme-read-${r.id}-apply`} kind="quiet" label={t('themes.site.apply')} busy={apply.isPending && apply.variables === r.id} disabled={!online} onPress={() => apply.mutate(r.id)} /> : null}
            </View>
          ))}
        </Loadable>
        <Refusal error={apply.error} testID="theme-apply-error" />
      </Card>
    </Section>
  );
}

/**
 * Your shop's look (PRD 5.3, 5.19, 8.9; m-ThemePicker): pick one of the looks made for what you sell. Switching changes
 * the look only; products, pages, links and orders stay as they are (F-103). The accent can be tuned from the logo.
 */
export default function ThemesScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const [tune, setTune] = useState(true);
  const presets = useQuery({ queryKey: [...THEME_KEY, 'presets'], queryFn: () => api.themes.presets() });
  const current = useQuery({ queryKey: [...THEME_KEY, 'current'], queryFn: () => api.themes.get() });
  const choose = useMutation({
    mutationFn: (preset) => api.themes.choose({ preset, tuneAccent: tune }),
    onSuccess: (answer) => {
      queryClient.setQueryData([...THEME_KEY, 'current'], answer);
      queryClient.invalidateQueries({ queryKey: ['brand-kit'] });
    },
  });
  const looks = presets.data?.items ?? [];
  const now = current.data;
  return (
    <Page testID="screen-themes" offline={offline}>
      <Text variant="page">{t('themes.title')}</Text>
      <Card>
        <Text variant="title">{t('themes.hero.title')}</Text>
        <Text variant="small">{t('themes.hero.body')}</Text>
      </Card>
      {now?.check ? <Banner tone="warn" testID="theme-check">{t('themes.check')}</Banner> : null}
      <Toggle testID="theme-tune" title={t('themes.tune')} subtitle={t('themes.tuneHint')} value={tune} onValueChange={setTune} disabled={!online} />
      <Loadable query={presets} empty={!looks.length} testID="theme-looks" emptyTitle={t('themes.none')}>
        <View accessibilityRole="radiogroup" accessibilityLabel={t('themes.title')} style={{ gap: 12 }}>
          {looks.map((look) => (
            <LookCard key={look.code} testID={`look-${look.code}`} look={look} chosen={now?.preset === look.code} disabled={!online || choose.isPending} onPick={() => choose.mutate(look.code)} />
          ))}
        </View>
      </Loadable>
      {!online ? <Text variant="caption">{t('offline.writeDisabled')}</Text> : null}
      <Refusal error={choose.error} testID="theme-choose-error" />
      {choose.isSuccess ? <Banner tone="good" testID="theme-chosen">{t('themes.chosen', { name: choose.data.presetName })}</Banner> : null}
      {now ? <ThemeText key={`${now.preset}-${now.sealText}`} current={now} /> : null}
      <SiteReads />
    </Page>
  );
}
