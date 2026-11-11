import { Banner, Button, EmptyState, FieldGroup, ListCard, ListRow, LoadMore, PageHeader, Panel, SelectField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, plural } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { usePagedList, useRefresh } from '../../lib/query.js';
import { useFeedback } from '../../components/feedback.jsx';
import { ORDER_AREA } from './shared/areas.js';
import { FULFILMENT_STATUSES, PAYMENT_STATUSES } from './shared/contract.js';
import { FULFILMENT, PAYMENT } from './shared/labels.js';
import { StoreScreen, StoreTabs } from './shared/ui.jsx';

const FILE_STATUS = { queued: 'Being made', ready: 'Ready', failed: 'Couldn’t be made', expired: 'Expired' };

/** Orders as a CSV file, for this business only (9.9). Each file is kept for a while, then it expires. */
function NewFile() {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ from: '', to: '', fulfilment: '', payment: '' });

  async function make(event) {
    event.preventDefault();
    const { from, to, fulfilment, payment } = form.values;
    if (from && to && from > to) return form.reject({ to: 'Pick a date after the first one' });
    const body = Object.fromEntries(Object.entries({ from, to, fulfilment, payment }).filter(([, value]) => value));
    const made = await form.run(() => api.orderDownloads.create(body));
    if (made) {
      toast('Your file is ready.');
      await refresh();
    }
    return undefined;
  }

  return (
    <Panel title="Make a file">
      <form className="stack" onSubmit={make} noValidate>
        <p className="muted">A spreadsheet of your orders, newest first. Leave the filters empty for every order.</p>
        <FieldGroup>
          <div className="store-grid-2">
            <TextField label="From" type="date" {...form.field('from')} />
            <TextField label="Until" type="date" {...form.field('to')} />
          </div>
          <SelectField label="Where the parcel is" {...form.field('fulfilment')}>
            <option value="">Any</option>
            {FULFILMENT_STATUSES.map((key) => <option key={key} value={key}>{FULFILMENT[key].label}</option>)}
          </SelectField>
          <SelectField label="Where the money is" {...form.field('payment')}>
            <option value="">Any</option>
            {PAYMENT_STATUSES.map((key) => <option key={key} value={key}>{PAYMENT[key].label}</option>)}
          </SelectField>
        </FieldGroup>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <Button type="submit" block loading={form.busy}>Make the file</Button>
      </form>
    </Panel>
  );
}

export default function OrderFilesPage() {
  const files = usePagedList('order-downloads', api.orderDownloads.list);
  return (
    <>
      <PageHeader title="Order files" />
      <StoreTabs label="Orders area" tabs={ORDER_AREA} current="/orders/files" />
      <NewFile />
      <StoreScreen query={files} label="Loading your files" errorTitle="We couldn’t load your files">
        {() => (files.items.length ? (
          <>
            <ListCard aria-label="Your files">
              {files.items.map((file) => (
                <ListRow
                  key={file.id}
                  title={`Orders, ${formatDateTime(file.createdAt)}`}
                  meta={`${plural(file.rowCount, 'order')} · ${FILE_STATUS[file.status] ?? file.status}${file.expiresAt && file.status === 'ready' ? ` until ${formatDateTime(file.expiresAt)}` : ''}`}
                  trailing={file.fileUrl ? <Button as="a" variant="soft" href={file.fileUrl} download>Download</Button> : null}
                />
              ))}
            </ListCard>
            <LoadMore query={files} />
          </>
        ) : (
          <EmptyState title="No files yet">Make one above. It holds this business’s orders only.</EmptyState>
        ))}
      </StoreScreen>
    </>
  );
}
