import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, TextAreaField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { AreaTabs, Screen } from '../catalog/shared/ui.jsx';
import { PAGE_TABS, formToSettings, settingsToForm, templatePreview } from './form.js';

function SettingsForm({ settings }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(settingsToForm(settings));

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToSettings(form.values);
    if (errors) return form.reject(errors);
    return form.run(async () => {
      await api.pageSettings.update(body);
      toast('Saved.');
      await refresh();
    });
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <Panel title="Order on WhatsApp">
        <p className="muted">A second button on each product that opens the shopper’s WhatsApp with a message to you. A product can show or hide it for itself.</p>
        {settings.whatsappAvailable
          ? <p className="field-hint">Messages go to {settings.whatsappNumber}.</p>
          : <Banner tone="warn">The button can’t show yet. Save your WhatsApp number in <Link to="/settings">Settings</Link>, and check that your plan includes it.</Banner>}
        <Toggle label="Show the button on my products" {...form.toggle('whatsappOrder')} />
        <FieldGroup>
          <TextAreaField label="Message the shopper sends" rows={3} maxLength={500} hint="Keep {product}. You can also use {price} and {url}." {...form.field('whatsappTemplate')} />
        </FieldGroup>
        <p className="p3-consent" aria-label="Example message">{templatePreview(form.values.whatsappTemplate)}</p>
      </Panel>

      <Panel title="On every landing page">
        <Toggle label="Show more reels from the same category" {...form.toggle('moreReels')} />
        <Toggle label="Keep landing pages out of search engines" {...form.toggle('landingNoindex')} />
        <p className="field-hint">Landing pages are for people who come from your posts. Your creator page can still be found in search.</p>
      </Panel>

      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <div className="form-actions">
        <Button type="submit" size="large" block loading={form.busy}>Save settings</Button>
      </div>
    </form>
  );
}

export default function PageSettingsPage() {
  const allowed = useAllowed();
  const canManage = allowed(MANAGERS);
  const settings = useQuery({ queryKey: ['pages', 'settings'], queryFn: () => api.pageSettings.get(), enabled: canManage });
  return (
    <>
      <PageHeader title="Page settings" />
      <AreaTabs label="Landing page settings" tabs={PAGE_TABS} current="/pages/settings" />
      {canManage ? (
        <Screen query={settings} label="Loading your page settings" errorTitle="We couldn’t load your page settings">
          {(data) => <SettingsForm key={settings.dataUpdatedAt} settings={data} />}
        </Screen>
      ) : <EmptyState title="Only the owner or a manager can change this">Ask them to change the WhatsApp button and page settings.</EmptyState>}
    </>
  );
}
