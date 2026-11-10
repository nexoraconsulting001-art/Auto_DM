import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { useFeedback } from '../../components/feedback.jsx';
import { BackLink, Badge, Banner, Button, FieldGroup, Loadable, PageHeader, TextAreaField } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import { useRefresh } from '../../lib/query.js';
import { describeReason } from '../compliance/reasons.js';
import { AUTHOR_LABEL, MESSAGE_KIND, SENT_OUTCOMES, THREAD_STATUS, handle, pauseLine } from './views.js';
import './inbox.css';

const REFRESH_MS = 15_000;
const WINDOW_CLOSED = 'window.closed';

function Bubble({ message }) {
  const out = message.direction === 'out';
  const who = AUTHOR_LABEL[message.author];
  return (
    <li className={`bubble${out ? ' bubble-out' : ''}`}>
      {MESSAGE_KIND[message.kind] && <span className="bubble-kind">{MESSAGE_KIND[message.kind]}</span>}
      {message.text && <p className="bubble-text">{message.text}</p>}
      <span className="bubble-meta">{who ? `${who}, ` : ''}{formatDateTime(message.at)}</span>
    </li>
  );
}

/** Replies go through the same checks as every other send (PRD 6.7), so "didn't go" is a normal answer here, with its reason. */
function Composer({ threadId }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  async function send(event) {
    event.preventDefault();
    if (!text.trim()) {
      setProblem('Write a reply first.');
      return;
    }
    setBusy(true);
    setProblem('');
    try {
      const result = await api.inbox.reply(threadId, { text: text.trim() });
      if (SENT_OUTCOMES.includes(result.outcome)) {
        setText('');
        toast('Reply sent.');
      } else {
        setProblem(`Your reply didn’t go. ${describeReason(result.reason) || describeReason(result.outcome)}`);
      }
    } catch (error) {
      // The window closed while this was being typed: the refresh below replaces the composer and says so.
      if (error.reason !== WINDOW_CLOSED) setProblem(error.message);
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  return (
    <form className="composer" onSubmit={send} noValidate>
      <FieldGroup>
        <TextAreaField label="Your reply" rows={3} maxLength={4000} value={text} onChange={(event) => setText(event.target.value)} />
      </FieldGroup>
      {problem && <Banner tone="bad">{problem}</Banner>}
      <Button type="submit" size="large" block loading={busy}>Send reply</Button>
    </form>
  );
}

function Thread({ thread }) {
  const status = THREAD_STATUS[thread.status];
  const paused = pauseLine(thread, formatDateTime);
  return (
    <>
      <PageHeader title={handle(thread.username)} actions={<Badge tone={status.tone}>{status.label}</Badge>} />
      {thread.channel === 'facebook' && <p className="muted">On Facebook Messenger</p>}
      {thread.messages.length > 0
        ? <ol className="bubbles" aria-label="Messages">{thread.messages.map((message) => <Bubble key={message.id} message={message} />)}</ol>
        : <p className="muted">Messages are kept for 30 days, so older ones are gone.</p>}
      {paused && <Banner>{paused}</Banner>}
      {thread.canReply ? <Composer threadId={thread.id} /> : <Banner tone="warn">Reply in the Instagram app</Banner>}
    </>
  );
}

export default function ThreadPage() {
  const { id } = useParams();
  const thread = useQuery({ queryKey: ['inbox-thread', id], queryFn: () => api.inbox.thread(id), refetchInterval: REFRESH_MS });
  return (
    <>
      <BackLink to="/inbox">Inbox</BackLink>
      <Loadable query={thread} detail label="Loading this conversation" errorTitle="We couldn’t load this conversation">
        {(found) => <Thread thread={found} />}
      </Loadable>
    </>
  );
}
