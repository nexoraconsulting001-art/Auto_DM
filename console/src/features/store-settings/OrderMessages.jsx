import { useQuery } from '@tanstack/react-query';
import { Banner, Button, EmptyState, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime, plural } from '../../lib/format.js';
import { ALERT_EVENT_LABELS, ORDER_ALERT, statusOf } from '../orders/shared/labels.js';
import { skipText } from '../orders/shared/rules.js';
import { Badges, StoreScreen, useAction } from '../orders/shared/ui.jsx';

export const CHANNEL_LABELS = Object.freeze({ whatsapp: 'WhatsApp', email: 'Email' });

/** One message to the customer: what, how, and whether it went. A failed or skipped one can be sent again. */
export function AlertLine({ alert, action, showOrder }) {
  const status = statusOf(ORDER_ALERT, alert.status);
  const skipped = alert.status === 'skipped' && alert.skipReason;
  // A template still in review is the one reason short enough to be the badge itself (S-53); any other reason reads below.
  const pending = skipped && alert.skipReason === 'template_pending';
  return (
    <div className="order-line">
      <div className="order-line-head">
        <span className="order-line-title">{ALERT_EVENT_LABELS[alert.event] ?? alert.event}, {CHANNEL_LABELS[alert.channel] ?? alert.channel}</span>
        <Badges items={[pending ? { tone: 'warn', text: skipText(alert.skipReason) } : { tone: status.tone, text: status.label }]} />
      </div>
      {skipped && !pending && <span className="order-line-meta">{skipText(alert.skipReason)}</span>}
      <span className="order-line-meta">
        {[showOrder && `Order ${alert.orderNumber}`, alert.sentAt ? `Sent ${formatDateTime(alert.sentAt)}` : formatDateTime(alert.createdAt), alert.attempts > 1 && plural(alert.attempts, 'try', 'tries')].filter(Boolean).join(' · ')}
      </span>
      {['failed', 'skipped'].includes(alert.status) && (
        <div className="row-actions">
          <Button variant="soft" loading={action.busy === `alert-${alert.id}`} onClick={() => action.run(`alert-${alert.id}`, () => api.orderAlerts.retry(alert.id), 'Sending it again.')}>Send again</Button>
        </div>
      )}
    </div>
  );
}

/** The WhatsApp and email updates this order's customer was sent (9.16). */
export function OrderMessages({ order }) {
  const alerts = useQuery({ queryKey: ['order-alerts', 'order', String(order.id)], queryFn: () => api.orderAlerts.list({ orderId: order.id, limit: 50 }) });
  const action = useAction();
  return (
    <Panel title="Messages to the customer">
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
      <StoreScreen query={alerts} label="Loading the messages" errorTitle="We couldn’t load the messages">
        {({ items }) => (items.length
          ? <div>{items.map((alert) => <AlertLine key={alert.id} alert={alert} action={action} />)}</div>
          : <EmptyState title="No messages yet">Order updates go by WhatsApp and email, to customers who agreed to them.</EmptyState>)}
      </StoreScreen>
    </Panel>
  );
}
