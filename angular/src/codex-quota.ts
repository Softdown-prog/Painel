/** Pure display helpers for authenticated Codex quota snapshots. No predictions. */
export type CodexQuotaWindow={
 usedPercent:number|null;
 windowDurationMins:number|null;
 resetsAt:number|null;
};
export function availablePercent(window:CodexQuotaWindow):number|null{
 const used=window.usedPercent;
 if(typeof used!=='number'||!Number.isFinite(used)||used<0||used>100)return null;
 return Math.round((100-used)*10)/10;
}
export function quotaCountdown(window:CodexQuotaWindow,nowMs:number):string{
 const reset=window.resetsAt;
 if(typeof reset!=='number'||!Number.isSafeInteger(reset)||reset<=0||
    !Number.isFinite(nowMs))return 'Prazo não informado';
 const remainingMs=reset*1000-nowMs;
 if(remainingMs<=0)return 'Horário de renovação atingido; aguardando atualização';
 const minutes=Math.ceil(remainingMs/60_000);
 const days=Math.floor(minutes/1440),hours=Math.floor((minutes%1440)/60);
 const mins=minutes%60;
 if(days>0)return days+'d '+hours+'h '+mins+'min restantes';
 if(hours>0)return hours+'h '+mins+'min restantes';
 return mins+'min restantes';
}
