import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check } from 'lucide-react';
import { MANAGERS, staffWith } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, Card, EmptyState, ListRow, Loadable, PageHeader, Panel, Ring, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatPaise, plural } from '../../lib/format.js';
import { useAllowed, useRefresh } from '../../lib/query.js';
import { useSession } from '../../lib/session.jsx';
import { ResultBadge } from '../activity/ResultBadge.jsx';
import { OrderStatusBadge } from '../orders/OrderStatusBadge.jsx';
import { checklistView } from './checklist.js';

function StepAction({ step }) {
  const variant = step.next ? 'primary' : 'soft';
  if (step.href) return <Button as="a" variant={variant} href={step.href}>{step.action}</Button>;
  return <Button as={Link} variant={variant} to={step.to}>{step.action}</Button>;
}

function Checklist({ checklist }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const hide = useMutation({
    mutationFn: () => api.settings.update({ checklistDismissed: true }),
    onSuccess: refresh,
    onError: (error) => toast(error.message),
  });
  const view = checklistView(checklist);
  if (!view.visible) return null;

  return (
    <Card aria-labelledby="setup-title">
      <div className="setup-head">
        <Ring done={view.done} total={view.total} label={`${view.done} of ${view.total} steps done`} />
        <div className="setup-head-text">
          <h2 id="setup-title">Set up your store</h2>
          <p className="muted">{view.done} of {view.total} done. Steps tick themselves off as you go.</p>
        </div>
      </div>
      <ol className="steps">
        {view.steps.map((step, index) => (
          <li key={step.key} className={`step${step.done ? ' step-done' : ''}${step.next ? ' step-next' : ''}`}>
            <span className="step-mark" aria-hidden="true">{step.done ? <Check size={16} strokeWidth={2.4} /> : index + 1}</span>
            <div className="step-body">
              <h3>{step.title}</h3>
              {!step.done && <p className="muted">{step.text}</p>}
              {step.done ? <span className="step-state">Done</span> : <StepAction step={step} />}
            </div>
          </li>
        ))}
      </ol>
      <Button variant="outline" loading={hide.isPending} onClick={() => hide.mutate()}>Hide this</Button>
    </Card>
  );
}

function SetupPanel() {
  const setup = useQuery({ queryKey: ['setup'], queryFn: api.settings.setup });
  return (
    <Loadable query={setup} label="Checking your setup" errorTitle="We couldn’t check your setup">
      {(status) => (
        <>
          {status.testMode && <Banner tone="warn">Test mode is on: DMs are logged, not sent.</Banner>}
          {!status.instagram.connected && <Banner tone="warn">Instagram isn’t connected yet, so DMs can’t be sent.</Banner>}
          <Checklist checklist={status.checklist} />
        </>
      )}
    </Loadable>
  );
}

function StatTile({ value, label, today, highlight }) {
  return (
    <div className={`flow-tile${highlight ? ' flow-tile-hi' : ''}`}>
      <span className="flow-value">{value}</span>
      <span className="flow-label">{label}</span>
      {today && <span className="flow-sub">{today}</span>}
    </div>
  );
}

function NeedsYou({ stats }) {
  const items = [
    stats.toConfirm > 0 && { key: 'confirm', to: '/orders?status=payment_submitted', title: `${plural(stats.toConfirm, 'order')} waiting for payment`, text: 'Check the payment and confirm.', cta: 'Review payments' },
    stats.toShip > 0 && { key: 'ship', to: '/orders?status=paid', title: `${plural(stats.toShip, 'paid order')} to ship`, text: 'Pack these and mark them shipped.', cta: 'Open orders' },
  ].filter(Boolean);
  if (!items.length) return null;
  return (
    <section className="stack" aria-labelledby="needs-title">
      <div className="panel-head">
        <h2 id="needs-title">Needs you</h2>
        <Badge tone="ink">{items.length}</Badge>
      </div>
      <div className="needs">
        {items.map((item) => (
          <Link key={item.key} className="needs-card" to={item.to}>
            <h3>{item.title}</h3>
            <p className="muted">{item.text}</p>
            <span className="needs-cta">{item.cta}</span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function StatsPanel() {
  const stats = useQuery({ queryKey: ['stats'], queryFn: api.stats.dashboard });
  return (
    <Loadable query={stats} label="Loading your numbers" errorTitle="We couldn’t load your numbers">
      {(numbers) => (
        <>
          <Card ink aria-labelledby="flow-title">
            <div className="panel-head">
              <h2 id="flow-title" className="flow-title">From feeling to price</h2>
              <span className="flow-range">All time</span>
            </div>
            <div className="flow">
              <StatTile value={numbers.dms.toLocaleString('en-IN')} label="DMs sent" today={`${numbers.dmsToday} today`} />
              <StatTile value={numbers.visits.toLocaleString('en-IN')} label="Store visits" today={`${numbers.visitsToday} today`} />
              <StatTile value={numbers.orders.toLocaleString('en-IN')} label="Orders" today={`${numbers.ordersToday} today`} />
              <StatTile value={formatPaise(numbers.revenuePaise)} label="Revenue" today="Paid and shipped" highlight />
            </div>
          </Card>
          <NeedsYou stats={numbers} />
        </>
      )}
    </Loadable>
  );
}

function ReelsPanel() {
  const reels = useQuery({ queryKey: ['reels', 'latest'], queryFn: () => api.reels.list({ limit: 5 }) });
  return (
    <Panel title="Reels" action={<Link className="panel-link" to="/reels">Manage reels</Link>}>
      <Loadable query={reels} label="Loading your reels" errorTitle="We couldn’t load your reels">
        {({ items }) => (items.length ? (
          <div className="row-list">
            {items.map((reel) => (
              <ListRow
                key={reel.id}
                as={Link}
                to={`/reels/${reel.id}`}
                leading={<Thumb src={reel.thumbnailUrl} tall />}
                title={reel.headline || reel.slug}
                meta={`${plural(reel.productCount, 'product')}, ${plural(reel.dmCount, 'DM')}, ${plural(reel.orderCount, 'order')}`}
                trailing={reel.active ? <Badge tone="good">Live</Badge> : <Badge>Paused</Badge>}
              />
            ))}
          </div>
        ) : <EmptyState title="No reel stores yet" action={<Button as={Link} variant="soft" to="/reels">Set up your first reel</Button>} />)}
      </Loadable>
    </Panel>
  );
}

function OrdersPanel() {
  const orders = useQuery({ queryKey: ['orders', 'latest'], queryFn: () => api.orders.list({ limit: 6 }) });
  return (
    <Panel title="Latest orders" action={<Link className="panel-link" to="/orders">All orders</Link>}>
      <Loadable query={orders} label="Loading your orders" errorTitle="We couldn’t load your orders">
        {({ items }) => (items.length ? (
          <div className="row-list">
            {items.map((order) => (
              <ListRow key={order.id} as={Link} to={`/orders/${order.id}`} title={order.orderNumber} meta={`${order.customerName}, ${formatPaise(order.totalPaise)}`} trailing={<OrderStatusBadge status={order.status} />} />
            ))}
          </div>
        ) : <EmptyState title="No orders yet">They’ll appear here as soon as someone checks out.</EmptyState>)}
      </Loadable>
    </Panel>
  );
}

function ActivityPanel() {
  const activity = useQuery({ queryKey: ['activity', 'latest'], queryFn: () => api.activity.list({ limit: 8 }) });
  return (
    <Panel title="Latest comments" action={<Link className="panel-link" to="/activity">All activity</Link>}>
      <Loadable query={activity} label="Loading your comments" errorTitle="We couldn’t load your comments">
        {({ items }) => (items.length ? (
          <div className="row-list">
            {items.map((row) => (
              <ListRow key={row.id} title={`@${row.username || '?'}`} meta={row.text} trailing={<ResultBadge result={row.result} />} />
            ))}
          </div>
        ) : <EmptyState title="No comments yet">They’ll show here once people comment your keywords.</EmptyState>)}
      </Loadable>
    </Panel>
  );
}

/** Each panel loads on its own and is shown only to someone the API would answer. */
const PANELS = [
  { access: MANAGERS, Section: SetupPanel },
  { access: staffWith('analytics'), Section: StatsPanel },
  { access: staffWith('automations'), Section: ReelsPanel },
  { access: staffWith('orders'), Section: OrdersPanel },
  { access: staffWith('automations'), Section: ActivityPanel },
];

export default function HomePage() {
  const { session } = useSession();
  const allowed = useAllowed();
  const panels = PANELS.filter(({ access }) => allowed(access));
  return (
    <>
      <PageHeader
        eyebrow={session.business.name}
        title={`Hello, ${session.user.name.split(' ')[0]}`}
        actions={<Button as="a" variant="outline" href="/">View your store</Button>}
      />
      {panels.map(({ Section }, index) => <Section key={index} />)}
      {panels.length === 0 && <EmptyState title="Your console is ready">Your orders, products and reels will show up here.</EmptyState>}
    </>
  );
}
