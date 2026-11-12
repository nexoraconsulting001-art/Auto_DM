import React, { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigation } from '@react-navigation/native';
import { formatWhen, useStrings } from '@bhava/app-core';
import { Banner, Button, Card, Choices, ConfirmSheet, Divider, Field, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { Loadable, MoneyField, Page, PhotoField, Refusal, useConnection } from './kit.js';
import { CATALOG } from './limits.js';
import { formatMoney } from './money.js';
import { EMPTY_PRODUCT, WHATSAPP_CHOICES, changedFields, formToProduct, isImported, needsAttention, productToForm, variantLabel, variantsFor } from './form.js';
import { PRODUCTS_KEY, PriceText } from './ProductsScreen.js';

const productKey = (id) => [...PRODUCTS_KEY, 'one', String(id)];

/** The categories a product can be in: every one of the business's, as on/off rows. */
function CategoryPicker({ value, onChange, disabled }) {
  const { api } = useServices();
  const { t } = useStrings();
  const categories = useQuery({ queryKey: ['categories', 'list', 'picker'], queryFn: () => api.categories.list({ limit: 100 }) });
  const items = categories.data?.items ?? [];
  if (categories.isPending || !items.length) return null;
  return (
    <Section title={t('products.form.categories')}>
      <Card>
        {items.map((category) => {
          const on = value.includes(category.id);
          return (
            <Toggle
              key={category.id}
              testID={`product-category-${category.id}`}
              title={category.name}
              value={on}
              disabled={disabled}
              onValueChange={() => onChange(on ? value.filter((id) => id !== category.id) : [...value, category.id])}
            />
          );
        })}
      </Card>
    </Section>
  );
}

/**
 * Up to three options (Size, Colour) and a variant for every combination of their values, each with its own price,
 * MRP, SKU, stock switch and photo. Changing the options keeps what was typed for a combination that is still there.
 */
function OptionsEditor({ form, set, errors, variantError, disabled }) {
  const { t } = useStrings();
  const theme = useTheme();
  const setOptions = (options) => set({ options, variants: variantsFor(options, form.variants, { price: form.price, mrp: form.mrp }) });
  const setVariant = (i, patch) => set({ variants: form.variants.map((v, at) => (at === i ? { ...v, ...patch } : v)) });
  const photoChoices = [{ value: 'none', label: t('products.form.noPhoto') }, ...form.images.map((_, i) => ({ value: String(i), label: t('products.photo', { number: i + 1 }) }))];
  return (
    <Section title={t('products.form.options')}>
      <Card testID="product-options">
        <Text variant="small">{t('products.form.optionsIntro')}</Text>
        {form.options.map((option, i) => (
          <View key={i} style={{ gap: theme.space[2] }}>
            {i ? <Divider /> : null}
            <Field testID={`product-option-${i}-name`} label={t('products.form.optionName.label')} value={option.name} editable={!disabled} onChangeText={(name) => setOptions(form.options.map((o, at) => (at === i ? { ...o, name } : o)))} />
            <Field testID={`product-option-${i}-values`} label={t('products.form.optionValues.label')} hint={t('products.form.optionValues.hint')} value={option.values} editable={!disabled} onChangeText={(values) => setOptions(form.options.map((o, at) => (at === i ? { ...o, values } : o)))} />
            <Button testID={`product-option-${i}-remove`} kind="quiet" label={t('products.form.removeOption')} disabled={disabled} onPress={() => setOptions(form.options.filter((_, at) => at !== i))} />
          </View>
        ))}
        {form.options.length < CATALOG.options ? (
          <Button testID="product-option-add" kind="secondary" label={t('products.form.addOption')} disabled={disabled} onPress={() => setOptions([...form.options, { name: '', values: '' }])} />
        ) : null}
        {errors.options ? <Text variant="caption" tone="bad" testID="product-options-error">{t(errors.options)}</Text> : null}
      </Card>
      {form.variants.length ? (
        <Card testID="product-variants">
          <Text variant="title">{t('products.form.variants', { count: form.variants.length })}</Text>
          {errors.variants ? <Text variant="caption" tone="bad" testID="product-variants-error">{`${variantError ? `${variantError}: ` : ''}${t(errors.variants)}`}</Text> : null}
          {form.variants.map((variant, i) => (
            <View key={variantLabel(variant)} testID={`product-variant-${i}`} style={{ gap: theme.space[2] }}>
              {i ? <Divider /> : null}
              <Text variant="small" style={{ fontWeight: '600' }}>{variantLabel(variant)}</Text>
              <MoneyField testID={`product-variant-${i}-price`} label={t('products.form.price')} value={variant.price} editable={!disabled} onChangeText={(price) => setVariant(i, { price })} />
              <MoneyField testID={`product-variant-${i}-mrp`} label={t('products.form.mrp')} value={variant.mrp} editable={!disabled} onChangeText={(mrp) => setVariant(i, { mrp })} />
              <Field testID={`product-variant-${i}-sku`} label={t('products.form.sku')} value={variant.sku} editable={!disabled} onChangeText={(sku) => setVariant(i, { sku })} />
              <Toggle testID={`product-variant-${i}-stock`} title={t('products.form.inStock')} value={variant.inStock} disabled={disabled} onValueChange={(inStock) => setVariant(i, { inStock })} />
              {form.images.length ? (
                <Choices testID={`product-variant-${i}-photo`} label={t('products.form.variantPhoto')} value={variant.imageIndex === null ? 'none' : String(variant.imageIndex)} disabled={disabled} onChange={(v) => setVariant(i, { imageIndex: v === 'none' ? null : Number(v) })} options={photoChoices} />
              ) : null}
            </View>
          ))}
        </Card>
      ) : null}
    </Section>
  );
}

/**
 * A product, new or saved (PRD 8.1, 8.2): name, description, price and MRP in rupees (sent as paise), up to six photos
 * checked against the upload limits before they go, options and variants, categories, stock, WhatsApp ordering. Only
 * what changed is sent, so an untouched imported price stays the site's (8.8). The server's refusal is shown as it
 * says it. Saving needs a connection.
 */
export default function ProductEditScreen({ route }) {
  const id = route?.params?.id && route.params.id !== 'new' ? String(route.params.id) : null;
  const { api } = useServices();
  const { t, locale } = useStrings();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { online, offline } = useConnection();
  const product = useQuery({ queryKey: productKey(id), queryFn: () => api.products.get(id), enabled: Boolean(id) });
  const [form, setForm] = useState(id ? null : { ...EMPTY_PRODUCT });
  const [errors, setErrors] = useState({});
  const [variantError, setVariantError] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [saved, setSaved] = useState(false);

  // The form starts from what the server has, once; a later refetch doesn't throw away what is being typed.
  useEffect(() => {
    if (id && product.data && !form) setForm(productToForm(product.data));
  }, [id, product.data, form]);
  const baseline = useMemo(() => (product.data ? formToProduct(productToForm(product.data)).body ?? null : null), [product.data]);

  const set = (patch) => {
    setSaved(false);
    setForm((old) => ({ ...old, ...patch }));
  };
  const done = (answer) => {
    queryClient.setQueryData(productKey(answer.id), answer);
    queryClient.invalidateQueries({ queryKey: [...PRODUCTS_KEY, 'list'] });
  };
  const save = useMutation({
    mutationFn: (body) => (id ? api.products.update(id, body) : api.products.create(body)),
    onSuccess: (answer) => {
      done(answer);
      setSaved(true);
      setForm(productToForm(answer));
      if (!id) navigation.replace?.('products.edit', { id: String(answer.id) });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.products.remove(id),
    onSuccess: () => {
      setConfirmRemove(false);
      queryClient.removeQueries({ queryKey: productKey(id) });
      queryClient.invalidateQueries({ queryKey: [...PRODUCTS_KEY, 'list'] });
      navigation.goBack();
    },
  });
  const recheck = useMutation({ mutationFn: () => api.products.recheck(id) });

  function submit() {
    const read = formToProduct(form);
    setErrors(read.errors ?? {});
    setVariantError(read.variantLabel ?? '');
    if (read.errors) return;
    const body = id && baseline ? changedFields(baseline, read.body) : read.body;
    if (id && !Object.keys(body).length) {
      setSaved(true);
      return;
    }
    save.mutate(body);
  }

  const data = product.data;
  const busy = save.isPending || remove.isPending;
  const locked = busy;
  const body = form ? (
    <>
      {data && needsAttention(data) ? <Banner tone="bad" testID="product-attention" title={t('products.badge.attention')}>{t(`products.fetch.${data.fetchStatus}`)}</Banner> : null}
      {data?.priceChanged ? (
        <Banner tone="warn" testID="product-price-changed" title={t('products.badge.priceChanged')}>
          {data.previousPricePaise === null ? t('products.priceChangedNoWas', { now: formatMoney(data.pricePaise) }) : t('products.priceChangedWas', { was: formatMoney(data.previousPricePaise), now: formatMoney(data.pricePaise) })}
        </Banner>
      ) : null}
      {data ? (
        <Card>
          <Text variant="meta">{t('products.shoppersSee')}</Text>
          <PriceText product={data} testID="product-display" />
          <Text variant="caption">{t(isImported(data) ? 'products.importedFrom' : 'products.source.manual', { source: t(`products.source.${['link', 'shopify', 'csv'].includes(data.source) ? data.source : 'adapter'}`) })}</Text>
          {data.lastCheck ? <Text variant="caption">{t('products.lastCheck', { when: formatWhen(t, data.lastCheck.at, { locale }) })}</Text> : null}
        </Card>
      ) : null}
      <Card>
        <Field testID="product-name" label={t('products.form.name')} value={form.name} editable={!locked} onChangeText={(name) => set({ name })} error={errors.name ? t(errors.name) : null} maxLength={CATALOG.nameLength} />
        <Field testID="product-description" label={t('products.form.description')} value={form.description} editable={!locked} onChangeText={(description) => set({ description })} error={errors.description ? t(errors.description) : null} multiline />
        <MoneyField testID="product-price" label={t('products.form.price')} value={form.price} editable={!locked} onChangeText={(price) => set({ price })} error={errors.price ? t(errors.price) : null} hint={form.options.length ? t('products.form.priceWithVariants') : null} />
        <MoneyField testID="product-mrp" label={t('products.form.mrp')} value={form.mrp} editable={!locked} onChangeText={(mrp) => set({ mrp })} error={errors.mrp ? t(errors.mrp) : null} hint={t('products.form.mrpHint')} />
        {!form.options.length ? <Field testID="product-sku" label={t('products.form.sku')} value={form.sku} editable={!locked} onChangeText={(sku) => set({ sku })} error={errors.sku ? t(errors.sku) : null} /> : null}
      </Card>
      <Card>
        <PhotoField testID="product-photos" label={t('products.form.photos', { max: CATALOG.images })} urls={form.images} max={CATALOG.images} disabled={locked || !online} onChange={(images) => set({ images, variants: form.variants.map((v) => (v.imageIndex !== null && v.imageIndex >= images.length ? { ...v, imageIndex: null } : v)) })} />
        {errors.images ? <Text variant="caption" tone="bad">{t(errors.images)}</Text> : null}
      </Card>
      <OptionsEditor form={form} set={set} errors={errors} variantError={variantError} disabled={locked} />
      <Card>
        <Toggle testID="product-in-stock" title={t('products.form.inStock')} value={form.inStock} disabled={locked} onValueChange={(inStock) => set({ inStock })} />
        <Field testID="product-stock" label={t('products.form.stock')} hint={t('products.form.stockHint')} value={form.stock} editable={!locked} keyboardType="number-pad" onChangeText={(stock) => set({ stock })} error={errors.stock ? t(errors.stock) : null} />
        <Toggle testID="product-active" title={t('products.form.active')} subtitle={t('products.form.activeHint')} value={form.active} disabled={locked} onValueChange={(active) => set({ active })} />
        <Toggle testID="product-featured" title={t('products.form.featured')} value={form.featured} disabled={locked} onValueChange={(featured) => set({ featured })} />
        <Choices testID="product-whatsapp" label={t('products.form.whatsapp')} value={form.whatsappOrder} disabled={locked} onChange={(whatsappOrder) => set({ whatsappOrder })} options={WHATSAPP_CHOICES.map((c) => ({ value: c, label: t(`products.whatsapp.${c}`) }))} />
        <Field testID="product-tags" label={t('products.form.tags')} hint={t('products.form.tagsHint')} value={form.tags} editable={!locked} onChangeText={(tags) => set({ tags })} error={errors.tags ? t(errors.tags) : null} />
        <Field testID="product-link" label={t('products.form.link')} hint={t('products.form.linkHint')} value={form.externalUrl} editable={!locked} autoCapitalize="none" keyboardType="url" onChangeText={(externalUrl) => set({ externalUrl })} error={errors.externalUrl ? t(errors.externalUrl) : null} />
      </Card>
      <CategoryPicker value={form.categoryIds} onChange={(categoryIds) => set({ categoryIds })} disabled={locked} />
      {Object.keys(errors).length ? <Banner tone="bad" testID="product-form-errors">{t('products.form.fix')}</Banner> : null}
      <Refusal error={save.error} testID="product-save-error" />
      {saved ? <Banner tone="good" testID="product-saved">{t('products.saved')}</Banner> : null}
      <Button testID="product-save" label={t(id ? 'common.save' : 'products.create')} busy={save.isPending} disabled={!online || remove.isPending} onPress={submit} />
      {!online ? <Text variant="caption" testID="product-offline">{t('offline.writeDisabled')}</Text> : null}
      {data && isImported(data) ? (
        <View style={{ gap: 4 }}>
          <Button testID="product-recheck" kind="secondary" label={t('products.recheck')} busy={recheck.isPending} disabled={!online} onPress={() => recheck.mutate()} />
          {recheck.data ? <Text variant="caption" testID="product-recheck-queued">{t('products.recheckQueued')}</Text> : null}
          <Refusal error={recheck.error} testID="product-recheck-error" />
        </View>
      ) : null}
      {id ? <Button testID="product-remove" kind="danger" label={t('products.removeProduct')} disabled={!online || busy} onPress={() => setConfirmRemove(true)} /> : null}
      <Refusal error={remove.error} testID="product-remove-error" />
      <ConfirmSheet
        testID="product-remove-confirm"
        visible={confirmRemove}
        title={t('products.removeConfirm.title')}
        confirmLabel={t('products.removeConfirm.action')}
        cancelLabel={t('common.cancel')}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => remove.mutate()}
        busy={remove.isPending}
        disabled={!online}
      >
        {t('products.removeConfirm.body')}
      </ConfirmSheet>
    </>
  ) : null;

  return (
    <Page testID="screen-product" offline={offline}>
      <Text variant="page">{id ? data?.name || t('products.title') : t('products.add')}</Text>
      {id ? <Loadable query={product} testID="product">{body}</Loadable> : body}
    </Page>
  );
}
