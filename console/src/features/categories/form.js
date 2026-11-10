export const EMPTY_CATEGORY = Object.freeze({ name: '', description: '', slug: '', position: '', imageUrl: '', visible: true });

export function categoryToForm(category) {
  return {
    name: category.name,
    description: category.description,
    slug: category.slug,
    position: String(category.position),
    imageUrl: category.imageUrl,
    visible: category.visible,
  };
}

/** The form as the API wants it, or `errors` by field. An empty link name is left for the server to make from the name. */
export function formToCategory(form) {
  const errors = {};
  const name = form.name.trim();
  if (!name) errors.name = 'Name is required';
  const positionText = String(form.position).trim();
  if (positionText !== '' && !/^-?\d+$/.test(positionText)) errors.position = 'Order must be a whole number';
  if (Object.keys(errors).length) return { errors };
  return {
    body: {
      name,
      description: form.description.trim(),
      slug: form.slug.trim() || undefined,
      imageUrl: form.imageUrl,
      visible: form.visible,
      ...(positionText === '' ? {} : { position: Number(positionText) }),
    },
  };
}

/** One past the highest position, so a new category lands last. */
export const nextPosition = (categories) => (categories.length ? Math.max(...categories.map((category) => category.position)) + 1 : 1);

/** What has to change to put `ordered` into effect: numbers from 1, only where they differ. */
export function positionChanges(ordered) {
  return ordered.flatMap((category, index) => (category.position === index + 1 ? [] : [{ id: category.id, position: index + 1 }]));
}
