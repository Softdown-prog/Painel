import {Component, input, output, signal, OnInit} from '@angular/core';
import {initialInsertValues} from './database-row-values';

type Entry = Record<string,unknown>;
type Table = {schema:string;name:string;kind:string;size_bytes:string;estimated_rows:string};
type Column = {name:string;type:string;nullable:boolean;generated:boolean;primary:boolean;defaulted:boolean};
type Backup = {id:string;database:string;sizeBytes:number;sha256:string;createdAt:string};
type Tab = 'tables'|'sql'|'backups'|'access';
@Component({selector:'panel-database-manager',standalone:true,
  templateUrl:'./database-manager.component.html',styleUrl:'./database-manager.component.css'})
export class DatabaseManagerComponent implements OnInit {
  readonly database=input.required<string>();
  readonly databaseNames=input<string[]>([]);
  readonly closed=output<void>();
  readonly tab=signal<Tab>('tables');
  readonly busy=signal(false);readonly error=signal('');readonly notice=signal('');
  readonly tables=signal<Table[]>([]);readonly selected=signal<Table|null>(null);
  readonly columns=signal<Column[]>([]);readonly rows=signal<Entry[]>([]);readonly offset=signal(0);readonly more=signal(false);
  readonly sql=signal('SELECT current_database(), current_user;');readonly write=signal(false);readonly confirm=signal('');
  readonly sqlResult=signal<{columns:string[];rows:Entry[];truncated:boolean;affectedRows:number|null;command:string}|null>(null);
  readonly edit=signal<{action:'insert'|'update'|'delete';key:Entry;version:string}|null>(null);readonly values=signal('{}');
  readonly backupList=signal<Backup[]>([]);readonly source=signal('');readonly restoreList=signal<Backup[]>([]);
  readonly restoreId=signal('');readonly pending=signal<'drop'|'restore'|'remove-backup'|null>(null);readonly removeId=signal('');
  readonly access=signal<Entry|null>(null);
  readonly accessName=signal('');readonly accessPermission=signal('read');
  ngOnInit():void{this.source.set(this.database());if(this.databaseNames().includes(this.database()))void this.loadTables();
    else{this.tab.set('backups');void this.loadBackups();}}
  private async api<T>(action:string,method='GET',body?:object,database=this.database()):Promise<T>{
    const response=await fetch('/api/database/admin/'+encodeURIComponent(database)+'/'+action,{method,credentials:'same-origin',
      cache:'no-store',redirect:'error',headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    let value:unknown;try{value=await response.json();}catch{throw Error('A API não devolveu JSON válido.');}
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('Resposta inválida do banco.');
    if(!response.ok)throw Error(typeof (value as Entry)['error']==='string'?String((value as Entry)['error']):'Falha HTTP '+response.status);
    return value as T;
  }
  private async run(work:()=>Promise<void>):Promise<void>{
    if(this.busy())return;this.busy.set(true);this.error.set('');this.notice.set('');
    try{await work();}catch(e){this.error.set(e instanceof Error?e.message:'Operação não concluída.');}
    finally{this.busy.set(false);}
  }
  async loadTables():Promise<void>{await this.run(async()=>{
    this.tables.set([]);this.selected.set(null);this.rows.set([]);
    const result=await this.api<{tables:Table[]}>('tables');
    if(!Array.isArray(result.tables))throw Error('Inventário inválido.');
    this.tables.set(result.tables);
  });}
  async switchTab(tab:Tab):Promise<void>{
    if(this.busy())return;this.tab.set(tab);this.cancel();this.error.set('');
    if(tab==='backups')await this.loadBackups();
    if(tab==='access')await this.run(async()=>this.access.set(await this.api<Entry>('access')));
  }
  private async fetchRows(table:Table,offset:number):Promise<void>{
    this.rows.set([]);this.columns.set([]);this.more.set(false);
    const result=await this.api<{rows:Entry[];columns:Column[];hasMore:boolean;offset:number}>(
      'rows?schema='+encodeURIComponent(table.schema)+'&table='+encodeURIComponent(table.name)+'&offset='+offset);
    if(!Array.isArray(result.rows)||!Array.isArray(result.columns)||typeof result.hasMore!=='boolean')throw Error('Tabela inválida.');
    this.rows.set(result.rows);this.columns.set(result.columns);this.offset.set(result.offset);this.more.set(result.hasMore);
  }
  async openTable(table:Table,offset=0):Promise<void>{await this.run(async()=>{
    this.cancel();this.selected.set(table);await this.fetchRows(table,offset);
  });}
  startEdit(action:'insert'|'update'|'delete',row:Entry={}):void{
    this.cancel();const key:Entry={},values:Entry=action==='insert'?initialInsertValues(this.columns()):{};
    for(const col of this.columns()){
      if(col.primary && action!=='insert')key[col.name]=row[col.name];
      if(!col.generated && action==='update')values[col.name]=row[col.name];
    }
    this.edit.set({action,key,version:String(row['__panel_version']??'')});this.values.set(JSON.stringify(values,null,2));
  }
  async saveRow():Promise<void>{
    const edit=this.edit(),table=this.selected();
    if(!edit||!table||this.confirm()!==this.database())return;
    await this.run(async()=>{
      const values=edit.action==='delete'?{}:JSON.parse(this.values()) as unknown;
      if(!values||typeof values!=='object'||Array.isArray(values))throw Error('Os valores devem ser um objeto JSON.');
      await this.api('rows','POST',{schema:table.schema,table:table.name,...edit,values,confirmation:this.confirm()});
      this.cancel();await this.fetchRows(table,this.offset());this.notice.set('Registro '+(edit.action==='delete'?'excluído':edit.action==='insert'?'adicionado':'atualizado')+'.');
    });
  }
  async executeSql():Promise<void>{
    if(this.write()&&this.confirm()!==this.database())return;
    await this.run(async()=>{
      this.sqlResult.set(null);
      const result=await this.api<{columns:string[];rows:Entry[];truncated:boolean;affectedRows:number|null;command:string}>(
        'sql','POST',{sql:this.sql(),write:this.write(),confirmation:this.confirm()});
      if(!Array.isArray(result.rows)||!Array.isArray(result.columns))throw Error('Resultado SQL inválido.');
      this.sqlResult.set(result);this.confirm.set('');
      if(this.write())this.notice.set('Instrução executada. Atualize as tabelas para conferir a alteração.');
    });
  }
  async saveAccess():Promise<void>{
    if(this.confirm()!==this.database())return;
    await this.run(async()=>{
      const result=await this.api<{ok:boolean;message:string}>('access','POST',{name:this.accessName(),permission:this.accessPermission(),confirmation:this.confirm()});
      if(result.ok!==true)throw Error('A configuração de acesso não foi confirmada.');
      this.access.set(await this.api<Entry>('access'));this.confirm.set('');this.notice.set(result.message);
    });
  }
  prepareSql(sql:string):void{this.tab.set('sql');this.cancel();this.sql.set(sql);this.write.set(true);this.sqlResult.set(null);}
  createTable():void{this.prepareSql('CREATE TABLE public.nova_tabela (\n  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  nome text NOT NULL,\n  criado_em timestamptz NOT NULL DEFAULT now()\n);');}
  dropTable(table:Table):void{this.prepareSql('DROP TABLE '+this.quote(table.schema)+'.'+this.quote(table.name)+';');}
  quote(value:string):string{return '"'+value.replaceAll('"','""')+'"';}
  canEdit():boolean{return this.columns().some(c=>c.primary);}
  async loadBackups():Promise<void>{await this.run(async()=>{
    this.backupList.set((await this.api<{backups:Backup[]}>('backups')).backups);
    this.restoreList.set((await this.api<{backups:Backup[]}>('backups','GET',undefined,this.source()||this.database())).backups);
  });}
  async backup():Promise<void>{await this.run(async()=>{
    const result=await this.api<{backup:Backup}>('backups','POST',{});
    this.backupList.update(list=>[result.backup,...list]);
    if(this.source()===this.database())this.restoreList.set(this.backupList());
    this.notice.set('Backup criado. Baixe uma cópia para guardar fora da VPS.');
  });}
  async download(backup:Backup):Promise<void>{await this.run(async()=>{
    const parts:Uint8Array<ArrayBuffer>[]= [];let offset=0;
    while(offset<backup.sizeBytes){
      const chunk=await this.api<{offset:number;next:number;total:number;data:string}>('backup-part?id='+backup.id+'&offset='+offset);
      if(chunk.offset!==offset||chunk.next<=offset||chunk.next>backup.sizeBytes||chunk.total!==backup.sizeBytes)throw Error('Download interrompido: trecho inválido.');
      const data=Uint8Array.from(atob(chunk.data),c=>c.charCodeAt(0));
      if(data.byteLength!==chunk.next-offset)throw Error('Tamanho do trecho inválido.');
      parts.push(data);offset=chunk.next;
    }
    const blob=new Blob(parts,{type:'application/octet-stream'});
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',await blob.arrayBuffer())),n=>n.toString(16).padStart(2,'0')).join('');
    if(hash!==backup.sha256)throw Error('A integridade do download não foi confirmada.');
    const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=backup.database+'-'+backup.createdAt.slice(0,10)+'.dump';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),30_000);this.notice.set('Download verificado por SHA-256. Guarde o arquivo em local seguro.');
  });}
  prepare(action:'drop'|'restore'|'remove-backup',id=''):void{this.cancel();this.pending.set(action);this.removeId.set(id);}
  cancel():void{this.pending.set(null);this.edit.set(null);this.confirm.set('');}
  async confirmAction():Promise<void>{
    const action=this.pending();if(!action||this.confirm()!==this.database())return;
    await this.run(async()=>{
      const result=await this.api<{ok:boolean;message:string}>(action==='restore'?'restore':'delete','POST',{
        confirmation:this.confirm(),...(action==='restore'?{backupId:this.restoreId(),sourceDatabase:this.source()}:
          action==='remove-backup'?{backupId:this.removeId()}:{} )});
      if(result.ok!==true)throw Error('A alteração não foi confirmada.');
      this.cancel();this.notice.set(result.message);
      if(action==='drop'){this.closed.emit();return;}
      this.backupList.set((await this.api<{backups:Backup[]}>('backups')).backups);
    });
  }
  text(value:unknown):string{return value===null?'NULL':typeof value==='object'?JSON.stringify(value):String(value??'');}
  json(value:unknown):string{return JSON.stringify(value,null,2);}
  async copy(value:string):Promise<void>{try{await navigator.clipboard.writeText(value);this.notice.set('Copiado.');}catch{this.error.set('Não foi possível copiar. Selecione o texto para copiar.');}}
  size(bytes:number|string):string{return (Number(bytes)/1024/1024).toLocaleString('pt-BR',{maximumFractionDigits:2})+' MB';}
}
