import { useState } from 'react';
import { ChevronLeft, ChevronRight, Link2, Trash2, Upload } from 'lucide-react';
import { Button, FieldGroup, IconButton, TextField, Thumb } from '../design/index.jsx';
import { api } from '../lib/api/index.js';
import { moveItem } from '../lib/lists.js';
import { IMAGE_TYPES, imageProblem, isWebLink } from '../lib/images.js';

/** The upload button: a real file input, so it works with a keyboard and a screen reader. */
function UploadButton({ label, multiple, disabled, onFiles }) {
  return (
    <label className={`btn btn-soft file-button${disabled ? ' file-button-off' : ''}`}>
      <Upload size={16} strokeWidth={1.8} aria-hidden="true" />
      {label}
      <input
        className="sr-only"
        type="file"
        accept={IMAGE_TYPES.join(',')}
        multiple={multiple}
        disabled={disabled}
        onChange={(event) => {
          const files = [...event.target.files];
          event.target.value = '';
          if (files.length) onFiles(files);
        }}
      />
    </label>
  );
}

function Note({ error, status }) {
  const text = error || status.text;
  if (!text) return null;
  return <p className={error || status.tone === 'error' ? 'field-error' : 'field-hint'} role="status">{text}</p>;
}

/** A product's photos: upload or paste a link, put them in order, remove them. The first one is the cover. */
export function PhotoManager({ images, onChange, max, error }) {
  const [status, setStatus] = useState({ tone: 'hint', text: '' });
  const [link, setLink] = useState('');
  const [busy, setBusy] = useState(false);
  const full = images.length >= max;
  const say = (text, tone = 'hint') => setStatus({ tone, text });

  async function upload(files) {
    setBusy(true);
    let room = max - images.length;
    try {
      for (const [index, file] of files.entries()) {
        if (room <= 0) return say(`You can add up to ${max} photos.`, 'error');
        const problem = imageProblem(file);
        if (problem) return say(problem, 'error');
        say(`Uploading ${index + 1} of ${files.length}…`);
        const { url } = await api.media.upload(file);
        onChange((current) => [...current, url]);
        room -= 1;
      }
      return say('Uploaded. Save the product to keep the photos.');
    } catch (failure) {
      return say(failure.message, 'error');
    } finally {
      setBusy(false);
    }
  }

  function addLink() {
    const url = link.trim();
    if (!isWebLink(url)) return say('Paste a link that starts with https://', 'error');
    if (full) return say(`You can add up to ${max} photos.`, 'error');
    onChange((current) => [...current, url]);
    setLink('');
    return say('Photo added. Save the product to keep it.');
  }

  return (
    <div className="stack">
      {images.length > 0 && (
        <ul className="photo-list">
          {images.map((src, index) => (
            <li key={`${src}-${index}`} className="photo">
              <Thumb src={src} alt={`Photo ${index + 1}`} />
              {index === 0 && <span className="photo-cover">Cover</span>}
              <div className="photo-tools">
                <IconButton label={`Move photo ${index + 1} earlier`} disabled={index === 0} onClick={() => onChange((current) => moveItem(current, index, -1))}><ChevronLeft size={18} aria-hidden="true" /></IconButton>
                <IconButton label={`Move photo ${index + 1} later`} disabled={index === images.length - 1} onClick={() => onChange((current) => moveItem(current, index, 1))}><ChevronRight size={18} aria-hidden="true" /></IconButton>
                <IconButton label={`Remove photo ${index + 1}`} onClick={() => onChange((current) => current.filter((_, i) => i !== index))}><Trash2 size={16} aria-hidden="true" /></IconButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      <UploadButton label={busy ? 'Uploading…' : 'Upload photos'} multiple disabled={busy || full} onFiles={upload} />
      <div className="inline-field">
        <FieldGroup>
          <TextField label="Or paste a photo link" type="url" inputMode="url" placeholder="https://" value={link} onChange={(event) => setLink(event.target.value)} />
        </FieldGroup>
        <Button variant="outline" onClick={addLink}><Link2 size={16} strokeWidth={1.8} aria-hidden="true" />Add link</Button>
      </div>
      <Note error={error} status={status} />
    </div>
  );
}

/** One image: a category's picture, or a logo. `value` is a link, or '' for none. */
export function SingleImage({ label, value, onChange, error }) {
  const [status, setStatus] = useState({ tone: 'hint', text: '' });
  const [busy, setBusy] = useState(false);

  async function upload([file]) {
    const problem = imageProblem(file);
    if (problem) return setStatus({ tone: 'error', text: problem });
    setBusy(true);
    setStatus({ tone: 'hint', text: 'Uploading…' });
    try {
      const { url } = await api.media.upload(file);
      onChange(url);
      return setStatus({ tone: 'hint', text: 'Uploaded. Save to keep it.' });
    } catch (failure) {
      return setStatus({ tone: 'error', text: failure.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="single-image">
      <div className="single-image-row">
        <Thumb src={value} alt={label} />
        <UploadButton label={busy ? 'Uploading…' : `Upload ${label.toLowerCase()}`} disabled={busy} onFiles={upload} />
        {value && <IconButton label={`Remove ${label.toLowerCase()}`} onClick={() => onChange('')}><Trash2 size={16} aria-hidden="true" /></IconButton>}
      </div>
      <Note error={error} status={status} />
    </div>
  );
}
