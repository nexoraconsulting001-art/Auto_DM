import { useEffect, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { Avatar, Button, Chip, ChipRow, FieldGroup, Panel, TextAreaField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useSession } from '../../lib/session.jsx';
import { LIMITS, addVariant, byteLength, bytesLabel, fillLocally } from './form.js';

const PREVIEW_PAUSE_MS = 350;

export function useDebounced(value, delay = PREVIEW_PAUSE_MS) {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * The message box. It keeps its own text after the first render, so the words are only ever in the box itself and the
 * variables can be dropped in where the cursor is. Keyed by variant, so switching starts from that variant's words.
 */
function MessageField({ label, value, error, onChange }) {
  const box = useRef(null);
  const [initial] = useState(value);
  const over = byteLength(value) > LIMITS.textBytes;

  function insert(token) {
    const element = box.current;
    element.setRangeText(token, element.selectionStart, element.selectionEnd, 'end');
    element.focus();
    onChange(element.value);
  }

  return (
    <>
      <FieldGroup>
        <TextAreaField ref={box} label={label} rows={4} placeholder="Hi! Here’s the link from the reel." defaultValue={initial} error={error} onChange={(event) => onChange(event.target.value)} />
      </FieldGroup>
      <div className="variant-tools">
        <span className="insert-tools">
          <Button variant="soft" onClick={() => insert('{first_name}')}>Add first name</Button>
          <Button variant="soft" onClick={() => insert('{url}')}>Add link</Button>
        </span>
        <span className={`byte-count${over ? ' byte-count-over' : ''}`}>{bytesLabel(value)}</span>
      </div>
    </>
  );
}

function usePreview(body, linkUrl, buttonTitle) {
  const settled = useDebounced(body);
  return useQuery({
    queryKey: ['automation-preview', settled, linkUrl, buttonTitle],
    queryFn: () => api.automations.preview({ body: settled, linkUrl, buttonTitle }),
    enabled: settled.trim() !== '',
    retry: false,
    placeholderData: keepPreviousData,
  });
}

/** Which variant is open, and the server's reading of it. The editor and the preview sit apart on the page and share this. */
export function useActiveVariant(form) {
  const { variants, linkUrl, linkMode, tapButtonTitle, linkButtonTitle } = form.values;
  const [activeLabel, setActiveLabel] = useState(variants[0].label);
  const active = variants.find((variant) => variant.label === activeLabel) ?? variants[0];
  const preview = usePreview(active.body, linkUrl, linkMode === 'two_tap' ? tapButtonTitle : linkButtonTitle);
  return { active, preview, setActiveLabel };
}

/** What the commenter gets. Only the seller's name appears here, never Bhava's (PRD 6.5). */
export function DmPreview({ form, message: { active, preview } }) {
  const { session } = useSession();
  const { linkMode, linkMessage, tapButtonTitle, linkButtonTitle, linkUrl } = form.values;
  const hasBody = active.body.trim() !== '';
  const text = !hasBody ? 'Your message shows here.' : (preview.data?.filled ?? fillLocally(active.body, { url: linkUrl }));
  const without = hasBody ? (preview.data?.withoutName ?? fillLocally(active.body, { firstName: '', url: linkUrl })) : '';
  const twoTap = linkMode === 'two_tap';
  return (
    <Panel title="What they get in DMs">
      <div className="preview-stack">
        <div className="dm">
          <Avatar name={session.business.name} />
          <div className="dm-body">
            <span className="dm-name">{session.business.name}</span>
            <div className="dm-bubble">
              <p className="dm-text">{text}</p>
              <span className="dm-button">{twoTap ? tapButtonTitle : linkButtonTitle}</span>
            </div>
          </div>
        </div>
        {twoTap && (
          <div className="dm">
            <Avatar name={session.business.name} />
            <div className="dm-body">
              <span className="dm-name">After they tap</span>
              <div className="dm-bubble">
                <p className="dm-text">{fillLocally(linkMessage, { url: linkUrl }) || 'Here’s your link.'}</p>
                <span className="dm-button">{linkButtonTitle}</span>
              </div>
            </div>
          </div>
        )}
        {without && without !== text && <p className="preview-note">If we don’t have their name: {without}</p>}
      </div>
    </Panel>
  );
}

export function MessagePanel({ form, message: { active, preview, setActiveLabel } }) {
  const { variants } = form.values;
  const problems = active.body.trim() ? preview.data?.problems ?? [] : [];

  const update = (changes) => form.set('variants', (current) => current.map((variant) => (variant.label === active.label ? { ...variant, ...changes } : variant)));
  function add() {
    const next = addVariant(variants);
    form.set('variants', next);
    setActiveLabel(next[next.length - 1].label);
  }
  function remove() {
    const next = variants.filter((variant) => variant.label !== active.label);
    form.set('variants', next);
    setActiveLabel(next[0].label);
  }

  return (
    <>
      <div className="variant-tools">
        <ChipRow label="Variants">
          {variants.map((variant) => <Chip key={variant.label} pressed={variant.label === active.label} onClick={() => setActiveLabel(variant.label)}>Variant {variant.label}</Chip>)}
        </ChipRow>
        {variants.length < LIMITS.variantsMax && <Button variant="soft" onClick={add}>Add a variant</Button>}
        {variants.length > 1 && <Button variant="outline" onClick={remove}><Trash2 size={16} aria-hidden="true" />Remove {active.label}</Button>}
      </div>
      <MessageField key={active.label} label={`Message, variant ${active.label}`} value={active.body} error={form.errors.variants} onChange={(body) => update({ body })} />
      {problems.length > 0 && <ul className="problem-list">{problems.map((problem) => <li key={problem.reason}>{problem.message}</li>)}</ul>}
      <FieldGroup>
        <TextAreaField label="Plain-text version (optional)" rows={2} hint="Sent only if Instagram refuses the button. Include the link so it still works." value={active.fallbackText} onChange={(event) => update({ fallbackText: event.target.value })} />
      </FieldGroup>
    </>
  );
}

export function FollowupFields({ form }) {
  return (
    <FieldGroup>
      <TextField label="Send after (minutes)" inputMode="numeric" {...form.field('followupDelayMinutes')} hint={`${LIMITS.followupMinMinutes} to ${LIMITS.followupMaxMinutes}. Only goes if they replied.`} />
      <TextAreaField label="Follow-up text" rows={2} {...form.field('followupText')} />
    </FieldGroup>
  );
}
