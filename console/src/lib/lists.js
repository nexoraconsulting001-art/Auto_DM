/** A copy of `list` with the item at `index` moved by `delta` places. Moving off either end changes nothing. */
export function moveItem(list, index, delta) {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

/** "S, M,, L " to ['S', 'M', 'L'], without repeats. */
export function splitList(text) {
  return [...new Set(String(text ?? '').split(',').map((part) => part.trim()).filter(Boolean))];
}
