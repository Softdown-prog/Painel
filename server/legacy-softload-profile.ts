// Compatibility profile for the Softload V4 installation already running on the VPS.
// New hosted projects must be registered through projects.ts instead of this file.
export const LEGACY_SOFTLOAD_SERVICES = Object.freeze({
  app: { container: 'softload-vps-app-1', image: 'softload-app', controllable: true },
  agent: { container: 'softload-vps-agent-1', image: 'softload-agent', controllable: true },
  caddy: { container: 'softload-caddy', image: null, controllable: false }
});

export function legacySoftloadEnabled(env: { PANEL_SOFTLOAD_LEGACY?: string } = process.env) {
  return env.PANEL_SOFTLOAD_LEGACY === '1';
}

export function legacySoftloadEntries(enabled = legacySoftloadEnabled()) {
  return enabled ? Object.entries(LEGACY_SOFTLOAD_SERVICES) : [];
}
