import { useState } from 'react';
import { Link } from 'react-router-dom';
import { MANAGERS } from '@contracts/access.js';
import { CopyButton } from '../../components/copy.jsx';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, EmptyState, ListCard, LoadMore, Loadable, PageHeader, Panel, SearchField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, formatPaise, plural, whatsAppLink } from '../../lib/format.js';
import { useAllowed, useFilters, usePagedList, useSearchBox } from '../../lib/query.js';
import { useLoyaltyOn } from '../loyalty/useLoyalty.js';
import { CUSTOMER_AREA, LOYALTY_TAB } from '../orders/shared/areas.js';
import { StoreTabs } from '../orders/shared/ui.jsx';

/** Shown once, right after a reset. It lives in this page's memory only and goes when the seller leaves. */
function NewPassword({ reset, onClose }) {
  return (
    <Panel title={`New password for ${reset.name}`} aria-live="polite">
      <p className="reset-password"><code>{reset.temporaryPassword}</code></p>
      <p className="muted">Send it to them on WhatsApp at {reset.phone}. They can change it in My account. It won’t be shown again.</p>
      <div className="row-actions">
        <CopyButton text={reset.temporaryPassword} label="Copy password" />
        <Button variant="outline" onClick={onClose}>Done</Button>
      </div>
    </Panel>
  );
}

function CustomerRow({ customer, canReset, onReset, busy }) {
  const orders = plural(customer.orderCount, 'order');
  return (
    <div className="customer">
      <div className="customer-main">
        <span className="list-row-title">{customer.name} {customer.role !== 'customer' && <Badge tone="neel">{customer.role === 'owner' ? 'Owner' : 'Team'}</Badge>}</span>
        <span className="list-row-meta">
          <a href={whatsAppLink(customer.phone)} target="_blank" rel="noopener">{customer.phone}</a>
          {customer.email && ` · ${customer.email}`}
        </span>
        <span className="list-row-meta">
          {customer.orderCount ? <Link to={`/orders?search=${encodeURIComponent(customer.phone)}`}>{orders}</Link> : orders}
          {` · ${formatPaise(customer.spentPaise)} spent · Joined ${formatDate(customer.createdAt)}`}
        </span>
      </div>
      {canReset && customer.role === 'customer' && (
        <Button variant="outline" loading={busy} aria-label={`Reset password for ${customer.name}`} onClick={() => onReset(customer)}>Reset password</Button>
      )}
    </div>
  );
}

export default function CustomersPage() {
  const { confirm } = useFeedback();
  const allowed = useAllowed();
  const [params, setFilter] = useFilters();
  const search = params.get('search') ?? '';
  const [text, setText] = useSearchBox(search, (value) => setFilter('search', value));
  const customers = usePagedList('customers', api.customers.list, { search: search || undefined });
  const [reset, setReset] = useState(null);
  const [problem, setProblem] = useState('');
  const [busyId, setBusyId] = useState(null);
  const loyaltyOn = useLoyaltyOn();

  async function resetPassword(customer) {
    const yes = await confirm({ title: `Set a new password for ${customer.name}?`, text: 'Their current password stops working and they are signed out.', confirm: 'Set new password', cancel: 'Cancel' });
    if (!yes) return;
    setBusyId(customer.id);
    setProblem('');
    try {
      const { temporaryPassword } = await api.customers.resetPassword(customer.id);
      setReset({ name: customer.name, phone: customer.phone, temporaryPassword });
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHeader title="Customers" />
      <StoreTabs label="Customers area" tabs={loyaltyOn ? [...CUSTOMER_AREA, LOYALTY_TAB] : CUSTOMER_AREA} current="/customers" />
      <p className="lead">Shoppers who created an account with a password. Everyone who ordered, including WhatsApp sign-ins and guests, is under Shoppers.</p>
      {reset && <NewPassword reset={reset} onClose={() => setReset(null)} />}
      {problem && <Banner tone="bad">{problem}</Banner>}
      <SearchField label="Search by name or number" value={text} onChange={(event) => setText(event.target.value)} />
      <Loadable query={customers} label="Loading your customers" errorTitle="We couldn’t load your customers">
        {() => (customers.items.length ? (
          <>
            <ListCard>
              {customers.items.map((customer) => (
                <CustomerRow key={customer.id} customer={customer} canReset={allowed(MANAGERS)} busy={busyId === customer.id} onReset={resetPassword} />
              ))}
            </ListCard>
            <LoadMore query={customers} />
          </>
        ) : (
          <EmptyState title={search ? 'No customers match' : 'No customer accounts yet'}>
            {search ? 'Try another name or number.' : 'Shoppers can sign up, or add a password when they check out.'}
          </EmptyState>
        ))}
      </Loadable>
    </>
  );
}
