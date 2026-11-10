import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check } from 'lucide-react';
import { useFeedback } from '../../components/feedback.jsx';
import { SingleImage } from '../../components/images.jsx';
import { Banner, Button, ErrorState, FieldGroup, Loadable, PageHeader, Panel, SelectField, Spinner } from '../../design/index.jsx';
import { SESSION_KEY, api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { fetchAll, useRefresh } from '../../lib/query.js';
import { COLOR_SLOTS, FONT_CHOICES, MIN_CONTRAST, applyPreset, contrastRatio, formToKit, isHex, kitToForm } from './options.js';

/** The seller's look, on a miniature of the seller's own page. The console around it stays Bhava's. */
function ShopPreview({ form }) {
  const { colors } = form.values;
  return (
    <Panel title="How shoppers see it">
      <div className="kit-preview" style={{ background: colors.ground, color: colors.ink, borderColor: colors.line }}>
        <span className="kit-preview-eyebrow" style={{ color: colors.eyebrow }}>New in</span>
        <span className="kit-preview-title">Shop the reels you love</span>
        <div className="kit-preview-card" style={{ background: colors.card, borderColor: colors.line }}>
          <span className="kit-preview-line" style={{ color: colors.muted }}>Cotton kurta, ₹899</span>
          <span className="kit-preview-button" style={{ background: colors.primary, color: colors.on_primary }}>Buy now</span>
          <span className="kit-preview-tag" style={{ background: colors.accent, color: colors.on_accent }}>20% off</span>
        </div>
      </div>
      <p className="field-hint">Headings in {form.values.headingFont}, text in {form.values.bodyFont}.</p>
    </Panel>
  );
}

function PresetPicker({ presets, current, onPick }) {
  if (presets.isPending) return <Spinner label="Loading the looks" />;
  if (presets.isError) return <ErrorState title="We couldn’t load the looks" error={presets.error} onRetry={() => presets.refetch()} />;
  return (
    <div className="looks" role="radiogroup" aria-label="Pick a look">
      {presets.data.map((preset) => {
        const on = preset.code === current;
        return (
          <button key={preset.code} type="button" role="radio" aria-checked={on} className="look" onClick={() => onPick(preset)}>
            <span className="look-swatches" aria-hidden="true">
              {['primary', 'accent', 'ground'].map((key) => <span key={key} className="look-swatch" style={{ background: preset.colors[key] }} />)}
            </span>
            <span className="look-name">{preset.name}</span>
            {on && <span className="look-tick" aria-hidden="true"><Check size={14} strokeWidth={2.4} /></span>}
          </button>
        );
      })}
    </div>
  );
}

function ColorRow({ slot, label, value, error, onChange }) {
  return (
    <div className="color-row">
      <input className="color-swatch" type="color" aria-label={`${label}: pick a colour`} value={isHex(value) ? value.toLowerCase() : '#000000'} onChange={(event) => onChange(slot, event.target.value)} />
      <div className="color-text">
        <label className="field-label" htmlFor={`color-${slot}`}>{label}</label>
        <input id={`color-${slot}`} className="field-control" value={value} maxLength={7} aria-invalid={error ? true : undefined} onChange={(event) => onChange(slot, event.target.value)} />
        {error && <span className="field-error">{error}</span>}
      </div>
    </div>
  );
}

function BrandKitForm({ kit, presets }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const queries = useQueryClient();
  const form = useForm(kitToForm(kit));
  const { colors, preset } = form.values;
  const currentPreset = presets.data?.find((item) => item.code === preset);
  const setColor = (slot, value) => form.set('colors', (current) => ({ ...current, [slot]: value }));
  const pickPreset = (next) => {
    const applied = applyPreset(form.values, next);
    for (const name of ['preset', 'colors', 'headingFont', 'bodyFont']) form.set(name, applied[name]);
  };
  const contrast = isHex(colors.primary) && isHex(colors.on_primary) ? contrastRatio(colors.primary, colors.on_primary) : null;

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToKit(form.values, currentPreset);
    if (errors) return form.reject(errors);
    return form.run(async () => {
      await api.brandKit.update(body);
      toast('Brand kit saved.');
      await refresh();
      await queries.invalidateQueries({ queryKey: SESSION_KEY }); // the logo in the workspace switcher
    });
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <Panel title="Pick a look">
        <p className="muted">Your logo, products and reels slot right in. Switch any time.</p>
        <PresetPicker presets={presets} current={preset} onPick={pickPreset} />
      </Panel>

      <ShopPreview form={form} />

      <Panel title="Logos">
        <SingleImage label="Logo" value={form.values.logoUrl} onChange={(url) => form.set('logoUrl', url)} error={form.errors.logoUrl} />
        <SingleImage label="Dark logo" value={form.values.logoDarkUrl} onChange={(url) => form.set('logoDarkUrl', url)} error={form.errors.logoDarkUrl} />
        <SingleImage label="Favicon" value={form.values.faviconUrl} onChange={(url) => form.set('faviconUrl', url)} error={form.errors.faviconUrl} />
      </Panel>

      <Panel title="Colours">
        <div className="color-list">
          {COLOR_SLOTS.map(([slot, label]) => (
            <ColorRow key={slot} slot={slot} label={label} value={colors[slot]} error={form.errors[`color_${slot}`]} onChange={setColor} />
          ))}
        </div>
        {contrast !== null && contrast < MIN_CONTRAST && !form.errors.color_on_primary && (
          <Banner tone="warn">Buttons and their text are hard to read together ({contrast.toFixed(1)}:1). They need at least {MIN_CONTRAST}:1 to save.</Banner>
        )}
      </Panel>

      <Panel title="Fonts">
        <FieldGroup>
          <SelectField label="Heading font" {...form.field('headingFont')}>
            {FONT_CHOICES.map((font) => <option key={font} value={font}>{font}</option>)}
          </SelectField>
          <SelectField label="Body font" {...form.field('bodyFont')}>
            {FONT_CHOICES.map((font) => <option key={font} value={font}>{font}</option>)}
          </SelectField>
        </FieldGroup>
      </Panel>

      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <div className="form-actions">
        <Button type="submit" size="large" block loading={form.busy}>Save brand kit</Button>
      </div>
    </form>
  );
}

export default function BrandKitPage() {
  const kit = useQuery({ queryKey: ['brand-kit'], queryFn: api.brandKit.get });
  const presets = useQuery({ queryKey: ['brand-kit', 'presets'], queryFn: () => api.brandKit.presets().then((page) => page.items) });
  return (
    <>
      <PageHeader eyebrow="For your shoppers" title="Brand kit" />
      <p className="lead">This is the look of your store, links and messages. Your console stays the same.</p>
      <Loadable query={kit} label="Loading your brand kit" errorTitle="We couldn’t load your brand kit">
        {(data) => <BrandKitForm kit={data} presets={presets} />}
      </Loadable>
    </>
  );
}
