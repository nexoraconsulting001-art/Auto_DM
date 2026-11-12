/**
 * The pieces the store and account screens share, on top of @bhava/ui: a paged list that opens offline on what was
 * saved, the badge for a status, the way a change is made (only with a connection; a refusal shows the server's reason
 * and the screen reads the truth again), and the write-only field a key is typed into (P-17).
 *
 * Words come from the features' strings; nothing here names a business or the platform.
 */
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Linking, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as WebBrowser from 'expo-web-browser';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, errorKey, useOnline, useReauth, useStrings } from '@bhava/app-core';
import { isAllowed } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Divider, EmptyState, ErrorState, Field, ListRow, ListState, LoadingRows, Sheet, Text, Toggle, useTheme } from '@bhava/ui';
import { useSession } from '../../../shell/hooks.js';
import { WRITE_ONLY_FIELDS, formatPaise, rowsOf, toneOf } from './rules.js';

export { formatPaise };

/** True while a change can be sent: there is a connection and the session is not running on what it saved (P-19). */
export function useWritable() {
  const { offline } = useSession();
  const online = useOnline();
  return online && !offline;
}

/** `allowed(access)`: the same rule the server applies, for hiding a button the person may not use. */
export function useAllowed() {
  const { user } = useSession();
  return useCallback((access) => isAllowed(user ?? null, access), [user]);
}

/** The offline banner for a screen: shown whenever the screen is on saved rows. */
export function Offline() {
  const writable = useWritable();
  return <OfflineBanner offline={!writable} />;
}

/** A status as a badge, in the seller's words: orders.status.<group>.<status>. */
export function StatusBadge({ group, status, testID }) {
  const { t } = useStrings();
  if (!status) return null;
  return <Badge testID={testID} label={t(`orders.status.${group}.${status}`)} tone={toneOf(group, status)} />;
}

/** Several badges in a row. */
export function Badges({ items, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[1] }}>
      {items.map((item) => <StatusBadge key={`${item.group}.${item.status}`} {...item} />)}
    </View>
  );
}

/** Label and value on one line, for totals and facts. `strong` for a total. */
export function Fact({ label, value, strong = false, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} style={{ flexDirection: 'row', justifyContent: 'space-between', gap: theme.space[3] }}>
      <Text variant={strong ? 'body' : 'small'} style={strong ? { fontFamily: theme.font.bodySemiBold } : null}>{label}</Text>
      <Text variant={strong ? 'body' : 'small'} style={[{ textAlign: 'right', flexShrink: 1 }, strong ? { fontFamily: theme.font.bodySemiBold } : null]}>{value}</Text>
    </View>
  );
}

/**
 * Words for a change that failed, or '' for one the person stopped themselves (closing the re-auth sheet). A refusal
 * of the seller's own change (the state machine's 409, a check's 400, a limit's 429) shows the server's reason, which
 * is written for a person; anything else is the app's own line, so nothing about another record is ever shown.
 */
export function problemText(t, error) {
  if (!error || error.code === 'cancelled') return '';
  if (error.code === 'offline') return t('offline.writeDisabled');
  if (error.status === 0) return t('error.network');
  if ([400, 409, 429].includes(error.status) && error.message) {
    const fields = Object.values(error.fields ?? {}).filter((m) => typeof m === 'string' && m && m !== error.message);
    return [error.message, ...fields].join(' ');
  }
  if (error.status === 403) return t(error.code === 'reauth_required' ? 'reauth.body' : 'error.forbidden');
  if (error.status === 404) return t('error.notFound');
  return t('error.saveFailed');
}

/** Runs `work`; only if the server answers `reauth_required` does it ask for the fresh check, then tries once more. */
export async function whenAsked(runFresh, work) {
  try {
    return await work();
  } catch (error) {
    if (error?.code !== 'reauth_required') throw error;
    return runFresh(work);
  }
}

/**
 * How a screen makes a change: `run(key, work, { done, reload, fresh })`. Only with a connection; never queued. On success
 * the given queries are read again; on any refusal they are read again too, so the screen shows the truth and not
 * what it hoped (a status the state machine refused, a record someone else changed). `busy` is the running key.
 */
export function useAction(reload = []) {
  const queryClient = useQueryClient();
  const { t } = useStrings();
  const writable = useWritable();
  const { runFresh } = useReauth();
  const keys = useRef(reload);
  keys.current = reload;
  const [busy, setBusy] = useState('');
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');

  const refreshAll = useCallback(
    (extra = []) => Promise.all([...keys.current, ...extra].map((queryKey) => queryClient.invalidateQueries({ queryKey }))).catch(() => {}),
    [queryClient],
  );

  const run = useCallback(async (key, work, { done: doneKey, reload: extra = [], onError, fresh = false } = {}) => {
    setProblem('');
    setDone('');
    if (!writable) {
      setProblem(t('offline.writeDisabled'));
      return null;
    }
    setBusy(key);
    try {
      // A route marked fresh asks for fingerprint, face or a code first; any other asks only if the server says so.
      const result = fresh ? await runFresh(work) : await whenAsked(runFresh, work);
      if (doneKey) setDone(t(doneKey));
      await refreshAll(extra);
      return result ?? true;
    } catch (error) {
      setProblem(problemText(t, error));
      onError?.(error);
      if (error?.status >= 400 && error?.status < 500) await refreshAll(extra);
      return null;
    } finally {
      setBusy('');
    }
  }, [writable, t, refreshAll, runFresh]);

  const clear = useCallback(() => {
    setProblem('');
    setDone('');
  }, []);
  return { run, busy, problem, done, clear, writable };
}

/** What an action said: its problem in red, or what it did in green. */
export function ActionMessages({ action, testID }) {
  if (action.problem) return <Banner tone="bad" testID={testID ? `${testID}-problem` : undefined}>{action.problem}</Banner>;
  if (action.done) return <Banner tone="good" testID={testID ? `${testID}-done` : undefined}>{action.done}</Banner>;
  return null;
}

/** A list the API pages with `cursor` and `limit`, kept in the offline cache under `key`. */
export function usePaged(key, fetchPage, { enabled = true, limit = 25, meta } = {}) {
  return useInfiniteQuery({
    queryKey: key,
    queryFn: ({ pageParam }) => fetchPage({ limit, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: null,
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
    enabled,
    ...(meta ? { meta } : {}),
  });
}

/**
 * The rows of a paged query in a card, with the four states (loading, failed, empty, rows) and "Show more". A failed
 * read with saved rows in hand shows the rows: the screen's offline banner says why they may be old.
 */
export function PagedList({ query, testID, emptyTitle, emptyBody, rowKey = (row) => row.id, renderRow }) {
  const { t } = useStrings();
  const rows = rowsOf(query.data);
  return (
    <ListState
      testID={testID}
      loading={query.isPending}
      error={query.error}
      empty={rows.length === 0}
      loadingLabel={t('common.loading')}
      errorTitle={t('error.title')}
      errorBody={query.error ? t(errorKey(query.error)) : ''}
      onRetry={() => query.refetch()}
      retryLabel={t('common.retry')}
      emptyView={<EmptyState testID={testID ? `${testID}-empty` : undefined} title={emptyTitle}>{emptyBody}</EmptyState>}
    >
      <Card testID={testID}>
        {rows.map((row, i) => (
          <View key={String(rowKey(row))}>
            {i > 0 ? <Divider /> : null}
            {renderRow(row)}
          </View>
        ))}
      </Card>
      {query.hasNextPage ? <Button testID={testID ? `${testID}-more` : undefined} kind="secondary" label={t('orders.more')} onPress={() => query.fetchNextPage()} busy={query.isFetchingNextPage} /> : null}
    </ListState>
  );
}

/** One record: a spinner, a failure with a retry, or `children(data)`. */
export function RecordView({ query, testID, children }) {
  const { t } = useStrings();
  if (query.isPending) return <LoadingRows testID={testID ? `${testID}-loading` : undefined} label={t('common.loading')} />;
  if (!query.data) {
    return <ErrorState testID={testID ? `${testID}-error` : undefined} title={t('error.title')} onRetry={() => query.refetch()} retryLabel={t('common.retry')}>{t(errorKey(query.error))}</ErrorState>;
  }
  return children(query.data);
}

/** A rupee amount typed by a person. The field holds text; parseRupees() turns it into paise. */
export function RupeeField({ label, value, onChangeText, error, hint, testID }) {
  return <Field testID={testID} label={label} value={value} onChangeText={(text) => onChangeText(text.replace(/[^\d.,₹ ]/g, '').slice(0, 14))} error={error} hint={hint} keyboardType="decimal-pad" inputMode="decimal" maxLength={14} />;
}

/** A whole number typed by a person. */
export function NumberField({ label, value, onChangeText, error, hint, testID, signed = false }) {
  const allowed = signed ? /[^\d-]/g : /\D/g;
  return <Field testID={testID} label={label} value={value} onChangeText={(text) => onChangeText(text.replace(allowed, '').slice(0, 10))} error={error} hint={hint} keyboardType={signed ? 'numbers-and-punctuation' : 'number-pad'} inputMode="numeric" maxLength={10} />;
}

/**
 * A key, a secret or a password, typed and never shown again (P-17): masked, kept out of autofill, the clipboard menu
 * and the keyboard's memory, and never filled from anything the server sent. `saved` says whether one is stored,
 * without saying what it is.
 */
export function SecretField({ label, value, onChangeText, saved = false, error, hint, testID }) {
  const { t } = useStrings();
  return (
    <Field
      testID={testID}
      label={label}
      value={value}
      onChangeText={onChangeText}
      secret
      error={error}
      hint={hint ?? t(saved ? 'settings.secret.saved' : 'settings.secret.none')}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      contextMenuHidden
      importantForAutofill="no"
      textContentType="none"
      autoComplete="off"
      maxLength={1000}
    />
  );
}

/**
 * Entering or replacing keys (P-17). `fields` is [{ name, label, secret?, saved?, keyboardType?, autoCapitalize? }];
 * `save(values)` sends them; `build(values)`, when given, checks them and makes the body ({ body } or { problems }).
 * A fresh check comes first (fingerprint, face or a WhatsApp code); then the call, made
 * directly so the values never sit in the query cache; then every field is emptied, whatever the answer. Fields left
 * empty are not sent. `required` names the fields that must be filled.
 */
export function KeyForm({ testID, fields, required = [], build, save, submitLabel, doneKey, reload = [], disabled = false, intro, onSaved }) {
  const { t } = useStrings();
  const { runFresh } = useReauth();
  const writable = useWritable();
  const queryClient = useQueryClient();
  const blank = useMemo(() => Object.fromEntries(fields.map((field) => [field.name, ''])), [fields]);
  const [values, setValues] = useState(blank);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [missing, setMissing] = useState({});
  const [done, setDone] = useState('');

  async function submit() {
    setProblem('');
    setDone('');
    const absent = Object.fromEntries(required.filter((name) => !String(values[name] ?? '').trim()).map((name) => [name, t('settings.secret.required')]));
    let body = {};
    if (build) {
      const built = build(values);
      for (const [name, key] of Object.entries(built.problems ?? {})) absent[name] ??= t(key);
      body = built.body ?? {};
    } else {
      for (const field of fields) {
        const value = field.secret || WRITE_ONLY_FIELDS.includes(field.name) ? values[field.name] : String(values[field.name] ?? '').trim();
        if (value) body[field.name] = value;
      }
    }
    setMissing(absent);
    if (Object.keys(absent).length) return;
    if (!writable) {
      setProblem(t('offline.writeDisabled'));
      return;
    }
    setBusy(true);
    try {
      const answer = await runFresh(() => save(body));
      setValues(blank);
      if (doneKey) setDone(t(doneKey));
      onSaved?.(answer);
      await Promise.all(reload.map((queryKey) => queryClient.invalidateQueries({ queryKey }))).catch(() => {});
    } catch (error) {
      if (error?.code !== 'cancelled') {
        // Whatever the server said, what was typed is not kept: it is typed again.
        setValues(blank);
        setProblem(problemText(t, error));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <View testID={testID} style={{ gap: 12 }}>
      {intro ? <Text variant="small">{intro}</Text> : null}
      {fields.map((field) =>
        field.secret ? (
          <SecretField key={field.name} testID={`${testID}-${field.name}`} label={field.label} saved={field.saved} value={values[field.name]} error={missing[field.name]} onChangeText={(text) => setValues((v) => ({ ...v, [field.name]: text }))} />
        ) : (
          <Field
            key={field.name}
            testID={`${testID}-${field.name}`}
            label={field.label}
            hint={field.hint}
            value={values[field.name]}
            error={missing[field.name]}
            onChangeText={(text) => setValues((v) => ({ ...v, [field.name]: text }))}
            autoCapitalize={field.autoCapitalize ?? 'none'}
            autoCorrect={false}
            keyboardType={field.keyboardType}
            maxLength={field.maxLength ?? 200}
          />
        ),
      )}
      {problem ? <Banner tone="bad" testID={`${testID}-problem`}>{problem}</Banner> : null}
      {done ? <Banner tone="good" testID={`${testID}-done`}>{done}</Banner> : null}
      <Text variant="meta">{t('settings.secret.fresh')}</Text>
      <Button testID={`${testID}-save`} label={submitLabel} onPress={() => { submit(); }} busy={busy} disabled={disabled || !writable} />
    </View>
  );
}

/** A small line that money moves through the server's numbers only. */
export function Money({ paise, testID, strong = false }) {
  const theme = useTheme();
  return <Text testID={testID} variant="body" style={strong ? { fontFamily: theme.font.bodySemiBold } : null}>{formatPaise(paise)}</Text>;
}

/** A when, short: 12 Nov 2026, 4:05 pm, in India's time. */
export function formatWhenAt(value, locale = 'en') {
  const time = Date.parse(value ?? '');
  if (!Number.isFinite(time)) return '';
  try {
    return new Intl.DateTimeFormat(locale === 'hi' ? 'hi-IN' : 'en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(time));
  } catch {
    return new Date(time).toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * Steps down a line, as the tracking page draws a parcel's journey: each step done in the brand's colour, the latest
 * ringed in the accent, what is still to come hollow. `steps` is [{ key, title, meta?, note?, state: 'done'|'now'|'next' }].
 */
export function Journey({ steps, testID }) {
  const theme = useTheme();
  return (
    <View testID={testID} accessibilityRole="list" style={{ gap: 0 }}>
      {steps.map((step, i) => {
        const last = i === steps.length - 1;
        const dot = step.state === 'now'
          ? { width: 18, height: 18, borderRadius: 9, backgroundColor: theme.color.accent, borderWidth: 4, borderColor: theme.color.accentTint }
          : step.state === 'done'
            ? { width: 14, height: 14, borderRadius: 7, backgroundColor: theme.color.primary, marginLeft: 2 }
            : { width: 14, height: 14, borderRadius: 7, borderWidth: 2, borderColor: theme.color.line, backgroundColor: theme.color.surface, marginLeft: 2 };
        return (
          <View key={String(step.key)} testID={testID ? `${testID}-${i}` : undefined} accessible accessibilityLabel={[step.title, step.meta, step.note].filter(Boolean).join(', ')} style={{ flexDirection: 'row', gap: theme.space[3] }}>
            <View style={{ width: 18, alignItems: 'flex-start' }}>
              <View style={[{ marginTop: 3 }, dot]} />
              {!last ? <View style={{ flex: 1, width: 2, marginLeft: 8, backgroundColor: step.state === 'next' ? theme.color.line : theme.color.primaryLine, minHeight: 18 }} /> : null}
            </View>
            <View style={{ flex: 1, gap: 2, paddingBottom: last ? 0 : theme.space[3] }}>
              <Text variant="body" style={{ fontFamily: theme.font.bodySemiBold }}>{step.title}</Text>
              {step.meta ? <Text variant="meta">{step.meta}</Text> : null}
              {step.note ? <Text variant="small">{step.note}</Text> : null}
            </View>
          </View>
        );
      })}
    </View>
  );
}

/** The state of a form: `values`, `set(name)` for a field's onChange, `problems` by field (string keys), and `reset`. */
export function useForm(initial) {
  const [values, setValues] = useState(initial);
  const [problems, setProblems] = useState({});
  const set = useCallback((name) => (value) => setValues((v) => ({ ...v, [name]: typeof value === 'function' ? value(v[name]) : value })), []);
  const reset = useCallback((next) => {
    setValues(next);
    setProblems({});
  }, []);
  return { values, set, problems, setProblems, reset };
}

/** The words for a field's problem key, or undefined. */
export function useProblem(problems) {
  const { t } = useStrings();
  return (name, vars) => (problems?.[name] ? t(problems[name], vars) : undefined);
}

/** One choice from many, such as a state: the chosen one on a row, the rest in a sheet. `options` is [{ value, label }]. */
export function PickerField({ label, value, options, onChange, placeholder, error, disabled = false, testID }) {
  const { t } = useStrings();
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const chosen = options.find((option) => option.value === value);
  const shown = chosen?.label ?? placeholder ?? t('orders.pick');
  return (
    <View style={{ gap: theme.space[1] }}>
      <ListRow testID={testID} title={shown} subtitle={label} onPress={disabled ? undefined : () => setOpen(true)} disabled={disabled} accessibilityLabel={`${label}: ${shown}`} />
      {error ? <Text variant="meta" tone="bad" accessibilityRole="alert">{error}</Text> : null}
      <Sheet testID={testID ? `${testID}-sheet` : undefined} visible={open} onClose={() => setOpen(false)} closeLabel={t('common.close')} title={label}>
        {options.map((option) => (
          <ListRow key={String(option.value)} testID={testID ? `${testID}-${option.value}` : undefined} title={option.label} emphasis={option.value === value} onPress={() => { onChange(option.value); setOpen(false); }} />
        ))}
      </Sheet>
    </View>
  );
}

/** Several choices that may all be on: a toggle for each. `value` is the list of chosen values. */
export function ManyChoices({ options, value, onChange, disabled = false, testID }) {
  return (
    <View testID={testID}>
      {options.map((option) => (
        <Toggle key={String(option.value)} testID={testID ? `${testID}-${option.value}` : undefined} title={option.label} subtitle={option.hint} value={value.includes(option.value)} disabled={disabled} onValueChange={(on) => onChange(on ? [...new Set([...value, option.value])] : value.filter((v) => v !== option.value))} />
      ))}
    </View>
  );
}

/** An address the seller gives to another service (a webhook), with a button that copies it. */
export function CopyLine({ label, value, testID }) {
  const { t } = useStrings();
  const theme = useTheme();
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  return (
    <View testID={testID} style={{ gap: theme.space[1] }}>
      <Text variant="small">{label}</Text>
      <Text variant="body" selectable style={{ fontFamily: theme.font.bodyMedium }}>{value}</Text>
      <Button kind="quiet" testID={testID ? `${testID}-copy` : undefined} label={copied ? t('orders.copied') : t('orders.copy')} onPress={() => { Promise.resolve(Clipboard.setStringAsync(value)).then(() => setCopied(true)).catch(() => {}); }} />
    </View>
  );
}

/** Opens an https address in the system browser (Custom Tabs, Safari), never inside the app. Anything else is ignored. */
export function openOutside(url) {
  if (!/^https:\/\//i.test(String(url ?? ''))) return Promise.resolve(false);
  const opening = typeof WebBrowser?.openBrowserAsync === 'function' ? WebBrowser.openBrowserAsync(url) : Linking.openURL(url);
  return Promise.resolve(opening).then(() => true).catch(() => false);
}
