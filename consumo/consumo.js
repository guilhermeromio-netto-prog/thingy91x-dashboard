/* Consumo de dados por chip — extraído do inline de consumo/index.html (A4, RF-08.4).
   Lógica idêntica ao original; nenhum comportamento alterado.
   A3: Poll 45 s: dados historicos, sem urgencia de tempo real. */
(function(){
var on=/netlify\.app$/.test(location.hostname);
var B=(on?'':'https://thingy91x-x-dashboard.netlify.app')+'/.netlify/functions/ntn-lab';
var CHIPS={tracker:'Rastreador (chip do NTN)',meter:'Medidor (chip do Utilities)'};
var recs=[];
function devOf(r){return r.dv&&/^m/.test(r.dv)?'meter':'tracker'}
function isSat(r){var n=(r.txNet||r.net||'').toLowerCase();return n&&n!=='catm'&&n!=='lte'&&n!=='ltem'}
function fb(b){if(b==null)return 'sem dados';if(b<1024)return b+' B';if(b<1048576)return (b/1024).toFixed(1)+' KB';return (b/1048576).toFixed(2)+' MB'}
function fd(s){return new Date(s).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})+' (BRT)'}
async function get(q){var r=await fetch(B+q+'&t='+Date.now(),{cache:'no-store'});var j=await r.json();if(window.Pwa)window.Pwa.noteData(j);return Array.isArray(j.records)?j.records:[]}
async function load(){
 try{var a=await Promise.all([get('?pro=1&days=14'),get('?meter=1&days=62')]);var m={};
  a[0].concat(a[1]).forEach(function(r){if(typeof r.bytes!=='number')return;m[r.rx+'|'+r.seq+'|'+devOf(r)]=r});
  recs=Object.values(m).sort(function(x,y){return Date.parse(x.rx)-Date.parse(y.rx)});
  document.getElementById('st').textContent='atualizado '+fd(new Date())+' · próxima em 45 s';
 }catch(e){document.getElementById('st').textContent='falha ao ler a API: '+e.message}
 render()}
function render(){renderP();renderM()}
function renderM(){
 var now=new Date(),y=now.getFullYear(),mo=now.getMonth(),start=new Date(y,mo,1),dim=new Date(y,mo+1,0).getDate();
 var el=(now-start)/864e5,rest=dim-el,sel=document.getElementById('dev').value;
 var mon=recs.filter(function(r){return Date.parse(r.rx)>=start});
 var tb='';Object.keys(CHIPS).forEach(function(k){var rs=mon.filter(function(r){return devOf(r)===k});
  if(!rs.length){tb+='<tr><td>'+CHIPS[k]+'</td><td colspan="5">sem dados</td></tr>';return}
  var c=0,s=0;rs.forEach(function(r){isSat(r)?s+=r.bytes:c+=r.bytes});
  tb+='<tr><td>'+CHIPS[k]+'</td><td>'+rs.length+'</td><td>'+fb(c)+'</td><td>'+(s?fb(s):'0 B')+'</td><td>'+fb(c+s)+'</td><td>'+fd(rs[rs.length-1].rx)+'</td></tr>'});
 document.getElementById('tb').innerHTML=tb;
 var f=mon.filter(function(r){return sel==='all'||devOf(r)===sel});
 var tot=0,sat=0;f.forEach(function(r){tot+=r.bytes;if(isSat(r))sat+=r.bytes});
 var rate=el>0?tot/el:0,proj=tot+rate*rest,last=f.length?fd(f[f.length-1].rx):'sem dados';
 document.getElementById('cards').innerHTML=[['Total no mês',f.length?fb(tot):'sem dados'],['Satélite no mês',f.length?fb(sat):'sem dados'],['Média diária',f.length?fb(Math.round(rate)):'sem dados'],['Projeção do mês',f.length?fb(Math.round(proj)):'sem dados'],['Dias decorridos / restantes',el.toFixed(1)+' / '+rest.toFixed(1)],['Última mensagem',last]].map(function(c){return '<div class="card">'+c[0]+'<b>'+c[1]+'</b></div>'}).join('');
 limAlert(f.length?proj:null);
 var cv=document.getElementById('cv'),g=cv.getContext('2d'),W=cv.width,H=cv.height,P=40;g.clearRect(0,0,W,H);
 if(!f.length){g.fillStyle='#94a3b8';g.font='16px sans-serif';g.fillText('sem dados neste mês',P,H/2);return}
 var mx=Math.max(proj,1),X=function(d){return P+(W-2*P)*d/dim},Y=function(b){return H-P-(H-2*P)*b/mx};
 g.strokeStyle='#334155';g.strokeRect(P,P,W-2*P,H-2*P);g.fillStyle='#94a3b8';g.font='12px sans-serif';g.fillText(fb(Math.round(mx)),4,P-6);g.fillText('dia 1',P,H-P+16);g.fillText('dia '+dim,W-P-40,H-P+16);
 g.strokeStyle='#38bdf8';g.lineWidth=2;g.beginPath();g.moveTo(X(0),Y(0));var acc=0;f.forEach(function(r){acc+=r.bytes;g.lineTo(X((Date.parse(r.rx)-start)/864e5),Y(acc))});g.lineTo(X(el),Y(acc));g.stroke();
 g.setLineDash([6,6]);g.strokeStyle='#f59e0b';g.beginPath();g.moveTo(X(el),Y(tot));g.lineTo(X(dim),Y(proj));g.stroke();g.setLineDash([])}
var H3=3*36e5,mode='dia';
function bd(t){var d=new Date(t-H3);return {y:d.getUTCFullYear(),m:d.getUTCMonth(),d:d.getUTCDate(),h:d.getUTCHours(),w:d.getUTCDay()}}
function T(y,m,d,h){return Date.UTC(y,m,d,h||0)+H3}
var dt=document.getElementById('dt'),t0=bd(Date.now());dt.value=t0.y+'-'+String(t0.m+1).padStart(2,'0')+'-'+String(t0.d).padStart(2,'0');
var pb=document.getElementById('pb');[['dia','Dia'],['semana','Semana'],['mes','Mês']].forEach(function(o){var b=document.createElement('button');b.textContent=o[1];b.dataset.m=o[0];b.style.cssText='margin-right:6px;padding:6px 12px;border-radius:6px;border:1px solid #334155;color:#e5e7eb;cursor:pointer';b.onclick=function(){mode=o[0];render()};pb.appendChild(b)});
var DN=['dom','seg','ter','qua','qui','sex','sáb'],slots=[];
function period(){var p=dt.value.split('-').map(Number),y=p[0],m=p[1]-1,d=p[2],S=[],i;
 var byH=document.getElementById('wkh').checked;
 if(mode==='dia'){for(i=0;i<24;i++)S.push([T(y,m,d,i),T(y,m,d,i+1),String(i).padStart(2,'0')+'h'])}
 else if(mode==='semana'){var w=new Date(Date.UTC(y,m,d)).getUTCDay(),sd=d-w;
  for(i=0;i<7;i++){if(byH){for(var h=0;h<24;h++)S.push([T(y,m,sd+i,h),T(y,m,sd+i,h+1),DN[i]+' '+h+'h'])}else{var q=new Date(Date.UTC(y,m,sd+i));S.push([T(y,m,sd+i),T(y,m,sd+i+1),DN[i]+' '+q.getUTCDate()+'/'+(q.getUTCMonth()+1)])}}}
 else{var n=new Date(Date.UTC(y,m+1,0)).getUTCDate();for(i=1;i<=n;i++)S.push([T(y,m,i),T(y,m,i+1),String(i)])}
 return S}
function renderP(){
 [].forEach.call(pb.children,function(b){b.style.background=b.dataset.m===mode?'#2563eb':'#111a2e'});
 document.getElementById('wkl').style.display=mode==='semana'?'':'none';
 document.getElementById('projbox').style.display=mode==='mes'?'':'none';
 var sel=document.getElementById('dev').value,S=period(),a=S[0][0],z=S[S.length-1][1];
 slots=S.map(function(s){return {a:s[0],b:s[1],l:s[2],c:0,s:0,n:0}});
 var hr=new Array(24).fill(0),c=0,st=0,n=0;
 recs.forEach(function(r){var t=Date.parse(r.rx);if(t<a||t>=z||(sel!=='all'&&devOf(r)!==sel))return;
  for(var i=0;i<slots.length;i++){if(t>=slots[i].a&&t<slots[i].b){isSat(r)?slots[i].s+=r.bytes:slots[i].c+=r.bytes;slots[i].n++;break}}
  isSat(r)?st+=r.bytes:c+=r.bytes;n++;hr[bd(t).h]+=r.bytes});
 var pk=hr.indexOf(Math.max.apply(null,hr)),hrs=Math.max(1,(Math.min(z,Date.now())-a)/36e5);
 document.getElementById('pcards').innerHTML=(n?[['Total',fb(c+st)],['Satélite',fb(st)],['Cat-M',fb(c)],['Mensagens',n],['Hora de pico',String(pk).padStart(2,'0')+'h ('+fb(hr[pk])+')'],['Média por hora',fb(Math.round((c+st)/hrs))]]:[['Período','sem dados']]).map(function(x){return '<div class="card">'+x[0]+'<b>'+x[1]+'</b></div>'}).join('');
 var cv=document.getElementById('bars'),g=cv.getContext('2d'),W=cv.width,Hh=cv.height,P=46;g.clearRect(0,0,W,Hh);
 if(!n){g.fillStyle='#94a3b8';g.font='16px sans-serif';g.fillText('sem dados neste período',P,Hh/2);return}
 var mx=Math.max.apply(null,slots.map(function(s){return s.c+s.s}))||1,bw=(W-2*P)/slots.length,ev=Math.ceil(slots.length/24);
 g.fillStyle='#94a3b8';g.font='12px sans-serif';g.fillText(fb(mx),4,P-8);g.strokeStyle='#334155';g.strokeRect(P,P,W-2*P,Hh-2*P);
 slots.forEach(function(s,i){var x=P+i*bw,hc=(Hh-2*P)*s.c/mx,hs=(Hh-2*P)*s.s/mx;s.x=x;s.w=bw;
  g.fillStyle='#38bdf8';g.fillRect(x+1,Hh-P-hc,Math.max(1,bw-2),hc);g.fillStyle='#f59e0b';g.fillRect(x+1,Hh-P-hc-hs,Math.max(1,bw-2),hs);
  if(i%ev===0){g.fillStyle='#94a3b8';g.fillText(s.l,x+1,Hh-P+16)}})}
function tipAt(ev){var cv=document.getElementById('bars'),r=cv.getBoundingClientRect(),e=ev.touches?ev.touches[0]:ev,x=(e.clientX-r.left)*cv.width/r.width,tp=document.getElementById('tip');
 var s=slots.filter(function(q){return q.x!=null&&x>=q.x&&x<q.x+q.w})[0];if(!s){tp.style.display='none';return}
 tp.innerHTML='<b>'+s.l+'</b><br>Cat-M: '+fb(s.c)+'<br>Satélite: '+fb(s.s)+'<br>Mensagens: '+s.n;tp.style.display='block';
 tp.style.left=Math.min(e.clientX-r.left+10,r.width-160)+'px';tp.style.top=(e.clientY-r.top-60)+'px'}
var bc=document.getElementById('bars');bc.addEventListener('mousemove',tipAt);bc.addEventListener('touchstart',tipAt,{passive:true});bc.addEventListener('mouseleave',function(){document.getElementById('tip').style.display='none'});
dt.onchange=render;document.getElementById('wkh').onchange=render;
/* E3: limite do chip (RF-04.4), configurado pelo operador e salvo neste navegador */
var LIMK='ntn.chipLimitBytes';
function limGet(){var v=+localStorage.getItem(LIMK);return v>0?v:null}
function limAlert(proj){var el=document.getElementById('limAlert'),lim=limGet();if(!el)return;
 if(lim&&proj!=null&&proj>lim){el.innerHTML='<div class="al al--warn">📊 Projeção: '+fb(Math.round(proj))+', acima do limite de '+fb(lim)+' configurado</div>'}else el.innerHTML=''}
var ci=document.getElementById('chipLimit');if(ci){var l0=limGet();if(l0)ci.value=+(l0/1048576).toFixed(3);
 ci.onchange=function(){var mb=parseFloat(String(ci.value).replace(',','.'));if(mb>0)localStorage.setItem(LIMK,String(Math.round(mb*1048576)));else localStorage.removeItem(LIMK);render()}}
/* G4: exportação dos slots do período atual (RF-06), só bytes reais recebidos pela API */
function periodTxt(){var m={dia:'Dia',semana:'Semana',mes:'Mês'}[mode],d=document.getElementById('dev');return m+' de '+dt.value.split('-').reverse().join('/')+' · '+d.options[d.selectedIndex].text}
function expCsv(){var rows=slots.map(function(s){return {inicio:window.ApiCore.fmtDateBRT(s.a),periodo:s.l,catm_bytes:s.c,sat_bytes:s.s,total_bytes:s.c+s.s,mensagens:s.n}});
 var csv=window.ApiCore.toCSV(rows,['inicio','periodo','catm_bytes','sat_bytes','total_bytes','mensagens'],{inicio:'início (BRT)'});
 var a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));a.download='consumo-'+mode+'-'+dt.value+'.csv';a.click();setTimeout(function(){URL.revokeObjectURL(a.href)},2000)}
function expPdf(){var k=[].map.call(document.querySelectorAll('#pcards .card'),function(c){var b=c.querySelector('b');return [c.firstChild?String(c.firstChild.textContent).trim():'',b?b.textContent:'']});
 window.ApiCore.printReport('Consumo de dados por chip',k,'#bars',{period:periodTxt(),version:document.getElementById('st').textContent})}
if(window.ApiCore){document.getElementById('btnCsvC').onclick=expCsv;document.getElementById('btnPdfC').onclick=expPdf}
document.getElementById('dev').onchange=render;load();setInterval(load,45000);
if(window.Apresentacao)window.Apresentacao.init(); // F3: RF-05
})();
