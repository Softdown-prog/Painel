/**
 * Independent, side-effect-free status classification.
 * Green on GitHub is NEVER proof that a revision is installed on the VPS.
 */
export type Tone = 'success' | 'warning' | 'danger' | 'running' | 'muted';
export type Stage = { label: string; tone: Tone };
export type WorkflowRun = {
  id: number;
  sha: string;
  status: string;
  conclusion: string | null;
  createdAt?: string;
  updatedAt?: string;
  name?: string;
  event?: string;
};
export type LinkedProject = {slug: string; repository: string};
export type ReleaseSnapshot = {current?: {state?: string; revision?: string | null}} | null;
export type PublicationJob = {
  slug?: string; repository?: string; runId?: number;
  phase?: string; detail?: string;
};
const SHA = /^[a-f0-9]{40}$/i;
const activePhase: Record<string,string> = {
  queued:'Na fila da VPS',importing:'Importando imagem',staging:'Preparando container',
  health:'Testando saúde',promoting:'Ativando versão'
};
export function validRun(value: unknown): value is WorkflowRun {
  if (!value || typeof value !== 'object') return false;
  const run=value as Partial<WorkflowRun>;
  return typeof run.id === 'number' && Number.isSafeInteger(run.id) && run.id > 0 &&
    typeof run.sha === 'string' && SHA.test(run.sha) &&
    typeof run.status === 'string';
}
export function ciStatus(run: WorkflowRun): Stage {
  if (['queued','pending','waiting','requested'].includes(run.status))
    return {label:'Na fila do GitHub',tone:'running'};
  if (run.status === 'in_progress') return {label:'Compilando no GitHub',tone:'running'};
  if (run.status !== 'completed') return {label:'GitHub não confirmado',tone:'muted'};
  if (run.conclusion === 'success') return {label:'CI aprovado',tone:'success'};
  if (run.conclusion === 'failure' || run.conclusion === 'timed_out' ||
      run.conclusion === 'startup_failure') return {label:'CI falhou',tone:'danger'};
  if (run.conclusion === 'cancelled') return {label:'Cancelado',tone:'warning'};
  return {label:'CI não confirmado',tone:'muted'};
}
export function vpsStatus(
  run: WorkflowRun, repository: string, slug: string | null,
  release: ReleaseSnapshot, jobs: PublicationJob[]
): Stage {
  if (!slug) return {label:'Sem vínculo com a VPS',tone:'muted'};
  // Only the current running container with exactly the requested SHA can be green.
  if (release?.current?.state === 'running' &&
      typeof release.current.revision === 'string' &&
      release.current.revision.toLowerCase() === run.sha.toLowerCase())
    return {label:'Revisão em execução na VPS',tone:'success'};
  const job=jobs.find(item=>item.repository===repository && item.slug===slug &&
    item.runId===run.id);
  if (job?.phase === 'failed' || job?.phase === 'attention')
    return {label:'Publicação exige atenção',tone:'danger'};
  if (job && typeof job.phase==='string' && activePhase[job.phase])
    return {label:activePhase[job.phase] ?? 'Publicação em andamento',tone:'running'};
  if (!release) return {label:'VPS não verificada',tone:'muted'};
  if (release.current?.state === 'running' && SHA.test(release.current.revision ?? '') &&
      release.current.revision?.toLowerCase() !== run.sha.toLowerCase())
    return {label:'Outra revisão em execução',tone:'warning'};
  if (job?.phase === 'completed') return {label:'Concluído; conferir container',tone:'warning'};
  return {label:'Não confirmada na VPS',tone:'muted'};
}

/** GitHub execution details, not evidence of VPS installation. */
export type ActionStep={name:string;status:string;conclusion:string|null;number:number};
export type ActionJob={id:number;name:string;status:string;conclusion:string|null;steps:ActionStep[]};
export function statusIcon(stage:Stage):string {
  return stage.tone==='success'?'✓':stage.tone==='danger'?'×':
    stage.tone==='running'?'↻':stage.tone==='warning'?'!':'·';
}
export function deliveryStatus(run:WorkflowRun, vps:Stage):Stage {
  if(run.status!=='completed') {
    return {label:run.status==='in_progress'?'Workflow em execução':'Aguardando execução',tone:'running'};
  }
  if(run.conclusion==='failure'||run.conclusion==='timed_out'||run.conclusion==='startup_failure')
    return {label:'Workflow falhou',tone:'danger'};
  if(run.conclusion==='cancelled')return {label:'Execução cancelada',tone:'warning'};
  if(vps.tone==='success')return {label:'Revisão confirmada',tone:'success'};
  if(run.conclusion==='success'&&/deploy|publish|page|release|publica/i.test(run.name||''))
    return {label:'Workflow terminou; destino não verificado',tone:'warning'};
  if(run.conclusion==='success')return {label:'Workflow concluído',tone:'muted'};
  return {label:'Entrega não confirmada',tone:'muted'};
}
