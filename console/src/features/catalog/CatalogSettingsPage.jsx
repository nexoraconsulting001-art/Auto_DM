import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { useFeedback } from '../../components/feedback.jsx';
import { Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, plural } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useRefresh } from '../../lib/query.js';
import { CATALOG_TABS, recheckBody } from './form.js';
import { AreaTabs, Screen } from './shared/ui.jsx';

function RecheckForm({ settings }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ recheckHours: String(settings.recheckHours) });

  async function save(event) {
    event.preventDefault();
    const { body, error } = recheckBody(form.values.recheckHours);
    if (error) return form.reject({ recheckHours: error });
    return form.run(async () => {
      await api.catalogSettings.update(body);
      toast('Saved.');
      await refresh();
    });
  }

  return (
    <form className="stack" onSubmit={save} noValidate>
      <Panel title="How often we check">
        <p className="muted">We open each imported product’s page on your website to see that it is still there, in stock and at the same price.</p>
        <FieldGroup>
          <TextField label="Check every (hours)" inputMode="numeric" hint="From 1 to 720. Most shops keep 24." {...form.field('recheckHours')} />
        </FieldGroup>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <Button type="submit" loading={form.busy}>Save</Button>
      </Panel>
    </form>
  );
}

export default function CatalogSettingsPage() {
  const settings = useQuery({ queryKey: ['catalog', 'settings'], queryFn: () => api.catalogSettings.get() });
  return (
    <>
      <PageHeader title="Re-checks" />
      <AreaTabs label="Catalog pages" tabs={CATALOG_TABS} current="/catalog/settings" />
      <Screen query={settings} label="Loading your re-check settings" errorTitle="We couldn’t load your re-check settings">
        {(data) => (
          <>
            {data.attentionCount > 0 ? (
              <Banner tone="warn">
                {plural(data.attentionCount, 'product needs', 'products need')} attention. <Link to="/catalog?status=attention">Show {data.attentionCount === 1 ? 'it' : 'them'}</Link>
              </Banner>
            ) : (
              <EmptyState title="Nothing needs attention">
                {data.lastRecheckAt ? `Every imported product’s page was there at the last check, ${formatDateTime(data.lastRecheckAt)}.` : 'Imported products are checked here once you have some.'}
              </EmptyState>
            )}
            <RecheckForm settings={data} />
          </>
        )}
      </Screen>
    </>
  );
}
