import { useQuery } from '@tanstack/react-query';
import { Banner, PageHeader, Panel, Stat } from '../../design/index.jsx';
import { CopyButton } from '../../components/copy.jsx';
import { api } from '../../lib/api/index.js';
import { formatPaise } from '../../lib/format.js';
import { Screen } from '../catalog/shared/ui.jsx';
import '../billing/billing.css';

const STATE_WORDS = { pending: 'Waiting', credited: 'Credited', blocked: 'Not counted' };

export default function ReferralsPage() {
  const referrals = useQuery({ queryKey: ['referrals'], queryFn: () => api.referrals.get() });
  return (
    <div className="p7-stack">
      <PageHeader eyebrow="Grow" title="Refer a seller" />
      <Screen query={referrals} label="Loading your referral link" errorTitle="We couldn’t load your referral link">
        {(data) => (
          <>
            <Panel title="Your link">
              <p className="p7-meta">Share this link with another seller. When they sign up and pay, you earn {formatPaise(data.rewardPaise)} in credit.</p>
              <p className="p7-code" data-testid="referral-link">{data.link}</p>
              <div className="p7-row"><CopyButton text={data.link} label="Copy link" /><span className="p7-meta">Code {data.code}</span></div>
              <p className="p7-meta">Share it in a message or your bio. It is never put inside a DM to your buyers.</p>
            </Panel>
            <Panel title="How it is going">
              <div className="p7-row">
                {Object.entries(data.counts).map(([state, count]) => <Stat key={state} value={count} label={STATE_WORDS[state] ?? state} />)}
                <Stat value={formatPaise(data.creditedPaise)} label="Credited so far" />
              </div>
              {Object.values(data.counts).every((count) => count === 0) && <Banner tone="info">Nobody has used your link yet.</Banner>}
            </Panel>
          </>
        )}
      </Screen>
    </div>
  );
}
