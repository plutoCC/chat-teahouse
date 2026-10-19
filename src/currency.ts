import { useSyncExternalStore } from 'react';
import { DEFAULT_USD_CNY, validExchangeRate } from '../shared/pricing';

const key = 'teahouse-estimated-usd-cny';
const listeners = new Set<() => void>();
function read() {
  try { const n = Number(localStorage.getItem(key)); return validExchangeRate(n) ? n : DEFAULT_USD_CNY; }
  catch { return DEFAULT_USD_CNY; }
}
let rate = read();
function publish(next: number) { rate = next; for (const listener of listeners) listener(); }
window.addEventListener('storage', e => { if (e.key === key || e.key === null) publish(read()); });
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const useExchangeRate = () => useSyncExternalStore(subscribe, () => rate);
export function setExchangeRate(next: number) {
  if (!validExchangeRate(next)) return;
  try { localStorage.setItem(key, String(next)); } catch { /* Usable for this tab even if storage is unavailable. */ }
  publish(next);
}
