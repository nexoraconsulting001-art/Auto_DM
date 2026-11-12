import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, ConfirmSheet, Divider, Field, ListRow, Text, Toggle } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { Loadable, Page, PhotoField, Refusal, Thumb, useConnection } from '../products/kit.js';
import { SortableRow } from './sortable.js';
import { moveItem, optimistic } from './sequence.js';

export const CATEGORIES_KEY = ['categories'];
const LIST_KEY = [...CATEGORIES_KEY, 'list', 'all'];

/**
 * Categories (PRD 8.1, 8.13): every category in the order shelves and chips show them. Drag a row (or use its arrows)
 * to move it; the new order is shown at once and saved, and if the save fails the list goes back to how it was and
 * says why. Each category opens to its details and its reel order.
 */
export default function CategoriesScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const list = useQuery({ queryKey: LIST_KEY, queryFn: () => api.categories.list({ limit: 100 }) });
  const [failure, setFailure] = useState(null);
  const [saving, setSaving] = useState(false);
  const items = list.data?.items ?? [];

  async function move(from, to) {
    if (!online || saving) return;
    const next = moveItem(items, from, to);
    setFailure(null);
    setSaving(true);
    try {
      await optimistic({
        read: () => queryClient.getQueryData(LIST_KEY),
        write: (data) => queryClient.setQueryData(LIST_KEY, data),
        next: { ...list.data, items: next },
        send: () => api.categories.reorder({ ids: next.map((c) => c.id) }),
      });
    } catch (error) {
      setFailure(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Page testID="screen-categories" offline={offline}>
      <Text variant="page">{t('categories.title')}</Text>
      <Text variant="small">{t('categories.intro')}</Text>
      <Button testID="categories-add" label={t('categories.add')} disabled={!online} onPress={() => navigation.navigate('categories.create')} />
      {failure ? <Banner tone="bad" testID="categories-reorder-failed" title={t('categories.reorderFailed')} /> : null}
      <Refusal error={failure} testID="categories-reorder-error" />
      <Loadable query={list} empty={!items.length} testID="categories-list" emptyTitle={t('categories.empty')} emptyBody={t('categories.emptyBody')}>
        <Card>
          {items.map((category, i) => (
            <View key={category.id}>
              {i ? <Divider /> : null}
              <SortableRow testID={`category-${category.id}`} index={i} count={items.length} onMove={move} disabled={!online || saving} labels={{ up: t('categories.moveUp', { name: category.name }), down: t('categories.moveDown', { name: category.name }) }}>
                <ListRow
                  testID={`category-${category.id}-open`}
                  start={<Thumb uri={category.imageUrl} size={40} label={category.name} />}
                  title={category.name}
                  subtitle={t('categories.counts', { products: category.productCount, reels: category.reelCount })}
                  end={category.visible ? null : <Badge label={t('categories.hiddenBadge')} />}
                  onPress={() => navigation.navigate('categories.detail', { id: String(category.id) })}
                />
              </SortableRow>
            </View>
          ))}
        </Card>
      </Loadable>
    </Page>
  );
}

/** One category's details (name, address, photo, description, shown or hidden), new or saved, and the way to its reels. */
export function CategoryScreen({ route }) {
  const id = route?.params?.id && route.params.id !== 'new' ? String(route.params.id) : null;
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const category = useQuery({ queryKey: [...CATEGORIES_KEY, 'one', id], queryFn: () => api.categories.get(id), enabled: Boolean(id) });
  const [form, setForm] = useState(id ? null : { name: '', slug: '', imageUrl: '', description: '', visible: true });
  const [confirm, setConfirm] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (id && category.data && !form) setForm({ name: category.data.name, slug: category.data.slug, imageUrl: category.data.imageUrl, description: category.data.description, visible: category.data.visible });
  }, [id, category.data, form]);
  const set = (patch) => {
    setSaved(false);
    setForm((old) => ({ ...old, ...patch }));
  };
  const save = useMutation({
    mutationFn: () => {
      const body = { name: form.name.trim(), imageUrl: form.imageUrl, description: form.description.trim(), visible: form.visible, ...(form.slug.trim() ? { slug: form.slug.trim() } : {}) };
      return id ? api.categories.update(id, body) : api.categories.create(body);
    },
    onSuccess: (answer) => {
      queryClient.setQueryData([...CATEGORIES_KEY, 'one', String(answer.id)], answer);
      queryClient.invalidateQueries({ queryKey: [...CATEGORIES_KEY, 'list'] });
      setSaved(true);
      if (!id) navigation.replace?.('categories.detail', { id: String(answer.id) });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.categories.remove(id),
    onSuccess: () => {
      setConfirm(false);
      queryClient.invalidateQueries({ queryKey: [...CATEGORIES_KEY, 'list'] });
      navigation.goBack();
    },
  });
  const content = form ? (
    <>
      <Card>
        <Field testID="category-name" label={t('categories.form.name')} value={form.name} onChangeText={(name) => set({ name })} maxLength={60} error={save.isError && !form.name.trim() ? t('categories.form.nameRequired') : null} />
        <Field testID="category-slug" label={t('categories.form.slug')} hint={t('categories.form.slugHint')} value={form.slug} onChangeText={(slug) => set({ slug })} autoCapitalize="none" maxLength={60} />
        <Field testID="category-description" label={t('categories.form.description')} value={form.description} onChangeText={(description) => set({ description })} multiline maxLength={400} />
        <PhotoField testID="category-photo" label={t('categories.form.photo')} urls={form.imageUrl ? [form.imageUrl] : []} max={1} disabled={!online} onChange={(urls) => set({ imageUrl: urls[0] ?? '' })} />
        <Toggle testID="category-visible" title={t('categories.form.visible')} subtitle={t('categories.form.visibleHint')} value={form.visible} onValueChange={(visible) => set({ visible })} />
      </Card>
      <Refusal error={save.error} testID="category-save-error" />
      {saved ? <Banner tone="good" testID="category-saved">{t('categories.saved')}</Banner> : null}
      <Button testID="category-save" label={t(id ? 'common.save' : 'categories.add')} busy={save.isPending} disabled={!online || !form.name.trim()} onPress={() => save.mutate()} />
      {!online ? <Text variant="caption">{t('offline.writeDisabled')}</Text> : null}
      {id ? (
        <>
          <ListRow testID="category-open-reels" title={t('categories.reels.title')} subtitle={t('categories.reels.count', { count: category.data?.reelCount ?? 0 })} onPress={() => navigation.navigate('categories.reels', { id })} />
          <Button testID="category-remove" kind="danger" label={t('categories.remove')} disabled={!online} onPress={() => setConfirm(true)} />
          <Refusal error={remove.error} testID="category-remove-error" />
        </>
      ) : null}
      <ConfirmSheet testID="category-remove-confirm" visible={confirm} title={t('categories.removeConfirm.title')} confirmLabel={t('categories.removeConfirm.action')} cancelLabel={t('common.cancel')} onCancel={() => setConfirm(false)} onConfirm={() => remove.mutate()} busy={remove.isPending} disabled={!online}>
        {t('categories.removeConfirm.body')}
      </ConfirmSheet>
    </>
  ) : null;
  return (
    <Page testID="screen-category" offline={offline}>
      <Text variant="page">{id ? category.data?.name || t('categories.title') : t('categories.add')}</Text>
      {id ? <Loadable query={category} testID="category">{content}</Loadable> : content}
    </Page>
  );
}
