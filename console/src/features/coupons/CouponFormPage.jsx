import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Banner, Button, EmptyState, FieldGroup, PageHeader, Panel, SearchField, SelectField, Stat, TextField, Toggle } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatPaise } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { fetchAll, useRefresh } from '../../lib/query.js';
import { COUPON_KINDS, COUPON_SCOPES } from '../orders/shared/contract.js';
import { COUPON_KIND_LABELS, COUPON_SCOPE_LABELS } from '../orders/shared/labels.js';
import { NumberField, RupeeField, StoreScreen } from '../orders/shared/ui.jsx';
import { COUPON_FIELDS, EMPTY_COUPON, couponToForm, formToCoupon } from './form.js';

/** A searchable checklist of products or categories. */
function Picker({ legend, query, picked, onChange, error }) {
  const [text, setText] = useState('');
  return (
    <StoreScreen query={query} label={`Loading your ${legend.toLowerCase()}`} errorTitle={`We couldn’t load your ${legend.toLowerCase()}`}>
      {(list) => {
        if (!list.length) return <EmptyState title={`No ${legend.toLowerCase()} yet`}>Add some first, or use the whole order.</EmptyState>;
        const needle = text.trim().toLowerCase();
        const shown = list.filter((item) => item.name.toLowerCase().includes(needle));
        return (
          <fieldset className="store-checks">
            <legend>{legend} ({picked.length} picked)</legend>
            <SearchField label={`Search ${legend.toLowerCase()}`} value={text} onChange={(event) => setText(event.target.value)} />
            <div className="store-pick-list">
              {shown.map((item) => (
                <label key={item.id} className="store-check">
                  <input type="checkbox" checked={picked.includes(item.id)} onChange={(event) => onChange(event.target.checked ? [...picked, item.id] : picked.filter((id) => id !== item.id))} />
                  {item.name}
                </label>
              ))}
              {!shown.length && <p className="muted">Nothing matches.</p>}
            </div>
            {error && <span className="field-error" role="alert">{error}</span>}
          </fieldset>
        );
      }}
    </StoreScreen>
  );
}

function Stats({ coupon }) {
  const stats = useQuery({ queryKey: ['coupons', String(coupon.id), 'stats'], queryFn: () => api.coupons.stats(coupon.id) });
  return (
    <Panel title="How it did">
      <StoreScreen query={stats} label="Loading how it did" errorTitle="We couldn’t load how it did">
        {(data) => (data.orders ? (
          <div className="store-stats">
            <Stat value={String(data.orders)} label="Orders" />
            <Stat value={formatPaise(data.revenuePaise)} label="Sales" />
            <Stat value={formatPaise(data.discountPaise)} label="Given off" />
          </div>
        ) : <EmptyState title="Not used yet">Orders with this code show here.</EmptyState>)}
      </StoreScreen>
    </Panel>
  );
}

function CouponForm({ coupon }) {
  const navigate = useNavigate();
  const { toast, confirm } = useFeedback();
  const refresh = useRefresh();
  const form = useForm(coupon ? couponToForm(coupon) : { ...EMPTY_COUPON }, { rename: COUPON_FIELDS });
  const locked = Boolean(coupon && coupon.usedCount > 0);
  const { kind, scope } = form.values;
  const products = useQuery({ queryKey: ['products', 'all'], queryFn: () => fetchAll(api.products.list), enabled: scope === 'products' });
  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list), enabled: scope === 'categories' });
  const pages = useQuery({ queryKey: ['pages', 'all'], queryFn: () => fetchAll(api.pages.list) });
  const [removing, setRemoving] = useState(false);
  const [problem, setProblem] = useState('');

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToCoupon(form.values, { locked });
    if (errors) return form.reject(errors);
    let saved = null;
    const done = await form.run(async () => {
      saved = coupon ? await api.coupons.update(coupon.id, body) : await api.coupons.create(body);
    });
    if (done) {
      toast(coupon ? 'Coupon saved.' : 'Coupon made.');
      await refresh();
      if (!coupon) navigate(`/coupons/${saved.id}`, { replace: true });
    }
    return undefined;
  }

  async function remove() {
    const yes = await confirm({ title: `Delete ${coupon.code}?`, text: 'Shoppers can’t use it any more. Orders that used it keep their discount.', confirm: 'Delete coupon', cancel: 'Keep it' });
    if (!yes) return;
    setRemoving(true);
    setProblem('');
    try {
      await api.coupons.remove(coupon.id);
      toast('Coupon deleted.');
      await refresh({ leaving: true });
      navigate('/coupons');
    } catch (error) {
      setProblem(error.message);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <form className="stack" onSubmit={save} noValidate aria-label={coupon ? `Coupon ${coupon.code}` : 'New coupon'}>
      <Panel title="The code">
        <FieldGroup>
          <TextField label="Code" hint={locked ? 'It has been used, so the code and kind stay as they are.' : 'Shoppers type it at checkout, in capitals or not.'} maxLength={40} autoCapitalize="characters" disabled={locked} {...form.field('code')} />
        </FieldGroup>
        <fieldset className="store-choice" disabled={locked}>
          <legend>What it gives</legend>
          {COUPON_KINDS.map((value) => (
            <label key={value} className="store-option">
              <input type="radio" name="kind" value={value} checked={kind === value} onChange={() => form.set('kind', value)} />
              <span className="store-option-text"><span className="store-option-title">{COUPON_KIND_LABELS[value]}</span></span>
            </label>
          ))}
        </fieldset>
        <FieldGroup>
          {kind === 'percent' && (
            <>
              <TextField label="Percentage off (%)" inputMode="decimal" {...form.field('percent')} />
              <RupeeField label="Most it takes off" hint="Leave empty for no cap." {...form.field('cap')} />
            </>
          )}
          {kind === 'flat' && <RupeeField label="Amount off" {...form.field('amount')} />}
          <RupeeField label="Smallest order" hint="Leave empty for any order." {...form.field('minOrder')} />
        </FieldGroup>
      </Panel>
      <Panel title="Limits">
        <FieldGroup>
          <div className="store-grid-2">
            <TextField label="Starts" type="datetime-local" {...form.field('startsAt')} />
            <TextField label="Ends" type="datetime-local" {...form.field('endsAt')} />
          </div>
          <NumberField label="Uses in all" hint="Leave empty for no limit." {...form.field('maxUses')} />
          <NumberField label="Uses per customer" hint="Leave empty for no limit." {...form.field('maxUsesPerCustomer')} />
        </FieldGroup>
        <Toggle label="First order only" {...form.toggle('firstOrderOnly')} />
        <fieldset className="store-choice">
          <legend>Applies to</legend>
          {COUPON_SCOPES.map((value) => (
            <label key={value} className="store-option">
              <input type="radio" name="scope" value={value} checked={scope === value} onChange={() => { form.set('scope', value); form.set('scopeIds', []); }} />
              <span className="store-option-text"><span className="store-option-title">{COUPON_SCOPE_LABELS[value]}</span></span>
            </label>
          ))}
        </fieldset>
        {scope === 'products' && <Picker legend="Products" query={products} picked={form.values.scopeIds} error={form.errors.scopeIds} onChange={(ids) => form.set('scopeIds', ids)} />}
        {scope === 'categories' && <Picker legend="Categories" query={categories} picked={form.values.scopeIds} error={form.errors.scopeIds} onChange={(ids) => form.set('scopeIds', ids)} />}
      </Panel>
      <Panel title="Made for">
        <StoreScreen query={pages} label="Loading your landing pages" errorTitle="We couldn’t load your landing pages">
          {(list) => (
            <SelectField label="Reel or post" hint="Its sales then show against that reel in Insights." {...form.field('pageId')}>
              <option value="">None</option>
              {list.map((page) => <option key={page.id} value={page.id}>{page.headline || page.slug}</option>)}
            </SelectField>
          )}
        </StoreScreen>
        <Toggle label="Shoppers can use it" {...form.toggle('active')} />
      </Panel>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      {problem && <Banner tone="bad">{problem}</Banner>}
      <div className="form-actions">
        <Button type="submit" size="large" block loading={form.busy}>{coupon ? 'Save coupon' : 'Make coupon'}</Button>
        {coupon && <Button variant="danger" block loading={removing} onClick={remove}>Delete coupon</Button>}
      </div>
    </form>
  );
}

export default function CouponFormPage() {
  const { id } = useParams();
  const coupon = useQuery({ queryKey: ['coupons', id], queryFn: () => api.coupons.get(id), enabled: id !== undefined });
  if (id === undefined) {
    return (
      <>
        <BackLink to="/coupons">Coupons</BackLink>
        <PageHeader title="New coupon" />
        <CouponForm />
      </>
    );
  }
  return (
    <StoreScreen query={coupon} detail label="Loading this coupon" errorTitle="We couldn’t load this coupon">
      {(data) => (
        <>
          <BackLink to="/coupons">Coupons</BackLink>
          <PageHeader title={data.code} />
          <Stats coupon={data} />
          <CouponForm key={`${data.id}-${data.usedCount}-${data.active}`} coupon={data} />
        </>
      )}
    </StoreScreen>
  );
}
