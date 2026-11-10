import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { Badge, Banner, Button, EmptyState, Loadable, LoadMore, PageHeader, Spinner, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { plural } from '../../lib/format.js';
import { fetchAll, usePagedList } from '../../lib/query.js';
import { mergeReelCards } from './form.js';

function ReelCard({ card }) {
  const { reel } = card;
  return (
    <li className="reel-card">
      <Link className="reel-card-picture" to={`/reels/${card.id}`} state={card.post ? { post: card.post } : undefined}>
        <Thumb src={card.thumbnailUrl} alt={card.title} />
        <span className="reel-card-status">
          {reel ? (reel.active ? <Badge tone="good">Live</Badge> : <Badge>Paused</Badge>) : <Badge tone="warn">Not set up</Badge>}
        </span>
      </Link>
      <div className="reel-card-body">
        <p className="reel-card-title">{card.title}</p>
        <p className="reel-card-meta">{reel ? `${plural(reel.productCount, 'product')}, ${plural(reel.dmCount, 'DM')}, ${plural(reel.orderCount, 'order')}` : card.kind}</p>
        <Button as={Link} variant={reel ? 'soft' : 'primary'} to={`/reels/${card.id}`} state={card.post ? { post: card.post } : undefined} block>{reel ? 'Edit store' : 'Set up store'}</Button>
      </div>
    </li>
  );
}

export default function ReelsPage() {
  const reels = useQuery({ queryKey: ['reels', 'all'], queryFn: () => fetchAll(api.reels.list) });
  // Instagram being down must not hide the reels already set up, so this one fails on its own.
  const posts = usePagedList('instagram-posts', api.reels.instagramPosts, { limit: 50 }, { retry: false });

  return (
    <>
      <PageHeader title="Reels" />
      <p className="lead">Each reel gets its own store with 1 to 20 products. When someone comments the reel’s keyword, they get a DM with a button to that store.</p>
      {posts.isError && <Banner tone="warn">We couldn’t load your Instagram posts: {posts.error.message} Reels you already set up are still listed.</Banner>}
      <Loadable query={reels} label="Loading your reels" errorTitle="We couldn’t load your reels">
        {(configured) => {
          if (posts.isPending) return <Spinner label="Loading your Instagram posts" />;
          const cards = mergeReelCards(posts.items, configured);
          if (!cards.length) return <EmptyState title="No posts found">Post a reel on Instagram, then come back here to set up its store.</EmptyState>;
          return (
            <>
              <ul className="reel-cards">{cards.map((card) => <ReelCard key={card.id} card={card} />)}</ul>
              <LoadMore query={posts} />
            </>
          );
        }}
      </Loadable>
    </>
  );
}
