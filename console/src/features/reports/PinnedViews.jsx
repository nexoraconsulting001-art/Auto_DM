import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { staffWith } from '@contracts/access.js';
import { Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useAllowed } from '../../lib/query.js';
import { exploreCell } from '../insights/shared/figures.js';
import { LastUpdated } from '../insights/shared/ui.jsx';
import { breakdownValue, sourceLabel } from '../insights/shared/words.js';

const ROWS = 5;

function Card({ card }) {
  const { view, result } = card;
  const dims = Array.isArray(view.definition.dimensions) ? view.definition.dimensions.filter((d) => typeof d === 'string') : [];
  const first = dims[0];
  return (
    <Panel title={view.name} action={<Link className="panel-link" to={`/explore?view=${view.id}`}>Open</Link>}>
      <div className="an-table-wrap">
        <table className="an-table">
          <caption className="sr-only">{view.name}</caption>
          <thead>
            <tr>
              <th scope="col">{first ? <span className="sr-only">Breakdown</span> : 'Figure'}</th>
              {result.columns.map((c) => <th key={c.metric} scope="col">{c.label}<span className="an-col-source">{sourceLabel(c.source)}</span></th>)}
            </tr>
          </thead>
          <tbody>
            {first && result.rows.slice(0, ROWS).map((row, index) => (
              <tr key={index}>
                <th scope="row">{breakdownValue(first, row.dimensions[first])}</th>
                {result.columns.map((c) => <td key={c.metric}>{exploreCell(c.metric, row.metrics[c.metric]).value}</td>)}
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              {result.columns.map((c) => <td key={c.metric}>{exploreCell(c.metric, result.totals[c.metric]).value}</td>)}
            </tr>
          </tfoot>
        </table>
      </div>
      <LastUpdated at={result.lastUpdatedAt} prefix="Worked out" />
    </Panel>
  );
}

/** Saved views pinned to the dashboard (7.11, N-54), each worked out fresh from the cache. Quiet when there are none or they can't load. */
function Pinned() {
  const cards = useQuery({ queryKey: ['dashboard', 'cards'], queryFn: () => api.dashboard.cards(), retry: false });
  if (!cards.data?.items.length) return null;
  return (
    <section className="stack" aria-labelledby="pinned-title">
      <div className="panel-head">
        <h2 id="pinned-title">Pinned views</h2>
        <Link className="panel-link" to="/explore">Explore</Link>
      </div>
      <div className="an-cards">{cards.data.items.map((card) => <Card key={card.view.id} card={card} />)}</div>
    </section>
  );
}

export default function PinnedViews() {
  const allowed = useAllowed();
  return allowed(staffWith('analytics')) ? <Pinned /> : null;
}
