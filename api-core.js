/* api-core.js: Nucleo comum de API da Plataforma NTN 2.0 (RF-01).
   Script classico no navegador (window.ApiCore) e CommonJS (require) nos testes Node.
   Sem dependencias externas; sem acesso ao DOM. */

// Resolucao da URL base: vazia apenas no Netlify (netlify.app).
// Localhost, GitHub Pages e qualquer outro host usam a URL completa.
const BASE_URL = (typeof location !== 'undefined' && /netlify\.app$/i.test(location.hostname))
  ? ''
  : 'https://thingy91x-x-dashboard.netlify.app';

const API = BASE_URL + '/.netlify/functions/ntn-lab';

// ---------- fetch ----------

// H3: avisa o pwa.js se a resposta veio do cache offline (campo __cachedAt).
function noteOffline(j) {
  if (typeof window !== 'undefined' && window.Pwa && window.Pwa.noteData) window.Pwa.noteData(j);
  return j;
}

/**
 * Busca registros do Rastreador.
 * @param {number} days - janela em dias (padrao 7)
 * @returns {Promise<object[]>}
 */
async function fetchTracker(days = 7) {
  const r = await fetch(API + '?pro=1&days=' + days + '&t=' + Date.now(), { cache: 'no-store' });
  const j = noteOffline(await r.json());
  return Array.isArray(j.records) ? j.records : [];
}

/**
 * Busca registros do Medidor (Utilities).
 * @param {number} days - janela em dias (padrao 62)
 * @returns {Promise<object[]>}
 */
async function fetchMeter(days = 62) {
  const r = await fetch(API + '?meter=1&days=' + days + '&t=' + Date.now(), { cache: 'no-store' });
  const j = noteOffline(await r.json());
  return Array.isArray(j.records) ? j.records : [];
}

// ---------- dedup ----------

/**
 * Remove registros duplicados e ordena por ts.
 * Chave: rx|seq|type|dv, mesmo criterio usado em consumo.js.
 * Em colisao, mantém o registro com mais campos preenchidos.
 * @param {object[]} records
 * @returns {object[]}
 */
function dedup(records) {
  const m = new Map();
  for (const r of records) {
    const key = (r.rx || r.ts || '') + '|' + (r.seq ?? '') + '|' + (r.type || '') + '|' + (r.dv || '');
    const existing = m.get(key);
    if (!existing || Object.keys(r).length > Object.keys(existing).length) {
      m.set(key, r);
    }
  }
  return [...m.values()].sort((a, b) => {
    const ta = Date.parse(a.ts || a.rx || '');
    const tb = Date.parse(b.ts || b.rx || '');
    return ta - tb || (a.seq ?? 0) - (b.seq ?? 0);
  });
}

// ---------- formatacao ----------

/**
 * Formata segundos em texto legivel (pt-BR).
 * Ex.: fmtDur(90) -> "1 min 30 s"
 * @param {number|null} s
 * @returns {string}
 */
function fmtDur(s) {
  if (s == null || !isFinite(s)) return 'sem dados';
  s = Math.round(s);
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.floor(s / 60) + ' min ' + String(s % 60).padStart(2, '0') + ' s';
  return Math.floor(s / 3600) + ' h ' + String(Math.floor((s % 3600) / 60)).padStart(2, '0') + ' min';
}

/**
 * Formata bytes em texto legivel (pt-BR).
 * Ex.: fmtBytes(2048) -> "2,0 KB"
 * @param {number|null} b
 * @returns {string}
 */
function fmtBytes(b) {
  if (b == null) return 'sem dados';
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' KB';
  return (b / 1048576).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' MB';
}

/**
 * Retorna "ha X s/min/h" a partir de uma string ISO.
 * @param {string} isoString
 * @returns {string}
 */
function ago(isoString) {
  if (!isoString) return 'sem dados';
  const s = Math.round((Date.now() - Date.parse(isoString)) / 1000);
  if (s < 0) return 'agora';
  if (s < 90) return 'há ' + s + ' s';
  if (s < 5400) return 'há ' + Math.round(s / 60) + ' min';
  if (s < 172800) return 'há ' + Math.round(s / 3600) + ' h';
  return 'há ' + Math.round(s / 86400) + ' d';
}

// ---------- exportacao CSV e relatorio PDF (RF-06, G1) ----------

const TZ = 'America/Sao_Paulo';
// Campos que nunca saem num CSV ou relatorio (custo, tarifa, margem).
const BLOCKED_COL = /(custo|cost|price|preco|tarif|margem|margin)/i;
// Identificadores do chip: so os 4 ultimos digitos.
const MASKED_COL = /^(iccid|imsi|ic)$/i;
// Coordenadas: arredondadas a 2 casas (cerca de 1 km), nunca a posicao exata.
const COORD_COL = /^(lat|lon|lng)$/i;
const DATE_COL = /^(ts|rx|since|start|end|exportedAt)$/;

function fmtDateBRT(v) {
  const t = typeof v === 'number' ? v : Date.parse(v);
  if (v == null || v === '' || isNaN(t)) return '';
  return new Date(t).toLocaleString('pt-BR', { timeZone: TZ });
}

function maskId(v) {
  const x = String(v == null ? '' : v).replace(/\s/g, '');
  return x ? '•••• ' + x.slice(-4) : '';
}

/** Valor seguro para exportacao: aplica as regras de privacidade por coluna. */
function safeValue(col, v) {
  if (v == null) return '';
  if (MASKED_COL.test(col)) return maskId(v);
  if (COORD_COL.test(col)) { const n = Number(v); return isFinite(n) ? n.toFixed(2).replace('.', ',') : ''; }
  if (DATE_COL.test(col)) return fmtDateBRT(v);
  if (typeof v === 'number') return isFinite(v) ? String(v).replace('.', ',') : '';
  if (typeof v === 'boolean') return v ? 'sim' : 'não';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function csvCell(x) {
  return /[";\r\n]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x;
}

/**
 * Gera CSV pronto para o Excel em pt-BR: BOM, separador ';', CRLF,
 * datas em horario de Brasilia e numeros com virgula decimal.
 * Colunas de custo sao descartadas, ICCID/IMSI mascarados e coordenadas arredondadas.
 * @param {object[]} records
 * @param {string[]} columns - chaves na ordem desejada
 * @param {object} [labelMap] - chave -> titulo da coluna
 * @returns {string}
 */
function toCSV(records, columns, labelMap = {}) {
  const cols = (columns || []).filter((c) => !BLOCKED_COL.test(c) && !BLOCKED_COL.test(labelMap[c] || ''));
  const head = cols.map((c) => csvCell(String(labelMap[c] || c)));
  const lines = (records || []).map((r) => cols.map((c) => csvCell(safeValue(c, r ? r[c] : null))).join(';'));
  return '\ufeff' + [head.join(';'), ...lines].join('\r\n');
}

function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * HTML do relatorio (puro, testavel). kpis: [[rotulo, valor], ...].
 * KPIs de custo sao descartados.
 */
function reportHTML(title, kpis, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const rows = (kpis || []).filter((k) => k && !BLOCKED_COL.test(String(k[0])) && !/R\$/.test(String(k[1])));
  return '<header class="pr-h"><h1>' + escHtml(title) + '</h1>'
    + '<p><b>Período:</b> ' + escHtml(opts.period || 'sem dados') + '</p>'
    + '<p><b>Gerado em:</b> ' + escHtml(fmtDateBRT(now)) + ' (horário de Brasília)</p></header>'
    + '<h2>Indicadores</h2><table class="pr-k"><tbody>'
    + (rows.length ? rows.map((k) => '<tr><th>' + escHtml(k[0]) + '</th><td>' + escHtml(k[1]) + '</td></tr>').join('') : '<tr><td>sem dados</td></tr>')
    + '</tbody></table><div class="pr-chart"></div>'
    + '<p class="pr-note">Dados reais lidos da API no momento da geração. Sem coordenadas exatas, sem ICCID ou IMSI completos e sem valores de custo.</p>'
    + '<footer class="pr-f">' + escHtml(opts.version || '') + '</footer>';
}

const PRINT_CSS = '#printReport{display:none}'
  + '@media print{body>*:not(#printReport){display:none!important}'
  + '#printReport{display:block!important;font:11pt/1.4 Inter,Arial,sans-serif;color:#000;background:#fff}'
  + '#printReport h1{font-size:18pt;margin:0 0 4pt}#printReport h2{font-size:12pt;margin:12pt 0 4pt}'
  + '#printReport p{margin:2pt 0}#printReport table{border-collapse:collapse;width:100%}'
  + '#printReport th,#printReport td{border:1px solid #bbb;padding:3pt 6pt;text-align:left}'
  + '#printReport th{width:40%;background:#f2f2f2}#printReport .pr-chart img,#printReport .pr-chart svg{max-width:100%;height:auto;margin-top:8pt;page-break-inside:avoid}'
  + '#printReport .pr-note,#printReport .pr-f{font-size:9pt;color:#444;margin-top:10pt}'
  + '@page{margin:14mm}}';

/**
 * Monta o relatorio e abre a impressao do navegador (Salvar como PDF).
 * @param {string} title
 * @param {Array<[string,string]>} kpis
 * @param {string} [chartSelector] - seletor CSS de canvas ou svg a incluir
 * @param {object} [opts] - { period, version }
 */
function printReport(title, kpis, chartSelector, opts = {}) {
  if (typeof document === 'undefined') return;
  if (!document.getElementById('printReportCss')) {
    const st = document.createElement('style'); st.id = 'printReportCss'; st.textContent = PRINT_CSS; document.head.appendChild(st);
  }
  let box = document.getElementById('printReport');
  if (!box) { box = document.createElement('div'); box.id = 'printReport'; document.body.appendChild(box); }
  box.innerHTML = reportHTML(title, kpis, opts);
  const slot = box.querySelector('.pr-chart');
  if (chartSelector) document.querySelectorAll(chartSelector).forEach((el) => {
    try {
      if (el.tagName === 'CANVAS') { const img = document.createElement('img'); img.src = el.toDataURL('image/png'); slot.appendChild(img); }
      else slot.appendChild(el.cloneNode(true));
    } catch (e) { console.warn('printReport: gráfico não incluído', e); }
  });
  const clean = () => { box.innerHTML = ''; window.removeEventListener('afterprint', clean); };
  window.addEventListener('afterprint', clean);
  window.print();
}

/** Le os KPIs visiveis de um container (.kpi com <small> rotulo e <b>/.big valor). */
function kpisFromDom(sel) {
  if (typeof document === 'undefined') return [];
  const t = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  return [...document.querySelectorAll(sel + ' .kpi')].map((k) => [t(k.querySelector('small')), t(k.querySelector('.big') || k.querySelector('b'))]).filter((k) => k[0]);
}

// ---------- exportacao ----------

// Navegador sem bundler: expoe via window.ApiCore
if (typeof window !== 'undefined') {
  window.ApiCore = { BASE_URL, API, fetchTracker, fetchMeter, dedup, fmtDur, fmtBytes, ago, toCSV, printReport, reportHTML, fmtDateBRT, maskId, kpisFromDom };
}

// CommonJS (Node.js nos testes)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { BASE_URL, API, fetchTracker, fetchMeter, dedup, fmtDur, fmtBytes, ago, toCSV, printReport, reportHTML, fmtDateBRT, maskId, kpisFromDom };
}
