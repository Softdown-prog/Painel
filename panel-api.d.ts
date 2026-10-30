export {};
declare global {
interface PanelApiClient {
  request<T = unknown>(path: string, options?: RequestInit): Promise<T>;
}
interface Window { panelApi: PanelApiClient; }
}
