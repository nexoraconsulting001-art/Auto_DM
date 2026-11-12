import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, useStrings } from '@bhava/app-core';
import { MANAGERS, isAllowed } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, EmptyState, Field, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { RecordState, Refusal, refusalOf, useWritable } from '../compliance/kit.js';
import { KeywordEditor } from '../reels/KeywordEditor.js';
import {
  GOES_OUT, STATE_TONES, automationToForm, changeTrigger, draftWarnings, formToAutomation, launchChecks, newForm, publicReplyProblem, serverFieldErrors,
  stateMoves, trackingChanges, triggerOf, triggersFor,
} from './form.js';
import { ChecksPanel, DmPreview, ExtrasPanel, LinkPanel, MediaPicker, MessagePanel, SchedulePanel, usePreview } from './panels.js';
import { StatsPanel, TestersPanel } from './TestingPanels.js';

export const NEW = 'new';
export const automationKey = (id) => ['automations', 'detail', String(id)];
const FREE_PLAN = 'free';
/** The fields the builder shows an error beside; a server error about any other is listed under the refusal. */
const SHOWN_FIELDS = new Set(['name', 'keywords', 'anyModeAcknowledged', 'priority', 'variants', 'fallbackText', 'linkUrl', 'tapButtonTitle', 'linkButtonTitle', 'linkMessage', 'publicReplyEnabled', 'followupDelayMinutes', 'followupText', 'startsAt', 'endsAt', 'dailyStart', 'dailyEnd', 'schedule', 'triggers']);

/** The builder's one form: values, errors by field, and the words for an error. */
function useForm(initial, disabled) {
  const { t } = useStrings();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState({});
  const set = useCallback((name, value) => setValues((current) => ({ ...current, [name]: typeof value === 'function' ? value(current[name]) : value })), []);
  const merge = useCallback((changes) => setValues((current) => ({ ...current, ...changes })), []);
  const words = useCallback((field) => {
    const error = errors[field];
    if (!error) return '';
    return error.text ?? t(error.key, error.values);
  }, [errors, t]);
  return { values, errors, setErrors, set, merge, words, disabled };
}

function Step({ number, title, sub, children, testID }) {
  const theme = useTheme();
  return (
    <Card testID={testID}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[3] }}>
        <View style={{ width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.color.primaryTint }}>
          <Text variant="title" style={{ color: theme.color.primaryDeep }}>{String(number)}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text variant="title">{title}</Text>
          <Text variant="meta">{sub}</Text>
        </View>
      </View>
      {children}
    </Card>
  );
}

function Matching({ form }) {
  const { t } = useStrings();
  const { triggerType, matchMode } = form.values;
  return (
    <>
      {matchMode === 'keywords' ? (
        <KeywordEditor
          testID="builder-keywords"
          keywords={form.values.keywords}
          draft={form.values.keywordDraft}
          onChange={(next) => form.set('keywords', next)}
          onDraft={(next) => form.set('keywordDraft', next)}
          error={form.words('keywords')}
          disabled={form.disabled}
          labelKey="automations.match.add"
          hintKey="automations.match.hint"
          removeKey="automations.match.remove"
        />
      ) : null}
      <Toggle testID="builder-any" title={t(triggerType === 'comment' ? 'automations.match.everyComment' : 'automations.match.everyMessage')} value={matchMode === 'any'} onValueChange={(on) => form.set('matchMode', on ? 'any' : 'keywords')} disabled={form.disabled} />
      {matchMode === 'any' && triggerType === 'comment' ? (
        <>
          <Toggle testID="builder-any-ack" title={t('automations.match.acknowledge')} value={form.values.anyModeAcknowledged} onValueChange={(v) => form.set('anyModeAcknowledged', v)} disabled={form.disabled} />
          {form.words('anyModeAcknowledged') ? <Text variant="meta" tone="bad">{form.words('anyModeAcknowledged')}</Text> : null}
        </>
      ) : null}
      {triggerType === 'story_reply' ? <Toggle testID="builder-reactions" title={t('automations.match.reactions')} value={form.values.includeReactions} onValueChange={(v) => form.set('includeReactions', v)} disabled={form.disabled} /> : null}
      {triggerType === 'dm_keyword' ? <Field testID="builder-priority" label={t('automations.match.priority')} hint={t('automations.match.priorityHint')} value={form.values.priority} onChangeText={(v) => form.set('priority', v)} keyboardType="number-pad" maxLength={4} editable={!form.disabled} error={form.words('priority')} /> : null}
    </>
  );
}

/** Saves the per-reel ids next to the automation. The automation is saved by then, so a failure here undoes nothing. */
async function saveTracking(api, values, rows) {
  const warnings = [];
  for (const change of trackingChanges(values, rows)) {
    if (change.op === 'create') warnings.push(...((await api.measurementIds.create({ mediaId: change.mediaId, kind: change.kind, value: change.value }))?.warnings ?? []));
    if (change.op === 'update') warnings.push(...((await api.measurementIds.update(change.id, { value: change.value }))?.warnings ?? []));
    if (change.op === 'remove') await api.measurementIds.remove(change.id);
  }
  return warnings;
}

function Editor({ automation, navigation, landed = '' }) {
  const { api } = useServices();
  const { user, business, entitlements } = useSession();
  const { t } = useStrings();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const writable = useWritable();
  const form = useForm(automation ? automationToForm(automation) : newForm(), !writable);
  const [active, setActive] = useState(form.values.variants[0].label);
  const [confirming, setConfirming] = useState(null); // 'live' | 'delete'
  const [done, setDone] = useState(/^automations\.done\.[a-z]+$/.test(landed) ? landed : '');
  const [savedWarnings, setSavedWarnings] = useState(automation?.warnings ?? []);
  const [trackingProblem, setTrackingProblem] = useState(null);
  const trackingRows = useRef([]);
  const { values } = form;
  const trigger = triggerOf(values.triggerType);
  const state = automation?.state ?? 'draft';
  const canManage = isAllowed(user, MANAGERS);
  const canOneTap = business?.plan !== FREE_PLAN;
  const activeBody = (values.variants.find((v) => v.label === active) ?? values.variants[0]).body;
  const preview = usePreview(form, activeBody);

  // The brand kit's public replies are the owner's and managers' to read; the server checks the count for anyone else.
  const kit = useQuery({ queryKey: ['automations', 'brand-kit'], queryFn: () => api.brandKit.get(), enabled: canManage, retry: false });
  const replyCount = kit.data ? (kit.data.publicReplyVariants ?? []).length : null;

  // One tap can't stay selected on a plan without it, for example after a downgrade.
  useEffect(() => {
    if (!canOneTap && values.linkMode === 'one_tap') form.set('linkMode', 'two_tap');
  }, [canOneTap, values.linkMode]); // eslint-disable-line react-hooks/exhaustive-deps

  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['automations'] }), queryClient.invalidateQueries({ queryKey: ['home'] })]);

  /** Save, then move it on when asked. Each step's refusal stays on screen in the engine's or the server's words. */
  const run = useMutation({
    mutationFn: async (next) => {
      setDone('');
      setTrackingProblem(null);
      let id = automation?.id;
      if (next === null || GOES_OUT.includes(next) || !automation) {
        const { body, errors } = formToAutomation(values, { replyCount });
        if (errors) {
          form.setErrors(errors);
          return { invalid: true };
        }
        form.setErrors({});
        form.merge({ keywords: body.keywords, keywordDraft: '' });
        const saved = automation ? await api.automations.update(automation.id, body) : await api.automations.create(body);
        id = saved.id;
        queryClient.setQueryData(automationKey(id), saved);
        setSavedWarnings(saved.warnings ?? []);
        try {
          const warnings = await saveTracking(api, values, trackingRows.current);
          if (warnings.length) setSavedWarnings((current) => [...current, ...warnings]);
        } catch (error) {
          setTrackingProblem(error);
        }
      }
      if (next) {
        const moved = await api.automations.setState(id, { state: next });
        queryClient.setQueryData(automationKey(id), moved);
      }
      return { id, next, created: !automation };
    },
    onSuccess: async (result) => {
      if (result.invalid) return;
      setDone(result.next ? `automations.done.${result.next}` : 'automations.done.saved');
      await refresh();
      // A new screen for the saved automation, so a second Save can't create a second one.
      if (result.created) navigation?.setParams?.({ id: String(result.id), done: result.next ? `automations.done.${result.next}` : 'automations.done.saved' });
    },
    onError: (error) => form.setErrors(serverFieldErrors(error)),
  });

  const remove = useMutation({
    mutationFn: () => api.automations.remove(automation.id),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: automationKey(automation.id) });
      await refresh();
      navigation?.goBack?.();
    },
  });

  const moves = automation ? stateMoves(state) : ['test', 'live'];
  const primaryMoves = moves.filter((next) => next !== 'archived');
  const busy = run.isPending || remove.isPending;
  const warnings = useMemo(() => {
    const drafts = draftWarnings(values);
    return [...drafts.map((w) => ({ code: w.code, text: t(w.key, w.values) })), ...savedWarnings.filter((w) => !drafts.some((d) => d.code === w.code)).map((w) => ({ code: w.code, text: w.message }))];
  }, [values, savedWarnings, t]);
  const replyProblem = form.words('publicReplyEnabled') || (publicReplyProblem(values, replyCount) ? t(publicReplyProblem(values, replyCount).key, publicReplyProblem(values, replyCount).values) : '');
  const move = (next) => (next === 'live' ? setConfirming('live') : run.mutate(next));
  const triggerOptions = triggersFor(entitlements).map((option) => ({ value: option.value, label: t(`automations.trigger.${option.value}`) }));
  const stepTwo = trigger.keywords !== 'none';

  return (
    <>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
        <Text variant="title" style={{ flex: 1 }}>{t(automation ? 'automations.edit' : 'automations.new')}</Text>
        <Badge testID="builder-state" label={t(`automations.state.${state}`)} tone={STATE_TONES[state]} />
      </View>
      <Field testID="builder-name" label={t('automations.name')} hint={t('automations.nameHint')} value={values.name} onChangeText={(v) => form.set('name', v)} maxLength={120} editable={writable} error={form.words('name')} />

      {trigger.usesMedia && !values.anyStory ? <MediaPicker form={form} automationId={automation?.id ?? null} /> : null}

      <Step number={1} title={t('automations.step.when')} sub={t('automations.step.whenSub')} testID="builder-step-trigger">
        <Choices testID="builder-trigger" label={t('automations.step.when')} value={values.triggerType} onChange={(v) => form.merge(changeTrigger(values, v))} disabled={!writable} options={triggerOptions} />
        {values.triggerType === 'story_reply' ? <Toggle testID="builder-any-story" title={t('automations.anyStory')} value={values.anyStory} onValueChange={(v) => form.set('anyStory', v)} disabled={!writable} /> : null}
      </Step>

      {stepTwo ? (
        <Step number={2} title={t('automations.step.says')} sub={t('automations.step.saysSub')} testID="builder-step-match">
          <Matching form={form} />
        </Step>
      ) : null}

      <Step number={stepTwo ? 3 : 2} title={t('automations.step.reply')} sub={t('automations.step.replySub')} testID="builder-step-reply">
        <MessagePanel form={form} active={active} setActive={setActive} preview={preview} />
        <LinkPanel form={form} canOneTap={canOneTap} saved={automation} trackingRows={trackingRows} />
      </Step>

      <DmPreview form={form} active={active} preview={preview} />
      <ExtrasPanel form={form} isComment={trigger.value === 'comment'} replyProblem={replyProblem} canWriteReplies={canManage} />
      <SchedulePanel form={form} />
      <ChecksPanel checks={launchChecks(values, { replyCount })} />

      {warnings.length ? (
        <View testID="builder-warnings" style={{ gap: theme.space[2] }}>
          {warnings.map((warning) => <Banner key={warning.code} testID={`builder-warning-${warning.code}`} tone="warn">{warning.text}</Banner>)}
        </View>
      ) : null}
      {Object.keys(form.errors).length && !run.error ? <Banner testID="builder-invalid" tone="bad">{t('automations.fixAbove')}</Banner> : null}
      <Refusal error={run.error ?? remove.error} testID="builder-refusal" />
      {Object.entries(form.errors).filter(([field, error]) => !SHOWN_FIELDS.has(field) && error.text).map(([field, error]) => <Text key={field} variant="meta" tone="bad" testID={`builder-field-${field}`}>{error.text}</Text>)}
      {trackingProblem ? <Banner testID="builder-tracking-problem" tone="warn">{t('automations.trackingNotSaved', { why: refusalOf(t, trackingProblem).text })}</Banner> : null}
      {done ? <Banner testID="builder-done" tone="good">{t(done)}</Banner> : null}

      <Button testID="builder-save" label={t('common.save')} kind={automation ? 'primary' : 'secondary'} busy={busy && run.variables === null} disabled={!writable || busy} onPress={() => run.mutate(null)} />
      {primaryMoves.map((next) => (
        <Button key={next} testID={`builder-move-${next}`} label={t(`automations.move.${next}`)} kind={next === 'live' ? 'primary' : 'secondary'} busy={busy && run.variables === next} disabled={!writable || busy} onPress={() => move(next)} />
      ))}

      {automation ? <TestersPanel automation={automation} writable={writable} /> : null}
      {automation ? <StatsPanel automation={automation} writable={writable} /> : null}
      {automation ? (
        <Section title={t('automations.danger')}>
          {moves.includes('archived') ? <Button testID="builder-move-archived" kind="secondary" label={t('automations.move.archived')} disabled={!writable || busy} onPress={() => run.mutate('archived')} /> : null}
          <Button testID="builder-delete" kind="danger" label={t('automations.delete')} disabled={!writable || busy} onPress={() => setConfirming('delete')} />
        </Section>
      ) : null}

      <ConfirmSheet
        testID="builder-confirm"
        visible={Boolean(confirming)}
        tone={confirming === 'live' ? 'primary' : 'danger'}
        title={t(confirming === 'live' ? 'automations.confirmLive.title' : 'automations.confirmDelete.title')}
        confirmLabel={t(confirming === 'live' ? 'automations.move.live' : 'automations.delete')}
        cancelLabel={t('common.notNow')}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const what = confirming;
          setConfirming(null);
          if (what === 'live') run.mutate('live');
          else remove.mutate();
        }}
        disabled={!writable}
      >
        {t(confirming === 'live' ? 'automations.confirmLive.body' : 'automations.confirmDelete.body')}
      </ConfirmSheet>
    </>
  );
}

/**
 * The builder (PRD 6.8, m-Automation.dc.html): where it runs, what it listens for, the message and its variants, the
 * link, extras, the schedule and the checks, then Save, Test or Go live. "new" starts a blank one. Every change needs a
 * connection; a refusal shows the reason the server or the compliance engine gave, next to the field when it names one.
 */
export default function BuilderScreen({ route, navigation }) {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const id = String(route?.params?.id ?? NEW);
  const isNew = id === NEW;
  const valid = isNew || /^[1-9]\d{0,17}$/.test(id);
  const automation = useQuery({ queryKey: automationKey(id), queryFn: () => api.automations.get(id), enabled: valid && !isNew });
  let body;
  if (!valid) body = <EmptyState testID="builder-missing" title={t('error.notFound')} />;
  else if (isNew) body = <Editor key={NEW} automation={null} navigation={navigation} />;
  else body = <RecordState query={automation} testID="builder">{(found) => <Editor key={found.id} automation={found} navigation={navigation} landed={route?.params?.done} />}</RecordState>;
  return (
    <Screen testID="screen-builder" title={t(isNew ? 'automations.new' : 'automations.edit')}>
      <OfflineBanner offline={!writable} />
      {body}
    </Screen>
  );
}
