/** Leitura conservadora de RAM: MemAvailable desconta cache recuperável. */
export function memorySnapshot(total: number, free: number, meminfo = '') {
  const size = Number.isFinite(total) && total > 0 ? total : 0;
  const match = /^MemAvailable:\s*(\d+)\s+kB\s*$/m.exec(meminfo);
  const candidate = match ? Number(match[1]) * 1024 : NaN;
  const valid = Number.isFinite(candidate) && candidate >= 0 && candidate <= size;
  const available = valid ? candidate : Math.max(0, Math.min(size, Number.isFinite(free) ? free : 0));
  return { total: size, used: size - available, available, source: valid ? 'memavailable' : 'os-freemem' };
}
