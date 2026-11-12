import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { OfflineBanner, useStrings } from '@bhava/app-core';
import { MANAGERS, isAllowed } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, Divider, Field, ListRow, Screen, Section, Text, Toggle, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { RecordState, Refusal, useWritable } from './kit.js';
import { LOWERABLE_CAPS, WORD_LISTS, capsToOverrides, overridesToCaps } from './notices.js';

const SETTINGS_KEY = ['compliance', 'settings'];

function RulesForm({ settings, canEdit, writable }) {
  const { api } = useServices();
  const { t } = useStrings();
  const queryClient = useQueryClient();
  const [values, setValues] = useState(() => ({ dryRun: settings.dryRun, disclosureEnabled: settings.disclosureEnabled, utmEnabled: settings.utmEnabled, ...overridesToCaps(settings.capOverrides) }));
  const [errors, setErrors] = useState({});
  const set = (name) => (value) => setValues((old) => ({ ...old, [name]: value }));
  const save = useMutation({
    mutationFn: (body) => api.compliance.updateSettings(body),
    onSuccess: (saved) => queryClient.setQueryData(SETTINGS_KEY, saved),
  });
  const off = !canEdit || !writable;

  function submit() {
    const { overrides, errors: problems } = capsToOverrides(values);
    setErrors(problems ?? {});
    if (problems) return;
    save.mutate({ dryRun: values.dryRun, disclosureEnabled: values.disclosureEnabled, utmEnabled: values.utmEnabled, capOverrides: overrides });
  }

  return (
    <>
      <Section title={t('compliance.rules.howTitle')}>
        <Card>
          <Toggle testID="rules-dry-run" title={t('compliance.rules.dryRun')} subtitle={t('compliance.rules.dryRunHint')} value={values.dryRun} onValueChange={set('dryRun')} disabled={off} />
          <Divider />
          <Toggle testID="rules-disclosure" title={t('compliance.rules.disclosure')} subtitle={t('compliance.rules.disclosureHint')} value={values.disclosureEnabled} onValueChange={set('disclosureEnabled')} disabled={off} />
          <Divider />
          <Toggle testID="rules-utm" title={t('compliance.rules.utm')} value={values.utmEnabled} onValueChange={set('utmEnabled')} disabled={off} />
        </Card>
      </Section>
      <Section title={t('compliance.rules.limitsTitle')}>
        <Card>
          <Text variant="small">{t('compliance.rules.limitsIntro')}</Text>
          {LOWERABLE_CAPS.map(({ code, max }) => (
            <Field
              key={code}
              testID={`rules-${code}`}
              label={t(`compliance.cap.${code}`)}
              value={values[code]}
              onChangeText={set(code)}
              placeholder={String(max)}
              keyboardType="number-pad"
              editable={!off}
              error={errors[code] ? t(errors[code].key, errors[code].values) : undefined}
            />
          ))}
        </Card>
      </Section>
      <Refusal error={save.error} testID="rules-refusal" />
      {save.isSuccess ? <Banner tone="good" testID="rules-saved">{t('compliance.rules.saved')}</Banner> : null}
      {canEdit ? <Button testID="rules-save" label={t('compliance.rules.save')} busy={save.isPending} disabled={!writable} onPress={submit} /> : null}
    </>
  );
}

function WordsPanel({ canEdit, writable }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const [list, setList] = useState(WORD_LISTS[0]);
  const [draft, setDraft] = useState('');
  const [showBase, setShowBase] = useState(false);
  const words = useQuery({ queryKey: ['compliance', 'words', list], queryFn: () => api.compliance.words({ list }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['compliance', 'words', list] });
  const add = useMutation({ mutationFn: (word) => api.compliance.addWord({ list, word }), onSuccess: async () => { setDraft(''); await refresh(); } });
  const remove = useMutation({ mutationFn: (id) => api.compliance.removeWord(id), onSuccess: refresh });
  useEffect(() => setShowBase(false), [list]);

  return (
    <Section title={t('compliance.words.title')}>
      <Choices testID="words-list" label={t('compliance.words.which')} value={list} onChange={setList} options={WORD_LISTS.map((code) => ({ value: code, label: t(`compliance.words.${code}`) }))} />
      <Text variant="small">{t(`compliance.words.${list}Hint`)}</Text>
      <Card>
        <RecordState query={words} testID="words">
          {({ base, added }) => (
            <>
              {added.length === 0 ? <Text variant="small" testID="words-none">{t('compliance.words.none')}</Text> : null}
              {added.map((word, i) => (
                <View key={word.id}>
                  {i > 0 ? <Divider /> : null}
                  <ListRow
                    testID={`word-${word.id}`}
                    title={word.word}
                    end={canEdit ? <Button testID={`word-${word.id}-remove`} kind="quiet" label={t('compliance.words.remove')} accessibilityHint={t('compliance.words.removeHint', { word: word.word })} disabled={!writable} onPress={() => remove.mutate(word.id)} /> : null}
                  />
                </View>
              ))}
              <Divider />
              <ListRow testID="words-base" title={t('compliance.words.base', { count: base.length })} end={<Badge label={String(base.length)} />} onPress={() => setShowBase((v) => !v)} />
              {showBase ? <Text variant="small" testID="words-base-list">{base.join(', ')}</Text> : null}
            </>
          )}
        </RecordState>
      </Card>
      {canEdit ? (
        <View style={{ gap: theme.space[2] }}>
          <Field testID="words-draft" label={t('compliance.words.add')} value={draft} onChangeText={setDraft} maxLength={60} editable={writable} />
          <Button testID="words-add" kind="secondary" label={t('compliance.words.addAction')} busy={add.isPending} disabled={!writable || !draft.trim()} onPress={() => add.mutate(draft.trim())} />
        </View>
      ) : null}
      <Refusal error={add.error ?? remove.error} testID="words-refusal" />
    </Section>
  );
}

/** Rules and word lists: dry run, the disclosure note, link tags, lower caps, and the words the engine watches for. */
export default function ComplianceSettingsScreen() {
  const { api } = useServices();
  const { user } = useSession();
  const { t } = useStrings();
  const writable = useWritable();
  const canEdit = isAllowed(user, MANAGERS);
  const settings = useQuery({ queryKey: SETTINGS_KEY, queryFn: () => api.compliance.settings() });
  return (
    <Screen testID="screen-compliance-rules" title={t('compliance.rules.title')}>
      <OfflineBanner offline={!writable} />
      {!canEdit ? <Banner testID="rules-read-only">{t('compliance.rules.readOnly')}</Banner> : null}
      <RecordState query={settings} testID="rules">
        {(current) => <RulesForm settings={current} canEdit={canEdit} writable={writable} />}
      </RecordState>
      <WordsPanel canEdit={canEdit} writable={writable} />
    </Screen>
  );
}
