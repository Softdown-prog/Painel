import {Component,OnDestroy,OnInit,computed,signal} from '@angular/core';
type Daily={date:string;rx:number;tx:number};
type Traffic={available:boolean;interface?:string;source?:string;billingNote?:string;
 historyStartsAt?:string|null;lastSampleAt?:string|null;message?:string;
 settings?:{allowanceBytes:number;resetDay:number};
 month?:{rx:number;tx:number;total:number;periodStart:string;percentage:number;alert:string};
 daily?:Daily[]};
type Point={at:string;memoryPercent:number|null;diskPercent:number|null};
type History={available:boolean;cadenceMinutes:number;samples:Point[];lastSampleAt:string|null;explanation:string};
type Overview={resourceHistory?:History};
const TB=1024**4;
@Component({selector:'panel-traffic',standalone:true,templateUrl:'./traffic.component.html',styleUrl:'./traffic.component.css'})
export class TrafficComponent implements OnInit,OnDestroy{
 readonly traffic=signal<Traffic|null>(null);
 readonly history=signal<History|null>(null);
 readonly loading=signal(false);
 readonly saving=signal(false);
 readonly error=signal('');
 readonly notice=signal('');
 readonly allowance=signal(1);
 readonly resetDay=signal(1);
 readonly pending=signal(false);
 readonly confirmation=signal('');
 readonly selectedMetric=signal<'memoryPercent'|'diskPercent'>('memoryPercent');
 readonly usagePct=computed(()=>{
   const value=this.traffic()?.month?.percentage;
   return typeof value==='number'&&Number.isFinite(value)?Math.max(0,Math.min(100,value)):0;
 });
 readonly daily=computed(()=>{
   const rows=this.traffic()?.daily??[];
   const valid=rows.filter(r=>/^\d{4}-\d{2}-\d{2}$/.test(r.date)&&
     Number.isFinite(r.rx)&&Number.isFinite(r.tx)&&r.rx>=0&&r.tx>=0);
   const max=Math.max(1,...valid.map(x=>x.rx+x.tx));
   return valid.slice(-31).map(r=>({date:r.date,
     rxPct:Math.max(0,r.rx/max*100),txPct:Math.max(0,r.tx/max*100),
     rx:r.rx,tx:r.tx}));
 });
 readonly points=computed(()=>{
   const metric=this.selectedMetric();
   const rows=this.history()?.samples??[];
   return rows.map(p=>({time:Date.parse(p.at),value:p[metric]}))
     .filter((p):p is {time:number;value:number}=>Number.isFinite(p.time)&&
       typeof p.value==='number'&&Number.isFinite(p.value)&&p.value>=0&&p.value<=100)
     .sort((a,b)=>a.time-b.time);
 });
 readonly path=computed(()=>{
   const values=this.points();
   const first=values[0],last=values.at(-1);
   if(!first||!last||values.length<2||last.time<=first.time)return '';
   return values.map(p=>{
     const x=12+(p.time-first.time)/(last.time-first.time)*336;
     const y=100-p.value*.9;
     return x.toFixed(2)+','+y.toFixed(2);
   }).join(' ');
 });
 private timer:ReturnType<typeof setInterval>|null=null;
 ngOnInit():void{
   void this.refresh();
   this.timer=setInterval(()=>{
     if(document.visibilityState==='visible'&&!this.loading()&&!this.saving()&&!this.pending())
       void this.refresh(true);
   },60000);
 }
 ngOnDestroy():void{if(this.timer!==null)clearInterval(this.timer);this.timer=null;}
 private async api<T>(path:string,method='GET',body?:object):Promise<T>{
   const r=await fetch('/api'+path,{method,credentials:'same-origin',redirect:'error',cache:'no-store',
     headers:body?{'content-type':'application/json'}:{accept:'application/json'},
     ...(body?{body:JSON.stringify(body)}:{})});
   let data:unknown;try{data=await r.json();}catch{throw Error('Resposta JSON inválida da VPS.');}
   if(!data||typeof data!=='object'||Array.isArray(data))throw Error('Dados inesperados da API.');
   if(!r.ok){const msg=(data as {error?:unknown}).error;throw Error(typeof msg==='string'?msg:'HTTP '+r.status);}
   return data as T;
 }
 async refresh(auto=false):Promise<void>{
   if(this.loading()||this.saving())return;
   this.loading.set(true);if(!auto)this.error.set('');
   const [traffic,overview]=await Promise.allSettled([
     this.api<Traffic>('/traffic'),this.api<Overview>('/overview')
   ]);
   if(traffic.status==='fulfilled'){
     const t=traffic.value;
     if(t.available===true&&t.settings&&t.month&&Array.isArray(t.daily)&&
       Number.isSafeInteger(t.settings.resetDay)&&Number.isFinite(t.settings.allowanceBytes)&&
       Number.isFinite(t.month.total)&&Number.isFinite(t.month.percentage)){
       this.traffic.set(t);
       if(!this.pending()){
         this.allowance.set(Math.round(t.settings.allowanceBytes/TB*10000)/10000);
         this.resetDay.set(t.settings.resetDay);
       }
     }else{this.traffic.set(null);this.error.set(t.message||'Dados de tráfego indisponíveis.');}
   }else{this.traffic.set(null);this.error.set('Não foi possível consultar os contadores de tráfego.');}
   if(overview.status==='fulfilled'&&overview.value.resourceHistory){
     const h=overview.value.resourceHistory;
     if(h.available===true&&Array.isArray(h.samples))this.history.set(h);
     else this.history.set(null);
   }else this.history.set(null);
   this.loading.set(false);
 }
 prepare(event:Event):void{
   event.preventDefault();
   if(this.saving()||this.loading()||!this.traffic()?.available||!this.validSettings())return;
   this.pending.set(true);this.confirmation.set('');this.notice.set('');this.error.set('');
 }
 validSettings():boolean{
   return Number.isFinite(this.allowance())&&this.allowance()>=.01&&this.allowance()<=1000&&
     Number.isInteger(this.resetDay())&&this.resetDay()>=1&&this.resetDay()<=28;
 }
 cancel():void{this.pending.set(false);this.confirmation.set('');}
 async save():Promise<void>{
   if(!this.pending()||this.confirmation()!=='ATUALIZAR'||!this.validSettings()||
     this.saving()||this.loading()||!this.traffic()?.available)return;
   this.saving.set(true);this.error.set('');this.notice.set('');
   try{
     const result=await this.api<Traffic>('/traffic','POST',
       {allowanceTb:this.allowance(),resetDay:this.resetDay()});
     if(result.available!==true||!result.settings)throw Error('Configuração não confirmada pela VPS.');
     this.notice.set('Referência de tráfego e dia de renovação atualizados na VPS.');
     this.cancel();
     this.saving.set(false);
     await this.refresh();
   }catch(e){this.error.set(e instanceof Error?e.message:'Não foi possível salvar.');this.cancel();}
   finally{this.saving.set(false);}
 }
 bytes(value:number|undefined|null):string{
   if(typeof value!=='number'||!Number.isFinite(value)||value<0)return '—';
   const units=['B','KB','MB','GB','TB','PB'];let n=value,i=0;
   while(n>=1024&&i<units.length-1){n/=1024;i++;}
   return n.toLocaleString('pt-BR',{maximumFractionDigits:2})+' '+(units[i]??'B');
 }
 date(value:string|null|undefined):string{
   if(!value)return 'Sem medição';const d=new Date(value);
   return Number.isFinite(d.getTime())?d.toLocaleString('pt-BR'):'Sem medição';
 }
};
