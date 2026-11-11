import { useQuery } from '@tanstack/react-query';
import { Banner, Button, EmptyState, Panel, TextAreaField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { useRefresh } from '../../lib/query.js';
import { useFeedback } from '../../components/feedback.jsx';
import { timelineStep } from './shared/rules.js';
import { StoreScreen, Timeline } from './shared/ui.jsx';

function AddNote({ orderId }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const form = useForm({ note: '' });

  async function add(event) {
    event.preventDefault();
    if (!form.values.note.trim()) return form.reject({ note: 'Write a note first' });
    const done = await form.run(() => api.orders.addNote(orderId, { note: form.values.note.trim() }));
    if (done) {
      form.set('note', '');
      toast('Note added.');
      await refresh();
    }
    return undefined;
  }

  return (
    <form className="stack" onSubmit={add} noValidate>
      <TextAreaField label="Add a note to the timeline" hint="Your team sees it. The customer doesn’t." maxLength={1000} {...form.field('note')} />
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <Button type="submit" variant="soft" loading={form.busy}>Add note</Button>
    </form>
  );
}

/** Who changed what and when (9.9). The app reads the same rows, so both show the same thing (S-32). */
export function OrderTimeline({ orderId }) {
  const timeline = useQuery({ queryKey: ['orders', String(orderId), 'timeline'], queryFn: () => api.orders.timeline(orderId) });
  return (
    <Panel title="Timeline">
      <StoreScreen query={timeline} label="Loading the timeline" errorTitle="We couldn’t load the timeline">
        {({ items }) => (items.length
          ? <Timeline label="What happened to this order" items={items.map(timelineStep)} />
          : <EmptyState title="Nothing yet">Each change to this order will be listed here.</EmptyState>)}
      </StoreScreen>
      <AddNote orderId={orderId} />
    </Panel>
  );
}
