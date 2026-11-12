import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core';
import { MANAGERS } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, Divider, Field, ListRow, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { AddressRow, Loadable, MoreButton, Page, PhotoField, Refusal, Thumb, itemsOf, useCan, useConnection, usePaged } from '../products/kit.js';
import { CATALOG, LANDING_KINDS, PAGE_SLUG } from '../products/limits.js';
import { formatMoney } from '../products/money.js';
import { moveItem } from '../categories/sequence.js';
import { figureText } from '../insights/figures.js';

export const PAGES_KEY = ['pages'];
const pageKey = (id) => [...PAGES_KEY, 'one', String(id)];
const LEAD_CHOICES = ['follow', 'on', 'off'];
const leadToForm = (v) => (v === null || v === undefined ? 'follow' : v ? 'on' : 'off');
const leadToApi = (v) => (v === 'follow' ? null : v === 'on');

/**
 * Products on a page, in the page's order (K-30): move, remove, and add from the catalog. `limit` is the plan's
 * (1 on tier 1, up to 20 above, K-41); more is refused by the server with an upgrade note, which is shown as it says.
 */
function ProductList({ value, onChange, limit = CATALOG.landingProducts, disabled }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const found = useQuery({ queryKey: ['products', 'list', 'picker', search], queryFn: () => api.products.list({ status: 'active', search: search || undefined, limit: 20 }), enabled: open });
  const chosen = new Set(value.map((p) => p.id));
  return (
    <Section title={t('pages.products.title', { count: value.length, limit })}>
      <Card testID="page-products">
        {!value.length ? <Text variant="small">{t('pages.products.none')}</Text> : null}
        {value.map((product, i) => (
          <View key={product.id} testID={`page-product-${product.id}`} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
            <Text variant="caption">{String(i + 1)}</Text>
            <View style={{ flex: 1 }}>
              <ListRow title={product.name} subtitle={[formatMoney(product.pricePaise), product.soldOut ? t('products.badge.soldOut') : null].filter(Boolean).join(' · ')} start={<Thumb uri={product.image} size={40} label={product.name} />} />
            </View>
            <Button testID={`page-product-${product.id}-up`} kind="quiet" label={t('pages.products.up')} disabled={disabled || i === 0} onPress={() => onChange(moveItem(value, i, i - 1))} />
            <Button testID={`page-product-${product.id}-remove`} kind="quiet" label={t('products.remove')} disabled={disabled} onPress={() => onChange(value.filter((p) => p.id !== product.id))} />
          </View>
        ))}
        {value.length < limit ? <Button testID="page-products-add" kind="secondary" label={t('pages.products.add')} disabled={disabled} onPress={() => setOpen(!open)} /> : <Text variant="caption" testID="page-products-full">{t('pages.products.full', { limit })}</Text>}
        {open ? (
          <View style={{ gap: theme.space[2] }}>
            <Field testID="page-products-search" label={t('products.search')} value={search} onChangeText={setSearch} />
            <Loadable query={found} empty={!(found.data?.items ?? []).length} testID="page-products-found" emptyTitle={t('products.emptyFiltered')}>
              {(found.data?.items ?? []).filter((p) => !chosen.has(p.id)).map((p) => (
                <ListRow
                  key={p.id}
                  testID={`page-products-pick-${p.id}`}
                  title={p.name}
                  subtitle={formatMoney(p.display?.pricePaise ?? p.pricePaise)}
                  start={<Thumb uri={p.images?.[0]} size={40} label={p.name} />}
                  onPress={() => {
                    onChange([...value, { id: p.id, name: p.name, pricePaise: p.display?.pricePaise ?? p.pricePaise, image: p.images?.[0] ?? '', active: p.active, soldOut: Boolean(p.display?.soldOut), position: value.length }]);
                    if (value.length + 1 >= limit) setOpen(false);
                  }}
                />
              ))}
            </Loadable>
          </View>
        ) : null}
      </Card>
    </Section>
  );
}

/**
 * Landing pages (PRD 8.10): one per automated reel, post or story, at a direct address on the business's own host,
 * which is the link the DM sends (K-32: no redirect, no shortener). Each shows its products in the owner's order.
 */
export default function PagesScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const navigation = useNavigation();
  const can = useCan();
  const { online, offline } = useConnection();
  const [kind, setKind] = useState('all');
  const [status, setStatus] = useState('all');
  const list = usePaged([...PAGES_KEY, 'list', kind, status], (page) => api.pages.list({ kind, status, limit: 30, ...page }));
  const items = itemsOf(list);
  return (
    <Page testID="screen-pages" offline={offline}>
      <Text variant="page">{t('pages.title')}</Text>
      <Text variant="small">{t('pages.intro')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        <Button testID="pages-add" label={t('pages.add')} disabled={!online} onPress={() => navigation.navigate('pages.create')} />
        {can(MANAGERS) ? <Button testID="pages-open-settings" kind="secondary" label={t('pages.settings.title')} onPress={() => navigation.navigate('pages.settings')} /> : null}
        {can(MANAGERS) ? <Button testID="pages-open-layout" kind="quiet" label={t('pages.layout.title')} onPress={() => navigation.navigate('pages.layout')} /> : null}
      </View>
      <Choices testID="pages-kind" label={t('pages.kindLabel')} value={kind} onChange={setKind} options={['all', ...LANDING_KINDS].map((k) => ({ value: k, label: t(`pages.kind.${k}`) }))} />
      <Choices testID="pages-status" label={t('pages.statusLabel')} value={status} onChange={setStatus} options={['all', 'active', 'inactive'].map((s) => ({ value: s, label: t(`pages.status.${s}`) }))} />
      <Loadable query={list} empty={!items.length} testID="pages-list" emptyTitle={t('pages.empty')} emptyBody={t('pages.emptyBody')}>
        <Card>
          {items.map((page, i) => (
            <View key={page.id}>
              {i ? <Divider /> : null}
              <ListRow
                testID={`page-${page.id}`}
                start={<Thumb uri={page.thumbnailUrl} label={page.headline || page.slug} />}
                title={page.headline || page.slug}
                subtitle={`${t(`pages.kind.${page.kind}`)} · ${t('pages.productCount', { count: page.productCount })} · ${t('pages.visits', { count: figureText(t, page.visits) })}`}
                end={<Badge label={t(page.active ? 'pages.status.active' : 'pages.status.inactive')} tone={page.active ? 'good' : 'neutral'} />}
                onPress={() => navigation.navigate('pages.detail', { id: String(page.id) })}
              />
            </View>
          ))}
        </Card>
        <MoreButton query={list} testID="pages-more" />
      </Loadable>
    </Page>
  );
}

/** A new landing page: pick the post, reel or story, then its products. Its address is made from the slug, on your own host. */
export function PageCreateScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const [kind, setKind] = useState('all');
  const [media, setMedia] = useState(null);
  const [products, setProducts] = useState([]);
  const [slug, setSlug] = useState('');
  const [headline, setHeadline] = useState('');
  const choices = usePaged([...PAGES_KEY, 'media', kind], (page) => api.pages.media({ kind, limit: 24, ...page }));
  const posts = itemsOf(choices);
  const slugBad = slug.trim() !== '' && !PAGE_SLUG.test(slug.trim().toLowerCase());
  const create = useMutation({
    mutationFn: () => api.pages.create({
      channel: media.channel, kind: media.kind, mediaId: media.mediaId, productIds: products.map((p) => p.id),
      ...(slug.trim() ? { slug: slug.trim().toLowerCase() } : {}), ...(headline.trim() ? { headline: headline.trim() } : {}),
    }),
    onSuccess: (page) => {
      queryClient.setQueryData(pageKey(page.id), page);
      queryClient.invalidateQueries({ queryKey: [...PAGES_KEY, 'list'] });
      navigation.replace?.('pages.detail', { id: String(page.id) });
    },
  });
  return (
    <Page testID="screen-page-create" offline={offline}>
      <Text variant="page">{t('pages.add')}</Text>
      <Section title={t('pages.create.pick')}>
        <Choices testID="page-media-kind" label={t('pages.kindLabel')} value={kind} onChange={setKind} options={['all', ...LANDING_KINDS].map((k) => ({ value: k, label: t(`pages.kind.${k}`) }))} />
        <Loadable query={choices} empty={!posts.length} testID="page-media" emptyTitle={t('pages.create.noPosts')} emptyBody={t('pages.create.noPostsBody')}>
          <Card>
            {posts.map((post, i) => (
              <View key={`${post.channel}-${post.mediaId}`}>
                {i ? <Divider /> : null}
                <ListRow
                  testID={`page-media-${post.mediaId}`}
                  start={<Thumb uri={post.thumbnailUrl} label={post.caption || t(`pages.kind.${post.kind}`)} />}
                  title={post.caption || t(`pages.kind.${post.kind}`)}
                  subtitle={post.pageId ? t('pages.create.hasPage') : t(`pages.kind.${post.kind}`)}
                  end={media?.mediaId === post.mediaId ? <Badge label={t('pages.create.chosen')} tone="primary" /> : null}
                  disabled={Boolean(post.pageId)}
                  onPress={() => setMedia(post)}
                />
              </View>
            ))}
          </Card>
          <MoreButton query={choices} testID="page-media-more" />
        </Loadable>
      </Section>
      {media ? (
        <>
          <ProductList value={products} onChange={setProducts} disabled={create.isPending} />
          <Card>
            <Field testID="page-create-headline" label={t('pages.form.headline')} value={headline} onChangeText={setHeadline} maxLength={200} />
            <Field testID="page-create-slug" label={t('pages.form.slug')} hint={t('pages.form.slugHint')} value={slug} onChangeText={setSlug} autoCapitalize="none" error={slugBad ? t('pages.form.slugBad') : null} />
          </Card>
          <Refusal error={create.error} testID="page-create-error" />
          <Button testID="page-create" label={t('pages.create.save')} busy={create.isPending} disabled={!online || !products.length || slugBad} onPress={() => create.mutate()} />
          {!products.length ? <Text variant="caption">{t('pages.create.pickProduct')}</Text> : null}
        </>
      ) : null}
    </Page>
  );
}

/** One landing page: its direct link, words, products in order, categories, the story cover, the lead form, on or off. */
export function PageScreen({ route }) {
  const id = String(route?.params?.id ?? '');
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const page = useQuery({ queryKey: pageKey(id), queryFn: () => api.pages.get(id) });
  const categories = useQuery({ queryKey: ['categories', 'list', 'all'], queryFn: () => api.categories.list({ limit: 100 }) });
  const [form, setForm] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  const toForm = (p) => ({ headline: p.headline, description: p.description, slug: p.slug, active: p.active, products: [...p.products].sort((a, b) => a.position - b.position), categoryIds: [...p.categoryIds], coverUrl: p.coverUrl, leadForm: leadToForm(p.leadForm) });
  useEffect(() => {
    if (page.data && !form) setForm(toForm(page.data));
  }, [page.data, form]);
  const set = (patch) => {
    setSaved(false);
    setForm((old) => ({ ...old, ...patch }));
  };
  const slugBad = form ? !PAGE_SLUG.test(form.slug.trim().toLowerCase()) : false;
  const save = useMutation({
    mutationFn: () => api.pages.update(id, {
      headline: form.headline.trim(), description: form.description.trim(), slug: form.slug.trim().toLowerCase(), active: form.active,
      productIds: form.products.map((p) => p.id), categoryIds: form.categoryIds, ...(page.data.kind === 'story' ? { coverUrl: form.coverUrl } : {}), leadForm: leadToApi(form.leadForm),
    }),
    onSuccess: (answer) => {
      queryClient.setQueryData(pageKey(id), answer);
      queryClient.invalidateQueries({ queryKey: [...PAGES_KEY, 'list'] });
      setForm(toForm(answer));
      setSaved(true);
    },
  });
  const remove = useMutation({
    mutationFn: () => api.pages.remove(id),
    onSuccess: () => {
      setConfirm(false);
      queryClient.invalidateQueries({ queryKey: [...PAGES_KEY, 'list'] });
      navigation.goBack();
    },
  });
  const data = page.data;
  return (
    <Page testID="screen-page" offline={offline}>
      <Text variant="page">{data?.headline || data?.slug || t('pages.one')}</Text>
      <Loadable query={page} testID="page">
        {data && form ? (
          <>
            <Card>
              <Text variant="meta">{t('pages.link')}</Text>
              <AddressRow url={data.url} testID="page-url" />
              <Text variant="caption">{t('pages.linkHint')}</Text>
            </Card>
            <Card>
              <Toggle testID="page-active" title={t('pages.form.active')} subtitle={t('pages.form.activeHint')} value={form.active} onValueChange={(active) => set({ active })} />
              <Field testID="page-headline" label={t('pages.form.headline')} value={form.headline} onChangeText={(headline) => set({ headline })} maxLength={200} />
              <Field testID="page-description" label={t('pages.form.description')} value={form.description} onChangeText={(description) => set({ description })} multiline maxLength={300} />
              <Field testID="page-slug" label={t('pages.form.slug')} hint={t('pages.form.slugChange')} value={form.slug} onChangeText={(slug) => set({ slug })} autoCapitalize="none" error={slugBad ? t('pages.form.slugBad') : null} />
              <Choices testID="page-lead-form" label={t('pages.form.leadForm')} value={form.leadForm} onChange={(leadForm) => set({ leadForm })} options={LEAD_CHOICES.map((c) => ({ value: c, label: t(`pages.lead.${c}`) }))} />
              {data.kind === 'story' ? <PhotoField testID="page-cover" label={t('pages.form.cover')} urls={form.coverUrl ? [form.coverUrl] : []} max={1} disabled={!online} onChange={(urls) => set({ coverUrl: urls[0] ?? '' })} /> : null}
            </Card>
            <ProductList value={form.products} onChange={(products) => set({ products })} limit={data.productLimit || CATALOG.landingProducts} disabled={save.isPending} />
            {(categories.data?.items ?? []).length ? (
              <Section title={t('pages.form.categories')}>
                <Card>
                  {categories.data.items.map((c) => (
                    <Toggle key={c.id} testID={`page-category-${c.id}`} title={c.name} value={form.categoryIds.includes(c.id)} onValueChange={(on) => set({ categoryIds: on ? [...form.categoryIds, c.id] : form.categoryIds.filter((x) => x !== c.id) })} />
                  ))}
                </Card>
              </Section>
            ) : null}
            <Refusal error={save.error} testID="page-save-error" />
            {saved ? <Banner tone="good" testID="page-saved">{t('pages.saved')}</Banner> : null}
            <Button testID="page-save" label={t('common.save')} busy={save.isPending} disabled={!online || slugBad || !form.products.length} onPress={() => save.mutate()} />
            {!online ? <Text variant="caption">{t('offline.writeDisabled')}</Text> : null}
            <Button testID="page-remove" kind="danger" label={t('pages.remove')} disabled={!online} onPress={() => setConfirm(true)} />
            <Refusal error={remove.error} testID="page-remove-error" />
            <ConfirmSheet testID="page-remove-confirm" visible={confirm} title={t('pages.removeConfirm.title')} confirmLabel={t('pages.removeConfirm.action')} cancelLabel={t('common.cancel')} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate()} busy={remove.isPending} disabled={!online}>
              {t('pages.removeConfirm.body')}
            </ConfirmSheet>
          </>
        ) : null}
      </Loadable>
    </Page>
  );
}
