export function countEditedById<T extends { id: string }>(
  selected: readonly T[],
  originalById: ReadonlyMap<string, T>,
) {
  return selected.filter(
    (item) => JSON.stringify(item) !== JSON.stringify(originalById.get(item.id)),
  ).length;
}
