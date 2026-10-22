/* pwa.js: PWA comum aos três painéis (RF-07). Script clássico: window.Pwa e module.exports.
   H2: registro do service worker. H3: banner de dados salvos quando offline. H4: botão Instalar app. */
(function (root) {
  function swUrl(loc) {
    // No GitHub Pages o site fica em /thingy91x-dashboard/; no localhost, na raiz servida.
    const base = /\/thingy91x-dashboard\//.test(loc.pathname) ? '/thingy91x-dashboard/' : '/';
    return { url: base + 'service-worker.js?v=36', scope: base };
  }
  function register() {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const s = swUrl(location);
    navigator.serviceWorker.register(s.url, { scope: s.scope }).catch((e) => console.warn('pwa: service worker não registrado', e));
  }
  // H3: "DD/MM HH:MM" no horário de Brasília
  function fmtCachedAt(iso) {
    const t = Date.parse(iso); if (isNaN(t)) return '';
    const p = {}; new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      .formatToParts(new Date(t)).forEach((x) => { p[x.type] = x.value; });
    return p.day + '/' + p.month + ' ' + p.hour + ':' + p.minute;
  }
  function bannerText(iso) { const f = fmtCachedAt(iso); return f ? 'Sem conexão: mostrando dados salvos de ' + f + ' (BRT)' : ''; }
  function banner(create) {
    if (typeof document === 'undefined') return null;
    let el = document.getElementById('pwaOffline');
    if (!el && create) {
      el = document.createElement('div'); el.id = 'pwaOffline'; el.setAttribute('role', 'status'); el.hidden = true;
      el.style.cssText = 'position:sticky;top:0;z-index:9999;background:#b45309;color:#fff;font:600 14px/1.4 Inter,system-ui,sans-serif;padding:8px 14px;text-align:center';
      document.body.insertBefore(el, document.body.firstChild);
    }
    return el;
  }
  function showOffline(iso) { const t = bannerText(iso); const el = banner(!!t); if (!el) return; el.textContent = t; el.hidden = !t; }
  function hideOffline() { const el = banner(false); if (el) el.hidden = true; }
  // Chamado pelo api-core.js e pelo consumo.js com o JSON da API.
  function noteData(j) { if (j && j.__cachedAt) showOffline(j.__cachedAt); else hideOffline(); return j; }
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('online', hideOffline);
  // H4: botão "Instalar app" só quando o navegador oferecer a instalação.
  let deferred = null;
  function installButton(create) {
    if (typeof document === 'undefined') return null;
    let b = document.getElementById('btnInstalar');
    if (!b && create) {
      const host = document.querySelector('header .actions') || document.querySelector('nav');
      if (!host) return null;
      b = document.createElement('button'); b.id = 'btnInstalar'; b.className = 'btn'; b.type = 'button';
      b.textContent = '⊕ Instalar app'; b.title = 'Instala o painel como aplicativo, com acesso offline aos últimos dados';
      if (host.tagName === 'NAV') b.style.cssText = 'float:right;margin-left:6px';
      b.addEventListener('click', async () => {
        if (!deferred) return;
        const ev = deferred; deferred = null; b.hidden = true;
        try { ev.prompt(); await ev.userChoice; } catch (e) { console.warn('pwa: instalação cancelada', e); }
      });
      host.insertBefore(b, host.firstChild);
    }
    return b;
  }
  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; const b = installButton(true); if (b) b.hidden = false; });
    window.addEventListener('appinstalled', () => { deferred = null; const b = installButton(false); if (b) b.remove(); });
  }
  const Pwa = { swUrl, register, fmtCachedAt, bannerText, showOffline, hideOffline, noteData, installButton };
  if (typeof window !== 'undefined') { window.Pwa = Pwa; if (typeof document !== 'undefined') register(); }
  if (typeof module !== 'undefined' && module.exports) module.exports = Pwa;
})(typeof window !== 'undefined' ? window : globalThis);
