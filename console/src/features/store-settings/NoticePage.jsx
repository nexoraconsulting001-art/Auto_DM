import { useQuery } from '@tanstack/react-query';
import { OWNER_ONLY } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, TextAreaField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { StoreScreen } from '../orders/shared/ui.jsx';

/**
 * The consent notice shoppers see at sign-in and checkout, in English and Hindi, naming the business (9.18). Publishing makes
 * a new version; consent already given keeps the version it was given to.
 */
function PublishForm({ notice }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ bodyEn: notice.bodyEn, bodyHi: notice.bodyHi });

  async function publish(event) {
    event.preventDefault();
    const found = {};
    if (!form.values.bodyEn.trim()) found.bodyEn = 'Write the notice in English';
    if (!form.values.bodyHi.trim()) found.bodyHi = 'Write the notice in Hindi';
    if (Object.keys(found).length) return form.reject(found);
    const done = await form.run(() => api.consentNotice.publish({ bodyEn: form.values.bodyEn.trim(), bodyHi: form.values.bodyHi.trim() }));
    if (done) {
      toast('New notice published.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={publish} noValidate aria-label="Consent notice">
      <FieldGroup>
        <TextAreaField label="In English" rows={6} maxLength={4000} {...form.field('bodyEn')} />
        <TextAreaField label="In Hindi" lang="hi" rows={6} maxLength={4000} {...form.field('bodyHi')} />
      </FieldGroup>
      <p className="field-hint">Name your business, what you use details for (delivering orders, order updates, offers on each channel), and how to withdraw.</p>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" block loading={form.busy}>Publish as a new version</Button>
    </form>
  );
}

export default function NoticePage() {
  const allowed = useAllowed();
  const notice = useQuery({ queryKey: ['consent-notice'], queryFn: api.consentNotice.get });
  return (
    <>
      <BackLink to="/store-settings">Store setup</BackLink>
      <PageHeader title="Consent notice" />
      <StoreScreen query={notice} label="Loading your consent notice" errorTitle="We couldn’t load your consent notice">
        {(data) => (
          <Panel title={data.version ? `Version ${data.version}` : 'Not published yet'}>
            {data.version ? <p className="muted">Published {data.createdAt ? formatDateTime(data.createdAt) : ''}. Shoppers see it at sign-in and at checkout.</p> : null}
            {allowed(OWNER_ONLY) ? <PublishForm key={data.version} notice={data} /> : (data.version ? (
              <>
                <p className="review-body">{data.bodyEn}</p>
                <p className="review-body" lang="hi">{data.bodyHi}</p>
                <p className="field-hint">Only the owner publishes a new version.</p>
              </>
            ) : <EmptyState title="No notice yet">The owner publishes it.</EmptyState>)}
          </Panel>
        )}
      </StoreScreen>
    </>
  );
}
