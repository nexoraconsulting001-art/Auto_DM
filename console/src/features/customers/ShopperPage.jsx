import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { OWNER_ONLY } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, formatPaise, whatsAppLink } from '../../lib/format.js';
import { useAllowed } from '../../lib/query.js';
import { shopperBadges } from '../orders/shared/rules.js';
import { Badges, Facts, StoreScreen, useAction } from '../orders/shared/ui.jsx';

/** A request the seller makes for a shopper who asked some other way (9.18). Erasure masks tax records and removes the rest (S-63). */
function DataRequests({ shopper }) {
  const { confirm } = useFeedback();
  const action = useAction();

  async function ask(kind) {
    const erasure = kind === 'erasure';
    const yes = await confirm({
      title: erasure ? `Delete ${shopper.name || 'this shopper'}’s personal data?` : `Prepare a copy of ${shopper.name || 'this shopper'}’s data?`,
      text: erasure
        ? 'Their name, phone, email, addresses, reviews, saves and return photos are removed. Invoices are kept for tax with the personal details masked. This can’t be undone.'
        : 'A copy of what this business holds about them is prepared for you to send.',
      confirm: erasure ? 'Delete their data' : 'Prepare a copy',
      cancel: 'Not now',
      tone: erasure ? 'danger' : 'primary',
    });
    if (yes) await action.run(kind, () => api.dataRequests.create({ shopperId: shopper.id, kind }), erasure ? 'Deletion started. Track it under Data requests.' : 'Copy requested. Track it under Data requests.');
  }

  return (
    <Panel title="Their data">
      <p className="muted">When a shopper asks you, not through their account, to delete their data or for a copy of it.</p>
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
      <div className="row-actions">
        <Button variant="outline" loading={action.busy === 'access'} onClick={() => ask('access')}>A copy of their data</Button>
        <Button variant="danger" loading={action.busy === 'erasure'} onClick={() => ask('erasure')}>Delete their data</Button>
      </div>
      <Button as={Link} variant="soft" to="/customers/data-requests">See data requests</Button>
    </Panel>
  );
}

export default function ShopperPage() {
  const { id } = useParams();
  const allowed = useAllowed();
  const shopper = useQuery({ queryKey: ['shoppers', id], queryFn: () => api.shoppers.get(id) });
  return (
    <StoreScreen query={shopper} detail label="Loading this shopper" errorTitle="We couldn’t load this shopper">
      {(data) => (
        <>
          <BackLink to="/customers/shoppers">Shoppers</BackLink>
          <PageHeader title={data.name || data.phone} actions={<Badges items={shopperBadges(data)} />} />
          <div className="columns">
            <Panel title="With you">
              <Facts rows={[
                ['Phone', data.phone],
                ['Email', data.email || 'None'],
                ['Orders', String(data.orders)],
                ['Spent', formatPaise(data.spentPaise)],
                ['Last order', data.lastOrderAt ? formatDate(data.lastOrderAt) : 'None'],
                ['WhatsApp offers', data.marketing.whatsapp ? 'Said yes' : 'No'],
                ['Email offers', data.marketing.email ? 'Said yes' : 'No'],
              ]}
              />
              <p className="field-hint">Offers go only to channels they said yes to at your store.</p>
              <Button as="a" variant="soft" href={whatsAppLink(data.phone)} target="_blank" rel="noopener">Message on WhatsApp</Button>
            </Panel>
            {allowed(OWNER_ONLY) ? <DataRequests shopper={data} /> : (
              <Panel title="Their data">
                <p className="muted">Only the owner can delete a shopper’s data or prepare a copy of it.</p>
              </Panel>
            )}
          </div>
        </>
      )}
    </StoreScreen>
  );
}
