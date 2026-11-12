import { useParams, Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, NotFoundState, PageHeader, Panel, TextAreaField, TextField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import {
  LISTING_LIMITS, LISTING_LONG, PLATFORMS, PLATFORM_LABELS, STORE_LABELS, formToListing, isPlatform, listingField, listingFieldNames, listingToForm,
} from './rules.js';
import { AreaTabs, Note, StoreScreen, UpgradePrompt, useAppConfig, useFields } from './ui.jsx';

function Counter({ info }) {
  return (
    <span className="myapp-counter" data-over={info.over} aria-live="polite">
      {info.over ? `${-info.left} over the limit` : `${info.length} of ${info.limit} characters`}
    </span>
  );
}

function ListingForm({ platform, listing }) {
  const { toast } = useFeedback();
  const queries = useQueryClient();
  const limits = { ...LISTING_LIMITS[platform], ...(listing.limits ?? {}) };
  const names = listingFieldNames(platform);
  const fields = useFields(listingToForm(platform, listing));

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToListing(platform, fields.values, limits);
    fields.touchAll(names);
    if (!body) {
      fields.setMessage(`Please check: ${Object.values(errors)[0]}`);
      return;
    }
    const done = await fields.run(async () => {
      const saved = await api.appListing.save(platform, body);
      queries.setQueryData(['app-publishing', 'listing', platform], saved);
      fields.reset(listingToForm(platform, saved));
    });
    if (done) toast(`Your ${STORE_LABELS[platform].replace(/^the /, '')} listing is saved.`);
  }

  return (
    <form className="myapp-form" onSubmit={save} noValidate aria-label={`${STORE_LABELS[platform]} listing`}>
      <Panel title={`What shoppers read in ${STORE_LABELS[platform].replace(/^the /, '')}`}>
        <div className="myapp-form">
          {names.map((name) => {
            const info = listingField(platform, name, fields.values[name], limits);
            const shown = fields.server[name] || (fields.touched[name] || info.over ? info.problem : '');
            const common = {
              label: info.label, name, value: fields.values[name], error: shown, hint: <Counter info={info} />, onChange: (event) => fields.set(name, event.target.value), autoComplete: 'off',
            };
            return LISTING_LONG.includes(name)
              ? <TextAreaField key={name} {...common} rows={name === 'fullDescription' ? 8 : 4} />
              : <TextField key={name} {...common} />;
          })}
        </div>
      </Panel>
      <p className="field-hint">Write about your own business. Do not use the platform’s name in the listing.</p>
      {fields.message && <Banner tone="bad">{fields.message}</Banner>}
      <div className="myapp-actions"><Button type="submit" loading={fields.busy}>Save listing</Button></div>
    </form>
  );
}

function Assets({ platform }) {
  const assets = useQuery({ queryKey: ['app-publishing', 'listing', platform, 'assets'], queryFn: () => api.appListing.assets(platform) });
  return (
    <Panel title="Pictures">
      <StoreScreen query={assets} label="Loading your store pictures" errorTitle="We couldn’t load your store pictures">
        {(data) => (data.items.length ? (
          <div className="myapp-shots" role="list" aria-label="Store pictures">
            {data.items.map((asset) => (
              <figure key={`${asset.kind}-${asset.device}-${asset.position}`} className="myapp-shot" role="listitem">
                {asset.url && <img src={asset.url} alt="" loading="lazy" width={asset.width || undefined} height={asset.height || undefined} />}
                <figcaption>
                  {asset.kind.replace(/_/g, ' ')}{asset.device ? `, ${asset.device.replace(/_/g, ' ')}` : ''} · {asset.width}×{asset.height}
                  {' '}<Badge tone={asset.specOk ? 'good' : 'bad'}>{asset.specOk ? 'Right size' : 'Fix needed'}</Badge>
                  {asset.problems.map((problem) => <span key={problem.code} className="field-error"> {problem.message}</span>)}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : <p className="field-hint">No pictures yet. We make them from your app when it builds.</p>)}
      </StoreScreen>
    </Panel>
  );
}

export default function ListingPage() {
  const { platform } = useParams();
  const config = useAppConfig();
  const valid = isPlatform(platform);
  const entitled = valid && config.data?.[platform]?.entitled;
  const listing = useQuery({ queryKey: ['app-publishing', 'listing', platform], queryFn: () => api.appListing.get(platform), enabled: Boolean(entitled) });

  return (
    <>
      <PageHeader title="Store listing" />
      <AreaTabs current="/my-app/listing" />
      {!valid ? <NotFoundState /> : (
        <>
          <nav className="chip-row store-tabs" aria-label="Store">
            {PLATFORMS.map((p) => <Link key={p} className="chip" to={`/my-app/listing/${p}`} aria-current={p === platform ? 'page' : undefined}>{PLATFORM_LABELS[p]}</Link>)}
          </nav>
          <StoreScreen query={config} label="Loading your plan" errorTitle="We couldn’t load your app">
            {() => (entitled ? (
              <div className="myapp-stack">
                <StoreScreen query={listing} label="Loading your listing" errorTitle="We couldn’t load your listing">
                  {(data) => (
                    <>
                      <ListingForm key={platform} platform={platform} listing={data} />
                      {data.validation && !data.validation.ok && (
                        <Note tone="warn">{data.validation.problems.map((p) => p.message).join(' ')}</Note>
                      )}
                    </>
                  )}
                </StoreScreen>
                <Assets platform={platform} />
              </div>
            ) : <UpgradePrompt platform={platform} what="a store listing" />)}
          </StoreScreen>
        </>
      )}
    </>
  );
}
