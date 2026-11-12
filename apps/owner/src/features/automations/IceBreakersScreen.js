import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, useStrings } from '@bhava/app-core';
import { Banner, Button, Card, Divider, Field, Screen, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { RecordState, Refusal, useWritable } from '../compliance/kit.js';

export const ICE_KEY = ['automations', 'ice-breakers'];
export const ICE_BREAKERS_MAX = 4; // COMPLIANCE_LIMITS.iceBreakersMax; a test keeps them equal
const QUESTION_MAX = 80;

/** The rows as the API wants them, or the index and key of the first problem. Pure. */
export function iceBreakersToBody(rows) {
  const items = rows.map((row) => ({ question: row.question.trim(), templateBody: row.templateBody.trim() }));
  for (const [index, item] of items.entries()) {
    if (!item.question) return { error: { index, key: 'automations.ice.needQuestion' } };
    if ([...item.question].length > QUESTION_MAX) return { error: { index, key: 'automations.ice.questionLong', values: { max: QUESTION_MAX } } };
    if (!item.templateBody) return { error: { index, key: 'automations.ice.needAnswer' } };
  }
  if (items.length > ICE_BREAKERS_MAX) return { error: { index: ICE_BREAKERS_MAX, key: 'automations.ice.tooMany', values: { max: ICE_BREAKERS_MAX } } };
  return { body: { items } };
}

function Editor({ saved }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const writable = useWritable();
  const [rows, setRows] = useState(saved.items);
  const [problem, setProblem] = useState(null);
  useEffect(() => setRows(saved.items), [saved]);
  const save = useMutation({
    mutationFn: (body) => api.iceBreakers.save(body),
    onSuccess: (answer) => queryClient.setQueryData(ICE_KEY, answer),
  });
  const change = (index, name) => (text) => setRows((current) => current.map((row, i) => (i === index ? { ...row, [name]: text } : row)));
  const submit = () => {
    const { body, error } = iceBreakersToBody(rows);
    setProblem(error ?? null);
    if (body) save.mutate(body);
  };
  return (
    <>
      <Card testID="ice">
        {rows.length === 0 ? <Text variant="small" testID="ice-empty">{t('automations.ice.empty')}</Text> : null}
        {rows.map((row, index) => (
          <View key={index} testID={`ice-${index}`} style={{ gap: theme.space[2] }}>
            {index > 0 ? <Divider /> : null}
            <Field testID={`ice-${index}-question`} label={t('automations.ice.question', { n: index + 1 })} value={row.question} onChangeText={change(index, 'question')} maxLength={QUESTION_MAX} editable={writable} error={problem?.index === index && /question|Question/i.test(problem.key) ? t(problem.key, problem.values) : ''} />
            <Field testID={`ice-${index}-answer`} label={t('automations.ice.answer')} value={row.templateBody} onChangeText={change(index, 'templateBody')} multiline maxLength={4000} editable={writable} error={problem?.index === index && problem.key === 'automations.ice.needAnswer' ? t(problem.key) : ''} />
            <Button testID={`ice-${index}-remove`} kind="quiet" label={t('automations.ice.remove')} disabled={!writable} onPress={() => setRows((current) => current.filter((_, i) => i !== index))} />
          </View>
        ))}
        {rows.length < ICE_BREAKERS_MAX ? <Button testID="ice-add" kind="secondary" label={t('automations.ice.add')} disabled={!writable} onPress={() => setRows((current) => [...current, { question: '', templateBody: '' }])} /> : null}
      </Card>
      {problem?.key === 'automations.ice.tooMany' ? <Banner tone="bad">{t(problem.key, problem.values)}</Banner> : null}
      <Refusal error={save.error} testID="ice-refusal" />
      {save.isSuccess ? <Banner testID="ice-saved" tone="good">{t('automations.ice.saved')}</Banner> : null}
      <Button testID="ice-save" label={t('common.save')} busy={save.isPending} disabled={!writable} onPress={submit} />
    </>
  );
}

/**
 * Ice breakers (PRD 6.4): up to four questions shown when someone opens a chat with the business, each with the answer
 * sent when tapped. The words are the shopper's, so they name the seller's store only.
 */
export default function IceBreakersScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const ice = useQuery({ queryKey: ICE_KEY, queryFn: () => api.iceBreakers.get() });
  return (
    <Screen testID="screen-ice-breakers" title={t('automations.ice.title')}>
      <OfflineBanner offline={!writable} />
      <Text variant="small">{t('automations.ice.intro', { max: ICE_BREAKERS_MAX })}</Text>
      <RecordState query={ice} testID="ice-state">{(saved) => <Editor saved={saved} />}</RecordState>
    </Screen>
  );
}
