/* Dados dos workflows para a tabela de revisões abaixo; sem caixa duplicada. */
(() => {
  const summary = document.getElementById('revisionActivitySummary');
  if (!summary) return;
  const phases = {
    queued:'Na fila da VPS', importing:'Importando imagem', staging:'Preparando versão',
    health:'Testando container', promoting:'Ativando versão'
  };
  let busy=false, timer=0;
  function visible() {
    return !document.hidden && location.hash.split('?')[0] === '#revisions';
  }
  function ciState(run) {
    if (['queued','pending','waiting','requested'].includes(run.status))
      return {kind:'running',label:'CI/CD na fila'};
    if (run.status === 'in_progress') return {kind:'running',label:'CI/CD executando'};
    if (run.status === 'completed' && run.conclusion === 'success')
      return {kind:'success',label:'CI/CD aprovado'};
    if (run.status === 'completed' && ['failure','timed_out','startup_failure'].includes(run.conclusion))
      return {kind:'failed',label:'CI/CD falhou'};
    if (run.status === 'completed' && run.conclusion === 'cancelled')
      return {kind:'warning',label:'CI/CD cancelado'};
    return {kind:'neutral',label:'CI/CD não confirmado'};
  }
  function vpsState(run, repo, project, release, history:any[]) {
    if (release?.current?.state === 'running' && release.current.revision === run.sha)
      return {kind:'success',label:'Ativa na VPS'};
    const job=history.find(item=>item.repository===repo.fullName && item.runId===run.id &&
      (!project || item.slug===project.slug));
    if (job?.phase === 'failed' || job?.phase === 'attention')
      return {kind:'failed',label:'Falha na publicação'};
    if (job && phases[job.phase]) return {kind:'running',label:phases[job.phase]};
    if (!project) return {kind:'neutral',label:'Sem vínculo com a VPS'};
    if (!release) return {kind:'neutral',label:'VPS não verificada'};
    if (release.current?.state === 'running' && release.current.revision && release.current.revision !== run.sha)
      return {kind:'warning',label:'Outra revisão ativa'};
    if (job?.phase === 'completed') return {kind:'warning',label:'Concluído; conferir VPS'};
    return {kind:'neutral',label:'Ainda não ativa na VPS'};
  }
  function report(runs, message) {
    window.updateRevisionRuns?.(runs, message);
    summary.textContent=message;
  }
  function schedule(ongoing) {
    window.clearTimeout(timer);
    if (visible()) timer=window.setTimeout(()=>{void refreshRevisionActivity();},ongoing?20000:90000);
  }
  async function refreshRevisionActivity() {
    if (busy || !visible()) return;
    busy=true;
    window.clearTimeout(timer);
    summary.textContent='Conferindo últimas revisões do GitHub e da VPS...';
    try {
      const response=await window.panelApi.request('/repositories');
      const repos=Array.isArray(response.repositories) ? response.repositories.filter((repo)=>
        typeof repo.fullName==='string' && /^Softdown-prog\/[A-Za-z0-9_.-]+$/.test(repo.fullName) &&
        typeof repo.workflow==='string') : [];
      if (!repos.length) {
        report([], 'Nenhum repositório com workflow conectado. Conecte-o na aba Publicações.');
        schedule(false);return;
      }
      const [projectsData,publicationsData]=await Promise.all([
        window.panelApi.request('/projects').catch(()=>null),
        window.panelApi.request('/publications').catch(()=>null)
      ]);
      const projects=Array.isArray(projectsData?.projects)?projectsData.projects:[];
      const history=Array.isArray(publicationsData?.history)?publicationsData.history:[];
      const groups=await Promise.all(repos.map(async(repo)=>{
        const project=projects.find((item)=>item.repository===repo.fullName);
        const [runsResult,releaseResult]=await Promise.allSettled([
          window.panelApi.request('/repositories/'+repo.fullName+'/runs'),
          project && typeof project.slug==='string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.slug)
            ? window.panelApi.request('/projects/'+project.slug+'/releases'):Promise.resolve(null)
        ]);
        return {repo,project,runs:runsResult.status==='fulfilled' &&
          Array.isArray(runsResult.value?.runs)?runsResult.value.runs.slice(0,5):null,
          release:releaseResult.status==='fulfilled'?releaseResult.value:null};
      }));
      const rows=[];
      let failures=0,ongoing=false,active=0;
      for (const group of groups) {
        if (!group.runs) { failures++;continue; }
        for (const run of group.runs) {
          if (!Number.isSafeInteger(run.id) || run.id<=0 ||
            typeof run.sha!=='string' || !/^[0-9a-f]{40}$/i.test(run.sha) ||
            typeof run.status!=='string') continue;
          const ci=ciState(run);
          const vps=vpsState(run,group.repo,group.project,group.release,history);
          if(ci.kind==='running'||vps.kind==='running')ongoing=true;
          if(vps.kind==='success')active++;
          rows.push({
            repository:group.repo.fullName,
            slug:group.project?.slug || group.repo.fullName,
            sha:run.sha.toLowerCase(),runId:run.id,createdAt:run.createdAt||'',
            ci,vps,url:'https://github.com/'+group.repo.fullName+'/actions/runs/'+run.id
          });
        }
      }
      rows.sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
      report(rows,'Atualizado às '+new Date().toLocaleTimeString('pt-BR')+' · '+
        active+' revisão(ões) confirmada(s) na VPS'+
        (failures?' · '+failures+' consulta(s) GitHub indisponível(is)':'')+
        '. Verde no CI não garante deploy nem acesso público.');
      schedule(ongoing);
    }catch(error){
      report([], 'Não foi possível consultar o GitHub: '+
        (error instanceof Error?error.message:'erro inesperado')+'.');
      schedule(false);
    }finally{busy=false;}
  }
  document.addEventListener('visibilitychange',()=>{
    if(visible())void refreshRevisionActivity();
    else window.clearTimeout(timer);
  });
  Object.assign(window,{refreshRevisionActivity});
})();
