import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Badge, FieldGroup, SelectField, TextAreaField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { describeReason } from '../compliance/reasons.js';
import { LINK_TYPES, LIMITS, TRACKING } from './form.js';
import { useDebounced } from './MessagePanel.jsx';

const PAID_ONLY = 'One tap needs a paid plan';
const isFullLink = (text) => /^https?:\/\/\S+$/i.test(text.trim());

function LinkModes({ form, canOneTap }) {
  const { linkMode } = form.values;
  const pick = (mode) => {
    if (mode === 'one_tap' && !canOneTap) return;
    form.set('linkMode', mode);
  };
  return (
    <div className="stack">
      <div className="link-modes" role="group" aria-label="How the link is sent">
        <button type="button" className="link-mode" aria-pressed={linkMode === 'two_tap'} onClick={() => pick('two_tap')}>
          <span className="link-mode-name">Two taps</span>
          <span className="link-mode-text">They tap a button, then get the link. Counts every tap.</span>
        </button>
        <button type="button" className="link-mode" aria-pressed={linkMode === 'one_tap'} onClick={() => pick('one_tap')}>
          <span className="link-mode-name">One tap</span>
          <span className="link-mode-text">The link is in the first DM. Taps can’t be counted.</span>
        </button>
      </div>
      {!canOneTap && <span className="field-hint">{PAID_ONLY}</span>}
      {form.errors.linkMode && canOneTap && <span className="field-error">{form.errors.linkMode}</span>}
    </div>
  );
}

/** The exact address the shopper will open. Until a link can be checked, this shows what was last saved. */
function FinalLink({ form, saved }) {
  const url = useDebounced(form.values.linkUrl.trim());
  const preview = useQuery({
    queryKey: ['link-preview', url, form.values.media[0]?.id ?? ''],
    queryFn: () => api.links.preview({ url, mediaId: form.values.media[0]?.id }),
    enabled: isFullLink(url),
    retry: false,
  });
  const finalUrl = preview.data?.finalUrl ?? (saved && url === saved.linkUrl ? saved.finalUrl : '');
  if (!finalUrl) return null;
  return (
    <div className="final-link">
      <span className="final-link-label">People will open</span>
      <span>{finalUrl}</span>
      {preview.data && !preview.data.allowed && <span className="field-error">{describeReason(preview.data.reason) || 'That link can’t be used in a DM.'}</span>}
      {preview.data?.warnings.map((warning) => <span key={warning.code} className="field-hint">{warning.message}</span>)}
    </div>
  );
}

/** Keeps the page told about what is saved for this reel, and fills the boxes once unless the seller has already typed something. */
function useSavedTracking(form, mediaId, onRows) {
  const list = useQuery({
    queryKey: ['measurement-ids', mediaId],
    queryFn: () => api.measurementIds.list({ mediaId, limit: 100 }),
    enabled: Boolean(mediaId),
    retry: false,
  });
  const rows = list.data?.items;
  useEffect(() => {
    if (rows) onRows(rows);
  }, [rows, onRows]);

  const { linkType, trackingId, discountCode } = form.values;
  const filledFor = useRef(null);
  useEffect(() => {
    const key = `${mediaId}:${linkType}`;
    if (!rows || filledFor.current === key) return;
    filledFor.current = key;
    const saved = (kind) => rows.find((row) => row.kind === kind)?.value ?? '';
    if (TRACKING[linkType] && !trackingId) form.set('trackingId', saved(TRACKING[linkType].kind));
    if (!discountCode) form.set('discountCode', saved('discount_code'));
  }, [rows, mediaId, linkType, trackingId, discountCode, form.set]);
}

function TrackingFields({ form, onRows }) {
  const { media, linkType } = form.values;
  const onlyMedia = media.length === 1 ? media[0].id : null;
  useSavedTracking(form, onlyMedia, onRows);
  const tracking = TRACKING[linkType];
  if (!onlyMedia) return media.length > 1 ? <p className="field-hint">Pick one reel to give it its own tracking ID or discount code.</p> : null;
  return (
    <FieldGroup>
      {tracking && <TextField label={tracking.label} hint={tracking.hint} maxLength={120} autoComplete="off" {...form.field('trackingId')} />}
      <TextField label="Discount code (optional)" hint="Orders using it count toward this reel." maxLength={120} autoComplete="off" {...form.field('discountCode')} />
    </FieldGroup>
  );
}

export function LinkPanel({ form, canOneTap, saved, onMeasurementRows }) {
  const { linkMode } = form.values;
  return (
    <>
      <LinkModes form={form} canOneTap={canOneTap} />
      <FieldGroup>
        <SelectField label="Tapping it opens" {...form.field('linkType')}>
          {LINK_TYPES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </SelectField>
        <TextField label="Link" inputMode="url" autoComplete="off" placeholder="https://" hint="The full address. It goes straight there, with nothing in between." {...form.field('linkUrl')} />
      </FieldGroup>
      <FinalLink form={form} saved={saved} />
      <TrackingFields form={form} onRows={onMeasurementRows} />
      <FieldGroup>
        {linkMode === 'two_tap' && <TextField label="First button" hint={`Up to ${LIMITS.buttonTitleChars} characters`} {...form.field('tapButtonTitle')} />}
        <TextField label={linkMode === 'two_tap' ? 'Second button' : 'Button text'} hint={`Up to ${LIMITS.buttonTitleChars} characters`} {...form.field('linkButtonTitle')} />
        {linkMode === 'two_tap' && <TextAreaField label="Text with the link" rows={2} placeholder="Here’s your link." {...form.field('linkMessage')} />}
      </FieldGroup>
    </>
  );
}

export function LinkStatus({ status }) {
  if (status === 'ok') return <Badge tone="good">Link checked</Badge>;
  if (status === 'failed') return <Badge tone="bad">Link failed its check</Badge>;
  return null;
}
