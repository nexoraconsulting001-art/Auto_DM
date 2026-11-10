import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { MANAGERS } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Button, FieldGroup, PageHeader, Panel, SelectField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useAllowed } from '../../lib/query.js';
import { EXPLORE_DIMENSION_NAMES, FIGURE_TEXT } from '../insights/shared/catalog.js';
import { FUNNEL_STEP_WORDS, windowWords } from '../insights/shared/figures.js';
import { DownloadButtons } from '../insights/shared/download.jsx';
import { AnalyticsLoadable, LastUpdated, RangeBar, SourceTag, useRange } from '../insights/shared/ui.jsx';
import { breakdownValue, formatCount, formatRate, wordFor } from '../insights/shared/words.js';

const BREAKDOWN_WORDS = Object.freeze({ source: 'Source', device: 'Device', in_app: 'Opened in', city: 'City', state: 'State', visitor_type: 'New or returning', utm_campaign: 'Campaign', landing_page: 'Landing page', weekday: 'Weekday' });
const BREAKDOWN_CHOICES = Object.keys(BREAKDOWN_WORDS).filter((name) => EXPLORE_DIMENSION_NAMES.includes(name));

const stepName = (step) => (step.kind === 'page_view' ? `Page ${step.page ?? ''}` : wordFor(FUNNEL_STEP_WORDS, step.kind));

function Steps({ results }) {
  const comparing = results.steps.some((s) => s.previous !== null);
  return (
    <ol className="an-funnel" aria-label="Steps">
      {results.steps.map((step, index) => (
        <li key={`${step.kind}${index}`} className={`an-step${step.unavailable ? ' an-step-off' : ''}`}>
          <div className="an-step-head">
            <span className="an-step-title">{`${index + 1}. ${stepName(step)}`}</span>
            <span className="an-step-value">{step.unavailable ? step.message ?? FIGURE_TEXT.needsTier3 : formatCount(step.count)}</span>
          </div>
          {!step.unavailable && index > 0 && (
            <span className="an-tile-note">
              {step.stepRate === null ? 'No rate: nobody reached the step before' : `${formatRate(step.stepRate, 0)} of the step before`}
              {step.dropOff !== null && `, ${formatCount(step.dropOff)} dropped off`}
            </span>
          )}
          {comparing && !step.unavailable && <span className="an-tile-note">{step.previous === null ? 'Before: no figure' : `Before: ${formatCount(step.previous)}`}</span>}
        </li>
      ))}
    </ol>
  );
}

function Breakdown({ results, by }) {
  if (!by || !results.breakdown.length) return null;
  return (
    <div className="an-table-wrap">
      <table className="an-table">
        <caption className="sr-only">{`Each step by ${by}`}</caption>
        <thead>
          <tr>
            <th scope="col">{wordFor(BREAKDOWN_WORDS, by)}</th>
            {results.steps.map((step, i) => <th key={i} scope="col">{`Step ${i + 1}`}</th>)}
          </tr>
        </thead>
        <tbody>
          {results.breakdown.map((row) => (
            <tr key={row.key}>
              <th scope="row">{breakdownValue(by, row.key)}</th>
              {row.counts.map((count, i) => <td key={i}>{results.steps[i]?.unavailable ? '–' : formatCount(count)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** One funnel's count, step rate and drop-off (7.12). A step the plan doesn't include says "Needs tier 3" and counts nothing (N-58). */
export default function FunnelResultsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const allowed = useAllowed();
  const queries = useQueryClient();
  const { confirm, toast } = useFeedback();
  const [params, setParams] = useSearchParams();
  const [range, setRange, asked] = useRange('28');
  const by = BREAKDOWN_CHOICES.includes(params.get('by')) ? params.get('by') : '';
  const compare = params.get('compare') === 'previous' ? 'previous' : 'none';
  const funnel = useQuery({ queryKey: ['funnel', id, 'definition'], queryFn: () => api.funnels.get(id) });
  const resultsQuery = { ...range, compare, ...(by ? { breakdown: by } : {}) };
  const results = useQuery({ queryKey: ['funnel', id, 'results', resultsQuery], queryFn: () => api.funnels.results(id, resultsQuery), enabled: funnel.isSuccess, placeholderData: keepPreviousData });
  const remove = useMutation({
    mutationFn: () => api.funnels.remove(id),
    onSuccess: async () => {
      toast('Funnel deleted.');
      await queries.invalidateQueries({ queryKey: ['custom-funnels'], refetchType: 'none' });
      navigate('/funnels');
    },
    onError: (error) => toast(error.message),
  });
  const setParam = (name, value) => setParams((current) => {
    const next = new URLSearchParams(current);
    if (value) next.set(name, value);
    else next.delete(name);
    return next;
  }, { replace: true });

  async function askToRemove() {
    if (await confirm({ title: 'Delete this funnel?', text: 'Its results go with it. This can’t be undone.', confirm: 'Delete funnel' })) remove.mutate();
  }

  return (
    <>
      <BackLink to="/funnels">Funnels</BackLink>
      <AnalyticsLoadable query={funnel} detail label="Loading this funnel" errorTitle="We couldn’t load this funnel">
        {(definition) => (
          <>
            <PageHeader eyebrow="Funnel" title={definition.name} actions={allowed(MANAGERS) ? <Button as={Link} variant="soft" to={`/funnels/${definition.id}/edit`}>Change</Button> : null} />
            <p className="muted">{`Counted per ${definition.countBy}, with every step within ${windowWords(definition.windowMinutes)}.`}</p>
            <RangeBar query={range} onChange={setRange} asked={asked} />
            <FieldGroup>
              <SelectField label="Break down by" value={by} onChange={(event) => setParam('by', event.target.value)}>
                <option value="">Nothing</option>
                {BREAKDOWN_CHOICES.map((name) => <option key={name} value={name}>{BREAKDOWN_WORDS[name]}</option>)}
              </SelectField>
            </FieldGroup>
            <Toggle label="Compare with the period before" checked={compare === 'previous'} onChange={(event) => setParam('compare', event.target.checked ? 'previous' : '')} />
            <Panel title="Results" action={results.data ? <SourceTag source={results.data.source} /> : null}>
              <AnalyticsLoadable query={results} label="Counting each step" errorTitle="We couldn’t count this funnel">
                {(data) => (
                  <>
                    <Badge>{data.countBy === 'visitor' ? 'Per shopper' : 'Per visit'}</Badge>
                    <Steps results={data} />
                    <Breakdown results={data} by={by} />
                    <LastUpdated at={data.lastUpdatedAt} prefix="Worked out" />
                  </>
                )}
              </AnalyticsLoadable>
            </Panel>
            <Panel title="Download">
              <DownloadButtons label="Download this funnel" request={() => ({ source: 'funnel', funnelId: definition.id })} />
            </Panel>
            {allowed(MANAGERS) && <Button variant="danger" loading={remove.isPending} onClick={askToRemove}>Delete funnel</Button>}
          </>
        )}
      </AnalyticsLoadable>
    </>
  );
}
