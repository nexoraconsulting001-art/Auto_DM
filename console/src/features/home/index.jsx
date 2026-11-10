import { House } from 'lucide-react';
import { SIGNED_IN } from '@contracts/access.js';
import { EmptyState, PageHeader } from '../../design/index.jsx';
import { useSession } from '../../lib/session.jsx';

function HomePage() {
  const { session } = useSession();
  return (
    <>
      <PageHeader eyebrow={session.business.name} title={`Hello, ${session.user.name.split(' ')[0]}`} />
      <EmptyState title="Your console is ready">Your orders, products and reels will show up here.</EmptyState>
    </>
  );
}

export default {
  name: 'home',
  access: SIGNED_IN,
  nav: { to: '/', label: 'Home', icon: House, order: 0, primary: true },
  routes: [{ index: true, element: <HomePage /> }],
};
