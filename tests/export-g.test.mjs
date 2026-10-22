// tests/export-g.test.mjs: verificacoes do Bloco G (RF-06) nos paineis
// Execucao: node tests/export-g.test.mjs
import fs from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rd = (p) => fs.readFileSync(join(root, p), 'utf8');
let passed = 0, failed = 0;
function ok(label, cond) { if (cond) { console.log('  OK  ' + label); passed++; } else { console.error('FALHA ' + label); failed++; } }

console.log('\n=== G2 Rastreador ===');
{
  const js = rd('ntn/pro.js'), html = rd('ntn/index.html');
  ok('CSV via ApiCore.toCSV', /A\.toCSV\(/.test(js) && !/P\.toCSV\(/.test(js));
  ok('relatório via ApiCore.printReport', /A\.printReport\(/.test(js) && !/=== 'print'\) window\.print\(\)/.test(js));
  ok('colunas sem custo nem célula', !/'(cost|custo|cell|iccid|imsi)'/.test(js.match(/const CSV_COLS = \[[^\]]*\]/)[0]));
  ok('log completo sem separador vírgula', !/head\.join\(','\)/.test(js));
  ok('api-core com versão nova', /api-core\.js\?v=([2-9]|\d\d)/.test(html));
}
console.log('\n=== G3 Utilities ===');
{
  const js = rd('utilities/utilities.js'), html = rd('utilities/index.html');
  ok('botões CSV e PDF no HTML', /id="btnCsvU"[^>]*>⇩ Exportar CSV/.test(html) && /id="btnPdfU"[^>]*>⎙ Relatório PDF/.test(html));
  ok('colunas do design com totalL e deltaL', /CSV_U = \['ts', 'rx', 'type', 'net', 'totalL', 'deltaL', 'rsrp', 'snr', 'late', 'bytes', 'event', 'info'\]/.test(js));
  ok('usa toCSV e printReport do api-core', /ApiCore\.toCSV\(/.test(js) && /ApiCore\.printReport\(/.test(js));
  ok('sem tarifa no export', !/tariff/.test(js.slice(js.indexOf('G3:'), js.indexOf('async function load'))));
  ok('versões novas', /api-core\.js\?v=([2-9]|\d\d)/.test(html) && /utilities\.js\?v=15/.test(html));
}
console.log('\n=== G4 Consumo ===');
{
  const js = rd('consumo/consumo.js'), html = rd('consumo/index.html');
  ok('botões CSV e PDF no HTML', /id="btnCsvC"/.test(html) && /id="btnPdfC"/.test(html));
  ok('api-core carregado antes do consumo.js', /api-core\.js\?v=([2-9]|\d\d)/.test(html) && html.indexOf('api-core.js') < html.indexOf('consumo.js?v='));
  ok('colunas de bytes por período', /'periodo','catm_bytes','sat_bytes','total_bytes','mensagens'/.test(js));
}
console.log('\n' + (failed === 0 ? 'TODOS OK' : 'FALHAS: ' + failed) + ': ' + passed + ' passaram, ' + failed + ' falharam');
if (failed > 0) process.exit(1);
