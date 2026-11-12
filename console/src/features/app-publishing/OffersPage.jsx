import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeedback } from '../../components/feedback.jsx';
import { Banner, Button, LoadMore, PageHeader, Panel, SelectField, Stat, TextAreaField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { fetchAll, usePagedList } from '../../lib/query.js';
import { CAMPAIGN_STATUS, PUSH_LIMITS, newRequestKey, offerProblems } from './rules.js';
import { AreaTabs, Status, StoreScreen, useFields } from './ui.jsx';

function Summary({ summary }) {
  const missing = [['android', 'Android'], ['ios', 'iPhone and iPad']].filter(([key]) => !summary.credentials[key]);
  return (
    <Panel title="Who can get an offer">
      <div className="store-stats">
        <Stat value={String(summary.optedIn.offers)} label="Turned Offers on" />
        <Stat value={String(summary.reachableNow)} label="Can get one now" />
      </div>
      <p className="myapp-meta" data-testid="weekly-cap">
        Each shopper gets at most {summary.weeklyCap} {summary.weeklyCap === 1 ? 'offer' : 'offers'} a week (Monday to Sunday). Shoppers over the limit are skipped, not queued.
      </p>
      {summary.reachableNow === 0 && <Banner tone="warn">Nobody can get an offer right now. An offer would be kept as not sent.</Banner>}
      {missing.length > 0 && (
        <Banner tone="warn">
          Push keys are not set for {missing.map(([, label]) => label).join(' and ')}, so those shoppers cannot be reached. <Link to="/my-app/push-keys">Set push keys</Link>
        </Banner>
      )}
    </Panel>
  );
}

function Composer({ capacity }) {
  const { toast, confirm } = useFeedback();
  const queries = useQueryClient();
  const fields = useFields({ title: '', body: '', linkPath: '/', couponId: '' });
  const [key, setKey] = useState(() => newRequestKey());
  const [capped, setCapped] = useState('');
  const coupons = useQuery({ queryKey: ['coupons', 'all', 'active'], queryFn: () => fetchAll(api.coupons.list, { show: 'active' }), retry: false });
  const { values } = fields;
  const problems = offerProblems(values);
  const shown = (name) => fields.server[name] || (fields.touched[name] ? problems[name] : '');

  async function send(event) {
    event.preventDefault();
    fields.touchAll(['title', 'body', 'linkPath']);
    setCapped('');
    const first = problems.title || problems.body || problems.linkPath;
    if (first) {
      fields.setMessage(`Please check: ${first}`);
      return;
    }
    const ok = await confirm({
      title: 'Send this offer?',
      text: `It goes to about ${capacity} ${capacity === 1 ? 'shopper' : 'shoppers'} who turned Offers on. You cannot take it back.`,
      confirm: 'Send offer', cancel: 'Not yet', tone: 'primary',
    });
    if (!ok) return;
    const done = await fields.run(async () => {
      try {
        const campaign = await api.pushCampaigns.send({
          title: values.title.trim(), body: values.body.trim(), linkPath: values.linkPath.trim() || '/', requestKey: key, ...(values.couponId ? { couponId: Number(values.couponId) } : {}),
        });
        if (campaign.status === 'blocked') setCapped(campaign.blockReason || 'No shopper could get this offer.');
      } catch (error) {
        if (error.status === 409) {
          setCapped(error.message);
          await Promise.all([queries.invalidateQueries({ queryKey: ['app-publishing'] }), queries.invalidateQueries({ queryKey: ['app-publishing:offers'] })]);
          throw Object.assign(new Error(error.message), { cancelled: true });
        }
        throw error;
      }
    });
    if (done) {
      toast('Your offer is on its way.');
      fields.reset({ title: '', body: '', linkPath: '/', couponId: '' });
      setKey(newRequestKey());
      await Promise.all([queries.invalidateQueries({ queryKey: ['app-publishing'] }), queries.invalidateQueries({ queryKey: ['app-publishing:offers'] })]);
    }
  }

  const counter = (value, max) => {
    const length = [...value.trim()].length;
    return <span className="myapp-counter" data-over={length > max}>{length} of {max} characters</span>;
  };

  return (
    <form className="myapp-form" onSubmit={send} noValidate aria-label="New offer">
      <Panel title="New offer">
        <div className="myapp-form">
          <TextField label="Title" value={values.title} hint={counter(values.title, PUSH_LIMITS.titleMax)} error={shown('title')} autoComplete="off" onChange={(event) => fields.set('title', event.target.value)} />
          <TextAreaField label="Message" rows={3} value={values.body} hint={counter(values.body, PUSH_LIMITS.bodyMax)} error={shown('body')} onChange={(event) => fields.set('body', event.target.value)} />
          <TextField label="Opens this page" value={values.linkPath} hint="A page of your store, like /c/sale or /shop." error={shown('linkPath')} autoComplete="off" autoCapitalize="none" spellCheck={false} onChange={(event) => fields.set('linkPath', event.target.value)} />
          {coupons.data?.length > 0 && (
            <SelectField label="Coupon to go with it (optional)" value={values.couponId} onChange={(event) => fields.set('couponId', event.target.value)}>
              <option value="">No coupon</option>
              {coupons.data.map((coupon) => <option key={coupon.id} value={coupon.id}>{coupon.code}</option>)}
            </SelectField>
          )}
        </div>
        <p className="field-hint">Offers cannot hold phone numbers, emails, addresses or payment details. Shoppers can turn offers off in the app.</p>
      </Panel>
      {capped && <Banner tone="warn">{capped}. The offer is kept in your list below as not sent.</Banner>}
      {fields.message && <Banner tone="bad">{fields.message}</Banner>}
      <div className="myapp-actions"><Button type="submit" loading={fields.busy}>Send offer</Button></div>
    </form>
  );
}

function History() {
  const list = usePagedList('app-publishing:offers', api.pushCampaigns.list, {}, {
    refetchInterval: (query) => (query.state.data?.pages.some((page) => page.items.some((c) => c.status === 'queued' || c.status === 'sending')) ? 5000 : false),
  });
  return (
    <Panel title="Offers you sent">
      <StoreScreen query={list} label="Loading your offers" errorTitle="We couldn’t load your offers">
        {() => (list.items.length ? (
          <div role="list" aria-label="Offers sent">
            {list.items.map((campaign) => (
              <div key={campaign.id} className="myapp-row" role="listitem">
                <div className="myapp-row-head"><strong>{campaign.title}</strong><Status table={CAMPAIGN_STATUS} value={campaign.status} /></div>
                <p>{campaign.body}</p>
                <span className="myapp-meta">
                  {formatDateTime(campaign.sentAt ?? campaign.createdAt)} · {campaign.sentCount} sent of {campaign.audienceCount}
                  {campaign.cappedCount ? ` · ${campaign.cappedCount} over the weekly limit` : ''}{campaign.failedCount ? ` · ${campaign.failedCount} failed` : ''}
                </span>
                {campaign.blockReason && <span className="myapp-meta">Why it was not sent: {campaign.blockReason}</span>}
              </div>
            ))}
            <LoadMore query={list} />
          </div>
        ) : <p className="field-hint">You have not sent an offer yet.</p>)}
      </StoreScreen>
    </Panel>
  );
}

export default function OffersPage() {
  const summary = useQuery({ queryKey: ['app-publishing', 'push-summary'], queryFn: () => api.pushCampaigns.summary() });
  return (
    <>
      <PageHeader title="Offers" />
      <AreaTabs current="/my-app/offers" />
      <StoreScreen query={summary} label="Loading your offers" errorTitle="We couldn’t load your offers">
        {(data) => (
          <div className="myapp-stack">
            <Summary summary={data} />
            <Composer capacity={data.reachableNow} />
            <History />
          </div>
        )}
      </StoreScreen>
    </>
  );
}
