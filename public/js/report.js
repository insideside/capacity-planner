// Отчёт о выполнении релиза — отдельная страница для просмотра и сохранения в PDF.
// Данные читаются с сервера (сессия планировщика) и пересчитываются при каждом изменении проекта.
var R={project:null,access:null,periodId:null,phase:'all',pollMs:10000,loadedAt:null};

function ge(id){return document.getElementById(id);}
function escH(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
function fmtH(h){return h.toLocaleString('ru')+' ч';}
function fmtD(s){if(!s)return '—';var p=s.split('-');return p[2]+'.'+p[1]+'.'+p[0];}
function hashArgs(){var o={};location.hash.replace(/^#/,'').split('&').forEach(function(kv){var i=kv.indexOf('=');if(i>0)o[kv.slice(0,i)]=decodeURIComponent(kv.slice(i+1));});return o;}
function setHash(){history.replaceState(null,'','#p='+encodeURIComponent(R.project.projectId)+'&v='+encodeURIComponent(R.periodId)+(R.phase!=='all'?'&f='+R.phase:''));}
function inPhase(p,t){return R.phase==='all'||CPCalc.phaseOf(p,t)===R.phase;}

function api(url){
  return fetch(url,{credentials:'same-origin',cache:'no-store'}).then(function(r){
    return r.json().catch(function(){return {};}).then(function(d){if(!r.ok){var e=new Error(d.message||('HTTP '+r.status));e.status=r.status;throw e;}return d;});
  });
}
function showError(e){
  ge('report').innerHTML='<div class="empty">'+(e.status===401
    ?'Сессия не найдена. <a href="/">Войдите в планировщик</a> и откройте отчёт снова.'
    :escH(e.message))+'</div>';
}

function load(){
  var a=hashArgs();
  if(!a.p){showError(new Error('Не указан проект'));return Promise.resolve();}
  return api('/api/projects/'+encodeURIComponent(a.p)).then(function(d){
    R.project=d.project;R.access=d.access;R.loadedAt=new Date();
    var ids=R.project.periods.map(function(p){return p.id;});
    R.periodId=ids.indexOf(R.periodId||a.v)>=0?(R.periodId||a.v):ids[0];
    if(!R.loadedOnce){R.phase=(a.f==='dev'||a.f==='tst')?a.f:'all';ge('phaseSel').value=R.phase;R.loadedOnce=true;}
    ge('backLink').href='/#p='+encodeURIComponent(R.project.projectId);
    renderSel();render();setHash();
  }).catch(showError);
}
function renderSel(){
  ge('verSel').innerHTML=R.project.periods.map(function(p){
    return '<option value="'+escH(p.id)+'"'+(p.id===R.periodId?' selected':'')+'>'+escH(p.name)+(p.closed?' 🔒':'')+'</option>';
  }).join('');
}

function aggRow(name,a,extraFirst){
  return '<tr><td>'+(extraFirst||'')+escH(name)+'</td>'
    +'<td>'+a.total.n+'</td><td>'+a.done.n+'</td><td>'+a.wip.n+'</td><td>'+a.new.n+'</td>'
    +'<td>'+a.total.h.toLocaleString('ru')+'</td><td>'+a.done.h.toLocaleString('ru')+'</td>'
    +'<td><span class="mini"><span style="width:'+a.pctH+'%"></span></span>'+a.pctH+'%</td></tr>';
}
var AGG_HEAD='<thead><tr><th>{first}</th><th>Задач</th><th>Выполн.</th><th>В работе</th><th>Новые</th><th>Часов</th><th>Выполн., ч</th><th>% по часам</th></tr></thead>';

function taskList(p,status,title){
  var rows='',cur=null,curShown=false,n=0,h=0;
  p.tasks.forEach(function(t){
    if(t.s&&t.d===0){cur=t;curShown=false;return;}
    if(t.s||!p.chk[t.w]||CPCalc.taskStatus(t)!==status||!inPhase(p,t))return;
    if(cur&&!curShown){rows+='<tr class="grp"><td colspan="4">'+escH(cur.n)+'</td></tr>';curShown=true;}
    var r=p.res[t.r];
    rows+='<tr><td style="padding-left:14px">'+escH(t.n)+'</td><td>'+escH(t.w)+'</td>'
      +'<td>'+(r?'<span class="dot" style="background:'+escH(r.color)+'"></span>'+escH(r.label):'— без ресурса')+'</td>'
      +'<td class="r">'+t.h+'</td></tr>';
    n++;h+=t.h;
  });
  if(!n)return '';
  return '<h2>'+title+' — '+n+' ('+fmtH(h)+')</h2><table class="tl"><thead><tr><th>Задача</th><th style="text-align:left">WBS</th><th style="text-align:left">Ресурс</th><th>Часы</th></tr></thead><tbody>'+rows+'</tbody></table>';
}

function render(){
  var p=R.project.periods.filter(function(x){return x.id===R.periodId;})[0];
  if(!p){ge('report').innerHTML='<div class="empty">Версия не найдена</div>';return;}
  var pr=CPCalc.progress(p,R.phase),a=pr.all;
  var phaseName=R.phase==='all'?'':CPCalc.PHASE_LABELS[R.phase].toLowerCase();
  var now=new Date();
  document.title='Отчёт о выполнении — '+p.name+(phaseName?' — '+phaseName:'')+' — '+now.toLocaleDateString('ru-RU');
  ge('updInfo').textContent='Актуально на '+now.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'})+' · ред. '+R.project.revision+' · обновляется автоматически';
  var lp=p.linkedTo&&R.project.periods.filter(function(x){return x.id===p.linkedTo;})[0];
  var html='<h1>'+(R.phase==='all'?'Отчёт о выполнении':'Готовность: '+phaseName)+' релиза «'+escH(p.name)+'»'+(p.closed?'<span class="badge">🔒 Веха закрыта</span>':'')+'</h1>'
    +'<div class="meta">Проект: <b>'+escH(R.project.name)+'</b>'+(lp?' · связана с «'+escH(lp.name)+'»':'')
    +'<br>Разработка: '+fmtD(p.devStart)+' — '+fmtD(p.devEnd)+' · Тестирование: '+fmtD(p.tstStart)+' — '+fmtD(p.tstEnd)
    +'<br>Сформирован: '+now.toLocaleString('ru-RU')+' · ревизия данных '+R.project.revision
    +(R.project.updatedBy?' (последнее изменение: '+escH(R.project.updatedBy)+', '+new Date(R.project.updatedAt).toLocaleString('ru-RU')+')':'')+'</div>';
  // готовность по фазам — всегда, выбранная подсвечена
  var phaseCard=function(k){
    var x=CPCalc.progress(p,k).all,w=function(s){return x.total.h?(x[s].h/x.total.h*100):0;};
    return '<div class="phase'+(R.phase===k?' sel':'')+'"><div class="t"><span>'+CPCalc.PHASE_LABELS[k]+'</span><b>'+x.pctH+'%</b></div>'
      +'<div class="bar"><span class="c-done" style="width:'+w('done')+'%"></span><span class="c-wip" style="width:'+w('wip')+'%"></span></div>'
      +'<div class="s">выполнено '+x.done.n+' из '+x.total.n+' задач · '+x.done.h.toLocaleString('ru')+' из '+fmtH(x.total.h)+(x.wip.n?' · в работе '+x.wip.n:'')+'</div></div>';
  };
  html+='<div class="phases">'+phaseCard('dev')+phaseCard('tst')+'</div>';
  // «По дням» — главный раздел отчёта, идёт первым
  var dailyHtml=a.total.n?renderDailyHtml(p,R.phase,ge('optAllDays').checked):'';
  html+=dailyHtml;
  if(a.total.n)html+='<h2>Итог по задачам и часам</h2>';
  if(!a.total.n){
    ge('report').innerHTML=html+'<div class="empty">'+(R.phase==='all'?'В релиз не включено ни одной задачи.':'В релизе нет задач этой фазы.')+'</div>';return;
  }
  html+='<div class="kpis">'
    +'<div class="kpi main"><div class="v">'+a.pctH+'%</div><div class="l">выполнено по часам ('+a.done.h.toLocaleString('ru')+' из '+fmtH(a.total.h)+')</div></div>'
    +'<div class="kpi"><div class="v">'+a.pctN+'%</div><div class="l">выполнено по задачам ('+a.done.n+' из '+a.total.n+')</div></div>'
    +'<div class="kpi"><div class="v">'+a.wip.n+'</div><div class="l">в работе · '+fmtH(a.wip.h)+'</div></div>'
    +'<div class="kpi"><div class="v">'+a.new.n+'</div><div class="l">не начато · '+fmtH(a.new.h)+'</div></div></div>';
  var w=function(k){return a.total.h?(a[k].h/a.total.h*100):0;};
  html+='<div class="bar"><span class="c-done" style="width:'+w('done')+'%"></span><span class="c-wip" style="width:'+w('wip')+'%"></span></div>'
    +'<div class="legend"><span><i class="c-done"></i>Выполнено '+Math.round(w('done'))+'%</span><span><i class="c-wip"></i>В работе '+Math.round(w('wip'))+'%</span><span><i class="c-new"></i>Не начато '+Math.round(w('new'))+'%</span>'
    +'<span class="muted">Учитываются только задачи, включённые в релиз (отмеченные галочкой)'+(R.phase==='all'?'':', ресурсы с окном «'+CPCalc.PHASE_LABELS[R.phase]+'»')+'.</span></div>';

  // по ресурсам
  var resKeys=Object.keys(p.res).filter(function(k){return pr.byRes[k];});
  Object.keys(pr.byRes).forEach(function(k){if(resKeys.indexOf(k)<0)resKeys.push(k);});
  html+='<h2>По ресурсам</h2><table>'+AGG_HEAD.replace('{first}','Ресурс')+'<tbody>'
    +resKeys.map(function(k){var r=p.res[k];return aggRow(r?r.label:'— без ресурса',pr.byRes[k],'<span class="dot" style="background:'+escH(r?r.color:'#d0d7de')+'"></span>');}).join('')
    +'</tbody><tfoot>'+aggRow('Итого',a).replace('<tr>','<tr class="tot">')+'</tfoot></table>';
  // по блокам
  html+='<h2>По блокам</h2><table>'+AGG_HEAD.replace('{first}','Блок')+'<tbody>'
    +pr.blocks.map(function(b){return aggRow(b.name,b.agg);}).join('')
    +'</tbody><tfoot>'+aggRow('Итого',a).replace('<tr>','<tr class="tot">')+'</tfoot></table>';
  // списки задач
  if(ge('optWip').checked)html+=taskList(p,'wip','<span class="st st-wip">В работе</span>');
  if(ge('optNew').checked)html+=taskList(p,'new','<span class="st st-new">Не начато</span>');
  if(ge('optDone').checked)html+=taskList(p,'done','<span class="st st-done">Выполнено</span>');
  html+='<div class="foot">Планировщик ёмкости · отчёт сформирован автоматически по данным сервера · '+now.toLocaleString('ru-RU')+'</div>';
  ge('report').innerHTML=html;
  if(dailyHtml)rdAttach();
}

// Автообновление: проверяем ревизию проекта и перечитываем данные при изменении.
function poll(){
  if(!R.project||document.hidden)return;
  api('/api/projects/'+encodeURIComponent(R.project.projectId)+'/revision').then(function(d){
    if(d.revision!==R.project.revision)load();else render();
  }).catch(function(){});
}

ge('verSel').addEventListener('change',function(){R.periodId=this.value;setHash();render();});
ge('phaseSel').addEventListener('change',function(){R.phase=this.value;setHash();render();});
['optWip','optNew','optDone','optAllDays'].forEach(function(id){ge(id).addEventListener('change',render);});
ge('btnPdf').addEventListener('click',function(){render();window.print();});
var _rsz=null;window.addEventListener('resize',function(){clearTimeout(_rsz);_rsz=setTimeout(rdAttach,150);});
window.addEventListener('beforeprint',rdAttach);window.addEventListener('afterprint',rdAttach);
document.addEventListener('visibilitychange',function(){if(!document.hidden)poll();});
window.addEventListener('hashchange',function(){var a=hashArgs();if(R.project&&(a.p!==R.project.projectId)){R.periodId=null;load();}});

api('/api/auth/me').then(function(d){
  if(d.config&&d.config.pollIntervalSec)R.pollMs=Math.max(2,d.config.pollIntervalSec)*1000;
  return load();
}).then(function(){setInterval(poll,R.pollMs);}).catch(showError);
