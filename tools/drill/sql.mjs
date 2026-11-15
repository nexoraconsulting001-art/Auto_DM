/** The drill's one error class and the one checksum statement both sides run (re-exported by index.mjs). */
export class DrillError extends Error {}

const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

/**
 * One statement that answers { rows, checksum } for a table: the number of rows and an md5 over every row as text, in
 * the order of `keyColumns`. With `tenantColumn` it takes $1, the business's id, and covers that business's rows only.
 */
export function checksumSql(table, keyColumns, { tenantColumn = '' } = {}) {
  for (const name of [table, ...keyColumns, ...(tenantColumn ? [tenantColumn] : [])]) {
    if (!IDENT.test(name)) throw new DrillError(`"${name}" is not a table or column name`);
  }
  if (!keyColumns.length) throw new DrillError('A checksum needs the columns to order by');
  const where = tenantColumn ? ` WHERE t.${tenantColumn} = $1` : '';
  const order = keyColumns.map((column) => `t.${column}`).join(', ');
  return `SELECT count(*)::int AS rows, COALESCE(md5(string_agg(t::text, '|' ORDER BY ${order})), '') AS checksum FROM ${table} t${where}`;
}
