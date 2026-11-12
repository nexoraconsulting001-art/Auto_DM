import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { Banner, Button, Card, Choices, Divider, Field, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { Loadable, Page, Refusal, useConnection } from '../products/kit.js';
import { BLOCK_SURFACES, PAGE_SURFACES } from '../products/limits.js';
import { moveItem } from '../categories/sequence.js';
import { PAGES_KEY } from './PagesScreen.js';

/**
 * Page settings (8.11, 8.12): the "Order on WhatsApp" button and its message (which must keep {product}), whether
 * landing pages are kept out of search engines, and "More reels" under each page. The button never shows when the
 * business has no WhatsApp number or its plan lacks it; the server says which.
 */
export function PageSettingsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const settings = useQuery({ queryKey: [...PAGES_KEY, 'settings'], queryFn: () => api.pageSettings.get() });
  const [template, setTemplate] = useState(null);
  const update = useMutation({
    mutationFn: (body) => api.pageSettings.update(body),
    onSuccess: (answer) => {
      queryClient.setQueryData([...PAGES_KEY, 'settings'], answer);
      setTemplate(null);
    },
  });
  const data = settings.data;
  const text = template ?? data?.whatsappTemplate ?? '';
  const templateBad = !text.includes('{product}') ? 'pages.settings.keepProduct' : !text.trim() ? 'pages.settings.writeMessage' : null;
  return (
    <Page testID="screen-page-settings" offline={offline}>
      <Text variant="page">{t('pages.settings.title')}</Text>
      <Loadable query={settings} testID="page-settings">
        {data ? (
          <>
            <Card>
              <Toggle testID="page-settings-whatsapp" title={t('pages.settings.whatsapp')} subtitle={data.whatsappAvailable ? t('pages.settings.whatsappTo', { number: data.whatsappNumber }) : t('pages.settings.whatsappUnavailable')} value={data.whatsappOrder && data.whatsappAvailable} disabled={!online || !data.whatsappAvailable || update.isPending} onValueChange={(whatsappOrder) => update.mutate({ whatsappOrder })} />
              <Field testID="page-settings-template" label={t('pages.settings.template')} hint={t('pages.settings.templateHint')} value={text} onChangeText={setTemplate} multiline maxLength={500} error={template !== null && templateBad ? t(templateBad) : null} />
              <Button testID="page-settings-template-save" kind="secondary" label={t('common.save')} disabled={!online || template === null || Boolean(templateBad)} busy={update.isPending} onPress={() => update.mutate({ whatsappTemplate: text })} />
            </Card>
            <Card>
              <Toggle testID="page-settings-noindex" title={t('pages.settings.noindex')} subtitle={t('pages.settings.noindexHint')} value={data.landingNoindex} disabled={!online || update.isPending} onValueChange={(landingNoindex) => update.mutate({ landingNoindex })} />
              <Toggle testID="page-settings-more" title={t('pages.settings.moreReels')} subtitle={t('pages.settings.moreReelsHint')} value={data.moreReels} disabled={!online || update.isPending} onValueChange={(moreReels) => update.mutate({ moreReels })} />
            </Card>
            {!online ? <Text variant="caption">{t('offline.writeDisabled')}</Text> : null}
            <Refusal error={update.error} testID="page-settings-error" />
          </>
        ) : null}
      </Loadable>
    </Page>
  );
}

/**
 * The layout of a surface (5.18, F-105): its blocks in order, each shown or hidden, the same in every look. Only blocks
 * that belong on the surface can be added. Saving writes the whole layout; a block's own settings are kept as they are.
 */
export function PageLayoutScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const [surface, setSurface] = useState('landing');
  const layout = useQuery({ queryKey: [...PAGES_KEY, 'blocks', surface], queryFn: () => api.pageBlocks.get({ surface }) });
  const [blocks, setBlocks] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    setBlocks(null);
    setSaved(false);
  }, [surface]);
  const shown = blocks ?? layout.data?.blocks ?? [];
  const change = (next) => {
    setSaved(false);
    setBlocks(next);
  };
  const save = useMutation({
    mutationFn: () => api.pageBlocks.save({ surface, blocks: shown.map((b) => ({ block: b.block, visible: b.visible, settings: b.settings ?? {} })) }),
    onSuccess: (answer) => {
      queryClient.setQueryData([...PAGES_KEY, 'blocks', surface], answer);
      setBlocks(null);
      setSaved(true);
    },
  });
  const allowed = Object.keys(BLOCK_SURFACES).filter((name) => BLOCK_SURFACES[name].includes(surface) && !shown.some((b) => b.block === name));
  return (
    <Page testID="screen-page-layout" offline={offline}>
      <Text variant="page">{t('pages.layout.title')}</Text>
      <Text variant="small">{t('pages.layout.intro')}</Text>
      <Choices testID="page-layout-surface" label={t('pages.layout.surface')} value={surface} onChange={setSurface} options={PAGE_SURFACES.map((s) => ({ value: s, label: t(`pages.surface.${s}`) }))} />
      <Loadable query={layout} empty={!shown.length} testID="page-layout" emptyTitle={t('pages.layout.empty')}>
        {layout.data && !layout.data.custom && !blocks ? <Text variant="caption" testID="page-layout-default">{t('pages.layout.default')}</Text> : null}
        <Card>
          {shown.map((b, i) => (
            <View key={b.block} testID={`block-${b.block}`} style={{ gap: theme.space[1] }}>
              {i ? <Divider /> : null}
              <Toggle testID={`block-${b.block}-visible`} title={t(`pages.block.${b.block}`)} value={b.visible} onValueChange={(visible) => change(shown.map((x) => (x.block === b.block ? { ...x, visible } : x)))} />
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[1] }}>
                <Button testID={`block-${b.block}-up`} kind="quiet" label={t('pages.layout.up')} disabled={i === 0} onPress={() => change(moveItem(shown, i, i - 1))} />
                <Button testID={`block-${b.block}-down`} kind="quiet" label={t('pages.layout.down')} disabled={i === shown.length - 1} onPress={() => change(moveItem(shown, i, i + 1))} />
                <Button testID={`block-${b.block}-remove`} kind="quiet" label={t('products.remove')} onPress={() => change(shown.filter((x) => x.block !== b.block))} />
              </View>
            </View>
          ))}
        </Card>
      </Loadable>
      {allowed.length ? (
        <Section title={t('pages.layout.add')}>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
            {allowed.map((name) => <Button key={name} testID={`block-add-${name}`} kind="secondary" label={t(`pages.block.${name}`)} onPress={() => change([...shown, { block: name, visible: true, settings: {} }])} />)}
          </View>
        </Section>
      ) : null}
      <Refusal error={save.error} testID="page-layout-error" />
      {saved ? <Banner tone="good" testID="page-layout-saved">{t('pages.saved')}</Banner> : null}
      <Button testID="page-layout-save" label={t('common.save')} busy={save.isPending} disabled={!online || !blocks} onPress={() => save.mutate()} />
      {!online ? <Text variant="caption">{t('offline.writeDisabled')}</Text> : null}
    </Page>
  );
}
