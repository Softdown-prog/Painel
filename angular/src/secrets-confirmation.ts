/** Confirmation carries only operation metadata: never duplicate or retain the secret value. */
export type SecretIntent={
  kind:'save'|'delete';
  name:string;
  replacement:boolean;
  revision:number;
};
export function currentSecretIntent(
  intent:SecretIntent|null,revision:number,entries:ReadonlyArray<{name:string}>,selectedName:string
):boolean {
  if(!intent||intent.revision!==revision)return false;
  const exists=entries.some(entry=>entry.name===intent.name);
  if(intent.kind==='delete')return exists;
  return intent.kind==='save'&&intent.name===selectedName&&intent.replacement===exists;
}
