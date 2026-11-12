import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { useQuery } from '@tanstack/react-query';
import { useStrings } from '@bhava/app-core';
import { OWNER_ONLY } from '@bhava/app-core/access';
import { Button, Card, Field, ListRow, Screen, Section, Text, useTheme } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { POLICY_KINDS, grievanceBody, noticeBody } from '../orders/kit/forms.js';
import { ActionMessages, Offline, RecordView, formatWhenAt, openOutside, useAction, useAllowed, useForm, useProblem, useWritable } from '../orders/kit/ui.js';

/**
 * Privacy (PRD 9.18): the grievance contact shown on the privacy page, the consent notice shoppers agree to (English and
 * Hindi, in the business's own name), and the policy pages on the business's own domain.
 */
export default function PrivacyScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const privacy = useQuery({ queryKey: ['privacy', 'contact'], queryFn: () => api.privacy.get() });
  return (
    <Screen testID="screen-privacy" title={t('privacy.title')}>
      <Offline />
      <Card>
        <ListRow testID="privacy-notice" title={t('privacy.notice')} subtitle={t('privacy.noticeMeta')} onPress={() => navigation.navigate('privacy.notice')} />
        <ListRow testID="privacy-policies" title={t('privacy.policies')} subtitle={t('privacy.policiesMeta')} onPress={() => navigation.navigate('privacy.policies')} />
      </Card>
      <Section title={t('privacy.grievance')} testID="privacy-grievance">
        <RecordView query={privacy} testID="privacy-contact">
          {(data) => <GrievanceForm key={JSON.stringify(data)} privacy={data} />}
        </RecordView>
      </Section>
    </Screen>
  );
}

function GrievanceForm({ privacy }) {
  const { api } = useServices();
  const { t } = useStrings();
  const writable = useWritable();
  const form = useForm({ grievanceName: privacy.grievanceName ?? '', grievanceEmail: privacy.grievanceEmail ?? '', grievancePhone: privacy.grievancePhone ?? '', grievanceAddress: privacy.grievanceAddress ?? '' });
  const problem = useProblem(form.problems);
  const action = useAction([['privacy']]);
  const { values, set } = form;

  async function save() {
    const built = grievanceBody(values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    await action.run('save', () => api.privacy.update(built.body), { done: 'privacy.grievanceSaved' });
  }

  return (
    <Card>
      <Text variant="small">{t('privacy.grievanceIntro')}</Text>
      <Field testID="privacy-name" label={t('privacy.name')} value={values.grievanceName} onChangeText={set('grievanceName')} maxLength={120} />
      <Field testID="privacy-email" label={t('privacy.email')} value={values.grievanceEmail} onChangeText={set('grievanceEmail')} error={problem('grievanceEmail')} keyboardType="email-address" autoCapitalize="none" maxLength={120} />
      <Field testID="privacy-phone" label={t('privacy.phone')} value={values.grievancePhone} onChangeText={set('grievancePhone')} keyboardType="phone-pad" maxLength={20} />
      <Field testID="privacy-address" label={t('privacy.address')} value={values.grievanceAddress} onChangeText={set('grievanceAddress')} multiline maxLength={400} />
      <ActionMessages action={action} testID="privacy-action" />
      <Button testID="privacy-save" label={t('privacy.saveContact')} disabled={!writable} busy={action.busy === 'save'} onPress={() => { save(); }} />
    </Card>
  );
}

/** The consent notice. Publishing makes a new version; consent already given keeps the version it was given to. */
export function NoticeScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const notice = useQuery({ queryKey: ['privacy', 'notice'], queryFn: () => api.consentNotice.get() });
  return (
    <Screen testID="screen-notice" title={t('privacy.notice')}>
      <Offline />
      <RecordView query={notice} testID="notice">
        {(data) => <Notice key={data.version} notice={data} />}
      </RecordView>
    </Screen>
  );
}

function Notice({ notice }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const theme = useTheme();
  const allowed = useAllowed();
  const writable = useWritable();
  const form = useForm({ bodyEn: notice.bodyEn ?? '', bodyHi: notice.bodyHi ?? '' });
  const problem = useProblem(form.problems);
  const action = useAction([['privacy', 'notice']]);

  async function publish() {
    const built = noticeBody(form.values);
    form.setProblems(built.problems ?? {});
    if (built.problems) return;
    await action.run('publish', () => api.consentNotice.publish(built.body), { done: 'privacy.published' });
  }

  return (
    <View style={{ gap: theme.space[4] }}>
      <Text variant="title" testID="notice-version">{notice.version ? t('privacy.version', { version: notice.version }) : t('privacy.notPublished')}</Text>
      {notice.version && notice.createdAt ? <Text variant="meta">{t('privacy.publishedAt', { when: formatWhenAt(notice.createdAt, locale) })}</Text> : null}
      {allowed(OWNER_ONLY) ? (
        <Card>
          <Field testID="notice-en" label={t('privacy.inEnglish')} value={form.values.bodyEn} onChangeText={form.set('bodyEn')} error={problem('bodyEn')} multiline maxLength={4000} />
          <Field testID="notice-hi" label={t('privacy.inHindi')} value={form.values.bodyHi} onChangeText={form.set('bodyHi')} error={problem('bodyHi')} multiline maxLength={4000} />
          <Text variant="meta">{t('privacy.noticeHint')}</Text>
          <ActionMessages action={action} testID="notice-action" />
          <Button testID="notice-publish" label={t('privacy.publish')} disabled={!writable} busy={action.busy === 'publish'} onPress={() => { publish(); }} />
        </Card>
      ) : (
        <Card>
          {notice.version ? <Text variant="body">{notice.bodyEn}</Text> : null}
          {notice.version ? <Text variant="body">{notice.bodyHi}</Text> : null}
          <Text variant="meta" testID="notice-owner-only">{t('privacy.ownerPublishes')}</Text>
        </Card>
      )}
    </View>
  );
}

/** Privacy, terms, refunds and shipping: each page's text, and the page itself on the business's own domain. */
export function PoliciesScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const policies = useQuery({ queryKey: ['privacy', 'policies'], queryFn: () => api.policies.all() });
  return (
    <Screen testID="screen-policies" title={t('privacy.policies')}>
      <Offline />
      <Text variant="small">{t('privacy.policiesIntro')}</Text>
      <RecordView query={policies} testID="policies">
        {({ items }) => {
          const byKind = new Map((items ?? []).map((policy) => [policy.kind, policy]));
          return POLICY_KINDS.map((kind) => {
            const policy = byKind.get(kind) ?? { kind, body: '', url: '', updatedAt: null };
            return <PolicyForm key={`${kind}-${policy.updatedAt}`} policy={policy} />;
          });
        }}
      </RecordView>
    </Screen>
  );
}

function PolicyForm({ policy }) {
  const { api } = useServices();
  const { t, locale } = useStrings();
  const writable = useWritable();
  const [body, setBody] = useState(policy.body ?? '');
  const action = useAction([['privacy', 'policies']]);
  return (
    <Section title={t(`privacy.policy.${policy.kind}`)} testID={`policy-${policy.kind}`}>
      <Card>
        <Field testID={`policy-${policy.kind}-body`} label={t('privacy.policyText')} hint={policy.updatedAt ? t('privacy.savedAt', { when: formatWhenAt(policy.updatedAt, locale) }) : t('privacy.standard')} value={body} onChangeText={setBody} multiline maxLength={40000} />
        <ActionMessages action={action} testID={`policy-${policy.kind}-action`} />
        <Button testID={`policy-${policy.kind}-save`} kind="secondary" label={t('common.save')} disabled={!writable} busy={action.busy === 'save'} onPress={() => action.run('save', () => api.policies.save({ kind: policy.kind, body }), { done: 'privacy.policySaved' })} />
        {policy.url ? <Button testID={`policy-${policy.kind}-view`} kind="quiet" label={t('privacy.viewPage')} onPress={() => { openOutside(policy.url); }} /> : null}
      </Card>
    </Section>
  );
}
