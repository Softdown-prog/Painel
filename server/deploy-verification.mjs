// Read-only verification of the running Softload images.
// Do not use the deployment .env file as proof that a container was updated.
export const CORE_IMAGES = Object.freeze({
  app: ['softload-vps-app-1', 'softload-app'],
  agent: ['softload-vps-agent-1', 'softload-agent'],
  sandbox: ['softload-vps-sandbox-1', 'softload-sandbox'],
  embeddings: ['softload-vps-embeddings-1', 'softload-embeddings']
});
const SHA = /^[a-f0-9]{40}$/;

export function revisionFromImage(image, service) {
  if (typeof image !== 'string') return null;
  const parts = image.match(/^([^@]+):([a-f0-9]{40})$/);
  if (!parts) return null;
  const repository = parts[1].split('/').pop();
  return repository === CORE_IMAGES[service]?.[1] ? parts[2] : null;
}

export function runDeploymentStatus(run, runtime, publicHealth=null) {
  if (['queued','pending','waiting'].includes(run.status)) return 'queued';
  if (run.status === 'in_progress') return 'building';
  if (run.conclusion === 'cancelled') return 'cancelled';
  if (run.conclusion === 'failure') return 'failed';
  if (run.conclusion !== 'success' || run.status !== 'completed') return 'unknown';
  if (runtime?.app?.status !== 'verified') return 'unconfirmed';
  if(run.sha !== runtime.app.revision)return 'superseded';
  if(publicHealth?.status === 'matched')return 'published';
  if(publicHealth?.status === 'different')return 'public-mismatch';
  return 'active';
}

export async function inspectDeployedServices(request, configuredSha) {
  const entries = await Promise.all(Object.entries(CORE_IMAGES).map(async ([id,[name]]) => {
    try {
      const response = await request('/containers/' + name + '/json');
      if (response.status === 404) return [id,{status:'missing',running:false,revision:null,image:null}];
      if (response.status !== 200) return [id,{status:'unavailable',running:false,revision:null,image:null}];
      const raw = JSON.parse(response.buffer.toString('utf8'));
      // Check identity as well as the image tag to avoid treating an unrelated container as a service.
      if (raw?.Name !== '/' + name || typeof raw?.State?.Running !== 'boolean')
        return [id,{status:'unavailable',running:false,revision:null,image:null}];
      const image = typeof raw.Config?.Image === 'string' ? raw.Config.Image : null;
      const revision = revisionFromImage(image,id);
      const running = raw.State.Running;
      return [id,{status:!running?'stopped':revision?'verified':'unconfirmed',
        running,revision,image}];
    } catch {
      return [id,{status:'unavailable',running:false,revision:null,image:null}];
    }
  }));
  const services=Object.fromEntries(entries);
  const app=services.app;
  const sha=SHA.test(configuredSha || '') ? configuredSha : null;
  return {
    app,services,configuredSha:sha,
    configuredMatchesRunning:sha && app.status==='verified'?sha===app.revision:null,
    source:'docker-container-inspect',
    checkedAt:new Date().toISOString()
  };
}
