import { Link } from 'react-router-dom';
import { Plus } from 'lucide-react';
import { MANAGERS } from '@contracts/access.js';
import { Button, EmptyState, LoadMore, PageHeader, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useAllowed, usePagedList } from '../../lib/query.js';
import { FUNNEL_STEP_WORDS, windowWords } from '../insights/shared/figures.js';
import { AnalyticsLoadable, TrafficTabs } from '../insights/shared/ui.jsx';
import { wordFor } from '../insights/shared/words.js';

/** Funnels the owner or a manager built (7.12), next to the default one every post already has. */
export default function FunnelListPage() {
  const allowed = useAllowed();
  const funnels = usePagedList('custom-funnels', api.funnels.list);
  const canEdit = allowed(MANAGERS);
  return (
    <>
      <PageHeader eyebrow="Traffic" title="Funnels" actions={canEdit ? <Button as={Link} to="/funnels/new"><Plus size={16} aria-hidden="true" />New funnel</Button> : null} />
      <TrafficTabs />
      <p className="lead">Build your own path of 2 to 8 steps on your store pages, and see where shoppers drop off. Each post’s comment-to-sale funnel is under <Link to="/analytics/funnels">Insights</Link>.</p>
      <Panel title="Your funnels">
        <AnalyticsLoadable query={funnels} label="Loading your funnels" errorTitle="We couldn’t load your funnels">
          {() => (funnels.items.length ? (
            <>
              <div className="an-rows">
                {funnels.items.map((funnel) => (
                  <Link key={funnel.id} className="an-row" to={`/funnels/${funnel.id}`}>
                    <span className="an-row-main">
                      <span className="an-row-title">{funnel.name}</span>
                      <span className="an-row-meta">{funnel.steps.map((s) => (s.kind === 'page_view' ? `Page ${s.page}` : wordFor(FUNNEL_STEP_WORDS, s.kind))).join(' → ')}</span>
                      <span className="an-row-meta">{`Counted per ${funnel.countBy}, within ${windowWords(funnel.windowMinutes)}. Changed ${formatDateTime(funnel.updatedAt)}.`}</span>
                    </span>
                  </Link>
                ))}
              </div>
              <LoadMore query={funnels} />
            </>
          ) : (
            <EmptyState title="No funnels yet" action={canEdit ? <Button as={Link} to="/funnels/new">Build a funnel</Button> : null}>
              {canEdit ? 'For example: landing page view, product tap, add to cart, payment success.' : 'The owner or a manager can build funnels here.'}
            </EmptyState>
          ))}
        </AnalyticsLoadable>
      </Panel>
    </>
  );
}
