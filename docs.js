// AetherMaster 5 — documentation pages: language switch (same choice as the app: ?lang, saved, browser).
// Copyright (c) 2026 Sonografica. All rights reserved.
(() => {
  const get = () => {
    try { const q = new URLSearchParams(location.search).get('lang'); if (q === 'ja' || q === 'en') return q; } catch {}
    try { const s = localStorage.getItem('aether-lang'); if (s === 'ja' || s === 'en') return s; } catch {}
    return /^ja\b/i.test(navigator.language || '') ? 'ja' : 'en';
  };
  const apply = (l) => {
    document.documentElement.lang = l;
    const t = document.querySelector(`title[data-${l}]`) || document.querySelector('title');
    if (t && t.dataset[l]) document.title = t.dataset[l];
    const b = document.getElementById('langSw');
    if (b) b.textContent = l === 'ja' ? 'EN' : '日本語';
  };
  let lang = get();
  apply(lang);
  document.addEventListener('DOMContentLoaded', () => {
    apply(lang);
    document.getElementById('langSw')?.addEventListener('click', () => {
      lang = lang === 'ja' ? 'en' : 'ja';
      try { localStorage.setItem('aether-lang', lang); } catch {}
      apply(lang);
    });
  });
})();
