import { useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { OWNER_ONLY } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, Sheet, TextAreaField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { RETURN, SHIPMENT, statusOf } from '../orders/shared/labels.js';
import { returnMoves, returnValue } from '../orders/shared/rules.js';
import { StatusBadge, StoreScreen, Timeline, useAction } from '../orders/shared/ui.jsx';
import { RefundButton } from '../payments/OrderMoney.jsx';
import { RESOLUTION_LABELS } from './ReturnsPage.jsx';

function Proofs({ proofs }) {
  if (!proofs.length) return <p className="muted">No proof was attached.</p>;
  return (
    <ul className="store-photos" aria-label="Proof from the customer">
      {proofs.map((proof, index) => (
        <li key={proof.id}>
          {proof.kind === 'photo'
            ? <a href={proof.fileUrl} target="_blank" rel="noopener"><img src={proof.fileUrl} alt={`Photo ${index + 1} from the customer`} /></a>
            : <a className="store-video" href={proof.fileUrl} target="_blank" rel="noopener">Video {index + 1}</a>}
        </li>
      ))}
    </ul>
  );
}

function DeclineSheet({ sheet, ret }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ note: '' });
  async function submit(event) {
    event.preventDefault();
    if (!form.values.note.trim()) return form.reject({ note: 'Say why, for the customer' });
    const done = await form.run(() => api.returns.decline(ret.id, { note: form.values.note.trim() }));
    if (done) {
      sheet.current?.close();
      toast('Return declined. The customer is told why.');
      await refresh();
    }
    return undefined;
  }
  return (
    <Sheet ref={sheet} title="Decline this return?">
      <form className="stack" onSubmit={submit} noValidate>
        <FieldGroup><TextAreaField label="Why, for the customer" maxLength={500} {...form.field('note')} /></FieldGroup>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <div className="sheet-actions">
          <Button variant="outline" onClick={() => sheet.current?.close()}>Keep it</Button>
          <Button type="submit" variant="danger" loading={form.busy}>Decline</Button>
        </div>
      </form>
    </Sheet>
  );
}

/** The owner's refund for a received return, against the return's order. The return closes when the refund goes through. */
function RefundForReturn({ ret }) {
  const order = useQuery({ queryKey: ['orders', String(ret.orderId)], queryFn: () => api.orders.get(ret.orderId) });
  return (
    <StoreScreen query={order} label="Loading the order" errorTitle="We couldn’t load the order">
      {(data) => <RefundButton order={data} returnId={ret.id} suggestedPaise={returnValue(ret, data)} label="Refund the customer" variant="primary" />}
    </StoreScreen>
  );
}

function ReturnDetail({ ret }) {
  const allowed = useAllowed();
  const { confirm } = useFeedback();
  const action = useAction();
  const decline = useRef(null);
  const moves = returnMoves(ret);
  const reverse = useQuery({ queryKey: ['shipments', 'one', String(ret.shipmentId)], queryFn: () => api.shipments.get(ret.shipmentId), enabled: Boolean(ret.shipmentId) });

  async function approve() {
    const yes = await confirm({ title: 'Approve this return?', text: 'A pickup is booked from the customer, on the same courier account as your deliveries.', confirm: 'Approve', cancel: 'Not yet', tone: 'primary' });
    if (yes) await action.run('approve', () => api.returns.approve(ret.id), 'Approved. The pickup is booked.');
  }
  async function receive(condition) {
    const good = condition === 'good';
    const yes = await confirm({
      title: good ? 'Received in good condition?' : 'Received, but not fit to sell?',
      text: good ? 'The items go back into stock.' : 'The items don’t go back into stock.',
      confirm: good ? 'Yes, back into stock' : 'Yes, not restockable',
      cancel: 'Go back',
      tone: 'primary',
    });
    if (yes) await action.run(`receive-${condition}`, () => api.returns.receive(ret.id, { condition }), 'Marked as received.');
  }
  async function exchange() {
    const yes = await confirm({ title: 'Close as exchanged?', text: 'Send the replacement as a new order or by hand. No refund is made.', confirm: 'Close as exchanged', cancel: 'Go back', tone: 'primary' });
    if (yes) await action.run('exchange', () => api.returns.close(ret.id, { resolution: 'exchange' }), 'Closed as exchanged.');
  }

  return (
    <>
      <BackLink to="/returns">Returns</BackLink>
      <PageHeader title={`Return for ${ret.orderNumber}`} actions={<StatusBadge table={RETURN} status={ret.status} />} />
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
      <div className="columns">
        <div className="stack">
          <Panel title="What’s coming back">
            <ul className="stack" aria-label="Items">
              {ret.items.map((line) => <li key={line.orderItemId}>{line.name} × {line.qty}</li>)}
            </ul>
            <dl className="facts">
              <div><dt>The customer wants</dt><dd>{RESOLUTION_LABELS[ret.resolution] ?? ret.resolution}</dd></div>
              <div><dt>Asked</dt><dd>{formatDateTime(ret.createdAt)}</dd></div>
              {ret.condition && <div><dt>Arrived</dt><dd>{ret.condition === 'good' ? `In good condition${ret.restocked ? ', back in stock' : ''}` : 'Not fit to sell'}</dd></div>}
            </dl>
            {ret.reason && <p className="review-body">“{ret.reason}”</p>}
            <Button as={Link} variant="outline" to={`/orders/${ret.orderId}`}>Open the order</Button>
          </Panel>
          <Panel title="Proof">
            <Proofs proofs={ret.proofs} />
          </Panel>
        </div>
        <div className="stack">
          <Panel title="Next step">
            {moves.length === 0 && <EmptyState title="Nothing to do">{ret.status === 'refunded' || ret.status === 'exchanged' ? 'This return is closed.' : 'This return has ended.'}</EmptyState>}
            {moves.includes('approve') && (
              <div className="row-actions">
                <Button loading={action.busy === 'approve'} onClick={approve}>Approve</Button>
                <Button variant="outline" onClick={() => decline.current?.showModal()}>Decline</Button>
              </div>
            )}
            {moves.includes('receive') && (
              <div className="order-actions">
                <p className="muted">When the parcel is back with you, check it:</p>
                <Button loading={action.busy === 'receive-good'} onClick={() => receive('good')}>Received in good condition</Button>
                <Button variant="outline" loading={action.busy === 'receive-not_restockable'} onClick={() => receive('not_restockable')}>Received, not restockable</Button>
              </div>
            )}
            {moves.includes('refund') && (
              <div className="order-actions">
                {allowed(OWNER_ONLY)
                  ? <><RefundForReturn ret={ret} /><p className="field-hint">The return closes by itself when the refund goes through.</p></>
                  : <p className="muted">The owner refunds the customer. The return closes when the refund goes through.</p>}
                <Button variant="outline" loading={action.busy === 'exchange'} onClick={exchange}>Close as exchanged</Button>
              </div>
            )}
          </Panel>
          {ret.shipmentId && (
            <Panel title="Return pickup">
              <StoreScreen query={reverse} label="Loading the pickup" errorTitle="We couldn’t load the pickup">
                {(shipment) => (
                  <>
                    <p><StatusBadge table={SHIPMENT} status={shipment.status} /> {shipment.awb ? `AWB ${shipment.awb}` : ''} {shipment.courierName}</p>
                    {(shipment.events ?? []).length > 0 && <Timeline label="Courier scans" items={shipment.events.map((event, index) => ({ key: `${event.at}-${index}`, title: statusOf(SHIPMENT, event.status).label, meta: formatDateTime(event.at) }))} />}
                  </>
                )}
              </StoreScreen>
            </Panel>
          )}
        </div>
      </div>
      <DeclineSheet sheet={decline} ret={ret} />
    </>
  );
}

export default function ReturnPage() {
  const { id } = useParams();
  const ret = useQuery({ queryKey: ['returns', id], queryFn: () => api.returns.get(id) });
  return (
    <StoreScreen query={ret} detail label="Loading this return" errorTitle="We couldn’t load this return">
      {(data) => <ReturnDetail ret={data} />}
    </StoreScreen>
  );
}
