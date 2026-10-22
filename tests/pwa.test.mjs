// node tests/pwa.test.mjs
import vm from 'vm'; import fs from 'fs'; import { fileURLToPath } from 'url'; import { dirname, join } from 'path';
const dir = dirname(fileURLToPath(import.meta.url));
const ctx = { window: {}, Date, Intl, console, isNaN };
vm.runInNewContext(fs.readFileSync(join(dir, '../pwa.js'), 'utf8'), ctx);
const P = ctx.window.Pwa; let f = 0;
const ok = (l, c, x = '') => { console.log((c ? '  OK  ' : 'FALHA ') + l + (c ? '' : ' ' + x)); if (!c) f++; };
ok('sw no Pages', P.swUrl({ pathname: '/thingy91x-dashboard/ntn/' }).scope === '/thingy91x-dashboard/');
ok('sw no localhost', P.swUrl({ pathname: '/ntn/' }).url.startsWith('/service-worker.js'));
ok('hora em BRT', P.fmtCachedAt('2026-10-22T13:05:00Z') === '22/10 10:05', P.fmtCachedAt('2026-10-22T13:05:00Z'));
ok('virada de dia em BRT', P.fmtCachedAt('2026-10-23T01:30:00Z') === '22/10 22:30');
ok('texto do banner', P.bannerText('2026-10-22T13:05:00Z') === 'Sem conexão: mostrando dados salvos de 22/10 10:05 (BRT)');
ok('sem data = sem banner', P.bannerText('x') === '');
ok('noteData sem DOM devolve o JSON', P.noteData({ records: [] }).records.length === 0);
// H4: beforeinstallprompt cria o botão e prompt() é chamado no clique
{
  const L = {}; let prompted = 0; const kids = [];
  const btn = { hidden: true, style: {}, listeners: {}, addEventListener(t, fn) { this.listeners[t] = fn; }, remove() { this.removed = true; } };
  const host = { tagName: 'DIV', insertBefore(b) { kids.push(b); } };
  const doc = { getElementById: () => kids[0] || null, querySelector: (q) => (q === 'header .actions' ? host : null), createElement: () => btn };
  const c2 = { window: { addEventListener: (t, fn) => { L[t] = fn; } }, document: doc, navigator: {}, Date, Intl, console, isNaN };
  vm.runInNewContext(fs.readFileSync(join(dir, '../pwa.js'), 'utf8'), c2);
  ok('sem evento, sem botão', kids.length === 0);
  L.beforeinstallprompt({ preventDefault() {}, prompt() { prompted++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  ok('botão Instalar app aparece', kids.length === 1 && btn.hidden === false && btn.textContent.includes('Instalar app'));
  await btn.listeners.click(); ok('prompt() chamado no clique', prompted === 1 && btn.hidden === true);
  L.appinstalled(); ok('botão some após instalar', btn.removed === true);
}
console.log(f ? 'FALHAS: ' + f : 'TODOS OK'); if (f) process.exit(1);
