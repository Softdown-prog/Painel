/** Read-only, credential-free, bounded public contract probe; never logs response bodies. */
const targets=[
 'https://panel.analysepro.com/api/session',
 'https://softload-vps-panel.pages.dev/api/session'
];
const outcomes=[];
for (const target of targets) {
  try {
    const response=await fetch(target,{redirect:'manual',cache:'no-store',
      headers:{accept:'application/json'},signal:AbortSignal.timeout(12000)});
    const type=response.headers.get('content-type')||'';
    const jsonType=/^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(type);
    let valid=false;
    if (jsonType) {
      const bytes=await response.text();
      if (bytes.length<=32768) {
        try {
          const obj=JSON.parse(bytes);
          valid=obj&&typeof obj==='object'&&!Array.isArray(obj)&&
            typeof obj.authenticated==='boolean'&&typeof obj.setupRequired==='boolean';
        } catch { /* invalid JSON */ }
      }
    }
    outcomes.push({target,status:response.status,jsonType,sessionContract:Boolean(valid)});
  } catch {
    outcomes.push({target,status:null,jsonType:false,sessionContract:false,networkError:true});
  }
}
console.log(JSON.stringify({schema_version:1,checkedAt:new Date().toISOString(),
  probes:outcomes,productionVerified:outcomes[0]?.sessionContract===true},null,2));
// A production outage must not silently pass as healthy. Still keep the diagnostic job
// observational: do not gate deployment on transient public connectivity.
