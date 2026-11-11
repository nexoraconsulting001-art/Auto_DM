import { useState } from 'react';
import { Link } from 'react-router-dom';
import { OWNER_ONLY } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Banner, Button, EmptyState, ListCard, ListRow, LoadMore, PageHeader, Panel, SearchField, SelectField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDate, formatDateTime, formatPaise, plural } from '../../lib/format.js';
import { useAllowed, useFilters, usePagedList, useRefresh, useSearchBox } from '../../lib/query.js';
import { useLoyaltyOn } from '../loyalty/useLoyalty.js';
import { CUSTOMER_AREA, LOYALTY_TAB } from '../orders/shared/areas.js';
import { shopperBadges } from '../orders/shared/rules.js';
import { Badges, StoreScreen, StoreTabs } from '../orders/shared/ui.jsx';

const FILE_STATUS = { queued: 'Being made', ready: 'Ready', failed: 'Couldn’t be made', expired: 'Expired' };

/** Only the owner takes the customer list away (9.17), and every download is in the audit log. */
function Downloads() {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const files = usePagedList('shopper-downloads', api.shopperDownloads.list);
  const [format, setFormat] = useState('xlsx');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function make() {
    setBusy(true);
    setProblem('');
    try {
      await api.shopperDownloads.create({ format });
      toast('Your file is ready.');
      await refresh();
    } catch (error) {
      setProblem(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Panel title="Customer list file">
      <p className="muted">This business’s customers only. Each download is recorded in the audit log, and the file expires after a day.</p>
      <div className="inline-field">
        <SelectField label="File type" value={format} onChange={(event) => setFormat(event.target.value)}>
          <option value="xlsx">Excel</option>
          <option value="csv">CSV</option>
        </SelectField>
        <Button variant="soft" loading={busy} onClick={make}>Make the file</Button>
      </div>
      {problem && <Banner tone="bad">{problem}</Banner>}
      <StoreScreen query={files} label="Loading your files" errorTitle="We couldn’t load your files">
        {() => (files.items.length ? (
          <ListCard aria-label="Customer list files">
            {files.items.map((file) => (
              <ListRow
                key={file.id}
                title={`${file.format === 'csv' ? 'CSV' : 'Excel'}, ${formatDateTime(file.createdAt)}`}
                meta={`${plural(file.rowCount, 'customer')} · ${FILE_STATUS[file.status] ?? file.status}`}
                trailing={file.fileUrl ? <Button as="a" variant="soft" href={file.fileUrl} download>Download</Button> : null}
              />
            ))}
          </ListCard>
        ) : <EmptyState title="No files yet">Make one above.</EmptyState>)}
      </StoreScreen>
    </Panel>
  );
}

export default function ShoppersPage() {
  const allowed = useAllowed();
  const loyaltyOn = useLoyaltyOn();
  const [params, setFilter] = useFilters();
  const search = params.get('search') ?? '';
  const [text, setText] = useSearchBox(search, (value) => setFilter('search', value));
  const shoppers = usePagedList('shoppers', api.shoppers.list, { search: search || undefined });

  return (
    <>
      <PageHeader title="Shoppers" />
      <StoreTabs label="Customers area" tabs={loyaltyOn ? [...CUSTOMER_AREA, LOYALTY_TAB] : CUSTOMER_AREA} current="/customers/shoppers" />
      <p className="lead">Everyone who ordered from this business, with what they ordered here only.</p>
      <SearchField label="Name, phone or email" value={text} onChange={(event) => setText(event.target.value)} />
      <StoreScreen query={shoppers} label="Loading your shoppers" errorTitle="We couldn’t load your shoppers">
        {() => (shoppers.items.length ? (
          <>
            <ListCard aria-label="Shoppers">
              {shoppers.items.map((shopper) => (
                <ListRow
                  key={shopper.id ?? `guest-${shopper.phone}`}
                  {...(shopper.id ? { as: Link, to: `/customers/shoppers/${shopper.id}` } : {})}
                  title={shopper.name || shopper.phone}
                  meta={`${shopper.id ? '' : `${shopper.phone} · `}${plural(shopper.orders, 'order')} · ${formatPaise(shopper.spentPaise)} spent${shopper.lastOrderAt ? ` · last ${formatDate(shopper.lastOrderAt)}` : ''}`}
                  trailing={<Badges items={shopperBadges(shopper)} />}
                />
              ))}
            </ListCard>
            <LoadMore query={shoppers} />
          </>
        ) : (
          <EmptyState title={search ? 'No shoppers match' : 'No shoppers yet'}>
            {search ? 'Try another name, phone or email.' : 'A shopper shows here after their first order with you.'}
          </EmptyState>
        ))}
      </StoreScreen>
      {allowed(OWNER_ONLY) && <Downloads />}
    </>
  );
}
