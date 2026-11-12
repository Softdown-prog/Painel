/** Prefill only required, user-editable columns. PostgreSQL defaults must be omitted,
 * not sent as explicit NULL, and manual primary keys must be editable. */
export type InsertColumn = {name:string;nullable:boolean;generated:boolean;defaulted:boolean};

export function initialInsertValues(columns:readonly InsertColumn[]):Record<string,null>{
  // fromEntries creates own data properties even for PostgreSQL columns named
  // __proto__, constructor or other JavaScript object prototype properties.
  return Object.fromEntries(columns.filter(column=>
    !column.generated&&!column.defaulted&&!column.nullable
  ).map(column=>[column.name,null])) as Record<string,null>;
}
