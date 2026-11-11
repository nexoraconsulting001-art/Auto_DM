import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CopyButton } from '../../components/copy.jsx';
import { Banner, Button, EmptyState, FieldGroup, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, formatPaise } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useRefresh } from '../../lib/query.js';
import { useFeedback } from '../../components/feedback.jsx';
import { SHIPMENT, SHIPMENT_MODE, statusOf } from '../orders/shared/labels.js';
import { CANCELLABLE_SHIPMENTS, canBookCourier } from '../orders/shared/rules.js';
import { Badges, NumberField, StoreScreen, Timeline, toWhole, useAction } from '../orders/shared/ui.jsx';

/**
 * An order's parcels (PRD 9.10): "Ready to ship" books the courier, the AWB, the label and the pickup; the courier's scans
 * move the order from there. The tracking link is the seller's own page on the seller's own domain (S-78), never the courier's.
 */
const CANCELLABLE = new Set(CANCELLABLE_SHIPMENTS);
const SIZE_FIELDS = [['weightGrams', 'Weight (grams)', 500000], ['lengthCm', 'Length (cm)', 500], ['breadthCm', 'Width (cm)', 500], ['heightCm', 'Height (cm)', 500]];

export const shipmentsKey = (orderId) => ['shipments', String(orderId)];

function ReadyToShip({ order }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ weightGrams: '', lengthCm: '', breadthCm: '', heightCm: '' });

  async function book(event) {
    event.preventDefault();
    const body = {};
    const found = {};
    for (const [name, , max] of SIZE_FIELDS) {
      const value = toWhole(form.values[name]);
      if (value === null) continue;
      if (!Number.isSafeInteger(value) || value < 1 || value > max) found[name] = `Enter a whole number from 1 to ${max.toLocaleString('en-IN')}`;
      else body[name] = value;
    }
    if (Object.keys(found).length) return form.reject(found);
    const done = await form.run(() => api.shipments.create(order.id, body));
    if (done) {
      toast('Courier booked. The label is ready.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={book} noValidate aria-label="Ready to ship">
      <p className="muted">Books the courier pickup and makes the label, with your business as the shipper. Leave the size empty to use the products’ own weight and size.</p>
      <details className="store-more">
        <summary>Parcel size</summary>
        <FieldGroup>
          <div className="store-grid-2">
            {SIZE_FIELDS.map(([name, label]) => <NumberField key={name} label={label} {...form.field(name)} />)}
          </div>
        </FieldGroup>
      </details>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" block loading={form.busy}>Ready to ship</Button>
    </form>
  );
}

function Label({ shipment }) {
  const [url, setUrl] = useState('');
  const action = useAction();
  if (!shipment.hasLabel) return null;
  if (url) return <Button as="a" variant="soft" href={url} target="_blank" rel="noopener">Open the label</Button>;
  return (
    <>
      <Button variant="soft" loading={action.busy === 'label'} onClick={async () => {
        const file = await action.run('label', () => api.shipments.label(shipment.id));
        if (file?.url) setUrl(file.url);
      }}>Get the label</Button>
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
    </>
  );
}

function ShipmentLine({ shipment }) {
  const { confirm } = useFeedback();
  const action = useAction();
  const status = statusOf(SHIPMENT, shipment.status);
  const events = shipment.events ?? [];

  async function cancel() {
    const yes = await confirm({ title: 'Cancel this pickup?', text: 'The courier won’t collect the parcel. You can book again afterwards.', confirm: 'Cancel pickup', cancel: 'Keep it' });
    if (yes) await action.run('cancel', () => api.shipments.cancel(shipment.id), 'Pickup cancelled.');
  }

  return (
    <div className="order-line">
      <div className="order-line-head">
        <span className="order-line-title">{shipment.kind === 'reverse' ? 'Return pickup' : 'Parcel'}{shipment.courierName ? `, ${shipment.courierName}` : ''}</span>
        <Badges items={[{ tone: status.tone, text: status.label }]} />
      </div>
      <span className="order-line-meta">
        {[shipment.awb && `AWB ${shipment.awb}`, SHIPMENT_MODE[shipment.mode], shipment.codPaise ? `Collect ${formatPaise(shipment.codPaise)} at the door` : '', shipment.chargePaise ? `Courier charge ${formatPaise(shipment.chargePaise)} at cost` : ''].filter(Boolean).join(' · ')}
      </span>
      <span className="order-line-meta">
        {shipment.weightGrams ? `${shipment.weightGrams} g, ${shipment.lengthCm} × ${shipment.breadthCm} × ${shipment.heightCm} cm · ` : ''}Booked {formatDateTime(shipment.createdAt)}
        {shipment.deliveredAt ? ` · Delivered ${formatDateTime(shipment.deliveredAt)}` : ''}
      </span>
      {shipment.trackingUrl && <span className="order-line-meta store-break">Tracking page: {shipment.trackingUrl}</span>}
      {events.length > 0 && (
        <details className="store-more">
          <summary>Courier scans</summary>
          <Timeline label="Courier scans" items={events.map((event, index) => ({ key: `${event.at}-${index}`, title: statusOf(SHIPMENT, event.status).label, meta: `${event.location ? `${event.location} · ` : ''}${formatDateTime(event.at)}`, note: event.providerStatus }))} />
        </details>
      )}
      <div className="row-actions">
        {shipment.trackingUrl && <CopyButton text={shipment.trackingUrl} label="Copy tracking link" />}
        <Label shipment={shipment} />
        {CANCELLABLE.has(shipment.status) && <Button variant="outline" loading={action.busy === 'cancel'} onClick={cancel}>Cancel pickup</Button>}
      </div>
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
    </div>
  );
}

export function OrderShipments({ order }) {
  const shipments = useQuery({ queryKey: shipmentsKey(order.id), queryFn: () => api.shipments.forOrder(order.id) });
  return (
    <Panel title="Shipping">
      <StoreScreen query={shipments} label="Loading the shipping" errorTitle="We couldn’t load the shipping">
        {({ items }) => (
          <>
            {items.length > 0 && <div>{items.map((shipment) => <ShipmentLine key={shipment.id} shipment={shipment} />)}</div>}
            {canBookCourier(order, items) && <ReadyToShip order={order} />}
            {!items.length && !canBookCourier(order, items) && (
              <EmptyState title="Nothing shipped">
                {order.fulfilmentStatus === 'pending' ? 'You can ship once the order is paid or confirmed.' : 'No courier was booked for this order.'}
              </EmptyState>
            )}
          </>
        )}
      </StoreScreen>
    </Panel>
  );
}
