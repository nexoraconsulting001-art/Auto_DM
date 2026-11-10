import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronUp, Plus } from 'lucide-react';
import { Badge, Banner, Button, EmptyState, IconButton, Loadable, PageHeader, Thumb } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { moveItem } from '../../lib/lists.js';
import { fetchAll, useRefresh } from '../../lib/query.js';
import { plural } from '../../lib/format.js';
import { positionChanges } from './form.js';

function CategoryRows({ categories }) {
  const refresh = useRefresh();
  const [problem, setProblem] = useState('');
  const [moving, setMoving] = useState(false);

  async function move(index, delta) {
    const changes = positionChanges(moveItem(categories, index, delta));
    setMoving(true);
    setProblem('');
    try {
      await Promise.all(changes.map(({ id, position }) => api.categories.update(id, { position })));
    } catch (failure) {
      setProblem(failure.message);
    } finally {
      await refresh();
      setMoving(false);
    }
  }

  return (
    <>
      {problem && <Banner tone="bad">{problem}</Banner>}
      <ol className="rank-list" aria-label="Category order">
        {categories.map((category, index) => (
          <li key={category.id} className={`rank${index === 0 ? ' rank-first' : ''}`}>
            <span className="rank-number" aria-hidden="true">{index + 1}</span>
            <div className="rank-card">
              <Link className="rank-link" to={`/categories/${category.id}`}>
                <Thumb src={category.imageUrl} tall />
                <span className="list-row-main">
                  <span className="list-row-title">{category.name}</span>
                  <span className="list-row-meta">/c/{category.slug} · {plural(category.productCount, 'product')}</span>
                  {!category.visible && <span><Badge>Hidden</Badge></span>}
                </span>
              </Link>
              <span className="rank-tools">
                <IconButton label={`Move ${category.name} up`} disabled={index === 0 || moving} onClick={() => move(index, -1)}><ChevronUp size={18} aria-hidden="true" /></IconButton>
                <IconButton label={`Move ${category.name} down`} disabled={index === categories.length - 1 || moving} onClick={() => move(index, 1)}><ChevronDown size={18} aria-hidden="true" /></IconButton>
              </span>
            </div>
          </li>
        ))}
      </ol>
    </>
  );
}

export default function CategoriesPage() {
  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });
  const add = <Button as={Link} to="/categories/new"><Plus size={16} strokeWidth={2} aria-hidden="true" />Add category</Button>;
  return (
    <>
      <PageHeader title="Categories" actions={add} />
      <p className="lead">Categories show as circles on your store’s home page and as chips in the shop. This order shows everywhere.</p>
      <Loadable query={categories} label="Loading your categories" errorTitle="We couldn’t load your categories">
        {(rows) => (rows.length ? <CategoryRows categories={rows} /> : (
          <EmptyState title="No categories yet" action={<Button as={Link} variant="soft" to="/categories/new">Add your first category</Button>}>
            Group your products so shoppers find them faster.
          </EmptyState>
        ))}
      </Loadable>
    </>
  );
}
