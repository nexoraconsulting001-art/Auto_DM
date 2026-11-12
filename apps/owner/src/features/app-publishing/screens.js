import React, { useState } from 'react';
import { View } from 'react-native';
import { useNavigation, useRoute } from '@react-navigation/native';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useReauth, useStrings } from '@bhava/app-core';
import { OWNER_ONLY } from '@bhava/app-core/access';
import { Badge, Banner, Button, Card, Choices, ConfirmSheet, EmptyState, Field, ListRow, Screen, Section, Text, Toggle } from '@bhava/ui';
import { useServices } from '../../shell/hooks.js';
import { ActionMessages, Offline, PagedList, PickerField, RecordView, SecretField, openOutside, problemText, useAction, useAllowed, usePaged, useWritable } from '../orders/kit/ui.js';
import {
  ACCESS_STATUS, ACCOUNT_TYPES, APP_FIELDS, BUILD_STATUS, BUILD_STEP_LABELS, CAMPAIGN_STATUS, CLOSED_TEST, CREDENTIAL_STATUS, DUNS_OPTIONS, LISTING_LONG, PLATFORMS,
  PLATFORM_LABELS, PUSH_LIMITS, STORE_LABELS, SUBMISSION_STATE, adviceFor, appFieldProblem, apnsProblems, ascKeyProblems, closedTestSummary, configToForm, failureText,
  fcmProblem, formToListing, formToUpdate, isPlanRefusal, isPlatform, listingField, listingFieldNames, listingToForm, newRequestKey, offerProblems,
} from './rules.js';

const CONFIG = ['app-publishing', 'config'];
const ACCESS = ['app-publishing', 'store-access'];
const CREDENTIALS = ['app-publishing', 'push-credentials'];
const SUMMARY = ['app-publishing', 'push-summary'];
const SCREEN = 'app-publishing';
const toneOf = (tone) => (tone === 'neel' ? 'primary' : tone);

const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }) : '');
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }) : '');

function Status({ table, value, testID }) {
  const entry = table[value];
  return entry ? <Badge testID={testID} tone={toneOf(entry[1])} label={entry[0]} /> : null;
}

/** The six pages of this area, as a row of choices. */
function AreaMenu({ current }) {
  const { t } = useStrings();
  const navigation = useNavigation();
  const options = ['index', 'stores', 'listing', 'review', 'offers', 'keys'].map((value) => ({ value, label: t(`app-publishing.tab.${value}`) }));
  return (
    <Choices testID="app-publishing-menu" label={t('app-publishing.menu')} value={current} options={options} onChange={(value) => navigation.navigate(`${SCREEN}.${value}`, value === 'listing' ? { platform: 'android' } : undefined)} />
  );
}

function Upgrade({ platform, testID }) {
  const { t } = useStrings();
  return <Banner tone="warn" testID={testID ?? `upgrade-${platform}`} title={t('app-publishing.upgrade.title')}>{t('app-publishing.upgrade.body', { platform: PLATFORM_LABELS[platform] })}</Banner>;
}

/** A record, or, when the plan lacks the feature, the upgrade note and not an error. */
function Guarded({ query, testID, children }) {
  const { t } = useStrings();
  if (query.isError && isPlanRefusal(query.error)) return <Banner tone="warn" testID={`${testID}-plan`} title={t('app-publishing.upgrade.title')}>{query.error.message || t('app-publishing.upgrade.generic')}</Banner>;
  return <RecordView query={query} testID={testID}>{children}</RecordView>;
}

function useConfigQuery() {
  const { api } = useServices();
  return useQuery({ queryKey: CONFIG, queryFn: () => api.appPublishing.get() });
}

function Hint({ children }) {
  return <Text variant="meta">{children}</Text>;
}

function NoPasswords() {
  const { t } = useStrings();
  return <Hint>{t('app-publishing.promise')}</Hint>;
}

/** Text fields of a form: values, which were touched, and the server's refusals by field. */
function useDraft(initial) {
  const [values, setValues] = useState(initial);
  const [touched, setTouched] = useState({});
  const [server, setServer] = useState({});
  const set = (name) => (value) => {
    setValues((v) => ({ ...v, [name]: value }));
    setTouched((v) => ({ ...v, [name]: true }));
    setServer((v) => (v[name] ? { ...v, [name]: undefined } : v));
  };
  const refused = (error) => {
    const fields = {};
    for (const [path, message] of Object.entries(error?.fields ?? {})) fields[path.split('.')[0]] ??= message;
    setServer(fields);
  };
  return { values, set, touched, setTouched, server, refused, reset: setValues };
}

// ---- 1. app details and builds ----

function DetailsForm({ config }) {
  const { api } = useServices();
  const { t } = useStrings();
  const action = useAction([CONFIG]);
  const draft = useDraft(configToForm(config));
  const [validation, setValidation] = useState(config.validation);
  const names = Object.keys(APP_FIELDS).filter((name) => !APP_FIELDS[name].platform || config[APP_FIELDS[name].platform].entitled);

  const errorOf = (name) => draft.server[name] || (draft.touched[name] ? appFieldProblem(name, draft.values[name]) : undefined);
  async function save() {
    const { body, errors } = formToUpdate(draft.values, config);
    draft.setTouched(Object.fromEntries(names.map((name) => [name, true])));
    if (names.some((name) => errors[name])) return;
    for (const name of Object.keys(body)) if (!names.includes(name)) delete body[name];
    if (!Object.keys(body).length) return;
    const saved = await action.run('save', () => api.appPublishing.save(body), { done: 'app-publishing.saved', onError: draft.refused });
    if (saved && saved !== true) {
      draft.reset(configToForm(saved));
      setValidation(saved.validation);
    }
  }
  async function check() {
    const found = await action.run('check', () => api.appPublishing.validate());
    if (found && found !== true) setValidation(found);
  }

  return (
    <View testID="app-publishing-form" style={{ gap: 12 }}>
      {[['app-publishing.section.app', ['appName', 'shortName', 'shopDomain', 'supportEmail', 'privacyUrl', 'urlScheme', 'splashBackground'], null],
        ['app-publishing.section.android', ['androidPackage', 'playAccountId', 'playSigningSha256'], 'android'],
        ['app-publishing.section.ios', ['iosBundleId', 'appleTeamId'], 'ios']].map(([title, list, platform]) => (
          <Section key={title} title={t(title)}>
            {platform && !config[platform].entitled ? <Upgrade platform={platform} /> : list.map((name) => (
              <Field
                key={name}
                testID={`app-field-${name}`}
                label={APP_FIELDS[name].label}
                hint={APP_FIELDS[name].hint}
                value={draft.values[name]}
                error={errorOf(name)}
                onChangeText={draft.set(name)}
                autoCapitalize={name === 'appleTeamId' || name === 'playSigningSha256' ? 'characters' : 'none'}
                autoCorrect={false}
                multiline={name === 'playSigningSha256'}
                keyboardType={name === 'supportEmail' ? 'email-address' : name === 'playAccountId' ? 'number-pad' : undefined}
              />
            ))}
          </Section>
      ))}
      <Hint>{t('app-publishing.brandKitNote')}</Hint>
      <ActionMessages action={action} testID="app-publishing" />
      {validation ? (
        validation.ok
          ? <Banner tone="good" testID="app-publishing-valid">{t('app-publishing.valid')}</Banner>
          : (
            <Banner tone="warn" testID="app-publishing-problems" title={t('app-publishing.problems')}>
              {validation.problems.map((p) => `${p.message}${p.platform ? ` (${PLATFORM_LABELS[p.platform]})` : ''}`).join('\n')}
            </Banner>
          )
      ) : null}
      <Button testID="app-publishing-save" label={t('app-publishing.save')} onPress={save} busy={action.busy === 'save'} disabled={!action.writable} />
      <Button testID="app-publishing-check" kind="secondary" label={t('app-publishing.check')} onPress={check} busy={action.busy === 'check'} disabled={!action.writable} />
    </View>
  );
}

function Builds({ config }) {
  const { api } = useServices();
  const { t } = useStrings();
  const allowed = useAllowed();
  const owner = allowed(OWNER_ONLY);
  const builds = usePaged(['app-publishing', 'builds'], (page) => api.appPublishing.builds(page));
  const action = useAction([['app-publishing', 'builds']]);
  const [picked, setPicked] = useState(PLATFORMS.filter((p) => config[p].entitled));
  async function request() {
    await action.run('build', () => api.appPublishing.requestBuild({ platforms: picked, requestKey: newRequestKey('build') }), { done: 'app-publishing.build.queued' });
  }
  return (
    <Section title={t('app-publishing.builds')} testID="app-publishing-builds-section">
      {PLATFORMS.map((platform) => (config[platform].entitled
        ? <Toggle key={platform} testID={`build-${platform}`} title={PLATFORM_LABELS[platform]} value={picked.includes(platform)} onValueChange={(on) => setPicked(on ? [...picked, platform] : picked.filter((p) => p !== platform))} />
        : <Upgrade key={platform} platform={platform} testID={`build-upgrade-${platform}`} />))}
      {!owner ? <Hint>{t('app-publishing.build.ownerOnly')}</Hint> : null}
      <ActionMessages action={action} testID="app-publishing-build" />
      <Button testID="app-publishing-build" label={t('app-publishing.build.request')} onPress={request} busy={action.busy === 'build'} disabled={!owner || !picked.length || !action.writable} />
      <PagedList
        testID="app-publishing-builds"
        query={builds}
        emptyTitle={t('app-publishing.builds.empty')}
        renderRow={(build) => (
          <ListRow
            testID={`build-${build.id}`}
            title={`${PLATFORM_LABELS[build.platform]} ${build.appVersion} (${build.buildNumber})`}
            subtitle={build.status === 'failed'
              ? `${build.failedStep ? `${BUILD_STEP_LABELS[build.failedStep]}. ` : ''}${build.failedMessage}${build.failedField ? ` (${APP_FIELDS[build.failedField]?.label ?? build.failedField})` : ''}`
              : when(build.createdAt)}
            end={<Status table={BUILD_STATUS} value={build.status} />}
          />
        )}
      />
    </Section>
  );
}

export function AppPublishingScreen() {
  const { t } = useStrings();
  const config = useConfigQuery();
  return (
    <Screen testID="screen-app-publishing" title={t('app-publishing.title')}>
      <Offline />
      <AreaMenu current="index" />
      <NoPasswords />
      <Guarded query={config} testID="app-publishing-config">
        {(data) => (
          <>
            <DetailsForm key={data.appName + data.shortName} config={data} />
            <Builds config={data} />
          </>
        )}
      </Guarded>
    </Screen>
  );
}

// ---- 2. store accounts ----

function AccountForm({ access }) {
  const { api } = useServices();
  const { t } = useStrings();
  const action = useAction([ACCESS]);
  const { platform } = access;
  const draft = useDraft({
    accountType: access.accountType === 'unknown' ? '' : access.accountType,
    legalName: access.legalName,
    dunsStatus: access.dunsStatus === 'unknown' ? '' : access.dunsStatus,
    playAccountAfterCutoff: false,
    startedAt: day(access.closedTest.startedAt),
    testers: access.closedTest.testers === null ? '' : String(access.closedTest.testers),
  });
  const { values } = draft;
  const [problem, setProblem] = useState('');
  const personalPlay = platform === 'android' && values.accountType === 'personal';

  async function save() {
    const body = {};
    setProblem('');
    if (values.accountType && values.accountType !== access.accountType) body.accountType = values.accountType;
    if (values.legalName.trim() !== access.legalName) body.legalName = values.legalName.trim();
    if (values.accountType === 'organisation' && values.dunsStatus && values.dunsStatus !== access.dunsStatus) body.dunsStatus = values.dunsStatus;
    if (platform === 'android' && values.accountType && values.playAccountAfterCutoff) body.playAccountAfterCutoff = true;
    if (personalPlay && (values.startedAt || values.testers !== '')) {
      const testers = values.testers === '' ? null : Number(values.testers);
      if (testers !== null && (!Number.isInteger(testers) || testers < 0 || testers > 1000)) return setProblem('Testers is a number from 0 to 1000.');
      if (values.startedAt && !/^\d{4}-\d{2}-\d{2}$/.test(values.startedAt)) return setProblem('Day the test started: use the form 2026-11-30.');
      body.closedTest = { startedAt: values.startedAt ? `${values.startedAt}T00:00:00+05:30` : null, testers };
    }
    if (!Object.keys(body).length) return undefined;
    return action.run('save', () => api.storeAccess.save(platform, body), { done: 'app-publishing.stores.saved', fresh: true, onError: draft.refused });
  }

  return (
    <View testID={`account-${platform}`} style={{ gap: 12 }}>
      <Choices testID={`account-${platform}-type`} label={t('app-publishing.stores.type')} value={values.accountType} options={ACCOUNT_TYPES.map(([value, label]) => ({ value, label }))} onChange={draft.set('accountType')} />
      <Field testID={`account-${platform}-legalName`} label={t('app-publishing.stores.legalName')} value={values.legalName} onChangeText={draft.set('legalName')} maxLength={200} error={draft.server.legalName} />
      {values.accountType === 'organisation' ? (
        <>
          <Choices testID={`account-${platform}-duns`} label={t('app-publishing.stores.duns')} value={values.dunsStatus} options={DUNS_OPTIONS.map(([value, label]) => ({ value, label }))} onChange={draft.set('dunsStatus')} />
          {/^https:\/\//.test(access.dunsLookupUrl) ? <Button kind="quiet" testID={`account-${platform}-duns-lookup`} label={t('app-publishing.stores.dunsLookup')} onPress={() => openOutside(access.dunsLookupUrl)} /> : null}
        </>
      ) : null}
      {platform === 'android' ? <Toggle testID={`account-${platform}-cutoff`} title={t('app-publishing.stores.cutoff')} value={values.playAccountAfterCutoff} onValueChange={draft.set('playAccountAfterCutoff')} /> : null}
      {personalPlay ? (
        <Card testID="account-closed-test">
          <Hint>{t('app-publishing.stores.closedTest', { testers: CLOSED_TEST.testers, days: CLOSED_TEST.days })}</Hint>
          <Field testID="account-startedAt" label={t('app-publishing.stores.startedAt')} value={values.startedAt} onChangeText={draft.set('startedAt')} placeholder="2026-11-30" autoCapitalize="none" />
          <Field testID="account-testers" label={t('app-publishing.stores.testers')} value={values.testers} onChangeText={(text) => draft.set('testers')(text.replace(/\D/g, '').slice(0, 4))} keyboardType="number-pad" error={draft.server.testers} />
          <Hint>{closedTestSummary(access.closedTest)}</Hint>
        </Card>
      ) : null}
      {problem ? <Banner tone="bad" testID={`account-${platform}-invalid`}>{problem}</Banner> : null}
      <ActionMessages action={action} testID={`account-${platform}`} />
      <Hint>{t('app-publishing.stores.fresh')}</Hint>
      <Button testID={`account-${platform}-save`} label={t('app-publishing.save')} onPress={() => { save(); }} busy={action.busy === 'save'} disabled={!action.writable} />
    </View>
  );
}

/** A box for a key that is typed or pasted, masked, and emptied the moment it is sent or refused. */
function AscKeyForm({ access }) {
  const { api } = useServices();
  const { t } = useStrings();
  const { runFresh } = useReauth();
  const writable = useWritable();
  const queries = useQueryClient();
  const blank = { keyId: '', issuerId: '', privateKey: '' };
  const [values, setValues] = useState(blank);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');
  const [removing, setRemoving] = useState(false);
  const { credential } = access;

  async function send(body) {
    setBusy(true);
    setProblem('');
    setDone('');
    try {
      await runFresh(() => api.storeAccess.save('ios', body));
      setDone(t(body.ascKey ? 'app-publishing.stores.keySaved' : 'app-publishing.stores.keyRemoved'));
      await queries.invalidateQueries({ queryKey: ACCESS });
    } catch (error) {
      if (error?.code !== 'cancelled') setProblem(error.fields && Object.keys(error.fields).length ? failureText(error) : problemText(t, error));
    } finally {
      setValues(blank); // saved or refused, the key is not kept
      setBusy(false);
    }
  }
  function submit() {
    const found = ascKeyProblems(values);
    setErrors(found.errors);
    if (found.body) send({ ascKey: found.body });
  }
  const change = (name) => (text) => {
    setValues((v) => ({ ...v, [name]: text }));
    setErrors((e) => ({ ...e, [name]: undefined }));
  };
  return (
    <View testID="asc-key" style={{ gap: 12 }}>
      <Hint>{t('app-publishing.stores.ascIntro')}</Hint>
      {credential.set ? <Banner tone="good" testID="asc-key-saved">{t('app-publishing.stores.keyHeld', { keyId: credential.keyId, last4: credential.keyLast4 })}</Banner> : null}
      <Field testID="asc-key-keyId" label={t('app-publishing.stores.keyId')} value={values.keyId} onChangeText={change('keyId')} error={errors.keyId} autoCapitalize="characters" autoCorrect={false} autoComplete="off" />
      <Field testID="asc-key-issuerId" label={t('app-publishing.stores.issuerId')} value={values.issuerId} onChangeText={change('issuerId')} error={errors.issuerId} autoCapitalize="none" autoCorrect={false} autoComplete="off" />
      <SecretField testID="asc-key-privateKey" label={t('app-publishing.stores.privateKey')} value={values.privateKey} onChangeText={change('privateKey')} error={errors.privateKey} hint={t('app-publishing.stores.privateKeyHint')} />
      {problem ? <Banner tone="bad" testID="asc-key-problem">{problem}</Banner> : null}
      {done ? <Banner tone="good" testID="asc-key-done">{done}</Banner> : null}
      <Button testID="asc-key-save" label={t('app-publishing.stores.saveKey')} onPress={submit} busy={busy} disabled={!writable} />
      {credential.set ? <Button testID="asc-key-remove" kind="secondary" label={t('app-publishing.stores.removeKey')} onPress={() => setRemoving(true)} disabled={!writable} /> : null}
      <ConfirmSheet testID="asc-key-confirm" visible={removing} title={t('app-publishing.stores.removeKeyTitle')} confirmLabel={t('app-publishing.stores.removeKey')} cancelLabel={t('common.cancel')} onCancel={() => setRemoving(false)} onConfirm={() => { setRemoving(false); send({ ascKey: null }); }}>
        <Text variant="body">{t('app-publishing.stores.removeKeyBody')}</Text>
      </ConfirmSheet>
    </View>
  );
}

function AccessCheck({ access }) {
  const { api } = useServices();
  const { t } = useStrings();
  const action = useAction([ACCESS]);
  const { status, roleFound, roleNeeded, checkedAt } = access.access;
  return (
    <View testID={`access-${access.platform}`} style={{ gap: 8 }}>
      <Status table={ACCESS_STATUS} value={status} testID={`access-${access.platform}-status`} />
      {status === 'role_too_low' ? <Banner tone="warn">{t('app-publishing.stores.roleLow', { found: roleFound || '-', needed: roleNeeded || '-' })}</Banner> : null}
      {checkedAt ? <Hint>{t('app-publishing.stores.checkedAt', { when: when(checkedAt) })}</Hint> : null}
      <ActionMessages action={action} testID={`access-${access.platform}`} />
      <Button testID={`access-${access.platform}-check`} kind="secondary" label={t('app-publishing.stores.check')} onPress={() => action.run('check', () => api.storeAccess.check(access.platform))} busy={action.busy === 'check'} disabled={!action.writable} />
    </View>
  );
}

function StorePlatform({ access }) {
  const { t } = useStrings();
  return (
    <Section title={`${PLATFORM_LABELS[access.platform]} · ${STORE_LABELS[access.platform].replace(/^the /, '')}`} testID={`stores-${access.platform}`}>
      {access.steps.map((step) => (
        <Card key={step.code} testID={`step-${access.platform}-${step.code}`}>
          <Badge tone={step.done ? 'good' : 'neutral'} label={t(step.done ? 'app-publishing.stores.done' : 'app-publishing.stores.todo')} />
          <Text variant="body">{step.title}</Text>
          {step.warning ? <Hint>{step.warning}</Hint> : null}
        </Card>
      ))}
      <AccountForm key={`${access.platform}-${access.accountType}-${access.legalName}`} access={access} />
      {access.platform === 'android'
        ? (
          <Card testID="play-invite">
            <Text variant="body">{t('app-publishing.stores.playInvite', { role: access.access.roleNeeded || '-' })}</Text>
            <Text variant="body" selectable testID="service-account-email">{access.serviceAccountEmail}</Text>
          </Card>
        )
        : <AscKeyForm access={access} />}
      <AccessCheck access={access} />
    </Section>
  );
}

export function StoreAccountsScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const allowed = useAllowed();
  const config = useConfigQuery();
  const list = useQuery({ queryKey: ACCESS, queryFn: () => api.storeAccess.get() });
  const owner = allowed(OWNER_ONLY);
  return (
    <Screen testID="screen-app-publishing-stores" title={t('app-publishing.tab.stores')}>
      <Offline />
      <AreaMenu current="stores" />
      <NoPasswords />
      {!owner ? <Banner tone="info" testID="stores-owner-only">{t('app-publishing.stores.ownerOnly')}</Banner> : null}
      <Guarded query={list} testID="app-publishing-stores">
        {(data) => PLATFORMS.map((platform) => {
          const access = data.items.find((item) => item.platform === platform);
          if (config.data && !config.data[platform].entitled) return <Upgrade key={platform} platform={platform} />;
          return access ? <StorePlatform key={platform} access={access} /> : null;
        })}
      </Guarded>
    </Screen>
  );
}

// ---- 3. store listing ----

function ListingForm({ platform, listing }) {
  const { api } = useServices();
  const { t } = useStrings();
  const action = useAction([['app-publishing', 'listing', platform]]);
  const limits = { ...(listing.limits ?? {}) };
  const names = listingFieldNames(platform);
  const draft = useDraft(listingToForm(platform, listing));

  async function save() {
    const { body } = formToListing(platform, draft.values, limits);
    draft.setTouched(Object.fromEntries(names.map((name) => [name, true])));
    if (!body) return undefined;
    return action.run('save', () => api.appListing.save(platform, body), { done: 'app-publishing.listing.saved', onError: draft.refused });
  }
  return (
    <View testID={`listing-${platform}`} style={{ gap: 12 }}>
      {names.map((name) => {
        const info = listingField(platform, name, draft.values[name], limits);
        const shown = draft.server[name] || (draft.touched[name] || info.over ? info.problem : undefined);
        return (
          <Field
            key={name}
            testID={`listing-${name}`}
            label={info.label}
            value={draft.values[name]}
            onChangeText={draft.set(name)}
            error={shown}
            hint={info.over ? t('app-publishing.listing.over', { count: -info.left }) : t('app-publishing.listing.count', { length: info.length, limit: info.limit })}
            multiline={LISTING_LONG.includes(name)}
            autoCorrect={false}
          />
        );
      })}
      <Hint>{t('app-publishing.listing.note')}</Hint>
      <ActionMessages action={action} testID="listing" />
      <Button testID="listing-save" label={t('app-publishing.save')} onPress={() => { save(); }} busy={action.busy === 'save'} disabled={!action.writable} />
    </View>
  );
}

function Assets({ platform }) {
  const { api } = useServices();
  const { t } = useStrings();
  const assets = useQuery({ queryKey: ['app-publishing', 'listing', platform, 'assets'], queryFn: () => api.appListing.assets(platform) });
  return (
    <Section title={t('app-publishing.listing.pictures')}>
      <Guarded query={assets} testID="listing-assets">
        {(data) => (data.items.length ? data.items.map((asset) => (
          <ListRow
            key={`${asset.kind}-${asset.device}-${asset.position}`}
            testID={`asset-${asset.kind}-${asset.position}`}
            title={`${asset.kind.replace(/_/g, ' ')}${asset.device ? `, ${asset.device.replace(/_/g, ' ')}` : ''}`}
            subtitle={[`${asset.width}×${asset.height}`, ...asset.problems.map((p) => p.message)].join('. ')}
            end={<Badge tone={asset.specOk ? 'good' : 'bad'} label={t(asset.specOk ? 'app-publishing.listing.sizeOk' : 'app-publishing.listing.sizeBad')} />}
          />
        )) : <EmptyState title={t('app-publishing.listing.noPictures')} />)}
      </Guarded>
    </Section>
  );
}

export function ListingScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const navigation = useNavigation();
  const route = useRoute();
  const platform = isPlatform(route.params?.platform) ? route.params.platform : 'android';
  const config = useConfigQuery();
  const entitled = config.data?.[platform]?.entitled;
  const listing = useQuery({ queryKey: ['app-publishing', 'listing', platform], queryFn: () => api.appListing.get(platform), enabled: Boolean(entitled) });
  return (
    <Screen testID="screen-app-publishing-listing" title={t('app-publishing.tab.listing')}>
      <Offline />
      <AreaMenu current="listing" />
      <Choices testID="listing-platform" label={t('app-publishing.listing.store')} value={platform} options={PLATFORMS.map((value) => ({ value, label: PLATFORM_LABELS[value] }))} onChange={(value) => navigation.setParams({ platform: value })} />
      <Guarded query={config} testID="listing-config">
        {() => (entitled ? (
          <>
            <Guarded query={listing} testID="listing-record">{(data) => <ListingForm key={platform} platform={platform} listing={data} />}</Guarded>
            <Assets platform={platform} />
          </>
        ) : <Upgrade platform={platform} />)}
      </Guarded>
    </Screen>
  );
}

// ---- 4. review status ----

function SubmissionCard({ item }) {
  const { t } = useStrings();
  return (
    <Section title={PLATFORM_LABELS[item.platform]} testID={`submission-${item.platform}`}>
      <Status table={SUBMISSION_STATE} value={item.state} testID={`submission-${item.platform}-state`} />
      <Hint>{item.appVersion ? `${item.appVersion}${item.buildNumber ? ` (${item.buildNumber})` : ''}` : t('app-publishing.review.noVersion')}{item.liveVersion ? ` · ${t('app-publishing.review.live', { version: item.liveVersion })}` : ''}</Hint>
      {item.submittedAt ? <Hint>{t('app-publishing.review.sent', { when: when(item.submittedAt) })}</Hint> : null}
      {item.reviewTask ? <Banner tone="warn" testID={`submission-${item.platform}-task`}>{t('app-publishing.review.task', { guideline: item.reviewTask.guideline || '-' })}</Banner> : null}
      {item.state === 'live' && /^https:\/\//.test(item.storeUrl) ? <Button kind="secondary" testID={`submission-${item.platform}-store`} label={t('app-publishing.review.open')} onPress={() => openOutside(item.storeUrl)} /> : null}
      {item.rejections.map((rejection) => (
        <Card key={`${rejection.guideline}-${rejection.rejectedAt}`} testID={`rejection-${item.platform}-${rejection.playbook.code}`}>
          <Text variant="body">{rejection.playbook.title}</Text>
          <Badge tone="bad" label={t('app-publishing.review.guideline', { guideline: rejection.guideline || '-' })} />
          {rejection.message ? <Hint>{rejection.message}</Hint> : null}
          <Text variant="small">{adviceFor(rejection.playbook.code)}</Text>
        </Card>
      ))}
      {item.presubmit ? (
        <Card testID={`presubmit-${item.platform}`}>
          <Text variant="body">{t(item.presubmit.passed ? 'app-publishing.review.checksPassed' : 'app-publishing.review.checksFailed')}</Text>
          {item.presubmit.checks.filter((c) => !c.passed).map((c) => <Hint key={c.code}>{`${c.code.replace(/_/g, ' ')}${c.guideline ? ` (${c.guideline})` : ''}${c.detail ? `: ${c.detail}` : ''}`}</Hint>)}
        </Card>
      ) : null}
    </Section>
  );
}

export function ReviewScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const config = useConfigQuery();
  const submissions = useQuery({ queryKey: ['app-publishing', 'submissions'], queryFn: () => api.appPublishing.submissions() });
  return (
    <Screen testID="screen-app-publishing-review" title={t('app-publishing.tab.review')}>
      <Offline />
      <AreaMenu current="review" />
      <Guarded query={submissions} testID="review-list">
        {(data) => (
          <>
            {PLATFORMS.map((platform) => {
              if (config.data && !config.data[platform].entitled) return <Upgrade key={platform} platform={platform} />;
              const item = data.items.find((i) => i.platform === platform);
              return item ? <SubmissionCard key={platform} item={item} /> : null;
            })}
            {!data.items.length ? <EmptyState testID="review-empty" title={t('app-publishing.review.empty')} /> : null}
          </>
        )}
      </Guarded>
    </Screen>
  );
}

// ---- 5. offers ----

function Composer({ capacity }) {
  const { api } = useServices();
  const { t } = useStrings();
  const action = useAction([SUMMARY, ['app-publishing', 'offers']]);
  const draft = useDraft({ title: '', body: '', linkPath: '/', couponId: '' });
  const [key, setKey] = useState(() => newRequestKey());
  const [asking, setAsking] = useState(false);
  const [capped, setCapped] = useState('');
  const coupons = useQuery({ queryKey: ['coupons', 'active-pick'], queryFn: () => api.coupons.list({ show: 'active', limit: 100 }), retry: false });
  const { values } = draft;
  const problems = offerProblems(values);
  const shown = (name) => draft.server[name] || (draft.touched[name] ? problems[name] : undefined);

  function review() {
    draft.setTouched({ title: true, body: true, linkPath: true });
    setCapped('');
    if (Object.keys(problems).length) return;
    setAsking(true);
  }
  async function send() {
    setAsking(false);
    const sent = await action.run('send', async () => {
      try {
        const campaign = await api.pushCampaigns.send({ title: values.title.trim(), body: values.body.trim(), linkPath: values.linkPath.trim() || '/', requestKey: key, ...(values.couponId ? { couponId: Number(values.couponId) } : {}) });
        if (campaign.status === 'blocked') setCapped(campaign.blockReason || t('app-publishing.offers.blocked'));
        return campaign;
      } catch (error) {
        if (error?.status === 409) setCapped(error.message);
        throw error;
      }
    }, { done: 'app-publishing.offers.sent', onError: draft.refused });
    if (sent) {
      draft.reset({ title: '', body: '', linkPath: '/', couponId: '' });
      draft.setTouched({});
      setKey(newRequestKey());
    }
  }
  const counter = (text, max) => t('app-publishing.listing.count', { length: [...text.trim()].length, limit: max });
  return (
    <Section title={t('app-publishing.offers.new')} testID="offer-composer">
      <Field testID="offer-title" label={t('app-publishing.offers.title')} value={values.title} onChangeText={draft.set('title')} error={shown('title')} hint={counter(values.title, PUSH_LIMITS.titleMax)} />
      <Field testID="offer-body" label={t('app-publishing.offers.message')} value={values.body} onChangeText={draft.set('body')} error={shown('body')} hint={counter(values.body, PUSH_LIMITS.bodyMax)} multiline />
      <Field testID="offer-link" label={t('app-publishing.offers.link')} value={values.linkPath} onChangeText={draft.set('linkPath')} error={shown('linkPath')} autoCapitalize="none" autoCorrect={false} hint={t('app-publishing.offers.linkHint')} />
      {coupons.data?.items?.length ? (
        <PickerField testID="offer-coupon" label={t('app-publishing.offers.coupon')} value={values.couponId} placeholder={t('app-publishing.offers.noCoupon')} options={[{ value: '', label: t('app-publishing.offers.noCoupon') }, ...coupons.data.items.map((c) => ({ value: String(c.id), label: c.code }))]} onChange={draft.set('couponId')} />
      ) : null}
      <Hint>{t('app-publishing.offers.noPersonal')}</Hint>
      {capped ? <Banner tone="warn" testID="offer-capped">{capped}</Banner> : null}
      <ActionMessages action={action} testID="offer" />
      <Button testID="offer-send" label={t('app-publishing.offers.send')} onPress={review} busy={action.busy === 'send'} disabled={!action.writable} />
      <ConfirmSheet testID="offer-confirm" visible={asking} tone="primary" title={t('app-publishing.offers.confirmTitle')} confirmLabel={t('app-publishing.offers.send')} cancelLabel={t('common.cancel')} onCancel={() => setAsking(false)} onConfirm={send}>
        <Text variant="body">{t('app-publishing.offers.confirmBody', { count: capacity })}</Text>
      </ConfirmSheet>
    </Section>
  );
}

export function OffersScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const summary = useQuery({ queryKey: SUMMARY, queryFn: () => api.pushCampaigns.summary() });
  const list = usePaged(['app-publishing', 'offers'], (page) => api.pushCampaigns.list(page));
  return (
    <Screen testID="screen-app-publishing-offers" title={t('app-publishing.tab.offers')}>
      <Offline />
      <AreaMenu current="offers" />
      <Guarded query={summary} testID="offers-summary">
        {(data) => (
          <>
            <Card testID="offers-cap">
              <Text variant="body" testID="offers-cap-text">{t('app-publishing.offers.cap', { cap: data.weeklyCap })}</Text>
              <Hint>{t('app-publishing.offers.reach', { optedIn: data.optedIn.offers, reachable: data.reachableNow })}</Hint>
              {data.reachableNow === 0 ? <Banner tone="warn" testID="offers-nobody">{t('app-publishing.offers.nobody')}</Banner> : null}
              {PLATFORMS.filter((p) => !data.credentials[p]).map((p) => <Banner key={p} tone="warn" testID={`offers-nokey-${p}`}>{t('app-publishing.offers.noKey', { platform: PLATFORM_LABELS[p] })}</Banner>)}
            </Card>
            <Composer capacity={data.reachableNow} />
          </>
        )}
      </Guarded>
      <Section title={t('app-publishing.offers.history')}>
        <PagedList
          testID="offers-list"
          query={list}
          emptyTitle={t('app-publishing.offers.empty')}
          renderRow={(campaign) => (
            <ListRow
              testID={`offer-${campaign.id}`}
              title={campaign.title}
              subtitle={[campaign.body, t('app-publishing.offers.counts', { sent: campaign.sentCount, audience: campaign.audienceCount }), campaign.blockReason].filter(Boolean).join('\n')}
              end={<Status table={CAMPAIGN_STATUS} value={campaign.status} />}
            />
          )}
        />
      </Section>
    </Screen>
  );
}

// ---- 6. push keys ----

/** Pasted or typed keys: masked, never filled from the server, emptied once sent or refused, and sent only after a fresh check. */
function KeyBox({ testID, title, status, savedText, fields, check, build, remove, removeTitle, removeBody }) {
  const { api } = useServices();
  const { t } = useStrings();
  const { runFresh } = useReauth();
  const writable = useWritable();
  const queries = useQueryClient();
  const blank = Object.fromEntries(fields.map((f) => [f.name, f.initial ?? '']));
  const [values, setValues] = useState(blank);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [done, setDone] = useState('');
  const [removing, setRemoving] = useState(false);

  async function send(body, doneKey) {
    setBusy(true);
    setProblem('');
    setDone('');
    try {
      await runFresh(() => api.pushCredentials.save(body));
      setDone(t(doneKey));
      await queries.invalidateQueries({ queryKey: CREDENTIALS });
    } catch (error) {
      if (error?.code !== 'cancelled') setProblem(error.fields && Object.keys(error.fields).length ? failureText(error) : problemText(t, error));
    } finally {
      setValues(blank); // saved or refused, the key is not kept
      setBusy(false);
    }
  }
  function submit() {
    const found = check(values);
    setErrors(found.errors);
    if (found.body !== null) send(build(found.body, values), 'app-publishing.keys.saved');
  }
  return (
    <Section title={title} testID={testID}>
      <Status table={CREDENTIAL_STATUS} value={status} testID={`${testID}-status`} />
      <Hint>{savedText}</Hint>
      {fields.map((field) => {
        const common = { testID: `${testID}-${field.name}`, label: field.label, value: values[field.name], error: errors[field.name], onChangeText: (text) => { setValues((v) => ({ ...v, [field.name]: text })); setErrors((e) => ({ ...e, [field.name]: undefined })); } };
        return field.secret
          ? <SecretField key={field.name} {...common} hint={field.hint} />
          : <Field key={field.name} {...common} hint={field.hint} autoCapitalize={field.capitals ? 'characters' : 'none'} autoCorrect={false} autoComplete="off" />;
      })}
      {problem ? <Banner tone="bad" testID={`${testID}-problem`}>{problem}</Banner> : null}
      {done ? <Banner tone="good" testID={`${testID}-done`}>{done}</Banner> : null}
      <Hint>{t('app-publishing.keys.fresh')}</Hint>
      <Button testID={`${testID}-save`} label={t('app-publishing.keys.save')} onPress={submit} busy={busy} disabled={!writable} />
      {remove ? <Button testID={`${testID}-remove`} kind="secondary" label={t('app-publishing.keys.remove')} onPress={() => setRemoving(true)} disabled={!writable} /> : null}
      <ConfirmSheet testID={`${testID}-confirm`} visible={removing} title={removeTitle} confirmLabel={t('app-publishing.keys.remove')} cancelLabel={t('common.cancel')} onCancel={() => setRemoving(false)} onConfirm={() => { setRemoving(false); send(remove, 'app-publishing.keys.removed'); }}>
        <Text variant="body">{removeBody}</Text>
      </ConfirmSheet>
    </Section>
  );
}

export function PushKeysScreen() {
  const { api } = useServices();
  const { t } = useStrings();
  const allowed = useAllowed();
  const owner = allowed(OWNER_ONLY);
  const config = useConfigQuery();
  const credentials = useQuery({ queryKey: CREDENTIALS, queryFn: () => api.pushCredentials.get(), enabled: owner });
  const entitled = (platform) => !config.data || config.data[platform].entitled;
  return (
    <Screen testID="screen-app-publishing-keys" title={t('app-publishing.tab.keys')}>
      <Offline />
      <AreaMenu current="keys" />
      <Hint>{t('app-publishing.keys.promise')}</Hint>
      {!owner ? <EmptyState testID="keys-owner-only" title={t('app-publishing.keys.ownerOnly')} /> : (
        <Guarded query={credentials} testID="keys-record">
          {(data) => (
            <>
              {entitled('android') ? (
                <KeyBox
                  testID="fcm"
                  title={t('app-publishing.keys.fcm')}
                  status={data.fcm.status}
                  savedText={data.fcm.set ? t('app-publishing.keys.fcmHeld', { project: data.fcm.projectId || '-', email: data.fcm.clientEmailMasked || '-' }) : t('app-publishing.keys.none')}
                  fields={[{ name: 'serviceAccount', label: t('app-publishing.keys.fcmFile'), secret: true, hint: t('app-publishing.keys.fcmHint') }]}
                  check={(values) => {
                    const message = fcmProblem(values.serviceAccount);
                    return { body: message ? null : values.serviceAccount.trim(), errors: message ? { serviceAccount: message } : {} };
                  }}
                  build={(body) => ({ fcm: { serviceAccount: body } })}
                  remove={data.fcm.set ? { fcm: null } : null}
                  removeTitle={t('app-publishing.keys.removeFcmTitle')}
                  removeBody={t('app-publishing.keys.removeFcmBody')}
                />
              ) : <Upgrade platform="android" />}
              {entitled('ios') ? (
                <KeyBox
                  testID="apns"
                  title={t('app-publishing.keys.apns')}
                  status={data.apns.status}
                  savedText={data.apns.set ? t('app-publishing.keys.apnsHeld', { keyId: data.apns.keyId, teamId: data.apns.teamId, env: data.apns.env }) : t('app-publishing.keys.none')}
                  fields={[
                    { name: 'keyId', label: t('app-publishing.keys.apnsKeyId'), capitals: true },
                    { name: 'teamId', label: t('app-publishing.keys.apnsTeamId'), capitals: true },
                    { name: 'key', label: t('app-publishing.keys.apnsFile'), secret: true, hint: t('app-publishing.keys.apnsHint') },
                  ]}
                  check={(values) => apnsProblems(values)}
                  build={(body) => ({ apns: body })}
                  remove={data.apns.set ? { apns: null } : null}
                  removeTitle={t('app-publishing.keys.removeApnsTitle')}
                  removeBody={t('app-publishing.keys.removeApnsBody')}
                />
              ) : <Upgrade platform="ios" />}
            </>
          )}
        </Guarded>
      )}
    </Screen>
  );
}

export default AppPublishingScreen;
