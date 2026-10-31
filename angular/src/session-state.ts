/** Conservative session checks for the administrative UI. The backend cookie is authoritative. */
export type AdminSession = {authenticated:boolean;setupRequired:boolean};
export function parseAdminSession(raw:unknown):AdminSession {
  if(!raw||typeof raw!=='object'||Array.isArray(raw))
    throw Error('Não foi possível validar a sessão administrativa.');
  const value=raw as Record<string,unknown>;
  if(typeof value['authenticated']!=='boolean'||typeof value['setupRequired']!=='boolean')
    throw Error('Não foi possível validar a sessão administrativa.');
  return {authenticated:value['authenticated'],setupRequired:value['setupRequired']};
}
/** 401 on protected endpoints means reauthentication, not a failed password or a permission check. */
/** An unverified logout must never be bypassed by a concurrent login. */
export function maySubmitAdminLogin(
  session:AdminSession|null,logoutPending:boolean,logoutUnconfirmed:boolean,
  busy:boolean,sessionChecking:boolean
):boolean{
  return session?.authenticated===false&&!session.setupRequired&&
    !logoutPending&&!logoutUnconfirmed&&!busy&&!sessionChecking;
}

export function expiredProtectedSession(status:number,path:string):boolean {
  return status===401&&path!=='/login'&&path!=='/setup'&&path!=='/logout'&&path!=='/session';
}
