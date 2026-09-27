// UI language for engine texts: ?lang=ja|en (pages pass it on to their workers), else the saved
// choice, else the browser language (Japanese browsers get Japanese, everyone else English).
const pick = () => {
  try { const q = new URLSearchParams(globalThis.location?.search || '').get('lang'); if (q === 'ja' || q === 'en') { try { globalThis.localStorage?.setItem('aether-lang', q); } catch {} return q; } } catch {}
  try { const s = globalThis.localStorage?.getItem('aether-lang'); if (s === 'ja' || s === 'en') return s; } catch {}
  return /^ja\b/i.test(globalThis.navigator?.language || '') ? 'ja' : 'en';
};
export const LANG = pick();
export const tr = (ja, en) => (LANG === 'ja' ? ja : en);

// Save the choice and reload so every text (including worker-made ones) switches together.
export function setLang(l) {
  try { localStorage.setItem('aether-lang', l); } catch {}
  const u = new URL(location.href);
  u.searchParams.delete('lang');
  location.replace(u.href);
}
