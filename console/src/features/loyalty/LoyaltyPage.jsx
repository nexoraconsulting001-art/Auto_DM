import { Link } from 'react-router-dom';
import { MANAGERS } from '@contracts/access.js';
import { Button, EmptyState, ListCard, ListRow, LoadMore, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useAllowed, usePagedList } from '../../lib/query.js';
import { CUSTOMER_AREA, LOYALTY_TAB } from '../orders/shared/areas.js';
import { REFERRAL } from '../orders/shared/labels.js';
import { StatusBadge, StoreScreen, StoreTabs } from '../orders/shared/ui.jsx';

function Referrals() {
  const referrals = usePagedList('loyalty-referrals', api.loyalty.referrals);
  return (
    <Panel title="Referrals">
      <StoreScreen query={referrals} label="Loading the referrals" errorTitle="We couldn’t load the referrals">
        {() => (referrals.items.length ? (
          <>
            <ListCard aria-label="Referrals">
              {referrals.items.map((referral) => (
                <ListRow
                  key={referral.id}
                  title={referral.orderId ? <Link to={`/orders/${referral.orderId}`}>A friend’s first order</Link> : 'A friend signed up'}
                  meta={`Invited by customer ${referral.referrerShopperId} · ${formatDateTime(referral.createdAt)}${referral.blockReason ? ` · ${referral.blockReason}` : ''}`}
                  trailing={<StatusBadge table={REFERRAL} status={referral.status} />}
                />
              ))}
            </ListCard>
            <LoadMore query={referrals} />
          </>
        ) : <EmptyState title="No referrals yet">Each customer has their own invite link in their account.</EmptyState>)}
      </StoreScreen>
    </Panel>
  );
}

export default function LoyaltyPage() {
  const allowed = useAllowed();
  const members = usePagedList('loyalty-members', api.loyalty.members);
  return (
    <>
      <PageHeader title="Loyalty points" actions={allowed(MANAGERS) ? <Button as={Link} variant="soft" to="/loyalty/settings">Point rules</Button> : null} />
      <StoreScreen query={members} label="Loading your members" errorTitle="We couldn’t load your members">
        {() => (
          <>
            <StoreTabs label="Customers area" tabs={[...CUSTOMER_AREA, LOYALTY_TAB]} current="/loyalty" />
            <Panel title="Points balances">
              {members.items.length ? (
                <>
                  <ListCard aria-label="Points balances">
                    {members.items.map((member) => (
                      <ListRow
                        key={member.shopperId}
                        as={Link}
                        to={`/loyalty/members/${member.shopperId}`}
                        state={{ name: member.name }}
                        title={member.name || `Customer ${member.shopperId}`}
                        meta={`Updated ${formatDateTime(member.updatedAt)}${member.pending ? ` · ${member.pending} pending` : ''}`}
                        trailing={<span className="row-money">{member.balance} points</span>}
                      />
                    ))}
                  </ListCard>
                  <LoadMore query={members} />
                </>
              ) : <EmptyState title="No points yet">Customers earn points on paid orders. They post when the return window closes.</EmptyState>}
            </Panel>
            <Referrals />
          </>
        )}
      </StoreScreen>
    </>
  );
}
