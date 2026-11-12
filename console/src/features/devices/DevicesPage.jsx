import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Smartphone } from 'lucide-react';
import { useFeedback } from '../../components/feedback.jsx';
import { Badge, Banner, Button, EmptyState, Loadable, PageHeader, Panel } from '../../design/index.jsx';
import { SESSION_KEY, api } from '../../lib/api/index.js';
import { formatDateTime } from '../../lib/format.js';
import '../account/account.css';
import { describeDevice } from './rules.js';

const DEVICES_KEY = ['auth-devices'];

function DeviceRow({ device, onSignOut, busy }) {
  const { name, kind, detail } = describeDevice(device);
  const Icon = device.platform === 'web' ? Monitor : Smartphone;
  return (
    <div className="acct-row">
      <span className="acct-row-icon" aria-hidden="true"><Icon size={20} strokeWidth={1.8} /></span>
      <span className="acct-row-main">
        <span className="acct-row-title">{name}</span>
        <span className="acct-row-meta">{[kind, detail].filter(Boolean).join(' · ')}</span>
        <span className="acct-row-meta">{`Last used ${formatDateTime(device.lastSeenAt)}`}</span>
        {(device.current || device.deviceUnlock) && (
          <span className="acct-badges">
            {device.current && <Badge tone="ink">This device</Badge>}
            {device.deviceUnlock && <Badge tone="good">Fingerprint or face unlock on</Badge>}
          </span>
        )}
      </span>
      <span className="acct-row-actions">
        <Button variant="outline" loading={busy} onClick={() => onSignOut(device)} aria-label={`Sign out ${name}`}>Sign out</Button>
      </span>
    </div>
  );
}

/**
 * Settings > Devices (PRD 10.2, 10.3; P-08): every phone and browser signed in to this person's account, at any of
 * their businesses, and signing one out everywhere at once. Each person sees only their own; signing a device out is
 * never held up by a re-auth.
 */
export default function DevicesPage() {
  const queries = useQueryClient();
  const { confirm, toast } = useFeedback();
  const devices = useQuery({ queryKey: DEVICES_KEY, queryFn: api.auth.devices });
  const revoke = useMutation({
    mutationFn: (device) => api.auth.revokeDevice(device.id),
    onSuccess: async (_none, device) => {
      if (device.current) {
        // This browser's own session ended with it.
        await queries.invalidateQueries({ queryKey: SESSION_KEY });
        return;
      }
      toast(`${describeDevice(device).name} is signed out. It stops working within a minute.`);
      await queries.invalidateQueries({ queryKey: DEVICES_KEY });
    },
  });

  async function askToSignOut(device) {
    const { name } = describeDevice(device);
    const yes = await confirm({
      title: `Sign out ${name}?`,
      text: device.current
        ? 'This is the device you’re using. You’ll be signed out here now.'
        : 'It is signed out of every business at once, within a minute. Signing in there again needs a new code or Google.',
      confirm: 'Sign it out',
    });
    if (yes) revoke.mutate(device);
  }

  return (
    <>
      <PageHeader eyebrow="Settings" title="Devices" />
      <p className="lead">Phones and browsers signed in to your account. Sign out any you don’t recognise.</p>
      <Panel title="Signed in">
        {revoke.isError && <Banner tone="bad">{revoke.error.message || 'That device wasn’t signed out. Try again.'}</Banner>}
        <Loadable query={devices} label="Loading your devices" errorTitle="We couldn’t load your devices">
          {({ devices: list }) => (list.length ? (
            <div className="acct-rows">
              {list.map((device) => (
                <DeviceRow key={device.id} device={device} onSignOut={askToSignOut} busy={revoke.isPending && revoke.variables?.id === device.id} />
              ))}
            </div>
          ) : (
            <EmptyState title="No devices listed yet">The Bhava for Business app on your phones, and browsers you sign in to with a WhatsApp code, show up here.</EmptyState>
          ))}
        </Loadable>
      </Panel>
    </>
  );
}
