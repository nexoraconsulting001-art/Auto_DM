/** The store's front page (P-27): its name and logo, a search entry, then the blocks the seller arranged, from the home feed. */
import React from 'react';
import { Pressable, ScrollView, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core/strings';
import { Card, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../services.js';
import { useBootstrap, useBrowseQuery } from '../../shell/data.js';
import { Chips, Photo, ProductTile, ReelTile, ReelVideo, Shown, openIfOwn } from '../../shell/parts.js';
import { Countdown } from './blocks.js';

const KINDS = ['privacy', 'terms', 'refund', 'shipping'];

function Header({ brand, logoUrl }) {
  const theme = useTheme();
  return (
    <View testID="home-header" style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
      {logoUrl ? <View style={{ width: 40 }}><Photo uri={logoUrl} name={brand.name} ratio={1} testID="brand-logo" /></View> : null}
      <Text variant="page" testID="brand-name" style={{ flexShrink: 1 }}>{brand.name}</Text>
    </View>
  );
}

function Block({ block, home, go, brand }) {
  const theme = useTheme();
  const { t } = useStrings();
  const { settings } = block;
  switch (block.type) {
    case 'hero': {
      const reel = home.reels[0];
      const lead = reel ?? home.products[0];
      if (!lead) return null;
      const label = reel ? reel.title : lead.name;
      return (
        <Pressable testID="block-hero" accessibilityRole="button" accessibilityLabel={label} onPress={() => (reel ? go('reels.reel', { slug: lead.slug }) : go('product.index', { slug: lead.slug }))}>
          <Photo uri={lead.image} name={label} ratio={4 / 3} />
        </Pressable>
      );
    }
    case 'shelves':
      return (
        <View testID="block-shelves" style={{ gap: theme.space[5] }}>
          {home.categories.length ? <Chips items={home.categories} value={null} onChange={(slug) => slug && go('category.index', { slug })} testID="home-categories" /> : null}
          {home.reels.length ? (
            <Section title={t('home.shelf.reels')} action={<Text variant="small" tone="primary" onPress={() => go('reels.index')}>{t('home.common.seeAll')}</Text>}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: theme.space[3] }}>
                {home.reels.map((reel) => <ReelTile key={reel.slug} reel={reel} width={120} onPress={() => go('reels.reel', { slug: reel.slug })} />)}
              </ScrollView>
            </Section>
          ) : null}
          {home.products.length ? (
            <Section title={t('home.shelf.products')} action={<Text variant="small" tone="primary" onPress={() => go('catalog.index')}>{t('home.common.seeAll')}</Text>}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[3] }}>
                {home.products.map((product) => (
                  <View key={product.slug} style={{ width: '47%' }}><ProductTile product={product} onPress={() => go('product.index', { slug: product.slug })} /></View>
                ))}
              </View>
            </Section>
          ) : null}
        </View>
      );
    case 'banner':
      return (
        <Pressable testID="block-banner" onPress={() => settings.linkUrl && openIfOwn(settings.linkUrl, brand)} accessibilityRole={settings.linkUrl ? 'link' : undefined} style={{ gap: theme.space[2] }}>
          {settings.imageUrl ? <Photo uri={settings.imageUrl} name={settings.text} ratio={16 / 9} /> : null}
          {settings.text ? <Text variant="title">{settings.text}</Text> : null}
        </Pressable>
      );
    case 'countdown':
      return <Countdown testID="block-countdown" text={settings.text} endsAt={settings.endsAt} />;
    case 'trust':
    case 'testimonials':
    case 'faq':
      return settings.items.length ? (
        <Card testID={`block-${block.type}`}>
          <Text variant="title">{t(`home.block.${block.type}`)}</Text>
          {settings.items.map((item, i) => (
            <View key={i} style={{ gap: 2 }}>
              {item.title ? <Text variant="small" style={{ color: theme.color.ink }}>{item.title}</Text> : null}
              {item.text ? <Text variant="small">{item.text}</Text> : null}
            </View>
          ))}
        </Card>
      ) : null;
    case 'video':
      return settings.url ? <View testID="block-video"><ReelVideo uri={settings.url} poster="" name={brand.name} /></View> : null;
    case 'bulk_order':
      return settings.text ? <Card testID="block-bulk"><Text variant="small">{settings.text}</Text></Card> : null;
    default:
      return null; // lead forms, the ticker and chat links belong to the website; the app draws what it has a screen for
  }
}

export default function HomeScreen() {
  const { t } = useStrings();
  const theme = useTheme();
  const { config } = useServices();
  const navigation = useNavigation();
  const go = (name, params) => navigation.navigate(name, params);
  const home = useBrowseQuery(['home'], (browse) => browse.home());
  const bootstrap = useBootstrap();
  const logo = bootstrap.data?.theme?.logoUrl;
  const email = bootstrap.data?.supportEmail || config.brand.supportEmail;
  return (
    <Screen testID="screen-home">
      <Header brand={config.brand} logoUrl={typeof logo === 'string' && /^https?:\/\//i.test(logo) ? logo : ''} />
      <Pressable testID="home-search" accessibilityRole="search" accessibilityLabel={t('home.search')} onPress={() => go('search.index')} style={{ minHeight: theme.tap.large, justifyContent: 'center', paddingHorizontal: theme.space[4], borderRadius: theme.radius.field, borderWidth: 1, borderColor: theme.color.line, backgroundColor: theme.color.surface }}>
        <Text variant="small" tone="muted">{t('home.search')}</Text>
      </Pressable>
      <Shown query={home}>
        {(data) => (
          <View style={{ gap: theme.space[5] }}>
            {data.blocks.map((block, i) => <Block key={`${block.type}-${i}`} block={block} home={data} go={go} brand={config.brand} />)}
            {data.blocks.length === 0 ? <Block block={{ type: 'shelves', settings: { items: [] } }} home={data} go={go} brand={config.brand} /> : null}
          </View>
        )}
      </Shown>
      <View testID="home-footer" style={{ gap: theme.space[2] }}>
        {KINDS.map((kind) => <Text key={kind} variant="small" tone="primary" testID={`policy-${kind}`} accessibilityRole="link" onPress={() => go('legal.index', { kind })}>{t(`legal.kind.${kind}`)}</Text>)}
        {email ? <Text variant="caption" testID="support-email" selectable>{email}</Text> : null}
      </View>
    </Screen>
  );
}
