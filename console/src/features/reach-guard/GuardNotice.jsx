import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { staffWith } from '@contracts/access.js';
import { Banner, Button } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useAllowed } from '../../lib/query.js';
import '../insights/shared/analytics.css';

const SHOWN = new Set(['tripped', 'permission_needed']);

function Notice() {
  const status = useQuery({ queryKey: ['reach-guard', 'status'], queryFn: () => api.reachGuard.status(), retry: false, refetchInterval: 60_000 });
  if (!status.data || !SHOWN.has(status.data.state)) return null;
  return (
    <div className="an-permission">
      <Banner tone="warn">{status.data.message}</Banner>
      <Button as={Link} variant="soft" to="/reach-guard">Open Reach Guard</Button>
    </div>
  );
}

/** The web banner of PRD 7.6: on Home while Reach Guard has tripped or needs permission, in the same words as its own screen. Quiet otherwise. */
export default function GuardNotice() {
  const allowed = useAllowed();
  return allowed(staffWith('analytics')) ? <Notice /> : null;
}
