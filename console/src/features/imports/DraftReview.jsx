import { useQuery } from '@tanstack/react-query';
import { useFeedback } from '../../components/feedback.jsx';
import { Banner, Button } from '../../design/index.jsx';
import { api } from '../../lib/api/index.js';
import { useForm } from '../../lib/forms.js';
import { fetchAll, useRefresh } from '../../lib/query.js';
import { ProductForm } from '../catalog/ProductForm.jsx';
import { RENAME, draftToForm, formToProduct } from '../catalog/form.js';

/**
 * What an import read, in the product form, for the owner to check before anything is saved (8.3, 8.7). Saving here is the owner's
 * own decision, so it is theirs to make even when the quality check stopped the automatic import.
 */
export function DraftReview({ itemId, draft, note, onSaved, onCancel }) {
  const { toast } = useFeedback();
  const refresh = useRefresh();
  const categories = useQuery({ queryKey: ['categories', 'all'], queryFn: () => fetchAll(api.categories.list) });
  const form = useForm(draftToForm(draft ?? {}), { rename: RENAME });

  async function save(event) {
    event.preventDefault();
    const { body, errors } = formToProduct(form.values);
    if (errors) return form.reject(errors);
    return form.run(async () => {
      const { productId } = await api.importItems.save(itemId, body);
      toast('Saved to your catalog.');
      await refresh();
      onSaved(productId);
    });
  }

  return (
    <form className="stack" onSubmit={save} noValidate aria-label="Check this product">
      {note && <Banner tone="info">{note}</Banner>}
      <ProductForm form={form} categories={categories} />
      {form.message && <Banner tone="bad">{form.message}</Banner>}
      <div className="form-actions">
        <Button type="submit" size="large" block loading={form.busy}>Save to catalog</Button>
        <Button variant="outline" size="large" block onClick={onCancel}>Not now</Button>
      </div>
    </form>
  );
}
