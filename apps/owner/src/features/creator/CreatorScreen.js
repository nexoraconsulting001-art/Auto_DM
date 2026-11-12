import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { Banner, Button, Card, Field, Text, Toggle } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { AddressRow, Loadable, Page, PhotoField, Refusal, useConnection } from '../products/kit.js';
import { CREATOR_SLUG } from '../products/limits.js';

export const CREATOR_KEY = ['creator-page'];

/** Pure: the changed fields of the creator page form, or the first problem by field (string keys). */
export function creatorBody(before, form) {
  const errors = {};
  const slug = String(form.slug ?? '').trim().toLowerCase();
  if (slug && !CREATOR_SLUG.test(slug)) errors.slug = 'creator.slugBad';
  const website = String(form.websiteUrl ?? '').trim();
  if (website && !/^https:\/\/[^\s\0]+$/i.test(website)) errors.websiteUrl = 'creator.websiteBad';
  if (!String(form.moreShelfTitle ?? '').trim()) errors.moreShelfTitle = 'creator.shelfRequired';
  if (Object.keys(errors).length) return { errors };
  const next = { slug, enabled: Boolean(form.enabled), displayName: form.displayName.trim(), bio: form.bio.trim(), photoUrl: form.photoUrl ?? '', websiteUrl: website, showWhatsapp: Boolean(form.showWhatsapp), moreShelfTitle: form.moreShelfTitle.trim() };
  const body = Object.fromEntries(Object.entries(next).filter(([key, value]) => value !== before[key] && !(key === 'slug' && !value)));
  return { body };
}

const toForm = (page) => ({ slug: page.slug, enabled: page.enabled, displayName: page.displayName, bio: page.bio, photoUrl: page.photoUrl, websiteUrl: page.websiteUrl, showWhatsapp: page.showWhatsapp, moreShelfTitle: page.moreShelfTitle });

/**
 * The creator page (PRD 8.14): one page at /<name> on the business's own address, with a shelf per category in the
 * category and reel order. The owner copies its link into the Instagram bio themselves; nothing here edits a bio.
 */
export default function CreatorScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const page = useQuery({ queryKey: CREATOR_KEY, queryFn: () => api.creator.get() });
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (page.data && !form) setForm(toForm(page.data));
  }, [page.data, form]);
  const set = (patch) => {
    setSaved(false);
    setForm((old) => ({ ...old, ...patch }));
  };
  const check = useMutation({ mutationFn: (slug) => api.creator.checkSlug({ slug }) });
  const save = useMutation({
    mutationFn: (body) => api.creator.update(body),
    onSuccess: (answer) => {
      queryClient.setQueryData(CREATOR_KEY, answer);
      setForm(toForm(answer));
      setSaved(true);
    },
  });
  function submit() {
    const read = creatorBody(page.data, form);
    setErrors(read.errors ?? {});
    if (read.errors) return;
    if (!Object.keys(read.body).length) {
      setSaved(true);
      return;
    }
    save.mutate(read.body);
  }
  const data = page.data;
  const slugChanged = form && form.slug.trim().toLowerCase() !== (data?.slug ?? '');
  return (
    <Page testID="screen-creator" offline={offline}>
      <Text variant="page">{t('creator.title')}</Text>
      <Text variant="small">{t('creator.intro')}</Text>
      <Loadable query={page} testID="creator">
        {data && form ? (
          <>
            {data.url ? (
              <Card>
                <Text variant="meta">{t('creator.link')}</Text>
                <AddressRow url={data.url} testID="creator-url" />
                <Text variant="caption">{t('creator.linkHint')}</Text>
              </Card>
            ) : <Banner tone="info" testID="creator-no-link">{t('creator.noLink')}</Banner>}
            <Card>
              <Toggle testID="creator-enabled" title={t('creator.enabled')} value={form.enabled} onValueChange={(enabled) => set({ enabled })} />
              <Field testID="creator-slug" label={t('creator.slug')} hint={t('creator.slugHint')} value={form.slug} onChangeText={(slug) => { check.reset(); set({ slug }); }} autoCapitalize="none" error={errors.slug ? t(errors.slug) : null} />
              {slugChanged && form.slug.trim() ? <Button testID="creator-slug-check" kind="quiet" label={t('creator.check')} busy={check.isPending} disabled={!online} onPress={() => check.mutate(form.slug.trim().toLowerCase())} /> : null}
              {check.data ? <Text variant="caption" tone={check.data.available ? 'good' : 'bad'} testID="creator-slug-answer">{check.data.message || t(check.data.available ? 'creator.free' : 'creator.taken')}</Text> : null}
              <Field testID="creator-name" label={t('creator.displayName')} value={form.displayName} onChangeText={(displayName) => set({ displayName })} maxLength={80} />
              <Field testID="creator-bio" label={t('creator.bio')} value={form.bio} onChangeText={(bio) => set({ bio })} multiline maxLength={300} />
              <PhotoField testID="creator-photo" label={t('creator.photo')} urls={form.photoUrl ? [form.photoUrl] : []} max={1} disabled={!online} onChange={(urls) => set({ photoUrl: urls[0] ?? '' })} />
              <Field testID="creator-website" label={t('creator.website')} hint={t('creator.websiteHint')} value={form.websiteUrl} onChangeText={(websiteUrl) => set({ websiteUrl })} autoCapitalize="none" keyboardType="url" error={errors.websiteUrl ? t(errors.websiteUrl) : null} />
              <Field testID="creator-shelf" label={t('creator.shelf')} value={form.moreShelfTitle} onChangeText={(moreShelfTitle) => set({ moreShelfTitle })} maxLength={40} error={errors.moreShelfTitle ? t(errors.moreShelfTitle) : null} />
              <Toggle testID="creator-whatsapp" title={t('creator.whatsapp')} value={form.showWhatsapp} onValueChange={(showWhatsapp) => set({ showWhatsapp })} />
            </Card>
            {data.badge ? <Text variant="caption" testID="creator-badge">{t('creator.badge')}</Text> : null}
            <Refusal error={save.error} testID="creator-error" />
            {saved ? <Banner tone="good" testID="creator-saved">{t('creator.saved')}</Banner> : null}
            <Button testID="creator-save" label={t('common.save')} busy={save.isPending} disabled={!online} onPress={submit} />
            {!online ? <Text variant="caption">{t('offline.writeDisabled')}</Text> : null}
          </>
        ) : null}
      </Loadable>
    </Page>
  );
}
