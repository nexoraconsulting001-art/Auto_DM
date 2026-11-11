import { useRef, useState } from 'react';
import { staffWith } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Banner, Button, Chip, ChipRow, EmptyState, FieldGroup, LoadMore, PageHeader, Panel, Sheet, TextAreaField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useForm } from '../../lib/forms.js';
import { useAllowed, useFilters, usePagedList, useRefresh } from '../../lib/query.js';
import { REVIEW_AREA } from '../orders/shared/areas.js';
import { REVIEW_STATUSES } from '../orders/shared/contract.js';
import { REVIEW } from '../orders/shared/labels.js';
import { reviewMoves } from '../orders/shared/rules.js';
import { Stars, StatusBadge, StoreScreen, StoreTabs, useAction } from '../orders/shared/ui.jsx';

function ReplySheet({ sheet, review, onClose }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ reply: review?.reply ?? '' });

  async function submit(event) {
    event.preventDefault();
    if (!form.values.reply.trim()) return form.reject({ reply: 'Write a reply first' });
    const done = await form.run(() => api.reviews.reply(review.id, { reply: form.values.reply.trim() }));
    if (done) {
      toast('Reply posted.');
      await refresh();
      onClose();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={submit} noValidate>
      <p className="sheet-text">Shoppers see it under the review, in your store’s name. One reply per review: saving again replaces it.</p>
      <FieldGroup><TextAreaField label="Your reply" rows={4} maxLength={1000} {...form.field('reply')} /></FieldGroup>
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <div className="sheet-actions">
        <Button variant="outline" onClick={() => sheet.current?.close()}>Cancel</Button>
        <Button type="submit" loading={form.busy}>Post reply</Button>
      </div>
    </form>
  );
}

function ReviewCard({ review, action, onReply }) {
  const moves = reviewMoves(review);
  return (
    <Panel aria-label={`Review of ${review.productName} by ${review.displayName}`}>
      <div className="order-line-head">
        <span className="order-line-title">{review.productName}</span>
        <StatusBadge table={REVIEW} status={review.status} />
      </div>
      <Stars rating={review.rating} />
      {review.body ? <p className="review-body">{review.body}</p> : <p className="muted">No words, just stars.</p>}
      {review.photos.length > 0 && (
        <ul className="store-photos" aria-label="Photos from the shopper">
          {review.photos.map((src, index) => <li key={src}><a href={src} target="_blank" rel="noopener"><img src={src} alt={`Photo ${index + 1} of ${review.productName}`} loading="lazy" /></a></li>)}
        </ul>
      )}
      <p className="field-hint">{review.displayName} · {formatDateTime(review.createdAt)}</p>
      {review.reply && <p className="review-reply"><strong>Your reply:</strong> {review.reply}</p>}
      <div className="row-actions">
        {moves.approve && <Button variant="soft" loading={action.busy === `approve-${review.id}`} onClick={() => action.run(`approve-${review.id}`, () => api.reviews.approve(review.id), 'Review approved. It shows on the product page.')}>Approve</Button>}
        {moves.hide && <Button variant="outline" loading={action.busy === `hide-${review.id}`} onClick={() => action.run(`hide-${review.id}`, () => api.reviews.hide(review.id), 'Review hidden. It no longer counts in the average.')}>Hide</Button>}
        <Button variant="outline" onClick={() => onReply(review)}>{review.reply ? 'Change reply' : 'Reply'}</Button>
      </div>
    </Panel>
  );
}

export default function ReviewsPage() {
  const allowed = useAllowed();
  const [params, setFilter] = useFilters();
  const status = REVIEW_STATUSES.includes(params.get('status')) ? params.get('status') : 'all';
  const productId = /^\d+$/.test(params.get('productId') ?? '') ? params.get('productId') : '';
  const reviews = usePagedList('reviews', api.reviews.list, { status, productId: productId || undefined });
  const action = useAction();
  const sheet = useRef(null);
  const [replying, setReplying] = useState(null);

  function reply(review) {
    setReplying(review);
    sheet.current?.showModal();
  }
  const close = () => {
    sheet.current?.close();
    setReplying(null);
  };

  return (
    <>
      <PageHeader title="Reviews" />
      {allowed(staffWith('analytics')) && <StoreTabs label="Reviews area" tabs={REVIEW_AREA} current="/reviews" />}
      <p className="lead">New reviews wait for you. Only approved ones show in your store and count in its average.</p>
      <ChipRow label="Filter reviews">
        <Chip pressed={status === 'all'} onClick={() => setFilter('status', '')}>All</Chip>
        {REVIEW_STATUSES.map((key) => <Chip key={key} pressed={status === key} onClick={() => setFilter('status', key)}>{REVIEW[key].label}</Chip>)}
      </ChipRow>
      {productId && <Button variant="outline" onClick={() => setFilter('productId', '')}>Show every product</Button>}
      {action.problem && <Banner tone="bad">{action.problem}</Banner>}
      <StoreScreen query={reviews} label="Loading your reviews" errorTitle="We couldn’t load your reviews">
        {() => (reviews.items.length ? (
          <>
            <div className="stack">
              {reviews.items.map((review) => <ReviewCard key={review.id} review={review} action={action} onReply={reply} />)}
            </div>
            <LoadMore query={reviews} />
          </>
        ) : (
          <EmptyState title={status !== 'all' || productId ? 'No reviews match' : 'No reviews yet'}>
            {status === 'pending' ? 'Nothing is waiting for you.' : 'Customers can review a product once it is delivered to them.'}
          </EmptyState>
        ))}
      </StoreScreen>
      <Sheet ref={sheet} title={replying ? `Reply to ${replying.displayName}` : 'Reply'} onClose={() => setReplying(null)}>
        {replying && <ReplySheet key={replying.id} sheet={sheet} review={replying} onClose={close} />}
      </Sheet>
    </>
  );
}
