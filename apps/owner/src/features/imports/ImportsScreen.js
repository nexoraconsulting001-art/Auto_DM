import React, { useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { formatWhen, useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, Choices, Divider, Field, ListRow, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { Loadable, MoneyField, MoreButton, Page, Refusal, Thumb, itemsOf, pickDocument, useConnection, usePaged } from '../products/kit.js';
import { CATALOG, IMPORT_ITEM_STATUSES } from '../products/limits.js';
import { draftToForm, formToProduct, splitList } from '../products/form.js';
import { CSV_RULE, uploadFile } from '../products/upload.js';

export const IMPORTS_KEY = ['imports'];
const WAYS = ['link', 'bulk', 'csv', 'shopify'];
const JOB_TONES = { queued: 'neutral', running: 'primary', done: 'good', failed: 'bad' };
const ITEM_TONES = { pending: 'neutral', draft: 'primary', created: 'good', updated: 'good', unchanged: 'neutral', existing: 'neutral', refused: 'warn', failed: 'bad', archived: 'neutral' };
const running = (job) => job?.status === 'queued' || job?.status === 'running';
/** What the phone's file picker may offer for a product CSV; the file is then checked against CSV_RULE before it goes. */
const CSV_PICK_TYPES = ['text/csv', 'text/comma-separated-values', 'text/plain', 'application/vnd.ms-excel', 'application/octet-stream'];

/**
 * A product read from a link, a feed or a CSV line, for the owner to check and save (8.7: nothing imported is live
 * until saved). The name, price, MRP, description, stock and photos can be corrected here; options and variants are
 * kept as read and can be changed on the product after saving. Saving skips the quality gate: the owner confirmed it.
 */
export function DraftCard({ itemId, draft, onSaved, testID = 'draft' }) {
  const { api } = useServices();
  const { t } = useStrings();
  const { online } = useConnection();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(() => draftToForm(draft));
  const [errors, setErrors] = useState({});
  const save = useMutation({
    mutationFn: (body) => api.importItems.save(itemId, body),
    onSuccess: (answer) => {
      queryClient.invalidateQueries({ queryKey: ['products', 'list'] });
      queryClient.invalidateQueries({ queryKey: IMPORTS_KEY });
      onSaved?.(answer.productId);
    },
  });
  const set = (patch) => setForm((old) => ({ ...old, ...patch }));
  function submit() {
    const read = formToProduct(form);
    setErrors(read.errors ?? {});
    if (!read.errors) save.mutate(read.body);
  }
  return (
    <Card testID={testID}>
      <Text variant="title">{t('imports.draft.title')}</Text>
      <Text variant="small">{t('imports.draft.intro')}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
        {form.images.map((url, i) => (
          <View key={url} style={{ alignItems: 'center' }}>
            <Thumb uri={url} size={64} label={t('products.photo', { number: i + 1 })} />
            <Button testID={`${testID}-photo-${i}-remove`} kind="quiet" label={t('products.remove')} onPress={() => set({ images: form.images.filter((_, at) => at !== i) })} />
          </View>
        ))}
      </View>
      <Field testID={`${testID}-name`} label={t('products.form.name')} value={form.name} onChangeText={(name) => set({ name })} error={errors.name ? t(errors.name) : null} />
      <MoneyField testID={`${testID}-price`} label={t('products.form.price')} value={form.price} onChangeText={(price) => set({ price })} error={errors.price ? t(errors.price) : null} />
      <MoneyField testID={`${testID}-mrp`} label={t('products.form.mrp')} value={form.mrp} onChangeText={(mrp) => set({ mrp })} error={errors.mrp ? t(errors.mrp) : null} />
      <Field testID={`${testID}-description`} label={t('products.form.description')} value={form.description} onChangeText={(description) => set({ description })} multiline error={errors.description ? t(errors.description) : null} />
      <Toggle testID={`${testID}-in-stock`} title={t('products.form.inStock')} value={form.inStock} onValueChange={(inStock) => set({ inStock })} />
      {form.options.length ? <Text variant="caption">{t('imports.draft.variants', { count: form.variants.length })}</Text> : null}
      {errors.options || errors.variants ? <Text variant="caption" tone="bad">{t(errors.options ?? errors.variants)}</Text> : null}
      {draft?.suggestedCategories?.length ? <Text variant="caption">{t('imports.draft.categories', { names: draft.suggestedCategories.join(', ') })}</Text> : null}
      <Refusal error={save.error} testID={`${testID}-error`} />
      <Button testID={`${testID}-save`} label={t('imports.draft.save')} busy={save.isPending} disabled={!online} onPress={submit} />
    </Card>
  );
}

/** One link (8.3): read at once; a draft to check and save, the product it already is, or why it couldn't be read. */
function LinkImport() {
  const { api } = useServices();
  const { t } = useStrings();
  const openLink = useOpenLink();
  const { online } = useConnection();
  const [url, setUrl] = useState('');
  const read = useMutation({ mutationFn: () => api.imports.link({ url: url.trim() }) });
  const result = read.data;
  return (
    <View style={{ gap: 8 }}>
      <Field testID="imports-link-url" label={t('imports.link.label')} hint={t('imports.link.hint')} value={url} onChangeText={setUrl} autoCapitalize="none" keyboardType="url" />
      <Button testID="imports-link-read" label={t('imports.link.read')} busy={read.isPending} disabled={!online || !url.trim()} onPress={() => read.mutate()} />
      <Refusal error={read.error} testID="imports-link-error" />
      {result?.status === 'existing' ? (
        <Banner testID="imports-link-existing" tone="info" action={<Button kind="secondary" label={t('imports.openProduct')} onPress={() => openLink(`/products/${result.productId}`)} />}>{result.message || t('imports.link.existing')}</Banner>
      ) : null}
      {result && ['refused', 'failed'].includes(result.status) ? (
        <Banner testID="imports-link-refused" tone="warn" title={t(`imports.link.${result.status}`)}>{result.message}</Banner>
      ) : null}
      {result?.draft && result.itemId && result.status !== 'existing' ? (
        <DraftCard key={result.itemId} itemId={result.itemId} draft={result.draft} testID="imports-link-draft" onSaved={(productId) => openLink(`/products/${productId}`)} />
      ) : null}
    </View>
  );
}

/** Many links (up to 25), a CSV file (2 MB, checked before it is sent), or a Shopify store's feed: each a job. */
function JobImport({ way, onStarted, pick = pickDocument }) {
  const { api } = useServices();
  const { t } = useStrings();
  const { online } = useConnection();
  const [text, setText] = useState('');
  const links = way === 'bulk' ? splitList(text.replace(/\s+/g, ',')) : [];
  const start = useMutation({
    mutationFn: async () => {
      if (way === 'bulk') return api.imports.bulk({ urls: links });
      if (way === 'shopify') return api.imports.shopify({ storeUrl: text.trim() });
      const asset = await pick(CSV_PICK_TYPES);
      if (!asset) return null;
      return uploadFile(asset, CSV_RULE, (file) => api.imports.csv(file)); // refuses before sending a file over the limits
    },
    onSuccess: (job) => {
      if (job) onStarted(job);
    },
  });
  const tooMany = way === 'bulk' && links.length > CATALOG.bulkLinks;
  return (
    <View style={{ gap: 8 }}>
      {way === 'bulk' ? (
        <Field testID="imports-bulk-urls" label={t('imports.bulk.label')} hint={t('imports.bulk.hint', { max: CATALOG.bulkLinks })} value={text} onChangeText={setText} multiline autoCapitalize="none" error={tooMany ? t('imports.bulk.tooMany', { max: CATALOG.bulkLinks }) : null} />
      ) : null}
      {way === 'shopify' ? <Field testID="imports-shopify-url" label={t('imports.shopify.label')} hint={t('imports.shopify.hint')} value={text} onChangeText={setText} autoCapitalize="none" keyboardType="url" /> : null}
      {way === 'csv' ? <Text variant="small">{t('imports.csv.intro')}</Text> : null}
      <Button
        testID={`imports-${way}-start`}
        label={t(`imports.${way}.start`, { count: links.length })}
        busy={start.isPending}
        disabled={!online || (way === 'bulk' && (!links.length || tooMany)) || (way === 'shopify' && !text.trim())}
        onPress={() => start.mutate()}
      />
      <Refusal error={start.error} testID={`imports-${way}-error`} />
    </View>
  );
}

/**
 * Imports (PRD 8.3 to 8.8): add products by pasting a link, many links, a CSV file or a Shopify store's address. A link
 * answers at once; the rest run in the background and report each line. Nothing is live until it is saved.
 */
export default function ImportsScreen() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const [way, setWay] = useState('link');
  const jobs = usePaged([...IMPORTS_KEY, 'jobs'], (page) => api.imports.list({ limit: 20, ...page }));
  const adapters = useQuery({ queryKey: [...IMPORTS_KEY, 'adapters'], queryFn: () => api.imports.adapters() });
  const list = itemsOf(jobs);
  const started = (job) => {
    queryClient.invalidateQueries({ queryKey: [...IMPORTS_KEY, 'jobs'] });
    navigation.navigate('imports.job', { id: String(job.id) });
  };
  const services = (adapters.data?.items ?? []).filter((a) => a.enabled);
  return (
    <Page testID="screen-imports" offline={offline}>
      <Text variant="page">{t('imports.title')}</Text>
      <Card>
        <Choices testID="imports-way" label={t('imports.way')} value={way} onChange={setWay} options={WAYS.map((w) => ({ value: w, label: t(`imports.way.${w}`) }))} />
        {way === 'link' ? <LinkImport /> : <JobImport key={way} way={way} onStarted={started} />}
        {!online ? <Text variant="caption" testID="imports-offline">{t('offline.writeDisabled')}</Text> : null}
        {services.length ? <Text variant="caption" testID="imports-adapters">{t('imports.adapters', { names: services.map((a) => a.label).join(', ') })}</Text> : null}
      </Card>
      <Section title={t('imports.recent')}>
        <Loadable query={jobs} empty={!list.length} testID="imports-jobs" emptyTitle={t('imports.jobs.empty')}>
          <Card>
            {list.map((job, i) => (
              <View key={job.id}>
                {i ? <Divider /> : null}
                <ListRow
                  testID={`import-job-${job.id}`}
                  title={t(`imports.kind.${job.kind}`)}
                  subtitle={`${t('imports.counts', { created: job.created, updated: job.updated, refused: job.refused + job.failed })} · ${formatWhen(t, job.createdAt, { locale })}`}
                  end={<Badge label={t(`imports.job.${job.status}`)} tone={JOB_TONES[job.status] ?? 'neutral'} />}
                  onPress={() => navigation.navigate('imports.job', { id: String(job.id) })}
                />
              </View>
            ))}
          </Card>
          <MoreButton query={jobs} testID="imports-jobs-more" />
        </Loadable>
      </Section>
    </Page>
  );
}

/** One import job: its counts while it runs (checked every few seconds), then each line with its outcome, and drafts to save. */
export function ImportJobScreen({ route }) {
  const id = String(route?.params?.id ?? '');
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  const { offline } = useConnection();
  const [status, setStatus] = useState('all');
  const [open, setOpen] = useState(null);
  const job = useQuery({ queryKey: [...IMPORTS_KEY, 'job', id], queryFn: () => api.imports.get(id), refetchInterval: (query) => (running(query.state.data) ? 4000 : false) });
  const items = usePaged([...IMPORTS_KEY, 'items', id, status], (page) => api.imports.items(id, { status, limit: 50, ...page }), { refetchInterval: running(job.data) ? 4000 : false });
  const lines = itemsOf(items);
  const data = job.data;
  return (
    <Page testID="screen-import-job" offline={offline}>
      <Text variant="page">{data ? t(`imports.kind.${data.kind}`) : t('imports.title')}</Text>
      <Loadable query={job} testID="import-job">
        {data ? (
          <Card>
            <Badge testID="import-job-status" label={t(`imports.job.${data.status}`)} tone={JOB_TONES[data.status] ?? 'neutral'} />
            {data.source ? <Text variant="caption">{data.source}</Text> : null}
            <Text variant="small" testID="import-job-counts">{t('imports.countsLong', { total: data.total, created: data.created, updated: data.updated, unchanged: data.unchanged, refused: data.refused, failed: data.failed, archived: data.archived })}</Text>
            {data.message ? <Text variant="small" tone={data.status === 'failed' ? 'bad' : undefined}>{data.message}</Text> : null}
            {running(data) ? <Text variant="caption" testID="import-job-running">{t('imports.running')}</Text> : null}
          </Card>
        ) : null}
      </Loadable>
      <Choices testID="import-items-status" label={t('imports.items.filter')} value={status} onChange={setStatus} options={['all', ...IMPORT_ITEM_STATUSES].map((s) => ({ value: s, label: t(s === 'all' ? 'imports.items.all' : `imports.item.${s}`) }))} />
      <Loadable query={items} empty={!lines.length} testID="import-items" emptyTitle={t(running(data) ? 'imports.items.waiting' : 'imports.items.empty')}>
        <Card>
          {lines.map((line, i) => (
            <View key={line.id} style={{ gap: theme.space[2] }}>
              {i ? <Divider /> : null}
              <ListRow
                testID={`import-item-${line.id}`}
                title={line.draft?.name || line.url || line.sku || t('imports.items.line', { line: line.line })}
                subtitle={line.message || undefined}
                end={<Badge label={t(`imports.item.${line.status}`)} tone={ITEM_TONES[line.status] ?? 'neutral'} />}
                onPress={line.productId ? () => openLink(`/products/${line.productId}`) : line.draft ? () => setOpen(open === line.id ? null : line.id) : undefined}
              />
              {open === line.id && line.draft ? <DraftCard itemId={line.id} draft={line.draft} testID={`import-item-${line.id}-draft`} onSaved={(productId) => openLink(`/products/${productId}`)} /> : null}
            </View>
          ))}
        </Card>
        <MoreButton query={items} testID="import-items-more" />
      </Loadable>
    </Page>
  );
}
