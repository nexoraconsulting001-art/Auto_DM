import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import ChevronUp from 'lucide-react-native/icons/chevron-up';
import ChevronDown from 'lucide-react-native/icons/chevron-down';
import Trash2 from 'lucide-react-native/icons/trash-2';
import { OfflineBanner, useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, ConfirmSheet, Divider, EmptyState, Field, IconButton, ListRow, LoadingRows, Screen, Section, Sheet, Text, Toggle, WorkspaceBadge, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { NothingSaved, RecordState, Refusal, formatPaise, useWritable } from '../compliance/kit.js';
import { KeywordEditor } from './KeywordEditor.js';
import { MAX_BUTTON_TEXT, MAX_REEL_PRODUCTS, NEW_REEL, formToReel, moveItem, previewMessage, reelToForm, serverFieldErrors } from './form.js';
import { Thumb, useReelSources } from './ReelsScreen.js';

export const reelKey = (id) => ['reels', 'detail', String(id)];
const REEL_ID = /^\d{1,40}$/;

function useDebounced(value, delay = 300) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** The catalog, searched on the server, to add products from. Archived ones say so. */
function Catalog({ visible, picked, onAdd, onClose }) {
  const { api } = useServices();
  const { t } = useStrings();
  const [search, setSearch] = useState('');
  const term = useDebounced(search.trim());
  const catalog = useQuery({ queryKey: ['reels', 'catalog', term], queryFn: () => api.products.list({ limit: 50, ...(term ? { search: term } : {}) }), enabled: visible });
  const items = catalog.data?.items ?? [];
  const full = picked.length >= MAX_REEL_PRODUCTS;
  return (
    <Sheet testID="reel-catalog" visible={visible} onClose={onClose} title={t('reels.catalog.title')} closeLabel={t('common.done')}>
      <Field testID="reel-catalog-search" label={t('reels.catalog.search')} value={search} onChangeText={setSearch} autoCorrect={false} />
      <RecordState query={catalog} testID="reel-catalog-list" emptyTitle={t('reels.catalog.empty')}>
        {() => (items.length ? items.map((product, i) => {
          const taken = picked.some((other) => other.id === product.id);
          return (
            <View key={product.id}>
              {i > 0 ? <Divider /> : null}
              <ListRow
                testID={`reel-catalog-${product.id}`}
                start={<Thumb url={product.images?.[0]} size={36} />}
                title={product.name}
                subtitle={`${formatPaise(product.pricePaise)}${product.active ? '' : `, ${t('reels.archived')}`}`}
                end={<Button testID={`reel-catalog-${product.id}-add`} kind={taken ? 'quiet' : 'secondary'} label={t(taken ? 'reels.catalog.added' : 'reels.catalog.add')} accessibilityHint={product.name} disabled={taken || full} onPress={() => onAdd(product)} />}
              />
            </View>
          );
        }) : <EmptyState testID="reel-catalog-none" title={t(term ? 'reels.catalog.noMatch' : 'reels.catalog.empty')}>{term ? null : t('reels.catalog.emptyBody')}</EmptyState>)}
      </RecordState>
    </Sheet>
  );
}

/** The products a reel shows, in the order they appear in the reel. */
function Products({ picked, onChange, error, disabled }) {
  const { t } = useStrings();
  const theme = useTheme();
  const [adding, setAdding] = useState(false);
  return (
    <Section title={t('reels.products')} action={<Badge testID="reel-product-count" label={`${picked.length} / ${MAX_REEL_PRODUCTS}`} tone={picked.length >= MAX_REEL_PRODUCTS ? 'warn' : 'neutral'} />}>
      <Card>
        <Text variant="small">{t('reels.productsIntro', { max: MAX_REEL_PRODUCTS })}</Text>
        {picked.length === 0 ? <Text variant="meta">{t('reels.noProducts')}</Text> : null}
        {picked.map((product, index) => (
          <View key={product.id}>
            {index > 0 ? <Divider /> : null}
            <ListRow
              testID={`reel-product-${product.id}`}
              start={<Text variant="meta">{String(index + 1)}</Text>}
              title={product.name}
              subtitle={`${formatPaise(product.pricePaise)}${product.active === false ? `, ${t('reels.archivedHidden')}` : ''}`}
              end={(
                <View style={{ flexDirection: 'row', gap: theme.space[1] }}>
                  <IconButton testID={`reel-product-${product.id}-up`} tone="quiet" label={t('reels.moveUp', { name: product.name })} disabled={disabled || index === 0} onPress={() => onChange(moveItem(picked, index, -1))} icon={<ChevronUp size={18} color={theme.color.ink2} />} />
                  <IconButton testID={`reel-product-${product.id}-down`} tone="quiet" label={t('reels.moveDown', { name: product.name })} disabled={disabled || index === picked.length - 1} onPress={() => onChange(moveItem(picked, index, 1))} icon={<ChevronDown size={18} color={theme.color.ink2} />} />
                  <IconButton testID={`reel-product-${product.id}-remove`} tone="quiet" label={t('reels.removeProduct', { name: product.name })} disabled={disabled} onPress={() => onChange(picked.filter((other) => other.id !== product.id))} icon={<Trash2 size={18} color={theme.color.badText} />} />
                </View>
              )}
            />
          </View>
        ))}
        <Button testID="reel-add-products" kind="secondary" label={t('reels.addProducts')} disabled={disabled || picked.length >= MAX_REEL_PRODUCTS} onPress={() => setAdding(true)} />
        {error ? <Text variant="meta" tone="bad" accessibilityRole="alert" testID="reel-products-error">{error}</Text> : null}
      </Card>
      <Catalog visible={adding} picked={picked} onClose={() => setAdding(false)} onAdd={(product) => onChange([...picked, product])} />
    </Section>
  );
}

/** What the commenter gets. Only the seller's name and logo appear here, never the platform's (PRD 2, 6.5). */
function DmPreview({ message, button }) {
  const { t } = useStrings();
  const theme = useTheme();
  const { business } = useSession();
  return (
    <Section title={t('reels.preview')}>
      <Card testID="reel-preview">
        <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
          <WorkspaceBadge name={business?.name} size={32} />
          <View style={{ flex: 1, gap: theme.space[1] }}>
            <Text variant="meta" testID="reel-preview-name">{business?.name}</Text>
            <View style={{ backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.tile, padding: theme.space[3], gap: theme.space[2] }}>
              <Text variant="body" testID="reel-preview-text">{previewMessage(message) || t('reels.previewEmpty')}</Text>
              <Text variant="small" tone="primary" testID="reel-preview-button">{button || NEW_REEL.buttonText}</Text>
            </View>
          </View>
        </View>
      </Card>
    </Section>
  );
}

function Editor({ id, reel, post, navigation }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const writable = useWritable();
  const [form, setForm] = useState(() => (reel ? reelToForm(reel) : { ...NEW_REEL, headline: (post?.caption ?? '').trim().slice(0, 60) }));
  const [errors, setErrors] = useState({});
  const [asking, setAsking] = useState(false);
  const set = (name) => (value) => setForm((current) => ({ ...current, [name]: value }));
  const media = {
    permalink: post?.permalink || reel?.permalink || '',
    thumbnailUrl: post?.thumbnailUrl || reel?.thumbnailUrl || '',
    caption: post?.caption || reel?.caption || '',
    videoUrl: reel?.videoUrl || '',
  };
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['reels'] }), queryClient.invalidateQueries({ queryKey: ['home'] })]);
  const save = useMutation({
    mutationFn: (body) => api.reels.save(id, body),
    onSuccess: async (saved) => {
      queryClient.setQueryData(reelKey(id), saved);
      await refresh();
    },
    onError: (error) => setErrors(serverFieldErrors(error)),
  });
  const remove = useMutation({
    mutationFn: () => api.reels.remove(id),
    onSuccess: async () => {
      await refresh();
      navigation?.goBack?.();
    },
  });
  const words = (field) => (errors[field] ? errors[field].text ?? t(errors[field].key, errors[field].values) : '');
  const submit = () => {
    const { body, errors: found } = formToReel(form, media);
    if (found) {
      setErrors(found);
      return;
    }
    setErrors({});
    setForm((current) => ({ ...current, keywords: body.keywords, keywordDraft: '' }));
    save.mutate(body);
  };

  return (
    <>
      <View style={{ flexDirection: 'row', gap: theme.space[3] }}>
        <Thumb url={media.thumbnailUrl} size={64} />
        <View style={{ flex: 1, gap: theme.space[1] }}>
          {media.caption ? <Text variant="small" numberOfLines={4}>{media.caption.slice(0, 240)}</Text> : null}
          <Text variant="meta">{t('reels.postId', { id })}</Text>
          {reel?.storeUrl ? <Text variant="meta" selectable testID="reel-store-url">{reel.storeUrl}</Text> : null}
        </View>
      </View>
      <Section title={t('reels.storePage')}>
        <Card>
          <Field testID="reel-headline" label={t('reels.headline')} hint={t('reels.headlineHint')} value={form.headline} onChangeText={set('headline')} maxLength={200} editable={writable} error={words('headline')} />
          <Field testID="reel-slug" label={t('reels.slug')} hint={t('reels.slugHint')} value={form.slug} onChangeText={set('slug')} maxLength={60} autoCapitalize="none" autoCorrect={false} editable={writable} error={words('slug')} />
          <Toggle testID="reel-active" title={t('reels.active')} value={form.active} onValueChange={set('active')} disabled={!writable} />
        </Card>
      </Section>
      <Products picked={form.products} onChange={set('products')} error={words('products')} disabled={!writable} />
      <Section title={t('reels.whenComments')}>
        <Card>
          <KeywordEditor
            testID="reel-keywords"
            keywords={form.keywords}
            draft={form.keywordDraft}
            onChange={set('keywords')}
            onDraft={set('keywordDraft')}
            error={words('keywords')}
            disabled={!writable}
            labelKey="reels.addKeyword"
            hintKey="reels.keywordHint"
            removeKey="reels.removeKeyword"
          />
        </Card>
      </Section>
      <Section title={t('reels.replyWith')}>
        <Card>
          <Field testID="reel-dm" label={t('reels.dm')} hint={t('reels.dmHint')} value={form.dmMessage} onChangeText={set('dmMessage')} maxLength={1000} multiline editable={writable} error={words('dmMessage')} />
          <Field testID="reel-button" label={t('reels.button')} hint={t('reels.buttonHint', { max: MAX_BUTTON_TEXT })} value={form.buttonText} onChangeText={set('buttonText')} maxLength={40} editable={writable} error={words('buttonText')} />
          <Toggle testID="reel-public" title={t('reels.publicReply')} subtitle={t('reels.publicReplyHint')} value={form.publicReplyOn} onValueChange={set('publicReplyOn')} disabled={!writable} />
          {form.publicReplyOn ? <Field testID="reel-public-text" label={t('reels.publicReplyText')} value={form.publicReply} onChangeText={set('publicReply')} maxLength={1000} editable={writable} error={words('publicReply')} /> : null}
        </Card>
      </Section>
      <DmPreview message={form.dmMessage} button={form.buttonText.trim()} />
      <Refusal error={save.error ?? remove.error} testID="reel-refusal" />
      {save.isSuccess ? <Banner testID="reel-saved" tone="good">{t('reels.saved')}</Banner> : null}
      <Button testID="reel-save" label={t(reel ? 'reels.save' : 'reels.create')} busy={save.isPending} disabled={!writable} onPress={submit} />
      {reel ? <Button testID="reel-remove" kind="danger" label={t('reels.remove')} disabled={!writable} busy={remove.isPending} onPress={() => setAsking(true)} /> : null}
      <ConfirmSheet
        testID="reel-remove-confirm"
        visible={asking}
        title={t('reels.removeTitle')}
        confirmLabel={t('reels.remove')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setAsking(false)}
        onConfirm={() => {
          setAsking(false);
          remove.mutate();
        }}
        disabled={!writable}
      >
        {t('reels.removeBody')}
      </ConfirmSheet>
    </>
  );
}

/**
 * One reel's store (the console's /reels/:id): its products, keywords and DM. Whether the post has a store comes from
 * the list, so a first visit is never a refused lookup; a post with none is set up from what Instagram said about it.
 */
export default function ReelScreen({ route, navigation }) {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const id = String(route?.params?.id ?? '');
  const valid = REEL_ID.test(id);
  const { reels, posts } = useReelSources();
  const listed = reels.items.some((item) => item.id === id);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = reels;
  // Look through every page of stores before deciding this post has none.
  useEffect(() => {
    if (valid && !listed && hasNextPage && !isFetchingNextPage) fetchNextPage();
  }, [valid, listed, hasNextPage, isFetchingNextPage, fetchNextPage]);
  const reel = useQuery({ queryKey: reelKey(id), queryFn: () => api.reels.get(id), enabled: valid && listed });
  const post = posts.items.find((item) => item.id === id) ?? null;

  let body;
  if (!valid) body = <EmptyState testID="reel-missing" title={t('error.notFound')} />;
  else if (reels.isPending && reels.isPaused) body = <NothingSaved testID="reel" />;
  else if (reels.isPending || (!listed && (reels.hasNextPage || reels.isFetchingNextPage))) body = <LoadingRows label={t('common.loading')} testID="reel-loading" />;
  else if (listed) body = <RecordState query={reel} testID="reel">{(found) => <Editor key={id} id={id} reel={found} post={post} navigation={navigation} />}</RecordState>;
  else if (posts.isPending && !posts.isPaused) body = <LoadingRows label={t('common.loading')} testID="reel-loading" />;
  else if (post) body = <Editor key={id} id={id} reel={null} post={post} navigation={navigation} />;
  else body = <EmptyState testID="reel-missing" title={t('error.notFound')}>{posts.error ? t('reels.postsFailedBody') : null}</EmptyState>;

  return (
    <Screen testID="screen-reel" title={t(listed ? 'reels.editTitle' : 'reels.setUpTitle')}>
      <OfflineBanner offline={!writable} />
      {body}
    </Screen>
  );
}
