(() => {
  const get=(id)=>document.getElementById(id);
  const bytes=(size)=>size>=1073741824?(size/1073741824).toFixed(2)+' GB':(size/1048576).toFixed(1)+' MB';
  const date=(value)=>{const d=new Date(value);return Number.isNaN(d.getTime())?'data desconhecida':d.toLocaleString('pt-BR');};
  const label={
    em_uso:'Em uso',reserva:'Backup protegido',recente:'Recente · manter',protegida:'Protegida',
    antiga:'Antiga · pode limpar',ausente:'Não encontrada na VPS'
  };
  async function call(path,options={}){
    const response=await fetch('/api'+path,{credentials:'same-origin',cache:'no-store',...options});
    const value=await response.json().catch(()=>({}));
    if(!response.ok)throw new Error(value.error||'Erro '+response.status);
    return value;
  }
  function info(text){get('revisionsNotice').textContent=text;}
  function cell(tag,value){
    const element=document.createElement(tag);
    element.textContent=value;
    return element;
  }
  function render(report){
    get('revisionsCheckedAt').textContent='Última verificação: '+date(report.checkedAt);
    get('revisionsCount').textContent=String(report.totalImports);
    get('revisionsOldCount').textContent=String(report.oldCount);
    get('revisionsOldSize').textContent=bytes(report.oldBytesEstimate);
    get('revisionsAuto').textContent=report.automatic&&report.enabled?'Ligada · a cada 6 horas':'Desligada';
    get('revisionsRetention').textContent='Mantendo pelo menos '+report.keepPerApp+
      ' revisões por aplicação e protegendo as importadas há menos de '+report.ageDays+' dias.';
    const button=get('revisionsCleanupButton');
    button.disabled=!report.enabled||report.oldCount===0;
    button.title=!report.enabled?'A limpeza precisa ser habilitada pelo administrador na VPS.':report.oldCount===0?'Não há imagens antigas elegíveis.':'Excluir apenas imagens antigas verificadas';
    const entries=get('revisionsEntries');entries.replaceChildren();
    if(!report.entries.length){entries.textContent='Nenhuma revisão de imagem foi importada por este painel.';}
    for(const entry of report.entries){
      const row=document.createElement('tr');
      row.append(cell('td',entry.slug),cell('td',entry.revision.slice(0,10)),
        cell('td',label[entry.status]||entry.status),cell('td',bytes(entry.sizeBytes)),
        cell('td',date(entry.importedAt)));
      row.title=entry.reason;entries.append(row);
    }
    const history=get('revisionsHistory');history.replaceChildren();
    if(!report.history.length)history.textContent='Nenhuma limpeza foi registrada neste painel.';
    for(const item of [...report.history].reverse().slice(0,12)){
      const row=document.createElement('div');row.className='revision-history-line';
      row.append(cell('strong',date(item.at)),cell('span',(item.source==='automatic'?'Automática':'Manual')+
        ' · '+item.removed+' removidas · '+item.failed+' falhas · '+bytes(item.bytesEstimate)));
      history.append(row);
    }
    info(report.enabled ?
      'Limpeza de imagens autorizada. A versão ativa e o backup não serão excluídos. Espaço indicado é uma estimativa; camadas Docker podem ser compartilhadas.' :
      'Consulta disponível. Limpeza desligada na VPS; nenhuma imagem será apagada automaticamente.');
  }
  async function refreshManagedRevisions(){
    info('Conferindo revisões e versões antigas na VPS...');
    try { render(await call('/maintenance/revisions')); }
    catch(error){
      get('revisionsCleanupButton').setAttribute('disabled','');
      info('A API ainda não oferece esta consulta ou a VPS está indisponível: '+
        (error instanceof Error?error.message:'falha inesperada')+
        '. O frontend sozinho não consegue garantir que imagens antigas foram removidas.');
    }
  }
  get('revisionsRefreshButton').addEventListener('click',()=>void refreshManagedRevisions());
  get('revisionsCleanupButton').addEventListener('click',async()=>{
    if(!confirm('Excluir SOMENTE imagens antigas importadas pelo Painel?\\n\\nA versão em uso, backups, containers e volumes serão preservados. A operação não poderá ser desfeita.'))return;
    const btn=get('revisionsCleanupButton');
    btn.disabled=true;
    info('Solicitando limpeza de imagens antigas...');
    try{
      const result=await call('/maintenance/revisions/cleanup',{method:'POST',
        headers:{'content-type':'application/json'},body:JSON.stringify({confirm:'LIMPAR_REVISOES_ANTIGAS'})});
      info('Limpeza solicitada: '+result.removed+' imagens removidas, '+result.failed+' falhas. Atualizando...');
      await refreshManagedRevisions();
    }catch(error){info(error instanceof Error?error.message:'Falha ao limpar imagens antigas.');await refreshManagedRevisions();}
  });
  Object.assign(window,{refreshManagedRevisions});
})();
