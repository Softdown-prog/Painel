(() => {
  let items=[];
  let enabled=false;
  const get=(id)=>document.getElementById(id);
  const message=(value)=>{get('secretsNotice').textContent=value;};
  const text=(tag,value)=>{
    const node=document.createElement(tag);node.textContent=value;return node;
  };
  async function request(path,options={}){
    const result=await fetch('/api'+path,{credentials:'same-origin',cache:'no-store',...options});
    const data=await result.json().catch(()=>({}));
    if(!result.ok)throw new Error(data.error||'Falha na VPS ('+result.status+').');
    return data;
  }
  const date=(value)=>value?new Date(value).toLocaleString('pt-BR'):'—';
  async function refreshPanelSecrets(){
    message('Conferindo os arquivos de chaves na VPS...');
    const list=get('secretsList');list.replaceChildren();
    const connections=get('secretsConnections');connections.replaceChildren();
    try {
      const data=await request('/secrets');
      items=data.entries||[];enabled=data.enabled;
      get('secretsTotal').textContent=String(items.filter(x=>x.installed).length);
      (get('secretsSave')).disabled=!enabled;
      if(!enabled){
        message('A área de chaves ainda não foi ativada na VPS. Consulte o guia de configuração.');
        list.textContent='A configuração do servidor precisa ser habilitada antes de cadastrar chaves.';
        return;
      }
      for(const c of data.connections||[]){
        const row=text('p',c.label+': '+(c.configured?'Arquivo conectado':'Ainda não configurado')+
          (c.managed?' · gerenciado por esta pasta':''));
        connections.append(row);
      }
      if(!items.length)list.textContent='Nenhuma chave cadastrada nesta pasta da VPS.';
      for(const item of items){
        const row=document.createElement('div');row.className='secret-item';
        const details=document.createElement('div');details.className='secret-details';
        details.append(text('strong',item.label),text('small',item.name+' · '+(item.category==='sistema'?'Sistema':'Aplicação')),
          text('small',item.installed?'Chave guardada na VPS · alterada '+date(item.updatedAt):
            'Arquivo não encontrado na VPS'));
        const action=document.createElement('button');action.type='button';
        action.className='secondary-button';action.textContent='Excluir chave';
        action.addEventListener('click',()=>void removeSecret(item.name));
        row.append(details,action);list.append(row);
      }
      message('As chaves ficam na VPS. O valor não pode ser visualizado novamente; para trocá-lo, salve uma nova chave com o mesmo nome.');
    }catch(error){
      enabled=false;(get('secretsSave')).disabled=true;
      message(error instanceof Error?error.message:'A consulta de chaves falhou.');
    }
  }
  async function removeSecret(name){
    if(!enabled)return;
    const password=(get('secretsAdminPassword')).value;
    if(!password){message('Digite sua senha administrativa no formulário para confirmar a exclusão.');return;}
    if(!confirm('Excluir o arquivo '+name+' da VPS?\n\nServiços que usam essa chave poderão parar de funcionar ao reiniciar.'))return;
    try{
      const result=await request('/secrets/'+encodeURIComponent(name),{
        method:'DELETE',headers:{'content-type':'application/json'},
        body:JSON.stringify({password,confirm:name})
      });
      (get('secretsAdminPassword')).value='';
      await refreshPanelSecrets();message(result.message);
    }catch(error){message(error instanceof Error?error.message:'Não foi possível excluir.');}
  }
  get('secretsForm').addEventListener('submit',async event=>{
    event.preventDefault();
    if(!enabled)return;
    const name=(get('secretName')).value.trim();
    const label=(get('secretLabel')).value.trim();
    const category=(get('secretCategory')).value;
    const value=(get('secretValue')).value;
    const password=(get('secretsAdminPassword')).value;
    if(!password){message('Digite sua senha administrativa para salvar esta chave na VPS.');return;}
    if(items.some(x=>x.name===name) &&
      !confirm('Já existe uma chave com esse nome. Substituir o arquivo na VPS?'))return;
    const button=get('secretsSave');button.disabled=true;
    try{
      const result=await request('/secrets',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({name,label,category,value,password})
      });
      (get('secretsForm')).reset();
      (get('secretValue')).value='';
      (get('secretsAdminPassword')).value='';
      await refreshPanelSecrets();
      message(result.message);
    }catch(error){message(error instanceof Error?error.message:'Falha ao salvar a chave na VPS.');}
    finally{button.disabled=!enabled;}
  });
  get('secretsRefresh').addEventListener('click',()=>void refreshPanelSecrets());
  Object.assign(window,{refreshPanelSecrets});
})();