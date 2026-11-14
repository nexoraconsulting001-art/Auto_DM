import React, { useState } from 'react';
import { View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { MANAGERS } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, Divider, Field, ListRow, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { UpgradePrompt, usePlanError } from '../billing/UpgradePrompt.js';
import { ActionMessages, Offline, PagedList, RecordView, formatWhenAt, useAction, useAllowed, usePaged } from '../orders/kit/ui.js';

export const AI = ['ai-replies'];
export const THRESHOLDS = [0.6, 0.7, 0.8, 0.9];
const OUTCOME_TONE = { answered: 'good', handed_off: 'warn', dropped: 'neutral', failed: 'bad', test: 'neutral' };
const QUESTION_MAX = 1000;

/**
 * FAQ and AI replies (PRD 6.11: A-61 to A-66): the questions the business answers, the switch and the confidence needed, a test
 * question that sends nothing, and the log of what was answered or handed to the team. Free and Tier 1 accounts that try to
 * switch it on or add an answer see the upgrade prompt, from the server's own refusal.
 */
export default function AiRepliesScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const allowed = useAllowed();
  const manager = allowed(MANAGERS);
  const action = useAction([AI]);
  const [planError, onError] = usePlanError();
  const settings = useQuery({ queryKey: [...AI, 'settings'], queryFn: () => api.aiReplies.settings() });
  const run = (key, work, done) => { onError(null); return action.run(key, work, { done, reload: [AI], onError }); };

  return (
    <Screen testID="screen-ai-replies" title={t('ai-replies.title')}>
      <Offline />
      <Text variant="small">{t('ai-replies.intro')}</Text>
      <ActionMessages action={action} testID="ai-action" />
      <UpgradePrompt error={planError} />
      <RecordView query={settings} testID="ai-settings">
        {(data) => {
          const levels = THRESHOLDS.includes(data.threshold) ? THRESHOLDS : [...THRESHOLDS, data.threshold].sort();
          return (
            <Card testID="ai-settings-card">
              <Toggle
                testID="ai-enabled"
                title={t('ai-replies.enable')}
                subtitle={!data.canEnable && !data.enabled ? t('ai-replies.needFaq') : t('ai-replies.enableHint')}
                value={data.enabled}
                disabled={!manager || !action.writable || (!data.canEnable && !data.enabled)}
                onValueChange={(enabled) => run('enabled', () => api.aiReplies.save({ enabled }), 'ai-replies.done.saved')}
              />
              {!data.configured ? <Banner tone="info" testID="ai-unconfigured">{t('ai-replies.unconfigured')}</Banner> : null}
              <Choices
                testID="ai-threshold"
                label={t('ai-replies.threshold')}
                disabled={!manager || !action.writable}
                value={data.threshold}
                onChange={(threshold) => run('threshold', () => api.aiReplies.save({ threshold }), 'ai-replies.done.saved')}
                options={levels.map((value) => ({ value, label: `${Math.round(value * 100)}%` }))}
              />
              <Text variant="meta">{t('ai-replies.thresholdHint')}</Text>
              {!manager ? <Text variant="meta">{t('ai-replies.managerOnly')}</Text> : null}
            </Card>
          );
        }}
      </RecordView>
      <Faq run={run} action={action} />
      <TestQuestion run={run} onError={onError} />
      <Log />
    </Screen>
  );
}

function Faq({ run, action }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const [draft, setDraft] = useState(null);
  const [missing, setMissing] = useState({});
  const query = usePaged([...AI, 'faq'], (page) => api.faq.list(page), { limit: 50 });

  const save = async () => {
    const question = draft.question.trim();
    const answer = draft.answer.trim();
    const problems = {};
    if (!question) problems.question = t('ai-replies.faq.needQuestion');
    if (!answer) problems.answer = t('ai-replies.faq.needAnswer');
    setMissing(problems);
    if (Object.keys(problems).length) return;
    const body = { question, answer, active: draft.active };
    const done = await run('faq-save', () => (draft.id ? api.faq.update(draft.id, body) : api.faq.create(body)), 'ai-replies.done.faq');
    if (done) setDraft(null);
  };

  return (
    <Section
      title={t('ai-replies.faq.title')}
      action={!draft ? <Button testID="faq-add" kind="secondary" label={t('ai-replies.faq.add')} disabled={!action.writable} onPress={() => { setMissing({}); setDraft({ id: null, question: '', answer: '', active: true }); }} /> : null}
    >
      {draft ? (
        <Card testID="faq-form">
          <Field testID="faq-question" label={t('ai-replies.faq.question')} value={draft.question} error={missing.question} maxLength={300} onChangeText={(question) => setDraft((d) => ({ ...d, question }))} />
          <Field testID="faq-answer" label={t('ai-replies.faq.answer')} value={draft.answer} error={missing.answer} maxLength={1000} multiline onChangeText={(answer) => setDraft((d) => ({ ...d, answer }))} />
          <Toggle testID="faq-active" title={t('ai-replies.faq.active')} value={draft.active} onValueChange={(active) => setDraft((d) => ({ ...d, active }))} />
          <Text variant="meta">{t('ai-replies.faq.note')}</Text>
          <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
            <Button testID="faq-save" label={t('common.save')} disabled={!action.writable} busy={action.busy === 'faq-save'} onPress={save} />
            <Button testID="faq-cancel" kind="quiet" label={t('common.cancel')} onPress={() => setDraft(null)} />
          </View>
        </Card>
      ) : null}
      <PagedList
        testID="faq-list"
        query={query}
        emptyTitle={t('ai-replies.faq.empty')}
        emptyBody={t('ai-replies.faq.emptyBody')}
        renderRow={(entry) => (
          <View style={{ gap: theme.space[1], paddingVertical: theme.space[2] }} testID={`faq-${entry.id}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
              <Text variant="body" style={{ flex: 1, fontFamily: theme.font.bodySemiBold }}>{entry.question}</Text>
              {!entry.active ? <Badge label={t('ai-replies.faq.off')} tone="neutral" /> : null}
            </View>
            <Text variant="small">{entry.answer}</Text>
            <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
              <Button testID={`faq-${entry.id}-edit`} kind="secondary" label={t('ai-replies.faq.edit')} onPress={() => { setMissing({}); setDraft({ id: entry.id, question: entry.question, answer: entry.answer, active: entry.active }); }} />
              <Button testID={`faq-${entry.id}-remove`} kind="quiet" label={t('ai-replies.faq.remove')} disabled={!action.writable} busy={action.busy === `faq-remove:${entry.id}`} onPress={() => run(`faq-remove:${entry.id}`, () => api.faq.remove(entry.id), 'ai-replies.done.removed')} />
            </View>
          </View>
        )}
      />
    </Section>
  );
}

/** Asks the model what it would say; nothing goes to a shopper. */
function TestQuestion({ run, onError }) {
  const { api } = useServices();
  const { t } = useStrings();
  const action = useAction([]);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState(null);
  const ask = async () => {
    const text = question.trim();
    if (!text) return;
    onError(null);
    setAnswer(null);
    const result = await action.run('test', () => api.aiReplies.testQuestion({ question: text }), { onError });
    if (result && typeof result === 'object') setAnswer(result);
  };
  return (
    <Section title={t('ai-replies.test.title')}>
      <Card testID="ai-test">
        <Field testID="ai-test-question" label={t('ai-replies.test.question')} value={question} maxLength={QUESTION_MAX} multiline onChangeText={setQuestion} hint={t('ai-replies.test.hint')} />
        <Button testID="ai-test-ask" label={t('ai-replies.test.ask')} disabled={!action.writable || !question.trim()} busy={action.busy === 'test'} onPress={ask} />
        <ActionMessages action={action} testID="ai-test-action" />
        {answer ? (
          <View style={{ gap: 6 }} testID="ai-test-answer">
            <Text variant="body">{answer.answer || t('ai-replies.test.noAnswer')}</Text>
            <Badge testID="ai-test-would" label={t(answer.wouldSend ? 'ai-replies.test.wouldSend' : 'ai-replies.test.wouldNot')} tone={answer.wouldSend ? 'good' : 'warn'} />
            {!answer.wouldSend && answer.reason ? <Text variant="meta">{t('ai-replies.test.reason', { reason: answer.reason })}</Text> : null}
            {answer.score !== null && answer.score !== undefined ? <Text variant="meta">{t('ai-replies.test.score', { score: Math.round(answer.score * 100), threshold: Math.round(answer.threshold * 100) })}</Text> : null}
            {answer.sources.length ? <Text variant="meta">{t('ai-replies.test.sources', { list: answer.sources.map((s) => s.label).join(', ') })}</Text> : null}
            <Text variant="meta">{t('ai-replies.test.nothingSent')}</Text>
          </View>
        ) : null}
      </Card>
    </Section>
  );
}

function Log() {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const [outcome, setOutcome] = useState('all');
  const query = usePaged([...AI, 'log', { outcome }], (page) => api.aiReplies.log({ ...(outcome === 'all' ? {} : { outcome }), ...page }));
  const choices = ['all', 'answered', 'handed_off', 'dropped', 'failed', 'test'];
  return (
    <Section title={t('ai-replies.log.title')}>
      <Choices testID="ai-log-filter" label={t('ai-replies.log.title')} value={outcome} onChange={setOutcome} options={choices.map((value) => ({ value, label: t(`ai-replies.outcome.${value}`) }))} />
      <PagedList
        testID="ai-log"
        query={query}
        emptyTitle={t('ai-replies.log.empty')}
        emptyBody={t('ai-replies.log.emptyBody')}
        renderRow={(row) => (
          <View style={{ gap: theme.space[1], paddingVertical: theme.space[2] }} testID={`ai-log-${row.id}`}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2] }}>
              <Badge label={t(`ai-replies.outcome.${row.outcome}`)} tone={OUTCOME_TONE[row.outcome] ?? 'neutral'} />
              <Text variant="meta" style={{ flex: 1, textAlign: 'right' }}>{formatWhenAt(row.at, locale)}</Text>
            </View>
            {row.question || row.answer ? (
              <>
                <Text variant="small">{row.question}</Text>
                {row.answer ? <Text variant="small">{row.answer}</Text> : null}
              </>
            ) : <Text variant="meta">{t('ai-replies.log.removed')}</Text>}
            {row.reason ? <Text variant="meta">{t('ai-replies.test.reason', { reason: row.reason })}</Text> : null}
          </View>
        )}
      />
      <Divider />
    </Section>
  );
}
