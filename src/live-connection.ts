/** Recreate terminally closed EventSources as well as transiently disconnected ones. */
export function connectRoomEvents(refresh: () => Promise<void>, setConnected: (connected: boolean) => void): () => void {
  let source: EventSource | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let updateTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let retryDelay = 2000;
  let generation = 0;
  const retry = () => {
    if (stopped || retryTimer) return;
    setConnected(false); generation++;
    source?.close(); clearTimeout(updateTimer); updateTimer = undefined;
    retryTimer = setTimeout(() => { retryTimer = undefined; connect(); }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  };
  const update = () => {
    if (stopped || updateTimer) return;
    const current = generation;
    updateTimer = setTimeout(() => {
      updateTimer = undefined;
      void refresh().then(() => {
        if (!stopped && current === generation && source?.readyState === EventSource.OPEN) { retryDelay = 2000; setConnected(true); }
      }).catch(() => { if (!stopped && current === generation) retry(); });
    }, 120);
  };
  const connect = () => {
    if (stopped) return;
    generation++;
    source = new EventSource('/api/events');
    source.addEventListener('change', update);
    source.onopen = update;
    source.onerror = retry;
  };
  connect();
  return () => { stopped = true; generation++; source?.close(); clearTimeout(retryTimer); clearTimeout(updateTimer); };
}
