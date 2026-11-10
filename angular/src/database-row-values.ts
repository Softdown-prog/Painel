/** Prefill only required, user-editable columns. PostgreSQL defaults must be omitted,
 * not sent as explicit NULL, and manual primary keys must be editable. */
export type InsertColumn = {name:string;nullable:boolean;generated:boolean;defaulted:boolean};

export function initialInsertValues(columns:readonly InsertColumn[]):Record<string,null>{
  const values:Record<string,null>={};
  for(const column of columns){
    if(!column.generated&&!column.defaulted&&!column.nullable)values[column.name]=null;
  }
  return values;
}
