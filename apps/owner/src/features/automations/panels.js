/**
 * The builder's parts (m-Automation.dc.html, the console's MediaPicker, MessagePanel, LinkPanel): where it runs, the
 * message and its variants, the link, the schedule, and the checks before launch. Each reads and changes the one form
 * the builder holds, through `form` = { values, errors, set, merge, words, disabled }.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Image, Pressable, View } from 'react-native';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import Check from 'lucide-react-native/icons/check';
import Circle from 'lucide-react-native/icons/circle';
import { useStrings } from '@bhava/app-core';
import { Badge, Banner, Button, Card, Choices, Field, Section, Text, Toggle, WorkspaceBadge, useTheme } from '@bhava/ui';
import { useServices, useSession } from '../../shell/hooks.js';
import { useOpenLink } from '../../shell/context.js';
import { PagedState, usePaged } from '../compliance/kit.js';
import { describeReason } from '../compliance/reasons.js';
import { isLost } from '../compliance/notices.js';
import { LIMITS, LINK_TYPES, TRACKING, addVariant, byteLength, fillLocally, isFullLink, toggleMedia } from './form.js';

const RECONNECT_REASON = 'paused.reconnect';
const MEDIA_FILTERS = Object.freeze(['all', 'reel', 'post', 'story']);
const isWebImage = (url) => /^https:\/\//i.test(String(url ?? ''));

export function useDebounced(value, delay = 350) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/** The one way out when Instagram can't be read. */
function ConnectPrompt({ reconnect }) {
  const { t } = useStrings();
  const openLink = useOpenLink();
  return (
    <View style={{ gap: 8 }}>
      <Banner testID="builder-connect" tone="warn">{t(reconnect ? 'automations.media.reconnect' : 'automations.media.connect')}</Banner>
      <Button testID="builder-connect-action" kind="secondary" label={t(reconnect ? 'compliance.notice.reconnectAction' : 'connect.ig.connect')} onPress={() => openLink('/connect')} />
    </View>
  );
}

function Tile({ media, picked, takenElsewhere, onToggle, disabled }) {
  const { t } = useStrings();
  const theme = useTheme();
  const caption = String(media.caption ?? '').trim().slice(0, 60);
  const kind = t(`automations.media.kind.${media.type}`);
  return (
    <Pressable
      testID={`media-${media.id}`}
      onPress={disabled ? undefined : onToggle}
      disabled={disabled}
      accessibilityRole="checkbox"
      accessibilityLabel={caption ? `${kind}: ${caption}` : kind}
      accessibilityState={{ checked: picked, disabled }}
      style={{ width: 96, minHeight: theme.tap.min, gap: 4, borderRadius: theme.radius.tile, padding: 2, borderWidth: 2, borderColor: picked ? theme.color.primary : 'transparent' }}
    >
      {isWebImage(media.thumbnailUrl) ? <Image source={{ uri: media.thumbnailUrl }} style={{ width: 88, height: 116, borderRadius: theme.radius.small }} /> : <View style={{ width: 88, height: 116, borderRadius: theme.radius.small, backgroundColor: theme.color.surfaceSunken }} />}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2 }}>
        <Badge label={kind} tone={picked ? 'primary' : 'neutral'} />
        {takenElsewhere ? <Badge testID={`media-${media.id}-in-use`} label={t('automations.media.inUse')} tone="warn" /> : null}
      </View>
    </Pressable>
  );
}

/** Pick a reel, post or story (PRD 6.8). A post another automation already answers says so. */
export function MediaPicker({ form, automationId }) {
  const { api } = useServices();
  const { t } = useStrings();
  const theme = useTheme();
  const [type, setType] = useState('all');
  const connection = useQuery({ queryKey: ['connect', 'instagram'], queryFn: () => api.instagram.connection(), retry: false });
  const status = connection.data?.status;
  const blocked = status === 'not_connected' || isLost(status);
  const media = usePaged(['automations', 'media'], (query) => api.instagram.media(query), { type, limit: 24 }, { retry: false, enabled: !blocked && connection.isSuccess });
  const picked = new Set(form.values.media.map((item) => item.id));
  let grid;
  if (blocked) grid = <ConnectPrompt reconnect={isLost(status)} />;
  else if (media.error?.reason === RECONNECT_REASON) grid = <ConnectPrompt reconnect />;
  else {
    grid = (
      <PagedState query={connection.isPending ? { ...media, isPending: true } : media} testID="builder-media" emptyTitle={t('automations.media.empty')} emptyBody={t('automations.media.emptyBody')}>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
          {media.items.map((item) => (
            <Tile
              key={item.id}
              media={item}
              picked={picked.has(item.id)}
              takenElsewhere={item.automationId !== null && item.automationId !== automationId}
              disabled={form.disabled}
              onToggle={() => form.merge(toggleMedia(form.values, item))}
            />
          ))}
        </View>
      </PagedState>
    );
  }
  return (
    <Section title={t('automations.media.title')}>
      <Card testID="builder-media-card">
        {!blocked ? <Choices testID="builder-media-filter" label={t('automations.media.filter')} value={type} onChange={setType} options={MEDIA_FILTERS.map((value) => ({ value, label: t(`automations.media.filter.${value}`) }))} /> : null}
        {grid}
        {form.values.media.length ? (
          <Text variant="meta" testID="builder-media-picked">{t('automations.media.picked', { count: form.values.media.length })}</Text>
        ) : null}
        {form.words('triggers') ? <Text variant="meta" tone="bad">{form.words('triggers')}</Text> : null}
      </Card>
    </Section>
  );
}

/** The server's reading of the open variant: filled in, and again with no first name, its size, and its problems. */
export function usePreview(form, body) {
  const { api } = useServices();
  const { linkUrl, linkMode, tapButtonTitle, linkButtonTitle } = form.values;
  const settled = useDebounced(body);
  return useQuery({
    queryKey: ['automations', 'preview', settled, linkUrl, linkMode === 'two_tap' ? tapButtonTitle : linkButtonTitle],
    queryFn: () => api.automations.preview({ body: settled, linkUrl, buttonTitle: linkMode === 'two_tap' ? tapButtonTitle : linkButtonTitle }),
    enabled: settled.trim() !== '',
    retry: false,
    placeholderData: keepPreviousData,
    meta: { offline: false },
  });
}

/** The message box, its variants (A, B, C rotate), the name and link buttons, and its byte count. */
export function MessagePanel({ form, active, setActive, preview }) {
  const { t } = useStrings();
  const theme = useTheme();
  const { variants } = form.values;
  const variant = variants.find((v) => v.label === active) ?? variants[0];
  const update = (changes) => form.set('variants', (current) => current.map((v) => (v.label === variant.label ? { ...v, ...changes } : v)));
  const bytes = byteLength(variant.body);
  const problems = variant.body.trim() ? preview.data?.problems ?? [] : [];
  return (
    <View style={{ gap: theme.space[2] }}>
      <Choices testID="builder-variants" label={t('automations.message.variants')} value={variant.label} onChange={setActive} options={variants.map((v) => ({ value: v.label, label: t('automations.message.variant', { label: v.label }) }))} />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.space[2] }}>
        {variants.length < LIMITS.variantsMax ? (
          <Button testID="builder-add-variant" kind="quiet" label={t('automations.message.addVariant')} disabled={form.disabled} onPress={() => {
            const next = addVariant(variants);
            form.set('variants', next);
            setActive(next[next.length - 1].label);
          }} />
        ) : null}
        {variants.length > 1 ? (
          <Button testID="builder-remove-variant" kind="quiet" label={t('automations.message.removeVariant', { label: variant.label })} disabled={form.disabled} onPress={() => {
            const next = variants.filter((v) => v.label !== variant.label);
            form.set('variants', next);
            setActive(next[0].label);
          }} />
        ) : null}
      </View>
      <Field
        testID="builder-body"
        label={t('automations.message.label', { label: variant.label })}
        value={variant.body}
        onChangeText={(body) => update({ body })}
        multiline
        maxLength={4000}
        editable={!form.disabled}
        error={form.words('variants')}
      />
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: theme.space[2] }}>
        <Button testID="builder-add-name" kind="secondary" label={t('automations.message.addName')} disabled={form.disabled} onPress={() => update({ body: `${variant.body}{first_name}` })} />
        <Button testID="builder-add-link" kind="secondary" label={t('automations.message.addLink')} disabled={form.disabled} onPress={() => update({ body: `${variant.body}{url}` })} />
        <Text variant="meta" testID="builder-bytes" tone={bytes > LIMITS.textBytes ? 'bad' : undefined}>{t('automations.message.bytes', { bytes: bytes.toLocaleString('en-IN'), max: LIMITS.textBytes.toLocaleString('en-IN') })}</Text>
      </View>
      {problems.map((problem) => (
        <Banner key={problem.reason} testID={`builder-problem-${problem.reason}`} tone="bad">{`${describeReason(t, problem.reason) || problem.message}`}</Banner>
      ))}
      <Field testID="builder-fallback" label={t('automations.message.fallback')} hint={t('automations.message.fallbackHint')} value={variant.fallbackText} onChangeText={(fallbackText) => update({ fallbackText })} multiline maxLength={4000} editable={!form.disabled} error={form.words('fallbackText')} />
    </View>
  );
}

/** What the commenter gets. Only the seller's name appears here, never the platform's (PRD 2, 6.5). */
export function DmPreview({ form, active, preview }) {
  const { t } = useStrings();
  const theme = useTheme();
  const { business } = useSession();
  const { linkMode, linkMessage, tapButtonTitle, linkButtonTitle, linkUrl, variants } = form.values;
  const variant = variants.find((v) => v.label === active) ?? variants[0];
  const hasBody = variant.body.trim() !== '';
  const text = !hasBody ? t('automations.preview.empty') : (preview.data?.filled ?? fillLocally(variant.body, { url: linkUrl }));
  const without = hasBody ? (preview.data?.withoutName ?? fillLocally(variant.body, { firstName: '', url: linkUrl })) : '';
  const twoTap = linkMode === 'two_tap';
  const bubble = (who, words, button, testID) => (
    <View testID={testID} style={{ flexDirection: 'row', gap: theme.space[2] }}>
      <WorkspaceBadge name={business?.name} size={32} />
      <View style={{ flex: 1, gap: theme.space[1] }}>
        <Text variant="meta">{who}</Text>
        <View style={{ backgroundColor: theme.color.surfaceSunken, borderRadius: theme.radius.tile, padding: theme.space[3], gap: theme.space[2] }}>
          <Text variant="body" testID={`${testID}-text`}>{words}</Text>
          {button ? <Text variant="small" tone="primary" testID={`${testID}-button`}>{button}</Text> : null}
        </View>
      </View>
    </View>
  );
  return (
    <Section title={t('automations.preview.title')}>
      <Card testID="builder-preview">
        {bubble(business?.name ?? '', text, twoTap ? tapButtonTitle : linkButtonTitle, 'builder-dm')}
        {twoTap ? bubble(t('automations.preview.afterTap'), fillLocally(linkMessage, { url: linkUrl }) || t('automations.preview.linkDefault'), linkButtonTitle, 'builder-dm-link') : null}
        {without && without !== text ? <Text variant="meta" testID="builder-dm-noname">{t('automations.preview.noName', { text: without })}</Text> : null}
      </Card>
    </Section>
  );
}

/** The exact address the shopper will open, with its tags, or why it isn't allowed. Never a redirect (PRD 4.11). */
function FinalLink({ form, saved }) {
  const { api } = useServices();
  const { t } = useStrings();
  const url = useDebounced(form.values.linkUrl.trim());
  const mediaId = form.values.media[0]?.id;
  const preview = useQuery({
    queryKey: ['automations', 'link-preview', url, mediaId ?? ''],
    queryFn: () => api.links.preview({ url, ...(mediaId ? { mediaId } : {}) }),
    enabled: isFullLink(url),
    retry: false,
    meta: { offline: false },
  });
  const finalUrl = preview.data?.finalUrl ?? (saved && url === saved.linkUrl ? saved.finalUrl : '');
  if (!finalUrl) return null;
  return (
    <View testID="builder-final-link" style={{ gap: 4 }}>
      <Text variant="meta">{t('links.peopleOpen')}</Text>
      <Text variant="small" selectable testID="builder-final-url">{finalUrl}</Text>
      {preview.data && !preview.data.allowed ? <Text variant="meta" tone="bad" testID="builder-link-refused">{describeReason(t, preview.data.reason) || t('links.notAllowed')}</Text> : null}
      {(preview.data?.warnings ?? []).map((warning) => <Text key={warning.code} variant="meta">{warning.message}</Text>)}
    </View>
  );
}

/** Fills the tracking boxes once from what is saved for the one post picked, unless the seller already typed something. */
function TrackingFields({ form, rowsRef }) {
  const { api } = useServices();
  const { t } = useStrings();
  const { media, linkType, trackingId, discountCode } = form.values;
  const mediaId = media.length === 1 ? media[0].id : null;
  const list = useQuery({ queryKey: ['automations', 'tracking', mediaId], queryFn: () => api.measurementIds.list({ mediaId, limit: 100 }), enabled: Boolean(mediaId), retry: false });
  const rows = list.data?.items;
  const filledFor = useRef(null);
  useEffect(() => {
    rowsRef.current = rows ?? [];
    const key = `${mediaId}:${linkType}`;
    if (!rows || filledFor.current === key) return;
    filledFor.current = key;
    const saved = (kind) => rows.find((row) => row.kind === kind)?.value ?? '';
    if (TRACKING[linkType] && !trackingId) form.set('trackingId', saved(TRACKING[linkType]));
    if (!discountCode) form.set('discountCode', saved('discount_code'));
  }, [rows, mediaId, linkType]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!mediaId) return media.length > 1 ? <Text variant="meta">{t('automations.link.trackingOne')}</Text> : null;
  return (
    <>
      {TRACKING[linkType] ? <Field testID="builder-tracking" label={t(`links.kind.${TRACKING[linkType]}`)} hint={t('automations.link.trackingHint')} value={trackingId} onChangeText={(v) => form.set('trackingId', v)} maxLength={120} autoCapitalize="none" autoCorrect={false} editable={!form.disabled} /> : null}
      <Field testID="builder-discount" label={t('automations.link.discount')} hint={t('automations.link.discountHint')} value={discountCode} onChangeText={(v) => form.set('discountCode', v)} maxLength={120} autoCapitalize="characters" autoCorrect={false} editable={!form.disabled} />
    </>
  );
}

/** How the link is sent, where it goes, and the button words. One tap needs a paid plan (PRD 6.6). */
export function LinkPanel({ form, canOneTap, saved, trackingRows }) {
  const { t } = useStrings();
  const theme = useTheme();
  const { linkMode, linkType } = form.values;
  return (
    <View style={{ gap: theme.space[2] }}>
      <Choices
        testID="builder-link-mode"
        label={t('automations.link.mode')}
        value={linkMode}
        onChange={(mode) => (mode === 'one_tap' && !canOneTap ? null : form.set('linkMode', mode))}
        disabled={form.disabled}
        options={[{ value: 'two_tap', label: t('automations.link.twoTap') }, ...(canOneTap ? [{ value: 'one_tap', label: t('automations.link.oneTap') }] : [])]}
      />
      <Text variant="meta">{t(linkMode === 'two_tap' ? 'automations.link.twoTapText' : 'automations.link.oneTapText')}</Text>
      {!canOneTap ? <Text variant="meta" testID="builder-one-tap-paid">{t('automations.link.paidOnly')}</Text> : null}
      <Choices testID="builder-link-type" label={t('automations.link.opens')} value={linkType} onChange={(v) => form.set('linkType', v)} disabled={form.disabled} options={LINK_TYPES.map((value) => ({ value, label: t(`automations.link.type.${value}`) }))} />
      <Field testID="builder-link-url" label={t('automations.link.url')} hint={t('automations.link.urlHint')} value={form.values.linkUrl} onChangeText={(v) => form.set('linkUrl', v)} keyboardType="url" autoCapitalize="none" autoCorrect={false} maxLength={2000} editable={!form.disabled} error={form.words('linkUrl')} />
      <FinalLink form={form} saved={saved} />
      <TrackingFields form={form} rowsRef={trackingRows} />
      {linkMode === 'two_tap' ? <Field testID="builder-tap-button" label={t('automations.link.firstButton')} hint={t('automations.link.buttonHint', { max: LIMITS.buttonTitleChars })} value={form.values.tapButtonTitle} onChangeText={(v) => form.set('tapButtonTitle', v)} maxLength={80} editable={!form.disabled} error={form.words('tapButtonTitle')} /> : null}
      <Field testID="builder-link-button" label={t(linkMode === 'two_tap' ? 'automations.link.secondButton' : 'automations.link.button')} hint={t('automations.link.buttonHint', { max: LIMITS.buttonTitleChars })} value={form.values.linkButtonTitle} onChangeText={(v) => form.set('linkButtonTitle', v)} maxLength={80} editable={!form.disabled} error={form.words('linkButtonTitle')} />
      {linkMode === 'two_tap' ? <Field testID="builder-link-message" label={t('automations.link.message')} value={form.values.linkMessage} onChangeText={(v) => form.set('linkMessage', v)} multiline maxLength={4000} editable={!form.disabled} error={form.words('linkMessage')} /> : null}
      {saved?.linkStatus === 'ok' ? <Badge testID="builder-link-ok" label={t('automations.link.checked')} tone="good" /> : null}
      {saved?.linkStatus === 'failed' ? <Badge testID="builder-link-failed" label={t('automations.link.failed')} tone="bad" /> : null}
    </View>
  );
}

/** Optional start and end, daily hours, and what happens outside them. Times are India time (PRD 6.8). */
export function SchedulePanel({ form }) {
  const { t } = useStrings();
  const theme = useTheme();
  const field = (name, label, hint) => (
    <Field testID={`builder-${name}`} label={t(label)} hint={t(hint)} value={form.values[name]} onChangeText={(v) => form.set(name, v)} autoCapitalize="none" autoCorrect={false} maxLength={16} editable={!form.disabled} error={form.words(name)} />
  );
  return (
    <Section title={t('automations.schedule.title')}>
      <Card testID="builder-schedule">
        <Text variant="small">{t('automations.schedule.intro')}</Text>
        {field('startsAt', 'automations.schedule.starts', 'automations.schedule.whenHint')}
        {field('endsAt', 'automations.schedule.ends', 'automations.schedule.whenHint')}
        <View style={{ flexDirection: 'row', gap: theme.space[2] }}>
          <View style={{ flex: 1 }}>{field('dailyStart', 'automations.schedule.from', 'automations.schedule.timeHint')}</View>
          <View style={{ flex: 1 }}>{field('dailyEnd', 'automations.schedule.until', 'automations.schedule.timeHint')}</View>
        </View>
        <Choices testID="builder-outside" label={t('automations.schedule.outside')} value={form.values.outsideHours} onChange={(v) => form.set('outsideHours', v)} disabled={form.disabled} options={[{ value: 'hold', label: t('automations.schedule.hold') }, { value: 'skip', label: t('automations.schedule.skip') }]} />
        {form.words('schedule') ? <Text variant="meta" tone="bad" testID="builder-schedule-error">{form.words('schedule')}</Text> : null}
      </Card>
    </Section>
  );
}

/** Public replies, the follow-up and the dry run. */
export function ExtrasPanel({ form, isComment, replyProblem, canWriteReplies }) {
  const { t } = useStrings();
  const openLink = useOpenLink();
  const { values } = form;
  return (
    <Section title={t('automations.extras.title')}>
      <Card testID="builder-extras">
        {isComment ? (
          <>
            <Toggle testID="builder-public" title={t('automations.extras.public')} subtitle={t('automations.extras.publicHint')} value={values.publicReplyEnabled} onValueChange={(v) => form.set('publicReplyEnabled', v)} disabled={form.disabled} />
            {replyProblem ? <Text variant="meta" tone="bad" testID="builder-public-problem">{replyProblem}</Text> : null}
            {replyProblem && canWriteReplies ? <Button kind="quiet" label={t('automations.extras.brandKit')} onPress={() => openLink('/brand-kit')} /> : null}
          </>
        ) : null}
        <Toggle testID="builder-followup" title={t('automations.extras.followup')} value={values.followupEnabled} onValueChange={(v) => form.set('followupEnabled', v)} disabled={form.disabled} />
        {values.followupEnabled ? (
          <>
            <Field testID="builder-followup-delay" label={t('automations.extras.after')} hint={t('automations.extras.afterHint', { min: LIMITS.followupMinMinutes, max: LIMITS.followupMaxMinutes })} value={values.followupDelayMinutes} onChangeText={(v) => form.set('followupDelayMinutes', v)} keyboardType="number-pad" maxLength={4} editable={!form.disabled} error={form.words('followupDelayMinutes')} />
            <Field testID="builder-followup-text" label={t('automations.extras.followupText')} value={values.followupText} onChangeText={(v) => form.set('followupText', v)} multiline maxLength={4000} editable={!form.disabled} error={form.words('followupText')} />
          </>
        ) : null}
        <Toggle testID="builder-dry-run" title={t('automations.extras.dryRun')} subtitle={t('automations.extras.dryRunHint')} value={values.dryRun} onValueChange={(v) => form.set('dryRun', v)} disabled={form.disabled} />
      </Card>
    </Section>
  );
}

/** "Before you launch": a guide; the server makes the real decision. */
export function ChecksPanel({ checks }) {
  const { t } = useStrings();
  const theme = useTheme();
  const passed = checks.filter((check) => check.ok).length;
  return (
    <Section title={t('automations.checks.title')} action={<Badge testID="builder-checks-count" label={t('automations.checks.count', { passed, total: checks.length })} tone={passed === checks.length ? 'good' : 'warn'} />}>
      <Card testID="builder-checks">
        {checks.map((check) => (
          <View key={check.key} testID={`builder-check-${check.key.split('.').pop()}`} accessible accessibilityLabel={`${t(check.key)}: ${t(check.ok ? 'automations.checks.done' : 'automations.checks.notYet')}`} style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space[2], minHeight: 32 }}>
            {check.ok ? <Check size={16} color={theme.color.goodText} /> : <Circle size={16} color={theme.color.ink3} />}
            <Text variant="small" tone={check.ok ? 'good' : undefined}>{t(check.key)}</Text>
          </View>
        ))}
      </Card>
    </Section>
  );
}
