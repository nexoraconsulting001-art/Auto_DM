import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, FieldGroup, ListRow, Loadable, PageHeader, Panel, SelectField, TextAreaField, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, formatPaise, whatsAppLink } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useRefresh } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { OrderStatusBadge } from './OrderStatusBadge.jsx';
import { ORDER_STATUS } from './status.js';

function StatusForm({ order }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ status: order.status, notes: order.notes });

  async function save(event) {
    event.preventDefault();
    const saved = await form.run(() => api.orders.setStatus(order.id, { status: form.values.status, notes: form.values.notes }));
    if (saved) {
      toast('Order updated.');
      await refresh();
    }
  }

  return (
    <Panel title="Update status">
      <form className="stack" onSubmit={save}>
        <FieldGroup>
          <SelectField label="Status" {...form.field('status')}>
            {Object.entries(ORDER_STATUS).map(([key, { label }]) => <option key={key} value={key}>{label}</option>)}
          </SelectField>
          <TextAreaField label="Internal note" placeholder="e.g. UTR number, courier and tracking ID" {...form.field('notes')} />
        </FieldGroup>
        {form.message && <Banner tone="bad">{form.message}</Banner>}
        <Button type="submit" block loading={form.busy}>Save</Button>
        <p className="field-hint">Cancelling puts the items back in stock.</p>
      </form>
    </Panel>
  );
}

function OrderDetail({ order }) {
  const { session } = useSession();
  const hello = `Hi ${order.customerName.split(' ')[0]}, this is ${session.business.name} about your order ${order.orderNumber}.`;

  return (
    <>
      <BackLink to="/orders">Orders</BackLink>
      <PageHeader title={order.orderNumber} actions={<OrderStatusBadge status={order.status} />} />
      <div className="columns">
        <Panel title="Items">
          <div className="row-list">
            {order.items.map((item) => (
              <ListRow
                key={item.id}
                as={item.productId ? Link : 'div'}
                {...(item.productId ? { to: `/products/${item.productId}` } : {})}
                leading={<Thumb src={item.image} />}
                title={item.name}
                meta={`${item.option ? `${item.option} · ` : ''}${formatPaise(item.pricePaise)} × ${item.qty}`}
                trailing={<span className="row-money">{formatPaise(item.pricePaise * item.qty)}</span>}
              />
            ))}
          </div>
          <dl className="totals">
            <div><dt>Subtotal</dt><dd>{formatPaise(order.subtotalPaise)}</dd></div>
            <div><dt>Delivery</dt><dd>{order.shippingPaise ? formatPaise(order.shippingPaise) : 'Free'}</dd></div>
            <div className="totals-grand"><dt>Total</dt><dd>{formatPaise(order.totalPaise)}</dd></div>
          </dl>
          <p className="field-hint">
            Placed {formatDateTime(order.createdAt)}
            {order.reelId && <> from <Link to={`/reels/${order.reelId}`}>this reel</Link></>}
            {order.source === 'dm' && ' via the DM link'}.
          </p>
        </Panel>
        <div className="stack">
          <StatusForm key={`${order.id}-${order.updatedAt}`} order={order} />
          <Panel title="Customer">
            <address className="address">
              {order.customerName}<br />
              {order.address}<br />
              {order.city}, {order.state} {order.pincode}
            </address>
            <p>
              <a href={`tel:+91${order.phone}`}>+91 {order.phone}</a>
              {order.email && <><br /><a href={`mailto:${order.email}`}>{order.email}</a></>}
            </p>
            <Button as="a" variant="soft" href={whatsAppLink(order.phone, hello)} target="_blank" rel="noopener">Message on WhatsApp</Button>
          </Panel>
        </div>
      </div>
    </>
  );
}

export default function OrderPage() {
  const { id } = useParams();
  const order = useQuery({ queryKey: ['orders', id], queryFn: () => api.orders.get(id) });
  return (
    <Loadable query={order} detail label="Loading this order" errorTitle="We couldn’t load this order">
      {(data) => <OrderDetail order={data} />}
    </Loadable>
  );
}
