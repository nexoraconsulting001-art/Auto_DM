import { useMutation } from '@tanstack/react-query';
import { MANAGERS, staffWith } from '@contracts/access.js';
import { useFeedback } from '../../components/feedback.jsx';
import { Button, Panel } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useAllowed } from '../../lib/query.js';
import { RETURN_TO } from '../connect/connection.js';
import { offersFacebook, statusNotices } from './notices.js';
import { NoticeList } from './StatusNotices.jsx';
import { useStatusSources } from './useStatus.js';

const READER = staffWith('automations');

function FacebookCard() {
  const { toast } = useFeedback();
  const start = useMutation({
    mutationFn: () => api.facebook.connect({ returnTo: RETURN_TO }),
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
    onError: (error) => toast(error.message),
  });
  return (
    <Panel title="Connect Facebook Page">
      <p className="muted">Optional. The same reels get the same DMs when people comment on Facebook.</p>
      <Button variant="soft" loading={start.isPending} onClick={() => start.mutate()}>Connect</Button>
    </Panel>
  );
}

function Notices() {
  const allowed = useAllowed();
  const { status, connection, facebook } = useStatusSources();
  // Quiet while loading and if it fails: Home has its own panels, and this is only here when something is wrong.
  const notices = statusNotices({ status: status.data, connection: connection.data, facebook: facebook.data });
  return (
    <>
      <NoticeList notices={notices} />
      {allowed(MANAGERS) && offersFacebook(facebook.data) && <FacebookCard />}
    </>
  );
}

/** What is stopping messages, above the dashboard. Shown only to people the API would answer. */
export default function HomeNotices() {
  const allowed = useAllowed();
  return allowed(READER) ? <Notices /> : null;
}
