/**
 * What the automation-side screens share (home, automations, inbox, connect, compliance, links, alerts, activity,
 * reels, domains): whether a change can be made now, how a refusal reads, paged lists from the offline cache, and the
 * status notices. It lives here because a refusal from the compliance engine is the case every screen must get right.
 *
 *   const writable = useWritable();                  false offline: every button that writes is disabled (P-19)
 *   <Refusal error={mutation.error} />               the engine's reason, the offline line, or the server's plain words
 *   const list = usePaged(['alerts'], api.alerts.list, { limit: 20 });   list.items, from the cache first
 *   <PagedState query={list} ...>{rows}</PagedState> loading, error, empty and the rows, with Load more
 *
 * Nothing here logs: a screen never writes a person's name, number or message anywhere but the screen.
 */
import React from 'react';
import { View } from 'react-native';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { errorKey, useOnline, useStrings } from '@bhava/app-core';
import { Banner, Button, EmptyState, ListState, Text, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { describeReason, isReason } from './reasons.js';
import { statusNotices } from './notices.js';

/** True when a change can be sent now: there is a connection and the session is not running on what it saved. */
export function useWritable() {
  const { offline } = useSession();
  const online = useOnline();
  return online && !offline;
}

const SERVER_WORDS = new Set([400, 409, 410, 413, 415, 422, 429]);

/**
 * What a refused change says, as { text, code }: the compliance engine's reason when it gave one (with the code, so
 * support can find it), the offline line, a plain sentence for access and missing records, and otherwise the server's
 * own words for a refusal it explained. A fault on the server is a sentence too, never a stack.
 */
export function refusalOf(t, error) {
  if (!error) return null;
  if (error.code === 'offline') return { text: t('offline.writeDisabled'), code: '' };
  if (error.status === 0 || error.code === 'network') return { text: t('error.network'), code: '' };
  if (error.reason && isReason(error.reason)) return { text: describeReason(t, error.reason), code: error.reason };
  if (error.status === 403) return { text: t('error.forbidden'), code: '' };
  if (error.status === 404) return { text: t('error.notFound'), code: '' };
  if (SERVER_WORDS.has(error.status) && typeof error.message === 'string' && error.message.trim()) return { text: error.message.trim(), code: error.reason ?? '' };
  return { text: t('error.saveFailed'), code: '' };
}

/** A refused change, on the screen. Nothing when there is no error. */
export function Refusal({ error, testID = 'refusal', title }) {
  const { t } = useStrings();
  const theme = useTheme();
  const refusal = refusalOf(t, error);
  if (!refusal) return null;
  return (
    <Banner testID={testID} tone="bad" title={title}>
      {refusal.text}
      {refusal.code ? <Text variant="caption" testID={`${testID}-code`} style={{ fontFamily: theme.font.bodyMedium }}>{`\n${refusal.code}`}</Text> : null}
    </Banner>
  );
}

/**
 * One list from the API, page by page, read from the offline cache first. `key` starts with the feature's name, so no
 * two screens share a cache entry by accident; `fetch` is an api method that takes { cursor, limit, ...query }.
 */
export function usePaged(key, fetch, query = {}, options = {}) {
  const result = useInfiniteQuery({
    queryKey: [...key, query],
    queryFn: ({ pageParam }) => fetch({ ...query, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null,
    getNextPageParam: (last) => last?.nextCursor || undefined,
    ...options,
  });
  const items = result.data?.pages?.flatMap((page) => page?.items ?? []) ?? [];
  return {
    items,
    data: result.data,
    isPending: result.isPending,
    isPaused: result.isPaused,
    isSuccess: result.isSuccess,
    isFetching: result.isFetching,
    error: result.error,
    refetch: result.refetch,
    hasNextPage: result.hasNextPage,
    fetchNextPage: result.fetchNextPage,
    isFetchingNextPage: result.isFetchingNextPage,
  };
}

/** Offline, with nothing of this saved on the phone yet: said plainly, instead of a spinner that never stops. */
export function NothingSaved({ testID }) {
  const { t } = useStrings();
  return <EmptyState testID={testID ? `${testID}-offline` : undefined} title={t('offline.title')}>{t('offline.body')}</EmptyState>;
}

/** The four states of a paged list, and "Load more" while there are more (disabled offline). */
export function PagedState({ query, testID, emptyTitle, emptyBody, emptyAction, children }) {
  const { t } = useStrings();
  const writable = useWritable();
  if (query.isPending && query.isPaused) return <NothingSaved testID={testID} />;
  return (
    <ListState
      testID={testID}
      loading={query.isPending}
      error={query.error}
      empty={query.items.length === 0}
      loadingLabel={t('common.loading')}
      errorTitle={t('error.title')}
      errorBody={query.error ? t(errorKey(query.error)) : ''}
      onRetry={() => query.refetch()}
      retryLabel={t('common.retry')}
      emptyView={<EmptyState testID={testID ? `${testID}-empty` : undefined} title={emptyTitle} action={emptyAction}>{emptyBody}</EmptyState>}
    >
      {children}
      {query.hasNextPage ? (
        <Button testID={testID ? `${testID}-more` : undefined} kind="secondary" label={t('compliance.kit.loadMore')} busy={query.isFetchingNextPage} disabled={!writable} onPress={() => query.fetchNextPage()} />
      ) : null}
    </ListState>
  );
}

/** One record: loading, failed, missing, or drawn by `children(data)`. */
export function RecordState({ query, testID, emptyTitle, children }) {
  const { t } = useStrings();
  if (query.isPending && query.isPaused) return <NothingSaved testID={testID} />;
  return (
    <ListState
      testID={testID}
      loading={query.isPending}
      error={query.error}
      empty={query.data === undefined || query.data === null}
      loadingLabel={t('common.loading')}
      errorTitle={t('error.title')}
      errorBody={query.error ? t(errorKey(query.error)) : ''}
      onRetry={() => query.refetch()}
      retryLabel={t('common.retry')}
      emptyView={<EmptyState title={emptyTitle ?? t('error.notFound')} />}
    >
      {query.data !== undefined && query.data !== null ? children(query.data) : null}
    </ListState>
  );
}

/** The three answers that decide whether messages can go. Each fails on its own, so one bad answer hides nothing else. */
export function useStatusSources({ enabled = true } = {}) {
  const { api } = useServices();
  const status = useQuery({ queryKey: ['compliance', 'status'], queryFn: () => api.compliance.status(), enabled, refetchInterval: 30_000 });
  const connection = useQuery({ queryKey: ['connect', 'instagram'], queryFn: () => api.instagram.connection(), enabled });
  const facebook = useQuery({ queryKey: ['connect', 'facebook'], queryFn: () => api.facebook.connection(), enabled, retry: false });
  return { status, connection, facebook };
}

/** The notices as a seller reads them: a banner each, with the one thing to do about it. */
export function NoticeList({ notices, testID = 'notices' }) {
  const { t } = useStrings();
  const theme = useTheme();
  const openLink = useOpenLink();
  if (!notices?.length) return null;
  const words = (notice) => {
    const values = { ...(notice.values ?? {}) };
    if (Array.isArray(values.scopes)) values.scopes = values.scopes.map((scope) => t(`compliance.scope.${scope}`)).join(t('compliance.kit.and'));
    return t(notice.text, values);
  };
  return (
    <View testID={testID} style={{ gap: theme.space[2] }}>
      {notices.map((notice) => (
        <Banner
          key={notice.key}
          testID={`notice-${notice.key}`}
          tone={notice.tone}
          action={notice.action ? <Button testID={`notice-${notice.key}-action`} kind="secondary" label={t(notice.action.label)} onPress={() => openLink(notice.action.path)} /> : null}
        >
          {words(notice)}
        </Banner>
      ))}
    </View>
  );
}

/** The status notices for anyone the API would answer; nothing at all for anyone else, and nothing while loading. */
export function StatusNotices({ allowed = true, omit = [] }) {
  const { status, connection, facebook } = useStatusSources({ enabled: allowed });
  if (!allowed) return null;
  const notices = statusNotices({ status: status.data, connection: connection.data, facebook: facebook.data }).filter((notice) => !omit.includes(notice.key));
  return <NoticeList notices={notices} />;
}

/** "3 Sept, 4:05 pm" in India time, the zone every schedule and log uses (PRD 6.8). A value that cannot be read shows nothing. */
export function formatDateTime(value, { locale = 'en' } = {}) {
  const at = new Date(value ?? '');
  if (Number.isNaN(at.getTime())) return '';
  try {
    return at.toLocaleString(locale === 'hi' ? 'hi-IN' : 'en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  } catch {
    return at.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * Money is integer paise everywhere, and this only shows it: "₹1,86,420" or "₹499.50", the console's format. Nothing
 * on the phone adds or works out an amount; a value that is not a whole number of paise shows nothing.
 */
export function formatPaise(paise) {
  if (!Number.isSafeInteger(paise)) return '';
  const sign = paise < 0 ? '-' : '';
  const whole = Math.trunc(Math.abs(paise) / 100);
  const rest = Math.abs(paise) % 100;
  const rupees = whole.toLocaleString('en-IN');
  return `${sign}₹${rest ? `${rupees}.${String(rest).padStart(2, '0')}` : rupees}`;
}
