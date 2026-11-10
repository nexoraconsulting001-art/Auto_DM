import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import { Badge, Banner, Button, Chip, ChipRow, EmptyState, Loadable, LoadMore, Panel, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { usePagedList } from '../../lib/query.js';
import { toggleMedia } from './form.js';

const FILTERS = Object.freeze([['all', 'All'], ['reel', 'Reels'], ['post', 'Posts'], ['story', 'Stories']]);
const TYPE_LABEL = Object.freeze({ reel: 'Reel', post: 'Post', story: 'Story' });
const LOST = new Set(['reconnect_needed', 'deauthorized']);
const RECONNECT_REASON = 'paused.reconnect';

function Tile({ media, picked, takenElsewhere, onToggle }) {
  const label = TYPE_LABEL[media.type];
  const caption = media.caption.trim().slice(0, 60);
  return (
    <button type="button" className="media-tile" aria-pressed={picked} aria-label={caption ? `${label}: ${caption}` : label} onClick={onToggle}>
      <Thumb src={media.thumbnailUrl} />
      <span className="media-tile-badges">
        <Badge tone="ink">{label}</Badge>
        {takenElsewhere && <Badge tone="warn">In use</Badge>}
      </span>
      {picked && <span className="media-tile-check" aria-hidden="true"><Check size={14} strokeWidth={3} /></span>}
    </button>
  );
}

function Picked({ form }) {
  const { media } = form.values;
  if (!media.length) return null;
  return (
    <div className="picked-list">
      {media.map((item) => (
        <span key={item.id} className="keyword">
          <span className="picked-name">{item.caption.trim().slice(0, 40) || `${TYPE_LABEL[item.type] ?? 'Post'} ${item.id}`}</span>
          <button type="button" className="keyword-remove" aria-label={`Remove ${item.caption.trim().slice(0, 40) || item.id}`} onClick={() => form.set('media', media.filter((other) => other.id !== item.id))}><X size={14} aria-hidden="true" /></button>
        </span>
      ))}
    </div>
  );
}

/** The one way out when Instagram can't be read. Shown once, whichever signal noticed first. */
function ConnectPrompt({ reconnect }) {
  return (
    <div className="stack">
      <Banner tone="warn">{reconnect ? 'Instagram stopped accepting your connection, so we can’t show your posts.' : 'Connect your account to choose a post.'}</Banner>
      <Button as={Link} to="/connect">{reconnect ? 'Reconnect Instagram' : 'Connect Instagram'}</Button>
    </div>
  );
}

function Grid({ form, automationId, type }) {
  const media = usePagedList('instagram-media', api.instagram.media, { type, limit: 24 }, { retry: false });
  if (media.isError && media.error.reason === RECONNECT_REASON) return <ConnectPrompt reconnect />;
  const picked = new Set(form.values.media.map((item) => item.id));
  return (
    <Loadable query={media} label="Loading your posts" errorTitle="We couldn’t load your posts">
      {() => (media.items.length ? (
        <>
          <div className="media-grid">
            {media.items.map((item) => (
              <Tile
                key={item.id}
                media={item}
                picked={picked.has(item.id)}
                takenElsewhere={item.automationId !== null && item.automationId !== automationId}
                onToggle={() => {
                  const change = toggleMedia(form.values, item);
                  Object.entries(change).forEach(([name, value]) => form.set(name, value));
                }}
              />
            ))}
          </div>
          <LoadMore query={media} />
        </>
      ) : <EmptyState title="No posts found">Post a reel on Instagram and it will show up here.</EmptyState>)}
    </Loadable>
  );
}

export function MediaPicker({ form, automationId }) {
  const [type, setType] = useState('all');
  const connection = useQuery({ queryKey: ['instagram-connection'], queryFn: () => api.instagram.connection() });
  const status = connection.data?.status;
  return (
    <Panel title="Pick a reel, post or story">
      {status === 'not_connected' || LOST.has(status)
        ? <ConnectPrompt reconnect={LOST.has(status)} />
        : (
          <>
            <ChipRow label="Filter posts">
              {FILTERS.map(([value, label]) => <Chip key={value} pressed={type === value} onClick={() => setType(value)}>{label}</Chip>)}
            </ChipRow>
            <Grid form={form} automationId={automationId} type={type} />
          </>
        )}
      <Picked form={form} />
      {form.errors.triggers && <span className="field-error">{form.errors.triggers}</span>}
    </Panel>
  );
}
