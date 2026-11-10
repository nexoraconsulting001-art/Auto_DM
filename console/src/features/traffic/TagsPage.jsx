import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useSession } from '../../lib/session.jsx';
import { ANALYTICS_LIMITS, FIGURE_TEXT } from '../insights/shared/catalog.js';
import { tagsBody } from '../insights/shared/figures.js';
import { AnalyticsLoadable, SourceTag, TrafficTabs } from '../insights/shared/ui.jsx';
import { formatCount } from '../insights/shared/words.js';

const PROVIDER_WORDS = Object.freeze({ meta: 'Meta Pixel and Conversions API', ga4: 'Google Analytics 4' });

/** Events sent and failed for each tag (7.14). Three failed days in a row alert the owner. */
function Health() {
  const health = useQuery({ queryKey: ['tags', 'health'], queryFn: () => api.tags.health() });
  return (
    <Panel title="Tag health" action={<SourceTag source="bhava" />}>
      <AnalyticsLoadable query={health} label="Checking your tags" errorTitle="We couldn’t check your tags">
        {(data) => (data.items.some((item) => item.enabled || item.sent || item.failed) ? (
          <div className="an-rows">
            {data.items.map((item) => (
              <div key={item.provider} className="an-row">
                <span className="an-row-main">
                  <span className="an-row-title">{Object.hasOwn(PROVIDER_WORDS, item.provider) ? PROVIDER_WORDS[item.provider] : item.provider}</span>
                  <span className="an-row-meta">{`${formatCount(item.sent)} events sent, ${formatCount(item.failed)} failed`}</span>
                  {item.lastError && <span className="an-row-meta">{`Last problem${item.lastErrorAt ? ` (${formatDateTime(item.lastErrorAt)})` : ''}: ${item.lastError}`}</span>}
                  {item.failedDaysInARow >= ANALYTICS_LIMITS.tagAlertAfterFailedDays && <span className="field-error">{`Failing for ${item.failedDaysInARow} days in a row. Check the ID and token.`}</span>}
                </span>
                <Badge tone={!item.enabled ? 'neutral' : item.failedDaysInARow > 0 ? 'warn' : 'good'}>{item.enabled ? 'On' : 'Off'}</Badge>
              </div>
            ))}
          </div>
        ) : <EmptyState title="No tags on">Once a tag is on and shoppers accept analytics, the events sent and any failures show here.</EmptyState>)}
      </AnalyticsLoadable>
    </Panel>
  );
}

function TagForm({ settings }) {
  const queries = useQueryClient();
  const { toast } = useFeedback();
  const blank = () => ({ metaEnabled: settings.meta.enabled, pixelId: settings.meta.pixelId, capiToken: '', ga4Enabled: settings.ga4.enabled, measurementId: settings.ga4.measurementId, apiSecret: '' });
  const [form, setForm] = useState(blank);
  const [errors, setErrors] = useState({});
  const set = (name) => (event) => setForm((current) => ({ ...current, [name]: event.target.type === 'checkbox' ? event.target.checked : event.target.value }));
  const save = useMutation({
    mutationFn: (body) => api.tags.update(body),
    onSuccess: async (saved) => {
      toast('Tags saved.');
      queries.setQueryData(['tags', 'settings'], saved);
      setForm({ metaEnabled: saved.meta.enabled, pixelId: saved.meta.pixelId, capiToken: '', ga4Enabled: saved.ga4.enabled, measurementId: saved.ga4.measurementId, apiSecret: '' });
      await queries.invalidateQueries({ queryKey: ['tags', 'health'] });
    },
    onError: (error) => {
      const fields = {};
      for (const [path, message] of Object.entries(error.fields ?? {})) fields[path.split('.').at(-1)] = message;
      setErrors(fields);
      toast(error.message);
    },
  });

  function submit(event) {
    event.preventDefault();
    const result = tagsBody(form, settings);
    setErrors(result.errors ?? {});
    if (result.errors) return;
    if (!Object.keys(result.body).length) {
      toast('Nothing has changed.');
      return;
    }
    save.mutate(result.body);
  }

  return (
    <form className="an-form" onSubmit={submit} noValidate>
      <Panel title="Meta Pixel">
        <Toggle label="Use my Meta Pixel" checked={form.metaEnabled} onChange={set('metaEnabled')} />
        <FieldGroup>
          <TextField label="Pixel ID" inputMode="numeric" autoComplete="off" value={form.pixelId} error={errors.pixelId} onChange={set('pixelId')} />
          <TextField label="Conversions API token" type="password" autoComplete="off" value={form.capiToken} error={errors.capiToken} hint={settings.meta.capiTokenSet ? 'A token is saved. Paste a new one only to replace it.' : 'From Events Manager. Kept encrypted and never shown again.'} onChange={set('capiToken')} />
        </FieldGroup>
      </Panel>
      <Panel title="Google Analytics 4">
        <Toggle label="Use my Google Analytics" checked={form.ga4Enabled} onChange={set('ga4Enabled')} />
        <FieldGroup>
          <TextField label="Measurement ID" autoComplete="off" autoCapitalize="characters" value={form.measurementId} error={errors.measurementId} onChange={set('measurementId')} />
          <TextField label="Measurement Protocol API secret" type="password" autoComplete="off" value={form.apiSecret} error={errors.apiSecret} hint={settings.ga4.apiSecretSet ? 'A secret is saved. Paste a new one only to replace it.' : 'Kept encrypted and never shown again.'} onChange={set('apiSecret')} />
        </FieldGroup>
      </Panel>
      <Button type="submit" size="large" block loading={save.isPending}>Save tags</Button>
    </form>
  );
}

/** The seller's own Meta Pixel and Google Analytics on their pages (7.14). Off by default, owner only, and silent until a shopper consents. */
export default function TagsPage() {
  const { session } = useSession();
  const isOwner = session.user.role === 'owner';
  const settings = useQuery({ queryKey: ['tags', 'settings'], queryFn: () => api.tags.get(), enabled: isOwner });
  return (
    <>
      <PageHeader eyebrow="Traffic" title="Pixels and tags" />
      <TrafficTabs />
      <p className="lead">Your own Meta Pixel and Google Analytics on your store pages, so your ads and tools see the same visits. Bhava never adds a tag of its own.</p>
      {isOwner ? (
        <AnalyticsLoadable query={settings} label="Loading your tags" errorTitle="We couldn’t load your tags">
          {(data) => {
            if (!data.available) return <EmptyState title="Available from tier 2">Pixels and analytics tags come with tier 2 and up. Cart and purchase events need tier 3.</EmptyState>;
            return (
              <>
                {!data.consentReady && <Banner tone="info">Tags stay silent for now: no tag loads and no event is sent until a shopper accepts “Analytics and ads” in your consent banner, which isn’t live yet. Your traffic figures don’t depend on it.</Banner>}
                <TagForm settings={data} />
              </>
            );
          }}
        </AnalyticsLoadable>
      ) : (
        <EmptyState title="Owner only">{`${FIGURE_TEXT.ownerOnly} Only the owner can set up pixels and tags. Their health is below.`}</EmptyState>
      )}
      <Health />
    </>
  );
}
