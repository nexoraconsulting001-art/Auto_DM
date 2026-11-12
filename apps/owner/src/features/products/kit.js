/**
 * What the catalog and analytics screens of the owner app share, on top of @bhava/ui: the four states every screen
 * has (loading, failed, empty, offline), the line that says why a change was refused, the data-source label on
 * every chart, figures that say "Not available" instead of 0, a price field, and photo and file picking that holds
 * the web's upload limits before anything is sent.
 *
 * Words come from the features' strings; nothing here names a business.
 */
import React, { useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Image, Linking, Pressable, View } from 'react-native';
import ChevronRight from 'lucide-react-native/icons/chevron-right';
import { OfflineBanner, errorKey, useOnline, useStrings } from '@bhava/app-core';
import { isAllowed } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, EmptyState, Field, IconButton, ListRow, ListState, Screen, Sparkline, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { CHART_KEYS, RANGES, chartOf, deltaWords, sourceKey } from '../insights/figures.js';
import { IMAGE_RULE, UploadRefused, fileProblem, refusalText, uploadImage } from './upload.js';

/** Online, from both the phone's connection and the session's last call. Writes need it; reads open from the cache without it. */
export function useConnection() {
  const { offline } = useSession();
  const online = useOnline() && !offline;
  return { online, offline: !online };
}

/** A screen with the Offline banner on top. */
export function Page({ testID, children, scroll = true, offline }) {
  return (
    <Screen testID={testID} scroll={scroll}>
      <OfflineBanner offline={offline} />
      {children}
    </Screen>
  );
}

/**
 * The four states of anything loaded: loading, failed with a retry, empty, or the content. Offline with nothing saved
 * on the phone says so instead of spinning: react-query pauses a read it can't make.
 */
export function Loadable({ query, empty = false, emptyTitle, emptyBody, emptyAction, testID, children }) {
  const { t } = useStrings();
  const pausedOffline = query.isPending && query.fetchStatus === 'paused';
  if (pausedOffline) {
    return (
      <EmptyState testID={testID ? `${testID}-offline` : undefined} title={t('offline.title')}>
        {t('offline.body')}
      </EmptyState>
    );
  }
  return (
    <ListState
      testID={testID}
      loading={query.isPending}
      error={query.error}
      empty={empty}
      loadingLabel={t('common.loading')}
      errorTitle={t('error.title')}
      errorBody={query.error ? t(errorKey(query.error)) : ''}
      onRetry={() => query.refetch()}
      retryLabel={t('common.retry')}
      emptyView={<EmptyState testID={testID ? `${testID}-empty` : undefined} title={emptyTitle} action={emptyAction}>{emptyBody}</EmptyState>}
    >
      {children}
    </ListState>
  );
}

/** Why a change didn't happen, in words; nothing when there was no failure. */
export function Refusal({ error, testID }) {
  const { t } = useStrings();
  const text = refusalText(t, error);
  if (!text) return null;
  return <Banner tone="bad" testID={testID}>{text}</Banner>;
}

/** Where a chart's or a table's numbers come from (7.15): "Measured by Bhava", "From Instagram/Facebook" or "From the destination". */
export function SourceTag({ code, testID }) {
  const { t } = useStrings();
  const key = sourceKey(code);
  if (!key) return null;
  return <Text variant="caption" testID={testID}>{t(key)}</Text>;
}

/** The three ranges every analytics screen offers. */
export function RangePicker({ value, onChange, testID = 'range' }) {
  const { t } = useStrings();
  return <Choices testID={testID} label={t('insights.range.label')} value={String(value)} onChange={onChange} options={RANGES.map((r) => ({ value: r, label: t(`insights.range.${r}`) }))} />;
}

/** A figure on a tile: its label, the number or why there is none, and the change on the period before. */
export function FigureTile({ label, text, delta, sub, testID }) {
  const theme = useTheme();
  const { t } = useStrings();
  const change = deltaWords(delta);
  return (
    <View testID={testID} style={{ flexGrow: 1, flexBasis: '45%', minWidth: 140, backgroundColor: theme.color.surface, borderRadius: theme.radius.tile, borderWidth: 1, borderColor: theme.color.line, padding: theme.space[3], gap: 2 }}>
      <Text variant="meta">{label}</Text>
      <Text variant="title" testID={testID ? `${testID}-value` : undefined}>{text}</Text>
      {change ? <Text variant="caption" tone={change.key.endsWith('down') ? 'bad' : change.key.endsWith('up') ? 'good' : 'muted'}>{t(change.key, change.values)}</Text> : null}
      {sub ? <Text variant="caption">{sub}</Text> : null}
    </View>
  );
}

/**
 * A line over days, or the words for why there is none ("Permission needed", "Not available", "Not collected",
 * "No data"): a missing day is left out, never drawn as 0. Always names its source.
 */
export function DaysChart({ title, days, permission, source, testID, width = 300 }) {
  const { t } = useStrings();
  const chart = chartOf(days, { permission });
  return (
    <Card testID={testID}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
        <Text variant="title" style={{ flex: 1 }}>{title}</Text>
        <SourceTag code={source} testID={testID ? `${testID}-source` : undefined} />
      </View>
      {chart.kind === 'chart' ? (
        <Sparkline testID={testID ? `${testID}-line` : undefined} values={chart.values} width={width} label={t('insights.chartLabel', { title, values: chart.values.join(', ') })} />
      ) : (
        <Text variant="small" testID={testID ? `${testID}-state` : undefined}>{t(CHART_KEYS[chart.kind])}</Text>
      )}
      {chart.kind === 'chart' && chart.gaps > 0 ? <Text variant="caption">{t('insights.chartGaps', { count: chart.gaps })}</Text> : null}
    </Card>
  );
}

/** A row that opens another screen. */
export function LinkRow({ title, subtitle, onPress, testID, disabled }) {
  const theme = useTheme();
  return <ListRow testID={testID} title={title} subtitle={subtitle} onPress={onPress} disabled={disabled} end={<ChevronRight color={theme.color.ink3} size={20} />} />;
}

/** A price typed in rupees. The screen reads it with readMoney (products/money.js): paise, never a float. */
export function MoneyField({ label, value, onChangeText, error, hint, testID, editable = true }) {
  return <Field testID={testID} label={label} value={value} onChangeText={onChangeText} error={error} hint={hint} keyboardType="decimal-pad" inputMode="decimal" placeholder="₹" editable={editable} />;
}

/** The phone's photo library: one photo, or null when the person backs out. JPEG on iOS, so HEIC never reaches the check. */
export async function pickImage(picker = require('expo-image-picker')) {
  const result = await picker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9, allowsMultipleSelection: false, preferredAssetRepresentationMode: 'compatible' });
  if (!result || result.canceled) return null;
  return result.assets?.[0] ?? null;
}

/** A document from the phone's files (a CSV), or null. */
export async function pickDocument(types, picker = require('expo-document-picker')) {
  const result = await picker.getDocumentAsync({ type: types, copyToCacheDirectory: true, multiple: false });
  if (!result || result.canceled) return null;
  return result.assets?.[0] ?? null;
}

/**
 * Photos for a product, a logo or a page: what is there, a remove button each, and "Add photo", which checks the
 * photo against the limits before sending it (5 MB; JPG, PNG, WebP or GIF) and shows the server's refusal if it
 * still says no. `onChange` gets the new list of addresses.
 */
export function PhotoField({ label, urls, onChange, max = 1, disabled = false, testID = 'photos', pick = pickImage }) {
  const { api } = useServices();
  const origin = useMediaOrigin();
  const { t } = useStrings();
  const theme = useTheme();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const list = (urls ?? []).filter(Boolean);
  async function add() {
    setError(null);
    let asset;
    try {
      asset = await pick();
    } catch {
      setError(new UploadRefused('products.upload.pickerFailed'));
      return;
    }
    if (!asset) return;
    const problem = fileProblem(asset, IMAGE_RULE);
    if (problem) {
      setError(new UploadRefused(problem));
      return;
    }
    setBusy(true);
    try {
      const uploaded = await uploadImage(api, asset);
      onChange([...list, uploaded.url].slice(0, max));
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }
  return (
    <View style={{ gap: theme.space[2] }}>
      <Text variant="meta">{label}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {list.map((url, i) => (
          <View key={`${url}-${i}`} testID={`${testID}-${i}`} style={{ alignItems: 'center', gap: 2 }}>
            <Image source={{ uri: absoluteMedia(url, origin) ?? undefined }} accessibilityLabel={t('products.photo', { number: i + 1 })} style={{ width: 72, height: 72, borderRadius: theme.radius.small, backgroundColor: theme.color.surfaceSunken }} />
            <Button testID={`${testID}-${i}-remove`} kind="quiet" label={t('products.remove')} disabled={disabled || busy} onPress={() => onChange(list.filter((_, at) => at !== i))} />
          </View>
        ))}
      </View>
      {list.length < max ? <Button testID={`${testID}-add`} kind="secondary" label={t('products.addPhoto')} busy={busy} disabled={disabled} onPress={add} /> : null}
      <Text variant="caption">{t('products.photoLimits')}</Text>
      <Refusal error={error} testID={`${testID}-error`} />
    </View>
  );
}

/**
 * A media path (/media/<id>) as an address the phone can load. Web links stay as they are. Uploaded media is served on
 * the business's own address; the session names it as `business.url` when the server sends one, and otherwise the
 * API's origin is used.
 */
export function absoluteMedia(url, origin) {
  if (!url || /^https?:\/\//i.test(url)) return url;
  if (!/^\/media\/[\w-]+$/.test(url) || !origin) return null;
  return `${String(origin).replace(/\/+$/, '')}${url}`;
}

/** Where this business's media is: its own address when the session knows it, else the API's origin. */
export function useMediaOrigin() {
  const { config } = useServices();
  const { business } = useSession();
  const own = typeof business?.url === 'string' && /^https?:\/\/[^/]+/.test(business.url) ? business.url.match(/^https?:\/\/[^/]+/)[0] : null;
  return own ?? config?.apiOrigin ?? null;
}

/** Opens a web address in the phone's browser: a file, a page's link. Only http(s). */
export async function openAddress(url, linking = Linking) {
  if (!/^https?:\/\//i.test(String(url ?? ''))) return false;
  await linking.openURL(url);
  return true;
}

/** A row of small figures, wrapping on a narrow phone. */
export function TileRow({ children, testID }) {
  const theme = useTheme();
  return <View testID={testID} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>{children}</View>;
}

/** Every page of a list, for "Show more". `fetchPage` gets { cursor } after the first page. */
export function usePaged(queryKey, fetchPage, options = {}) {
  return useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam ? { cursor: pageParam } : {}),
    initialPageParam: null,
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
    ...options,
  });
}
/** The rows of every page loaded so far. */
export const itemsOf = (query) => (query?.data?.pages ?? []).flatMap((p) => p?.items ?? []);

/** "Show more" under a list that has another page. */
export function MoreButton({ query, testID }) {
  const { t } = useStrings();
  if (!query?.hasNextPage) return null;
  return <Button testID={testID} kind="quiet" label={t('products.showMore')} busy={query.isFetchingNextPage} onPress={() => query.fetchNextPage()} />;
}

/**
 * Whether the signed-in person passes an access rule, for a button inside a screen: an owner-only action is not shown
 * to a manager. The server refuses it again.
 */
export function useCan() {
  const { user } = useSession();
  return (access) => Boolean(user) && isAllowed(user, access);
}

/** A small square picture for a row: a product photo, a post's thumbnail. */
export function Thumb({ uri, size = 48, label }) {
  const theme = useTheme();
  const origin = useMediaOrigin();
  const source = absoluteMedia(uri, origin);
  return <Image source={source ? { uri: source } : undefined} accessibilityLabel={label} accessibilityIgnoresInvertColors style={{ width: size, height: size, borderRadius: theme.radius.small, backgroundColor: theme.color.surfaceSunken }} />;
}

/** A file's address as the browser opens it: an https link as it is, a server path (/report-files/d12) on the API's origin. */
export function fileAddress(url, origin) {
  const text = String(url ?? '');
  if (/^https:\/\//i.test(text)) return text;
  if (/^\/[\w./-]+$/.test(text) && !text.includes('..') && origin && /^https?:\/\//i.test(origin)) return `${String(origin).replace(/\/+$/, '')}${text}`;
  return null;
}

/**
 * Opens a file the server made (a report, a download) in the phone's browser. A path on the server is made whole with
 * the API's address. The file asks for a web sign-in there: the app's own session can't travel with a link.
 */
export function FileButton({ url, label, testID }) {
  const { config } = useServices();
  const { t } = useStrings();
  const [failed, setFailed] = useState(false);
  const whole = fileAddress(url, config?.apiOrigin);
  if (!whole) return null;
  return (
    <View style={{ gap: 2 }}>
      <Button testID={testID} kind="secondary" label={label ?? t('products.file.open')} onPress={() => openAddress(whole).then((ok) => setFailed(!ok)).catch(() => setFailed(true))} />
      <Text variant="caption">{t('products.file.hint')}</Text>
      {failed ? <Text variant="caption" tone="bad">{t('products.file.failed')}</Text> : null}
    </View>
  );
}

/**
 * A web address the owner copies (a landing page's DM link, the creator page for the Instagram bio), shown in full so
 * they can see it is their own address with no redirect, with Copy and Open. `clipboard` is expo-clipboard.
 */
export function AddressRow({ url, testID, clipboard }) {
  const { t } = useStrings();
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  if (!url) return null;
  async function copy() {
    try {
      await (clipboard ?? require('expo-clipboard')).setStringAsync(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }
  return (
    <View style={{ gap: theme.space[1] }}>
      <Text variant="small" testID={testID} selectable>{url}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        <Button testID={testID ? `${testID}-copy` : undefined} kind="secondary" label={t(copied ? 'products.address.copied' : 'products.address.copy')} onPress={copy} />
        <Button testID={testID ? `${testID}-open` : undefined} kind="quiet" label={t('products.address.open')} onPress={() => openAddress(url).catch(() => {})} />
      </View>
    </View>
  );
}

/** A small "Sample" or status badge beside a title. */
export { Badge, IconButton, Pressable };
