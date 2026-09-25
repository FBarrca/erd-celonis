/** Find one shortest route through the loaded relationships, in either direction.
 * Table IDs, not names, identify endpoints. Each step retains the exact edge
 * and presents its column pairs in traversal order without modifying metadata.
 */
export function findPath(tables, relationships, from, to) {
  const adjacency = new Map(tables.map((table) => [table.id, []]));
  if (!adjacency.has(from) || !adjacency.has(to)) return null;
  for (const relationship of relationships) {
    if (!adjacency.has(relationship.source) || !adjacency.has(relationship.target)) continue;
    adjacency.get(relationship.source).push({ to: relationship.target, relationship, reversed: false });
    adjacency.get(relationship.target).push({ to: relationship.source, relationship, reversed: true });
  }

  const visited = new Map([[from, null]]);
  const queue = [from];
  for (let index = 0; index < queue.length && !visited.has(to); index += 1) {
    const current = queue[index];
    for (const edge of adjacency.get(current)) {
      if (visited.has(edge.to)) continue;
      visited.set(edge.to, { ...edge, from: current });
      queue.push(edge.to);
    }
  }
  if (!visited.has(to)) return null;

  const steps = [];
  const tableIds = [to];
  for (let current = to; current !== from;) {
    const step = visited.get(current);
    steps.push({
      from: step.from,
      to: current,
      relationship: step.relationship,
      columns: step.relationship.columns.map(([source, target]) => step.reversed ? [target, source] : [source, target]),
    });
    current = step.from;
    tableIds.push(current);
  }
  return { tableIds: tableIds.reverse(), steps: steps.reverse() };
}
