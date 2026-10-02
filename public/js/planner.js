// Планировщик ёмкости — логика рендера и редактирования (перенесена из capacity_planner.html).
// Слой персистентности (сервер, Undo/Redo, автосохранение) — в app.js.
// Расчёт рабочих дней и ёмкости — в /shared/calc.js (общий с сервером).
var HOL=CPCalc.HOL;
var wdays=CPCalc.wdays;

// Undo/Redo реализованы в app.js через снимки состояния после каждого действия;
// вызовы saveUndo() в исходном коде оставлены как маркеры изменяющих операций.
function saveUndo(){}

// ── DATA ────────────────────────────────────────────────────────
var DEFAULT_RES={
  core:{label:'Разработчики ядра',n:3,pct:195,period:'dev',color:'#1d4ed8'},
  test:{label:'Тестировщики',n:4,pct:125,period:'tst',color:'#15803d'},
  iface:{label:'Разраб. интерфейса',n:2,pct:130,period:'dev',color:'#7c3aed'},
  c1:{label:'Разработчик 1С',n:1,pct:65,period:'dev',color:'#b45309'},
  conf:{label:'Разработчик конфигураций',n:1,pct:65,period:'dev',color:'#0369a1'}
};

// periods[i].linkedTo = pid | null   (связь двунаправленная)
// id периода уникален глобально — несколько пользователей могут создавать периоды одновременно
function newPeriodId(){
  var id;do{id='p'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);}while(getPeriod(id));
  return id;
}
function mkPeriod(name,tasks,res){
  var id=newPeriodId();
  var r=res?JSON.parse(JSON.stringify(res)):JSON.parse(JSON.stringify(DEFAULT_RES));
  var t=tasks?JSON.parse(JSON.stringify(tasks)):[];
  var chk={};t.forEach(function(x){chk[x.w]=!x.s;});
  return{id:id,name:name||'Период '+(PERIODS.length+1),
    devStart:'2026-06-01',devEnd:'2026-11-15',tstStart:'2026-06-01',tstEnd:'2026-12-20',
    res:r,tasks:t,chk:chk,collapsed:{},filter:null,filterActive:null,folded:false,linkedTo:null,
    colWidths:{cb:32,h:46,r:98,name:0,del:18},closed:false};  // 0 = flex
}
// Состояние загружается с сервера (app.js). Никакого localStorage.
var PERIODS=[];
// Режим «только чтение» для всего проекта (нет права на редактирование).
var READONLY=false;

// ── HELPERS ─────────────────────────────────────────────────────
function gv(id){return document.getElementById(id).value;}
function ge(id){return document.getElementById(id);}
function getPeriod(pid){return PERIODS.filter(function(p){return p.id===pid;})[0];}
function getLinked(p){return p.linkedTo?getPeriod(p.linkedTo):null;}
// Связанный период, в который разрешено писать (закрытая веха не синхронизируется).
function getLinkedW(p){var lp=getLinked(p);return lp&&!lp.closed?lp:null;}
function isLocked(p){return READONLY||!p||!!p.closed;}
function editablePeriods(){return PERIODS.filter(function(p){return !isLocked(p);});}
function escH(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}
// Для закрытой вехи cap/usedP возвращают замороженный снимок (см. shared/calc.js).
function cap(p,k){return CPCalc.cap(p,k);}
function usedP(p){return CPCalc.usedP(p);}
function resOpts(res,sel){
  var o=Object.keys(res).map(function(k){return '<option value="'+escH(k)+'"'+(k===sel?' selected':'')+'>'+escH(res[k].label)+'</option>';}).join('');
  // ресурс, которого нет в пуле периода (например, после слияния) — показываем как есть, не подменяя
  if(sel&&sel!=='none'&&!res[sel])o+='<option value="'+escH(sel)+'" selected>⚠ '+escH(sel)+'</option>';
  return o+'<option value="none"'+(sel==='none'?' selected':'')+'>— без ресурса</option>';
}
// В списках выбора периода для изменений показываем только доступные для редактирования.
function periodOpts(sel){return editablePeriods().map(function(p){return '<option value="'+p.id+'"'+(p.id===sel?' selected':'')+'>'+escH(p.name)+'</option>';}).join('');}
function blockOpts(p,sel,exceptW){return p.tasks.filter(function(t){return t.s&&t.w!==exceptW;}).map(function(t){return '<option value="'+escH(t.w)+'"'+(t.w===sel?' selected':'')+'>'+escH(t.w)+' — '+escH(t.n)+'</option>';}).join('');}
function nextBlockWbs(p){
  // Автоматический WBS для нового блока
  var tops=p.tasks.filter(function(t){return t.s&&t.d===0;}).map(function(t){return t.w;});
  if(!tops.length) return '1';
  // Берём числовые части верхнего уровня
  var nums=tops.map(function(w){return parseFloat(w)||0;}).filter(function(n){return n>0;});
  if(!nums.length) return (tops.length+1)+'';
  return (Math.floor(Math.max.apply(null,nums))+1)+'';
}

// ── PARENT / MOVE utils ─────────────────────────────────────────
function getParentWbs(tasks,idx){
  var t=tasks[idx];
  for(var i=idx-1;i>=0;i--){if(tasks[i].s&&tasks[i].d<t.d)return tasks[i].w;}
  return null;
}
function moveTaskInPeriod(p,srcIdx,targetParentWbs){
  var src=p.tasks[srcIdx];
  var tp=p.tasks.find(function(t){return t.w===targetParentWbs;});
  if(!tp)return;
  var newDepth=tp.d+1;
  var oldPrefix=src.w;
  var newWbs=targetParentWbs+'.x'+Date.now()%100000;
  if(src.s){
    var block=p.tasks.filter(function(t){return t.w===oldPrefix||t.w.indexOf(oldPrefix+'.')===0;});
    p.tasks=p.tasks.filter(function(t){return t.w!==oldPrefix&&t.w.indexOf(oldPrefix+'.')!==0;});
    var oc={};block.forEach(function(t){var ow=t.w;var nw=ow===oldPrefix?newWbs:newWbs+t.w.slice(oldPrefix.length);oc[nw]=p.chk[ow];delete p.chk[ow];t.w=nw;t.d=ow===oldPrefix?newDepth:newDepth+(t.d-src.d);});Object.assign(p.chk,oc);
    var ins=p.tasks.map(function(t){return t.w;}).indexOf(targetParentWbs)+1;
    while(ins<p.tasks.length&&p.tasks[ins].w.indexOf(targetParentWbs+'.')===0)ins++;
    block.forEach(function(t,i){p.tasks.splice(ins+i,0,t);});
  }else{
    p.tasks.splice(srcIdx,1);var ov=p.chk[oldPrefix];delete p.chk[oldPrefix];
    src.w=newWbs;src.d=newDepth;p.chk[newWbs]=ov!==undefined?ov:false;
    var ins=p.tasks.map(function(t){return t.w;}).indexOf(targetParentWbs)+1;
    while(ins<p.tasks.length&&p.tasks[ins].w.indexOf(targetParentWbs+'.')===0)ins++;
    p.tasks.splice(ins,0,src);
  }
}

// ── LINK SYNC ───────────────────────────────────────────────────
// Когда меняем чекбокс в p, синхронизируем связанный период
// ── Жёсткая синхронизация близнецов ──────────────────────
// Близнец ищется по WBS (идентичность задач — по WBS); если такого WBS в связанном
// периоде нет (например, задача добавлена позже) — по имени, как в исходной версии.
// Закрытая веха не синхронизируется (getLinkedW).
function twinIn(lp,t){
  if(!lp||!t)return null;
  return lp.tasks.find(function(x){return x.w===t.w&&x.s===t.s;})
    ||lp.tasks.find(function(x){return x.n===t.n&&x.s===t.s;})||null;
}
function findTwin(p, t){
  return twinIn(getLinkedW(p),t);
}
function findTwinLp(p){return getLinkedW(p);}

function syncLinkedChk(p, taskW, val){
  var lp=getLinkedW(p);if(!lp)return;
  var srcTask=p.tasks.find(function(t){return t.w===taskW;});if(!srcTask)return;
  var lt=twinIn(lp,srcTask);
  if(lt&&!lt.s){lp.chk[lt.w]=!val;}
  // Также проверяем обратное направление: если lp тоже связан с кем-то ещё
  var llp=getLinkedW(lp);
  if(llp&&llp.id!==p.id){
    var lt2=twinIn(llp,srcTask);
    if(lt2&&!lt2.s)llp.chk[lt2.w]=val; // в третьем периоде — то же значение что в p
  }
}
function syncLinkedGroupChk(p, grpW, val){
  var lp=getLinkedW(p);if(!lp)return;
  var grp=p.tasks.find(function(t){return t.w===grpW;});if(!grp)return;
  p.tasks.forEach(function(t){
    if(!t.s&&t.w.indexOf(grpW+'.')===0){
      var lt=twinIn(lp,t);
      if(lt&&!lt.s)lp.chk[lt.w]=!val;
    }
  });
  // Обратное направление
  var llp=getLinkedW(lp);
  if(llp&&llp.id!==p.id){
    p.tasks.forEach(function(t){
      if(!t.s&&t.w.indexOf(grpW+'.')===0){
        var lt2=twinIn(llp,t);
        if(lt2&&!lt2.s)llp.chk[lt2.w]=val;
      }
    });
  }
}

// ── DUPS ────────────────────────────────────────────────────────
function getDupNames(){
  var nm={};
  PERIODS.forEach(function(p){p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).forEach(function(t){if(!nm[t.n])nm[t.n]=[];nm[t.n].push(p.id);});});
  var d={};Object.keys(nm).forEach(function(n){if(nm[n].length>1)d[n]=nm[n];});
  return d;
}
// Для связанных периодов: в какой паре период активна задача
function getActiveInPeriod(taskName, thisPid){
  var res=[];
  PERIODS.forEach(function(p){if(p.id===thisPid)return;var t=p.tasks.find(function(x){return x.n===taskName&&!x.s;});if(t&&p.chk[t.w])res.push(p.name);});
  return res;
}

// ── RENDER FUNCTIONS ─────────────────────────────────────────────
function renderAll(){
  var c=ge('periodsContainer');c.innerHTML='';
  var dups=getDupNames();
  PERIODS.forEach(function(p){c.appendChild(buildPeriodEl(p,dups));});
  PERIODS.forEach(function(p){if(!p.folded){renderResGrid(p);renderFilter(p);renderTree(p,dups);renderRight(p);renderStickyBar(p);}updateMeta(p);});
  // Устанавливаем observer один раз после рендера DOM
  setTimeout(function(){PERIODS.forEach(function(p){if(!p.folded)setupStickyObserver(p.id);});},50);
  var ap=ge('btnAddPeriod');if(ap)ap.style.display=READONLY?'none':'';
  updateUndoBtn();
}
function refreshAll(){
  var dups=getDupNames();
  PERIODS.forEach(function(p){if(!p.folded){renderResGrid(p);renderFilter(p);renderTree(p,dups);renderRight(p);renderStickyBar(p);}updateMeta(p);});
  updateUndoBtn();
}


// IntersectionObserver для sticky шапок периодов
function setupStickyObserver(pid){
  var hdr=document.querySelector('#period-'+pid+' .period-hdr');
  var bar=ge('sticky-'+pid);
  if(!hdr||!bar)return;
  if(bar._observer)bar._observer.disconnect();
  var obs=new IntersectionObserver(function(entries){
    entries.forEach(function(entry){
      if(!entry.isIntersecting){bar.classList.add('visible');}
      else{bar.classList.remove('visible');}
    });
  },{threshold:0,rootMargin:'-1px 0px 0px 0px'});
  obs.observe(hdr);
  bar._observer=obs;
}

function renderStickyBar(p){
  var el=ge('sticky-'+p.id);if(!el)return;
  var lp=getLinked(p);
  var u=usedP(p);
  var nT=p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).length;
  var totalH=p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).reduce(function(s,t){return s+t.h;},0);
  var linkBadge=lp?'<span class="sticky-link-badge">🔗 '+escH(lp.name)+'</span>':'';
  var chips=Object.keys(p.res).map(function(k){
    var r=p.res[k],c=cap(p,k),uu=u[k]||0;
    var pct=c>0?Math.min(uu/c*100,100):0;
    var col=uu>c?'#dc2626':uu>c*.85?'#d97706':r.color;
    var isActive=p.filter===k;
    var chipBg=isActive?r.color:'#f6f8fa';
    var chipColor=isActive?'#fff':'#24292f';
    return '<div class="sticky-res-chip" data-sfres="'+p.id+'|'+escH(k)+'" style="cursor:pointer;background:'+chipBg+';border-color:'+(isActive?r.color:'#d0d7de')+';color:'+chipColor+'">'
      +'<span style="width:8px;height:8px;border-radius:50%;background:'+r.color+';flex-shrink:0"></span>'
      +'<span>'+escH(r.label)+'</span>'
      +'<span style="color:'+(isActive?'#fff':col)+';font-weight:700">'+uu+'/'+c+'ч</span>'
      +'</div>';
  }).join('');
  el.innerHTML='<div class="sticky-bar-top">'
    +'<span class="sticky-period-name" data-scrollto="'+p.id+'">'+escH(p.name)+'</span>'
    +linkBadge
    +'<span style="font-size:11px;color:#656d76;margin-left:4px">'+nT+' задач · '+totalH.toLocaleString('ru')+'ч</span>'
    +'<span style="flex:1"></span>'
    +'<button class="btn btnp" style="padding:1px 7px;font-size:11px" data-addtask="'+p.id+'">+ Задача</button>'
    +'<button class="btn btnv" style="padding:1px 7px;font-size:11px" data-addblock="'+p.id+'">+ Блок</button>'
    +'</div>'
    +'<div class="sticky-res-list">'+chips+'</div>';
}

function refreshPeriod(pid){var p=getPeriod(pid);if(!p||p.folded)return;var d=getDupNames();renderResGrid(p);renderFilter(p);renderTree(p,d);renderRight(p);renderStickyBar(p);updateMeta(p);}
function updateMeta(p){
  renderStickyBar(p);  // синхронизируем sticky каждый раз
  var el=document.querySelector('#period-'+p.id+' .pmeta');if(!el)return;
  var nT=p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).length;
  var totalH=p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).reduce(function(s,t){return s+t.h;},0);
  el.textContent=nT+' задач · '+totalH.toLocaleString('ru')+'ч';
}

function buildPeriodEl(p,dups){
  var div=document.createElement('div');div.className='period-card';div.id='period-'+p.id;
  var lp=getLinked(p);
  var nT=p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).length;
  var totalH=p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).reduce(function(s,t){return s+t.h;},0);
  var locked=isLocked(p);
  if(locked)div.className+=' locked';
  if(p.closed)div.className+=' closed';
  var bothOpen=!READONLY&&!p.closed&&lp&&!lp.closed;
  var linkBadge=lp?'<span class="plink-badge">🔗 '+escH(lp.name)+'</span>':'';
  var closedBadge=p.closed?'<span class="closed-badge" title="Веха закрыта'+(p.frozenSnapshot&&p.frozenSnapshot.by?' пользователем '+escH(p.frozenSnapshot.by):'')+'">🔒 Закрыта'+(p.frozenSnapshot&&p.frozenSnapshot.at?' '+new Date(p.frozenSnapshot.at).toLocaleDateString('ru-RU'):'')+'</span>':'';
  var breakLink=bothOpen?'<button class="btn btnd" style="font-size:10px;padding:1px 5px" data-breaklink="'+p.id+'" title="Снять связь без удаления задач">✂ Связь</button>':'';
  var detach=bothOpen?'<button class="btn btnd" style="font-size:10px;padding:1px 5px" data-detach="'+p.id+'" title="Отвязать версию: удалить задачи, активные в связанной версии, и снять связь">⛓ Отвязать</button>':'';
  var closeBtn=READONLY?'':(p.closed
    ?(CAN_REOPEN?'<button class="btn" style="font-size:10px;padding:1px 5px" data-reopen="'+p.id+'">🔓 Переоткрыть</button>':'')
    :'<button class="btn" style="font-size:10px;padding:1px 5px" data-closeperiod="'+p.id+'" title="Закрыть веху: только чтение, ресурсы заморожены">🔒 Закрыть</button>');
  div.innerHTML='<div class="period-hdr" data-foldperiod="'+p.id+'">'
    +'<span class="ptog">'+(p.folded?'▶':'▼')+'</span>'
    +'<input class="ptitle" value="'+escH(p.name)+'" data-ptitle="'+p.id+'" style="flex:1;min-width:0"'+(locked?' disabled':'')+'>'
    +closedBadge+linkBadge
    +'<span class="pmeta">'+nT+' задач · '+totalH.toLocaleString('ru')+'ч</span>'
    +'<div class="pactions">'+detach+breakLink+closeBtn
    +'<button class="btn" style="font-size:10px;padding:1px 5px" data-addres="'+p.id+'">+ Ресурс</button>'
    +'<button class="btn btnd" style="font-size:10px;padding:1px 5px" data-delperiod="'+p.id+'">✕</button>'
    +'</div></div>';
  if(p.folded)return div;
  // Sticky bar — закреплённая шапка с именем периода и ресурсами
  var sticky=document.createElement('div');
  sticky.className='sticky-bar';
  sticky.id='sticky-'+p.id;
  sticky.dataset.scrollperiod=p.id;  // клик на фон → scroll к периоду
  sticky.style.cursor='pointer';
  div.appendChild(sticky);
  var body=document.createElement('div');body.className='period-body';
  // Dates
  body.innerHTML+='<div class="dates-row">'
    +'<span style="font-weight:700;margin-right:2px">Разработка:</span>'
    +'С <input type="date" value="'+p.devStart+'" data-pdate="'+p.id+'|devStart"> по <input type="date" value="'+p.devEnd+'" data-pdate="'+p.id+'|devEnd">'
    +'<span style="font-weight:700;margin-right:2px;margin-left:10px">Тестирование:</span>'
    +'С <input type="date" value="'+p.tstStart+'" data-pdate="'+p.id+'|tstStart"> по <input type="date" value="'+p.tstEnd+'" data-pdate="'+p.id+'|tstEnd">'
    +(p.closed&&p.frozenSnapshot?'<span class="frozen-note">❄ Ресурсы заморожены на '+new Date(p.frozenSnapshot.at).toLocaleString('ru-RU')+(p.frozenSnapshot.workdays?' · раб. дней: разработка '+p.frozenSnapshot.workdays.dev+', тестирование '+p.frozenSnapshot.workdays.tst:'')+'</span>':'')
    +'</div>';
  // Res grid
  body.innerHTML+='<div class="res-sec-hdr"><div class="sec" style="margin:0">Ресурсы</div>'
    +'<button class="btn ro-hide" style="font-size:10px;padding:1px 5px" data-pushres="'+p.id+'" title="Скопировать штат и % загрузки этой версии во все открытые версии. Закрытые вехи не затрагиваются">⇉ Штат в открытые версии</button>'
    +'</div><div class="res-grid" id="resgrid-'+p.id+'"></div>';
  // Main layout
  var colW=p.colWidths;
  body.innerHTML+='<div class="main-layout">'
    +'<div class="task-panel" id="tp-'+p.id+'">'
    +'<div class="phdr">'
    +'<button class="btn" data-selall="'+p.id+'">✓ Все</button>'
    +'<button class="btn" data-selnone="'+p.id+'">✗ Снять</button>'
    +'<button class="btn btnp" style="padding:2px 6px" data-addtask="'+p.id+'">+ Задача</button>'
    +'<button class="btn btnv" style="padding:2px 6px" data-addblock="'+p.id+'">+ Блок</button>'
    +'<span class="ct" id="selcnt-'+p.id+'" style="margin-left:auto;font-size:11px;color:#656d76"></span>'
    +'</div>'
    +'<div class="fbar" id="fbar-'+p.id+'"></div>'
    +'<div class="tw" id="tw-'+p.id+'">'
    +'<div class="tree-wrap"><table class="tree" id="tree-'+p.id+'" style="width:100%">'
    +'<thead><tr id="thead-'+p.id+'">'
    +'<th style="width:'+colW.cb+'px"></th>'
    +'<th style="width:'+colW.h+'px;text-align:right" class="resizable" data-col="h" data-pid="'+p.id+'">Ч</th>'
    +'<th style="width:'+colW.r+'px" class="resizable" data-col="r" data-pid="'+p.id+'">Ресурс</th>'
    +'<th>Задача</th>'
    +'<th style="width:'+(colW.st||96)+'px">Статус</th>'
    +'<th style="width:'+colW.del+'px"></th>'
    +'</tr></thead>'
    +'<tbody id="tbody-'+p.id+'"></tbody>'
    +'</table></div></div>'
    +'</div>'
    +'<div class="rp" id="right-'+p.id+'"></div>'
    +'</div>';
  div.appendChild(body);
  if(locked)lockDom(div);
  // Set table height to fill container after render
  setTimeout(function(){setTwHeight(p.id);},0);
  setupColResize(p.id);
  return div;
}

function setTwHeight(pid){
  var tp=ge('tp-'+pid);var tw=ge('tw-'+pid);if(!tp||!tw)return;
  var phdr=tp.querySelector('.phdr');var fbar=tp.querySelector('.fbar');
  var used=(phdr?phdr.offsetHeight:0)+(fbar?fbar.offsetHeight:0);
  var avail=tp.offsetHeight-used;
  if(avail>150)tw.style.height=avail+'px';
}

// ── COLUMN RESIZE ────────────────────────────────────────────────
function setupColResize(pid){
  var ths=document.querySelectorAll('#thead-'+pid+' th.resizable');
  ths.forEach(function(th){
    th.addEventListener('mousedown',function(e){
      var col=th.dataset.col;
      var startX=e.clientX;
      var startW=th.offsetWidth;
      function onMove(ev){
        var newW=Math.max(30,startW+(ev.clientX-startX));
        th.style.width=newW+'px';
        var p=getPeriod(pid);if(p)p.colWidths[col]=newW;
      }
      function onUp(){document.removeEventListener('mousemove',onMove);document.removeEventListener('mouseup',onUp);}
      document.addEventListener('mousemove',onMove);document.addEventListener('mouseup',onUp);
      e.preventDefault();
    });
  });
}

// ── RES GRID ─────────────────────────────────────────────────────
function renderResGrid(p){
  var el=ge('resgrid-'+p.id);if(!el)return;
  var u=usedP(p);
  el.innerHTML=Object.keys(p.res).map(function(k){
    var r=p.res[k],c=cap(p,k),uu=u[k]||0;
    var pct=c>0?Math.min(uu/c*100,100):0;
    var col=uu>c?'#dc2626':uu>c*.85?'#d97706':r.color;
    return '<div class="res-card" style="border-left-color:'+r.color+'">'
      +'<button class="res-del" data-delres="'+p.id+'|'+escH(k)+'">✕</button>'
      +'<input class="res-name-inp" value="'+escH(r.label)+'" data-resname="'+p.id+'|'+escH(k)+'">'
      +'<div class="res-row"><label>чел:</label><input type="number" min="1" max="50" value="'+r.n+'" data-resn="'+p.id+'|'+escH(k)+'">'
      +'<label>%:</label><input type="number" min="10" max="500" value="'+r.pct+'" data-respct="'+p.id+'|'+escH(k)+'">'
      +'<input type="color" value="'+escH(r.color)+'" data-rescol="'+p.id+'|'+escH(k)+'" style="width:22px;height:19px;padding:1px;border:1px solid #d0d7de;border-radius:3px;cursor:pointer"></div>'
      +'<div class="res-row"><label>период:</label><select class="res-per" data-resper="'+p.id+'|'+escH(k)+'">'
      +'<option value="dev"'+(r.period==='dev'?' selected':'')+'>Разработка</option>'
      +'<option value="tst"'+(r.period==='tst'?' selected':'')+'>Тестирование</option>'
      +'</select></div>'
      +'<div class="cap-bg"><div class="cap-fg" style="width:'+pct+'%;background:'+r.color+'"></div></div>'
      +'<div class="cap-txt"><span>'+uu+' / '+c+'ч</span><span style="color:'+col+';font-weight:700">'+(uu>c?'❌ +':'✅ -')+Math.abs(c-uu)+'ч</span></div>'
      +'</div>';
  }).join('');
  if(isLocked(p))lockDom(el);
}

// ── FILTER BAR ───────────────────────────────────────────────────
function renderFilter(p){
  var el=ge('fbar-'+p.id);if(!el)return;
  var allR=p.filter===null;var allA=p.filterActive===null;
  var tags='<button class="ftag'+(allR?' on':'')+'" data-fall="'+p.id+'" style="'+(allR?'background:#444;border-color:#444;color:#fff':'')+'">Все ресурсы</button> ';
  tags+=Object.keys(p.res).map(function(k){var r=p.res[k];var on=p.filter===k;
    return '<button class="ftag'+(on?' on':'')+'" data-fres="'+p.id+'|'+escH(k)+'" style="'+(on?'background:'+r.color+';border-color:'+r.color+';color:#fff':'')+'">'
      +escH(r.label)+'</button>';}).join(' ');
  tags+=' <span style="border-left:1px solid #d0d7de;margin:0 3px;height:14px;display:inline-block;vertical-align:middle"></span> ';
  var aon=p.filterActive===true;var non=p.filterActive===false;
  tags+='<button class="ftag'+(aon?' on':'')+'" data-factive="'+p.id+'|1" style="'+(aon?'background:#1a7f37;border-color:#1a7f37;color:#fff':'')+'">✓ Активные</button> ';
  tags+='<button class="ftag'+(non?' on':'')+'" data-factive="'+p.id+'|0" style="'+(non?'background:#888;border-color:#888;color:#fff':'')+'">✗ Неактивные</button>';
  el.innerHTML=tags;
}

// ── TREE ─────────────────────────────────────────────────────────
function isVisible(p,t){
  var parts=t.w.split('.');
  for(var i=1;i<parts.length;i++){var anc=parts.slice(0,i).join('.');if(p.collapsed[anc])return false;}
  if(p.filter&&!t.s&&t.r!==p.filter)return false;
  if(p.filter&&t.s){var has=p.tasks.some(function(c){return !c.s&&c.w.indexOf(t.w+'.')===0&&c.r===p.filter;});if(!has)return false;}
  if(p.filterActive===true&&!t.s&&!p.chk[t.w])return false;
  if(p.filterActive===false&&!t.s&&p.chk[t.w])return false;
  if(p.filterActive!==null&&t.s){
    var kids=p.tasks.filter(function(c){return !c.s&&c.w.indexOf(t.w+'.')===0;});
    if(p.filterActive===true&&!kids.some(function(c){return p.chk[c.w];}))return false;
    if(p.filterActive===false&&!kids.some(function(c){return !p.chk[c.w];}))return false;
  }
  return true;
}
function filteredH(p,t){
  if(!t.s)return p.chk[t.w]?t.h:0;
  var s=0;p.tasks.forEach(function(c){if(!c.s&&c.w.indexOf(t.w+'.')===0&&p.chk[c.w]&&(!p.filter||c.r===p.filter))s+=c.h;});return s;
}
function getResColor(p,rk){return (p.res[rk]&&p.res[rk].color)||'#d0d7de';}

// ── СТАТУСЫ ЗАДАЧ ────────────────────────────────────────────────
function todayStr(){var d=new Date();return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);}
// Смена статуса с датами: «В работе» запоминает дату начала (ws), «Выполнено» — дату выполнения (dn).
// По датам выполнения строится отчёт по дням.
function applyStatus(t,v,ws,dn){
  var day=todayStr();
  t.st=v;
  if(v==='new'){delete t.ws;delete t.dn;}
  else if(v==='wip'){t.ws=ws||t.ws||day;delete t.dn;}
  else{t.ws=ws||t.ws||dn||t.dn||day;t.dn=dn||t.dn||day;if(t.ws>t.dn)t.ws=t.dn;}
}
function copyStatus(from,to){if(!to||to.s)return;to.st=from.st;['ws','dn'].forEach(function(k){if(from[k])to[k]=from[k];else delete to[k];});}
function statusSelect(p,t,idx){
  var st=CPCalc.taskStatus(t);
  return '<select class="sts sts-'+st+'" data-setst="'+p.id+'|'+idx+'" title="Статус задачи">'
    +CPCalc.STATUSES.map(function(k){return '<option value="'+k+'"'+(k===st?' selected':'')+'>'+CPCalc.STATUS_LABELS[k]+'</option>';}).join('')
    +'</select>';
}
// Для строки-итога: выполнено/всего среди отмеченных листьев блока.
function blockStatusHtml(p,t){
  var kids=p.tasks.filter(function(c){return !c.s&&c.w.indexOf(t.w+'.')===0&&p.chk[c.w];});
  if(!kids.length)return '';
  var done=kids.filter(function(c){return CPCalc.taskStatus(c)==='done';}).length;
  var wip=kids.filter(function(c){return CPCalc.taskStatus(c)==='wip';}).length;
  var pct=Math.round(done/kids.length*100);
  return '<span class="blk-st" title="Выполнено '+done+' из '+kids.length+(wip?', в работе '+wip:'')+'">'
    +'<span class="blk-bar"><span style="width:'+pct+'%"></span></span>'+done+'/'+kids.length+'</span>';
}
// Карточка «Выполнение релиза» в правой панели. Фильтр готовности: все / разработка / тестирование
// (фаза задачи определяется окном её ресурса). Выбор фильтра — состояние экрана, на сервер не пишется.
var PG_PHASE={};
function progressCard(p){
  var ph=PG_PHASE[p.id]||'all';
  if(!CPCalc.progress(p).all.total.n)return '';
  var pr=CPCalc.progress(p,ph).all;
  var dev=CPCalc.progress(p,'dev').all,tst=CPCalc.progress(p,'tst').all;
  var tab=function(k,l,v){return '<button class="ftag'+(ph===k?' on pg-on':'')+'" data-pgphase="'+p.id+'|'+k+'">'+l+(v!=null?' <b>'+v+'%</b>':'')+'</button>';};
  var tabs='<div class="pg-tabs">'+tab('all','Все',null)+tab('dev','Разработка',dev.pctH)+tab('tst','Тестирование',tst.pctH)+'</div>';
  if(!pr.total.n)return '<div class="rcard"><div class="pg-hdr"><span class="sec" style="margin:0">Готовность релиза</span>'
    +'<button class="btn" style="padding:1px 6px;font-size:10px" data-report="'+p.id+'">📄 Отчёт</button></div>'+tabs+'<div class="pg-leg">Нет задач этой фазы</div></div>';
  var seg=function(k,cls){return pr.total.h?'<span class="pg-'+cls+'" style="width:'+(pr[k].h/pr.total.h*100)+'%"></span>':'';};
  return '<div class="rcard"><div class="pg-hdr"><span class="sec" style="margin:0">Готовность релиза</span>'
    +'<button class="btn" style="padding:1px 6px;font-size:10px" data-report="'+p.id+'" title="Открыть отчёт о выполнении (можно сохранить в PDF)">📄 Отчёт</button></div>'
    +tabs
    +'<div class="pg-big">'+pr.pctH+'%<span> по часам</span> · '+pr.pctN+'%<span> по задачам</span></div>'
    +'<div class="pg-bar">'+seg('done','done')+seg('wip','wip')+'</div>'
    +daysLine(p,ph)
    +'<div class="pg-leg"><span><i class="pg-done"></i>Выполнено '+pr.done.n+' · '+pr.done.h.toLocaleString('ru')+'ч</span>'
    +'<span><i class="pg-wip"></i>В работе '+pr.wip.n+' · '+pr.wip.h.toLocaleString('ru')+'ч</span>'
    +'<span><i class="pg-new"></i>Новые '+pr.new.n+' · '+pr.new.h.toLocaleString('ru')+'ч</span></div></div>';
}

// Строка «по дням» в карточке готовности: отставание/опережение плана, остаток дней, прогноз.
function daysLine(p,ph){
  var d=CPCalc.daily(p,ph,todayStr());
  if(!d.totalH)return '';
  var fd=function(s){return s?s.slice(8,10)+'.'+s.slice(5,7)+'.'+s.slice(0,4):'—';};
  var lag=d.lagDays>=0?'<b class="ok">опережение '+d.lagDays.toLocaleString('ru')+' раб. дн.</b>':'<b class="bad">отставание '+(-d.lagDays).toLocaleString('ru')+' раб. дн.</b>';
  return '<div class="pg-days">'+lag+' · осталось '+d.remaining+' раб. дн.'
    +'<br>прогноз: '+(d.forecast?'<b class="'+(d.late?'bad':'ok')+'">'+fd(d.forecast)+'</b>':'нет темпа')+' · окно до '+fd(d.window.end)+'</div>';
}

function renderTree(p,dups){
  var tbody=ge('tbody-'+p.id);if(!tbody)return;
  var lp=getLinked(p);
  var rows='';
  var dr=isLocked(p)?'false':'true';
  p.tasks.forEach(function(t,idx){
    if(!isVisible(p,t))return;
    var tw=escH(t.w);
    var ind='i'+Math.min(t.d,3);
    // dup / active-in badge
    var extra='';
    if(!t.s){
      if(dups&&dups[t.n]&&p.chk[t.w]){
        var others=dups[t.n].filter(function(pid){return pid!==p.id;}).map(function(pid){return getPeriod(pid).name;});
        if(others.length)extra+='<span class="dup-warn" title="Также активна в: '+escH(others.join(', '))+'">❗</span>';
      }
      if(lp){
        var lt=twinIn(lp,t);
        var hA=p.chk[t.w],tA=lt&&!lt.s&&lp.chk[lt.w];
        if(hA&&tA){
          extra+='<span class="active-in" style="background:#fff0f0;color:#dc2626;border-color:#fca5a5" title="Активна в обоих периодах — конфликт">'+escH(p.name)+' + '+escH(lp.name)+'</span>';
        }else if(hA){
          extra+='<span class="active-in" title="Активна в этом периоде">'+escH(p.name)+'</span>';
        }else if(tA){
          extra+='<span class="active-in" style="background:#f6f8fa;color:#656d76;border-color:#d0d7de" title="Активна в связанном периоде">'+escH(lp.name)+'</span>';
        }
      }
    }
    var col=getResColor(p,t.r);
    if(t.s){
      var kids=p.tasks.filter(function(c){return !c.s&&c.w.indexOf(t.w+'.')===0&&(!p.filter||c.r===p.filter);});
      var allOn=kids.length>0&&kids.every(function(c){return p.chk[c.w];});
      var sh=filteredH(p,t);
      var dk=p.tasks.filter(function(c){return c.w.indexOf(t.w+'.')===0&&c.w.split('.').length===t.w.split('.').length+1;});
      var gc='g'+Math.min(t.d,3);
      rows+='<tr class="'+gc+'" draggable="'+dr+'" data-pid="'+p.id+'" data-widx="'+idx+'">'
        +'<td style="display:flex;align-items:center;gap:1px;padding:2px 3px">'
        +(dk.length?'<button class="tog-btn" data-coltog="'+p.id+'|'+tw+'">'+(p.collapsed[t.w]?'▶':'▼')+'</button>':'<span style="width:13px"></span>')
        +'<input type="checkbox" class="cb"'+(allOn?' checked':'')+' data-grp="'+p.id+'|'+tw+'"></td>'
        +'<td class="tdr" style="font-size:10px;color:#656d76">'+(sh||'')+'</td>'
        +'<td></td>'
        +'<td class="'+ind+' task-name-cell" data-editpid="'+p.id+'" data-editidx="'+idx+'">'
          +'<span style="display:flex;align-items:center;gap:4px"><span class="tname">'+escH(t.n)+'</span>'+extra
          +'<button class="add-in-block-btn" data-addintask="'+p.id+'|'+tw+'" title="Добавить задачу в этот блок" style="border:1px solid #d0d7de;background:#f6f8fa;color:#656d76;border-radius:3px;padding:0 5px;font-size:10px;cursor:pointer;line-height:16px;opacity:0;transition:opacity .15s">+</button>'
          +'</span></td>'
        +'<td>'+blockStatusHtml(p,t)+'</td>'
        +'<td><button class="db" data-delpid="'+p.id+'" data-del="'+idx+'">✕</button></td>'
        +'</tr>';
    }else{
      rows+='<tr style="'+(p.chk[t.w]?'':'opacity:.4')+'" draggable="'+dr+'" data-pid="'+p.id+'" data-widx="'+idx+'">'
        +'<td style="padding:2px 3px"><input type="checkbox" class="cb"'+(p.chk[t.w]?' checked':'')+' data-tog="'+p.id+'|'+tw+'"></td>'
        +'<td class="tdr"><input class="hi" type="number" min="0" max="9999" value="'+t.h+'" data-seth="'+p.id+'|'+idx+'"></td>'
        +'<td><div class="rs-wrap"><span class="rs-color" style="background:'+col+'"></span><select class="rs" data-setr="'+p.id+'|'+idx+'">'+resOpts(p.res,t.r)+'</select></div></td>'
        +'<td class="'+ind+' task-name-cell" data-editpid="'+p.id+'" data-editidx="'+idx+'">'
          +'<span style="display:flex;align-items:center;gap:2px"><span class="tname'+(CPCalc.taskStatus(t)==='done'?' tdone':'')+'">'+escH(t.n)+'</span>'+extra+'</span></td>'
        +'<td>'+statusSelect(p,t,idx)+'</td>'
        +'<td><button class="db" data-delpid="'+p.id+'" data-del="'+idx+'">✕</button></td>'
        +'</tr>';
    }
  });
  tbody.innerHTML=rows;
  // обработчики drag вешаются на tbody один раз (tbody пересоздаётся только в buildPeriodEl)
  var sc=ge('selcnt-'+p.id);
  if(sc)sc.textContent='Выбрано: '+p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).length;
  setupDrag(p.id);
  if(isLocked(p))lockDom(tbody);
}
// Блокирует поля ввода внутри элемента (закрытая веха / режим только чтения).
function lockDom(root){
  root.querySelectorAll('input,select,textarea').forEach(function(e){e.disabled=true;});
}

// ── RIGHT PANEL ──────────────────────────────────────────────────
function renderRight(p){
  var el=ge('right-'+p.id);if(!el)return;
  var u=usedP(p);
  var totalH=p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).reduce(function(s,t){return s+t.h;},0);
  var nT=p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).length;
  var html='<div class="rcard"><div class="sg">'
    +'<div class="sc"><div class="sn">'+totalH.toLocaleString('ru')+'</div><div class="sl">часов</div></div>'
    +'<div class="sc"><div class="sn">'+nT+'</div><div class="sl">задач</div></div></div>';
  html+=Object.keys(p.res).map(function(k){
    var r=p.res[k],c=cap(p,k),uu=u[k]||0;if(!c)return '';
    var pct=Math.min(uu/c*100,100);var col=uu>c?'#dc2626':uu>c*.85?'#d97706':r.color;
    return '<div class="br"><div class="brt"><span>'+escH(r.label)+'</span>'
      +'<span style="color:'+col+';font-weight:700">'+uu+'/'+c+'ч ('+Math.round(uu/c*100)+'%)</span></div>'
      +'<div class="brb"><div class="brf" style="width:'+pct+'%;background:'+r.color+'"></div></div></div>';
  }).join('');
  html+='</div>';
  html+=progressCard(p);
  var blocks={};
  p.tasks.filter(function(t){return t.s&&t.d===0;}).forEach(function(t){blocks[t.w]={name:t.n,core:0,test:0,other:0,tot:0};});
  // Для каждой задачи найдём ближайший d=0 блок-предок
  function getTopBlock(taskIdx){
    for(var i=taskIdx-1;i>=0;i--){
      if(p.tasks[i].s&&p.tasks[i].d===0)return p.tasks[i].w;
    }
    return null;
  }
  p.tasks.forEach(function(t,ti){
    if(t.s||!p.chk[t.w]||!t.h)return;
    var bk=getTopBlock(ti);if(!bk||!blocks[bk])return;
    if(t.r==='core'||t.r==='conf')blocks[bk].core+=t.h;
    else if(t.r==='test')blocks[bk].test+=t.h;else blocks[bk].other+=t.h;
    blocks[bk].tot+=t.h;
  });
  var brows='',btot={core:0,test:0,other:0,tot:0};
  Object.keys(blocks).filter(function(k){return blocks[k].tot>0;}).sort(function(a,b){return blocks[b].tot-blocks[a].tot;}).forEach(function(k){
    var b=blocks[k];
    brows+='<tr><td style="max-width:130px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="'+escH(b.name)+'">'+escH(b.name)+'</td>'
      +'<td>'+(b.core||'—')+'</td><td>'+(b.test||'—')+'</td><td>'+(b.other||'—')+'</td><td style="font-weight:700">'+b.tot+'</td></tr>';
    ['core','test','other','tot'].forEach(function(x){btot[x]+=b[x];});
  });
  brows+='<tr class="tr"><td>ИТОГО</td><td>'+btot.core+'</td><td>'+btot.test+'</td><td>'+btot.other+'</td><td>'+btot.tot+'</td></tr>';
  html+='<div class="rcard"><table class="bt"><thead><tr><th>Блок</th><th>Ядро</th><th>Тест</th><th>Проч.</th><th>Итого</th></tr></thead><tbody>'+brows+'</tbody></table></div>';
  el.innerHTML=html;
}

// ── DRAG & DROP ──────────────────────────────────────────────────
var _dPid=null,_dIdx=null;
function setupDrag(pid){
  var tbody=ge('tbody-'+pid);
  if(!tbody)return;
  // Используем один set listeners на tbody (вместо N×5 на строках)
  // Удаляем старые через замену cloneNode
  if(tbody._dragSetup)return; // уже настроен
  tbody._dragSetup=true;
  tbody.addEventListener('dragstart',function(e){
    var row=e.target.closest('tr[data-widx]');
    if(!row)return;
    _dPid=row.dataset.pid;_dIdx=+row.dataset.widx;
    row.classList.add('dragging');e.dataTransfer.effectAllowed='move';
  });
  tbody.addEventListener('dragend',function(e){
    var row=e.target.closest('tr[data-widx]');
    if(row)row.classList.remove('dragging');
    document.querySelectorAll('tr.drag-over,tr.drag-into').forEach(function(r){
      r.classList.remove('drag-over');r.classList.remove('drag-into');
    });
  });
  tbody.addEventListener('dragover',function(e){
    e.preventDefault();
    var row=e.target.closest('tr[data-widx]');
    if(!row)return;
    document.querySelectorAll('tr.drag-over,tr.drag-into').forEach(function(r){
      r.classList.remove('drag-over');r.classList.remove('drag-into');
    });
    var ti=+row.dataset.widx;
    var sp=getPeriod(_dPid);
    var tgt=sp?sp.tasks[ti]:null;var src=sp?sp.tasks[_dIdx]:null;
    if(tgt&&tgt.s&&src&&!src.s){row.classList.add('drag-into');_dropInto=true;}
    else{row.classList.add('drag-over');_dropInto=false;}
  });
  tbody.addEventListener('dragleave',function(e){
    // Проверяем что ушли за пределы tbody
    if(!tbody.contains(e.relatedTarget)){
      document.querySelectorAll('tr.drag-over,tr.drag-into').forEach(function(r){
        r.classList.remove('drag-over');r.classList.remove('drag-into');
      });
      _dropInto=false;
    }
  });
  tbody.addEventListener('drop',function(e){
    e.preventDefault();
    document.querySelectorAll('tr.drag-over,tr.drag-into').forEach(function(r){
      r.classList.remove('drag-over');r.classList.remove('drag-into');
    });
    var row=e.target.closest('tr[data-widx]');
    if(!row)return;
    var tp=row.dataset.pid,ti=+row.dataset.widx;
    if(!_dPid||(_dPid===tp&&_dIdx===ti))return;
    saveUndo();
    var sp=getPeriod(_dPid);if(!sp)return;
    var srcIdx=_dIdx,src=sp.tasks[srcIdx],tgt=sp.tasks[ti];
    if(tgt&&tgt.s&&src&&!src.s&&_dropInto){
      moveTaskInPeriod(sp,srcIdx,tgt.w);
    }else{
      var targetParentWbs=tgt.s?tgt.w:getParentWbs(sp.tasks,ti);
      var srcParentWbs=getParentWbs(sp.tasks,srcIdx);
      if(targetParentWbs&&targetParentWbs!==srcParentWbs){
        moveTaskInPeriod(sp,srcIdx,targetParentWbs);
      }else{
        if(src.s){
          var block=[];var bi=srcIdx;
          while(bi<sp.tasks.length&&(sp.tasks[bi].w===src.w||sp.tasks[bi].w.indexOf(src.w+'.')===0)){block.push(sp.tasks.splice(bi,1)[0]);}
          var ni=sp.tasks.indexOf(tgt);if(ni<0)ni=ti<srcIdx?ti:Math.max(0,ti-block.length);
          block.forEach(function(b,i){sp.tasks.splice(ni+i,0,b);});
        }else{
          sp.tasks.splice(srcIdx,1);var ni=sp.tasks.indexOf(tgt);if(ni<0)ni=Math.max(0,ti<srcIdx?ti:ti-1);
          sp.tasks.splice(ni,0,src);
        }
      }
    }
    _dPid=null;_dIdx=null;_dropInto=false;refreshAll();
  });
}

// ── MODALS ───────────────────────────────────────────────────────
function openOv(id){var el=ge(id);el.style.cssText='display:flex;position:fixed;top:0;left:0;width:100%;height:100%;z-index:9999;background:rgba(0,0,0,.45);align-items:flex-start;justify-content:center;padding-top:50px;';document.body.style.overflow='hidden';}
function closeOv(id){ge(id).style.cssText='display:none';document.body.style.overflow='';}
var _ccb=null;
function confirm2(t,m,cb){ge('confirmTitle').textContent=t;ge('confirmMsg').textContent=m;_ccb=cb;openOv('ovConfirm');}
var _itab='full';
function switchImportTab(t){_itab=t;['full','tasks'].forEach(function(x){ge('tp'+x.charAt(0).toUpperCase()+x.slice(1)).className='tp'+(x===t?' on':'');ge('tab'+x.charAt(0).toUpperCase()+x.slice(1)+'Btn').className='tab'+(x===t?' on':'');});ge('importPreview').innerHTML='';}

function fillAddSelects(pid){
  ge('addPeriodSel').innerHTML=periodOpts(pid);
  updateAddParentSel();
}
function updateAddParentSel(){
  var pid=gv('addPeriodSel'),p=getPeriod(pid)||editablePeriods()[0];if(!p)return;
  ge('addParent').innerHTML=blockOpts(p);
  ge('addRes').innerHTML=resOpts(p.res,'core');
}

// ── ACTIONS ──────────────────────────────────────────────────────
function doAddTask(){
  saveUndo();
  var pid=gv('addPeriodSel'),p=getPeriod(pid);if(!p)return;
  var pw=gv('addParent'),name=ge('addName').value.trim(),h=+gv('addHours')||0,r=gv('addRes');
  if(!name){notify('Введите название');return;}
  if(isLocked(p))return;
  var pt=p.tasks.find(function(t){return t.w===pw;});
  var nw=uniqWbs(pw+'.x'+Date.now()%100000,p);
  var ins=p.tasks.map(function(t){return t.w;}).indexOf(pw)+1;
  while(ins<p.tasks.length&&p.tasks[ins].w.indexOf(pw+'.')===0)ins++;
  var asBlock=ge('addAsBlock')&&ge('addAsBlock').checked;
  var newTask=asBlock
    ?{w:nw,n:name,h:0,r:'none',s:true,d:(pt?pt.d:0)+1}
    :{w:nw,n:name,h:h,r:r,s:false,d:(pt?pt.d:0)+1};
  p.tasks.splice(ins,0,newTask);
  p.chk[nw]=asBlock?false:true;
  // Синхронизация в связанный период
  var lp=getLinkedW(p);
  if(lp){
    // Ищем соответствующий блок в lp: по WBS, затем по имени
    var lpt=pt?twinIn(lp,pt):lp.tasks.find(function(t){return t.s;});
    // при совпадающем родителе задача-двойник получает тот же WBS (идентичность по WBS)
    var lnw=(lpt&&lpt.w===pw&&!lp.tasks.some(function(t){return t.w===nw;}))?nw:uniqWbs((lpt?lpt.w:'lx')+'.x'+(Date.now()+1)%100000,lp);
    var matchRes=lp.res[r]?r:'none';
    var lTask=asBlock
      ?{w:lnw,n:name,h:0,r:'none',s:true,d:(lpt?lpt.d:0)+1}
      :{w:lnw,n:name,h:h,r:matchRes,s:false,d:(lpt?lpt.d:0)+1};
    if(lpt){
      var li=lp.tasks.map(function(t){return t.w;}).indexOf(lpt.w)+1;
      while(li<lp.tasks.length&&lp.tasks[li].w.indexOf(lpt.w+'.')===0)li++;
      lp.tasks.splice(li,0,lTask);
    }else{lp.tasks.push(lTask);}
    lp.chk[lnw]=asBlock?false:false; // инверсия — в lp неактивна
  }
  ge('addName').value='';
  closeOv('ovAdd');refreshAll();
}
function doAddBlock(){
  saveUndo();
  var pid=gv('apPeriodSel'),p=getPeriod(pid);if(!p||isLocked(p))return;
  var name=ge('addParentName').value.trim();
  if(!name){notify('Введите название');return;}
  var wbs=nextBlockWbs(p);
  // Убеждаемся что wbs уникален
  while(p.tasks.find(function(t){return t.w===wbs;}))wbs=parseFloat(wbs)+0.1+'';
  p.tasks.push({w:wbs,n:name,h:0,r:'none',s:true,d:0});p.chk[wbs]=false;
  ge('addParentName').value='';closeOv('ovAddParent');refreshAll();
}

// Уникальный WBS в периоде (на случай совпадения отметок времени).
function uniqWbs(w,p){var b=w,i=1;while(p.tasks.some(function(t){return t.w===w;}))w=b+'_'+(i++);return w;}
function openEdit(pid,idx){
  var p=getPeriod(pid);if(!p||isLocked(p))return;
  var t=p.tasks[idx];
  ge('editName').value=t.n;ge('editHours').value=t.h;ge('editPid').value=pid;ge('editIdx').value=idx;
  var curPar=getParentWbs(p.tasks,idx)||'';
  ge('editParent').innerHTML=blockOpts(p,curPar,t.w);
  ge('editRes').innerHTML=resOpts(p.res,t.r);
  ge('editHoursRow').style.display=t.s?'none':'';
  ge('editStRow').style.display=t.s?'none':'';
  ge('editSt').value=CPCalc.taskStatus(t);ge('editWs').value=t.ws||'';ge('editDn').value=t.dn||'';
  ge('editResRow').style.display=t.s?'none':'';
  ge('editParentRow').style.display=t.s?'none':'';
  ge('editMakeSummaryRow').style.display='';
  ge('btnMakeSummary').style.display=t.s?'none':'';
  ge('btnMakeLeaf').style.display=t.s?'':'none';
  var others=editablePeriods().filter(function(x){return x.id!==pid;});
  ge('editMoveRow').style.display=others.length?'':'none';
  if(others.length){
    ge('editMovePeriod').innerHTML=others.map(function(x){return '<option value="'+x.id+'">'+escH(x.name)+'</option>';}).join('');
    // Для блоков не нужен выбор родителя
    ge('editMoveParent').style.display=t.s?'none':'';
    if(!t.s)updateEditMoveParent();
  }
  openOv('ovEdit');ge('editName').focus();
}
function updateEditMoveParent(){var tp=getPeriod(gv('editMovePeriod'));if(!tp)return;ge('editMoveParent').innerHTML=blockOpts(tp);}

function doEdit(){
  saveUndo();
  var pid=gv('editPid'),idx=+gv('editIdx'),p=getPeriod(pid);if(!p||isLocked(p))return;
  var t=p.tasks[idx];
  var oldName=t.n,nn=ge('editName').value.trim();
  // Находим близнецов ДО переименования (по WBS, затем по старому имени)
  var lp=findTwinLp(p);
  var lt=lp?twinIn(lp,{w:t.w,n:oldName,s:t.s}):null;
  var llp=lp?getLinkedW(lp):null;
  var lt2=(llp&&llp.id!==pid)?twinIn(llp,{w:t.w,n:oldName,s:t.s}):null;
  // Применяем изменения к задаче
  if(nn)t.n=nn;
  if(!t.s){
    t.h=+gv('editHours')||0;t.r=gv('editRes');
    var nst=gv('editSt');
    if(nst!==CPCalc.taskStatus(t)||(gv('editWs')||'')!==(t.ws||'')||(gv('editDn')||'')!==(t.dn||'')){
      if(nst==='new'){applyStatus(t,'new');}
      else{delete t.ws;if(nst==='done')delete t.dn;applyStatus(t,nst,gv('editWs')||null,nst==='done'?(gv('editDn')||null):null);}
      if(lt)copyStatus(t,lt);if(lt2)copyStatus(t,lt2);
    }
    // Синхронизируем
    if(lt){if(nn)lt.n=nn;lt.h=t.h;lt.r=lp.res[t.r]?t.r:'none';}
    if(lt2){if(nn)lt2.n=nn;lt2.h=t.h;lt2.r=(llp&&llp.res[t.r])?t.r:'none';}
    var np=gv('editParent'),cp=getParentWbs(p.tasks,idx)||'';
    if(np&&np!==cp){moveTaskInPeriod(p,idx,np);closeOv('ovEdit');refreshAll();return;}
  } else {
    // Блок — только переименование
    if(lt&&nn)lt.n=nn;
    if(lt2&&nn)lt2.n=nn;
  }
  closeOv('ovEdit');refreshAll();
}
function doMakeLeaf(){
  saveUndo();
  var pid=gv('editPid'),idx=+gv('editIdx'),p=getPeriod(pid);if(!p||isLocked(p))return;
  var t=p.tasks[idx];
  var kids=p.tasks.filter(function(c){return c.w.indexOf(t.w+'.')===0;});
  var grandParentWbs=getParentWbs(p.tasks,idx);
  var grandParent=grandParentWbs?p.tasks.find(function(x){return x.w===grandParentWbs;}):null;
  var newDepth=grandParent?grandParent.d+1:0;
  kids.forEach(function(kid){
    var rel=kid.w.slice(t.w.length);
    var newW=grandParentWbs?grandParentWbs+rel:rel.slice(1);
    var oldChk=p.chk[kid.w];delete p.chk[kid.w];
    kid.w=newW;kid.d=newDepth+(kid.d-t.d-1)+1;p.chk[kid.w]=oldChk;
  });
  var savedH=+gv('editHours')||0,savedR=gv('editRes')||'none';
  t.s=false;t.h=savedH;t.r=savedR;t.d=newDepth;
  delete p.chk[t.w];p.chk[t.w]=true;
  closeOv('ovEdit');refreshAll();
}
function doMakeSummary(){
  saveUndo();
  var pid=gv('editPid'),idx=+gv('editIdx'),p=getPeriod(pid);if(!p||isLocked(p))return;
  var t=p.tasks[idx];
  t.s=true;t.h=0;delete p.chk[t.w];p.chk[t.w]=false;
  closeOv('ovEdit');refreshAll();
}
function doMoveTask(copy){
  saveUndo();
  var pid=gv('editPid'),idx=+gv('editIdx'),sp=getPeriod(pid);if(!sp||isLocked(sp))return;
  var t=sp.tasks[idx],tpid=gv('editMovePeriod'),tp=getPeriod(tpid);if(!tp||isLocked(tp))return;
  if(t.s){
    // Блок переносится целиком на верхний уровень целевого периода
    var block=sp.tasks.filter(function(c){return c.w===t.w||c.w.indexOf(t.w+'.')===0;});
    var cloned=JSON.parse(JSON.stringify(block));
    // если WBS блока уже заняты в целевом периоде — блок получает новый номер верхнего уровня
    var clash=cloned.some(function(c){return tp.tasks.some(function(x){return x.w===c.w;});});
    var oldPrefix=t.w,newPrefix=clash?nextBlockWbs(tp):t.w;
    while(clash&&tp.tasks.some(function(x){return x.w===newPrefix||x.w.indexOf(newPrefix+'.')===0;}))newPrefix=String(+newPrefix+1);
    cloned.forEach(function(c){var ow=c.w;c.w=newPrefix+ow.slice(oldPrefix.length);c.d=c.d-t.d;tp.chk[c.w]=sp.chk[ow]||false;});
    tp.tasks=tp.tasks.concat(cloned);
    if(!copy)sp.tasks=sp.tasks.filter(function(c){return c.w!==t.w&&c.w.indexOf(t.w+'.')!==0;});
  }else{
    var tpar=gv('editMoveParent');
    var tpt=tp.tasks.find(function(x){return x.w===tpar;});
    var nw=uniqWbs(tpar+'.x'+Date.now()%100000,tp);
    var cl=JSON.parse(JSON.stringify(t));cl.w=nw;cl.d=(tpt?tpt.d:0)+1;
    var ins=tp.tasks.map(function(x){return x.w;}).indexOf(tpar)+1;
    while(ins<tp.tasks.length&&tp.tasks[ins].w.indexOf(tpar+'.')===0)ins++;
    tp.tasks.splice(ins,0,cl);tp.chk[nw]=sp.chk[t.w]||false;
    if(!copy){sp.tasks.splice(idx,1);delete sp.chk[t.w];}
  }
  closeOv('ovEdit');refreshAll();
}

function doAddRes(pid){
  saveUndo();
  var p=getPeriod(pid);if(!p||isLocked(p))return;
  var key=gv('resKey').trim().replace(/[\s"'<>&|\\]+/g,'_').slice(0,40),label=gv('resLabel').trim();
  if(!key||!label){notify('Заполните ключ и название');return;}
  if(p.res[key])key=key+'_'+Date.now()%1000;
  p.res[key]={label:label,n:+gv('resN')||1,pct:+gv('resPct')||100,period:gv('resPeriod'),color:gv('resColor')};
  ge('resKey').value='';ge('resLabel').value='';closeOv('ovRes');refreshAll();
}
function deleteRes(pid,k){
  saveUndo();
  var p=getPeriod(pid);if(!p||isLocked(p))return;
  p.tasks.forEach(function(t){if(t.r===k)t.r='none';});delete p.res[k];
  if(p.filter===k)p.filter=null;refreshAll();
}

// ── PERIOD MANAGEMENT ────────────────────────────────────────────
function openAddPeriod(){
  var opts='<option value="">— без связи (независимый)</option>';
  // связать можно только с открытой версией, чья текущая пара (если есть) тоже открыта
  PERIODS.forEach(function(p){var old=getLinked(p);if(p.closed||(old&&old.closed))return;opts+='<option value="'+p.id+'">'+escH(p.name)+'</option>';});
  ge('newPeriodLink').innerHTML=opts;
  ge('newPeriodName').value='';ge('linkInfo').style.display='none';
  openOv('ovAddPeriod');ge('newPeriodName').focus();
}
function doAddPeriod(){
  saveUndo();
  var name=ge('newPeriodName').value.trim()||('Период '+(PERIODS.length+1));
  var linkId=gv('newPeriodLink');
  var lastRes=PERIODS.length>0?PERIODS[PERIODS.length-1].res:null;
  var newP=mkPeriod(name,null,lastRes);
  newP.tasks=[];newP.chk={};
  if(linkId){
    var lp=getPeriod(linkId);
    if(lp&&!lp.closed){
      // Если lp уже связан с кем-то — рвём ту связь
      if(lp.linkedTo){var old=getPeriod(lp.linkedTo);if(old)old.linkedTo=null;}
      // Копируем задачи с инверсией галочек
      newP.tasks=JSON.parse(JSON.stringify(lp.tasks));
      newP.chk={};lp.tasks.forEach(function(t){newP.chk[t.w]=!lp.chk[t.w];});
      // Копируем ресурсы
      newP.res=JSON.parse(JSON.stringify(lp.res));
      newP.linkedTo=lp.id;lp.linkedTo=newP.id;
    }
  }
  PERIODS.push(newP);closeOv('ovAddPeriod');renderAll();
}
function breakLink(pid){
  saveUndo();
  var p=getPeriod(pid);if(!p||!p.linkedTo)return;
  var lp=getPeriod(p.linkedTo);
  if(isLocked(p)||(lp&&lp.closed)){notify('Связь с закрытой вехой нельзя менять — сначала переоткройте её');return;}
  if(lp)lp.linkedTo=null;
  p.linkedTo=null;renderAll();
}

// ── EXPORT / IMPORT ──────────────────────────────────────────────
function exportCSV(){
  var lines=['#CAPACITY_PLANNER_V3_EXPORT'];
  PERIODS.forEach(function(p,pi){
    // linkedTo сохраняем как индекс периода (надёжнее чем pid)
    var linkedIdx=p.linkedTo?PERIODS.findIndex(function(x){return x.id===p.linkedTo;}):-1;
    lines.push('','#PERIOD,"'+pi+'","'+p.name.replace(/"/g,'""')+'"'+(linkedIdx>=0?','+linkedIdx:''));
    lines.push('#P,'+p.devStart+','+p.devEnd+','+p.tstStart+','+p.tstEnd);
    lines.push('#RESOURCES,key,label,n,pct,period,color');
    Object.keys(p.res).forEach(function(k){var r=p.res[k];lines.push('#R,"'+k+'","'+r.label.replace(/"/g,'""')+'",'+r.n+','+r.pct+','+r.period+','+r.color);});
    lines.push('#TASKS,wbs,name,hours,resource,isSummary,depth,checked,status');
    p.tasks.forEach(function(t){lines.push('"'+t.w+'","'+t.n.replace(/"/g,'""')+'",'+t.h+','+t.r+','+(t.s?1:0)+','+t.d+','+(p.chk[t.w]?1:0)+','+(t.s?'':CPCalc.taskStatus(t)));});
  });
  var blob=new Blob(['\uFEFF'+lines.join('\n')],{type:'text/csv;charset=utf-8'});
  var a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='capacity_plan_'+new Date().toISOString().slice(0,10)+'.csv';a.click();
}
function parseCSVLine(line){
  var res=[],cur='',inQ=false;
  for(var i=0;i<line.length;i++){var c=line[i];
    if(c==='"'){if(inQ&&line[i+1]==='"'){cur+='"';i++;}else inQ=!inQ;}
    else if((c===','||c===';')&&!inQ){res.push(cur.trim());cur='';}
    else cur+=c;}res.push(cur.trim());return res;
}
function doImport(){
  saveUndo();
  if(READONLY)return;
  if(_itab==='full'){
    if(PERIODS.some(function(p){return p.closed;})){notify('Полный импорт заменяет все периоды, а в проекте есть закрытые вехи. Сначала переоткройте их.');return;}
    var text=ge('csvFullInput').value.trim();if(!text){notify('Вставьте CSV');return;}
    var lines=text.split('\n');
    var isV3=text.indexOf('#CAPACITY_PLANNER_V3_EXPORT')>=0,isV2=text.indexOf('#CAPACITY_PLANNER_EXPORT')>=0;
    if(!isV3&&!isV2){notify('Неверный формат.');return;}
    if(isV3){
      var newPs=[],curP=null,linkMap={};
      lines.forEach(function(line){line=line.trim();
        if(line.indexOf('#PERIOD,')==0){var p2=parseCSVLine(line.slice(8));curP=mkPeriod(p2[1]||'Период');curP.tasks=[];curP.chk={};curP.res={};if(p2[2])linkMap[curP.id]=p2[2];newPs.push(curP);}
        else if(curP&&line.indexOf('#P,')==0){var p2=line.slice(3).split(',');curP.devStart=p2[0];curP.devEnd=p2[1];curP.tstStart=p2[2];curP.tstEnd=p2[3];}
        else if(curP&&line.indexOf('#R,')==0){var p2=parseCSVLine(line.slice(3));if(p2.length>=6)curP.res[p2[0]]={label:p2[1],n:+p2[2]||1,pct:+p2[3]||100,period:p2[4]||'dev',color:p2[5]||'#0969da'};}
        else if(curP&&line&&line.indexOf('#')<0){var p2=parseCSVLine(line);if(p2.length>=7){var t={w:p2[0],n:p2[1],h:+p2[2]||0,r:p2[3],s:p2[4]==='1',d:+p2[5]||0};if(!t.s&&(p2[7]==='wip'||p2[7]==='done'))t.st=p2[7];curP.tasks.push(t);curP.chk[p2[0]]=p2[6]==='1';}}
      });
      if(!newPs.length){notify('Периоды не найдены.');return;}
      PERIODS.length=0;newPs.forEach(function(p){PERIODS.push(p);});
      // Восстанавливаем ссылки
      // Восстанавливаем связи по индексу
      Object.keys(linkMap).forEach(function(newPid){
        var targetIdx=+linkMap[newPid];
        if(!isNaN(targetIdx)&&newPs[targetIdx]){
          var p=getPeriod(newPid);
          if(p)p.linkedTo=newPs[targetIdx].id;
        }
      });
    }else{
      var nRes={},nTasks=[],nChk={},dS='',dE='',tS='',tE='';
      lines.forEach(function(line){line=line.trim();
        if(line.indexOf('#P,')==0){var p2=line.slice(3).split(',');dS=p2[0];dE=p2[1];tS=p2[2];tE=p2[3];}
        else if(line.indexOf('#R,')==0){var p2=parseCSVLine(line.slice(3));if(p2.length>=6)nRes[p2[0]]={label:p2[1],n:+p2[2]||1,pct:+p2[3]||100,period:p2[4]||'dev',color:p2[5]||'#0969da'};}
        else if(line&&line.indexOf('#')<0){var p2=parseCSVLine(line);if(p2.length>=7){nTasks.push({w:p2[0],n:p2[1],h:+p2[2]||0,r:p2[3],s:p2[4]==='1',d:+p2[5]||0,st:(p2[4]!=='1'&&(p2[7]==='wip'||p2[7]==='done'))?p2[7]:undefined});nChk[p2[0]]=p2[6]==='1';}}
      });
      if(!nTasks.length){notify('Задачи не найдены.');return;}
      var imp=mkPeriod('Импортированный период',null,nRes);imp.tasks=nTasks;imp.chk=nChk;imp.res=nRes;
      if(dS)imp.devStart=dS;if(dE)imp.devEnd=dE;if(tS)imp.tstStart=tS;if(tE)imp.tstEnd=tE;
      PERIODS.length=0;PERIODS.push(imp);
    }
    ge('csvFullInput').value='';closeOv('ovImport');renderAll();
    notify('Загружено: '+PERIODS.length+' период(ов).');
  }else{
    var pid=gv('importPeriodSel'),p=getPeriod(pid);if(!p||isLocked(p)){notify('Выберите период');return;}
    var text=ge('csvTasksInput').value.trim(),defPw=gv('importParent');
    var parsed=text.split('\n').filter(function(l){return l.trim()&&l.indexOf('#')<0;})
      .map(function(l){var pp=parseCSVLine(l);return{parent:pp.length>=3?pp[0]:defPw,name:pp.length>=3?pp[1]:pp[0],h:+(pp.length>=3?pp[2]:pp[1])||40,r:(pp.length>=3?pp[3]:pp[2])||'core'};})
      .filter(function(x){return x.name;});
    if(!parsed.length){notify('Ничего не найдено');return;}
    parsed.forEach(function(item){
      var pw=item.parent||defPw;
      if(!p.tasks.find(function(t){return t.w===pw;}))p.tasks.push({w:pw,n:'Блок '+pw,h:0,r:'none',s:true,d:0});
      var pt=p.tasks.find(function(t){return t.w===pw;});
      var nw=pw+'.x'+Date.now()%100000+Math.round(Math.random()*99);
      var ins=p.tasks.map(function(t){return t.w;}).indexOf(pw)+1;
      while(ins<p.tasks.length&&p.tasks[ins].w.indexOf(pw+'.')===0)ins++;
      p.tasks.splice(ins,0,{w:nw,n:item.name,h:item.h,r:item.r,s:false,d:(pt?pt.d:0)+1});p.chk[nw]=true;
    });
    ge('csvTasksInput').value='';closeOv('ovImport');refreshAll();
  }
}
function previewImport(){
  var text=(_itab==='full'?ge('csvFullInput'):ge('csvTasksInput')).value.trim();
  if(!text){ge('importPreview').innerHTML='';return;}
  if(_itab==='full'){
    var isV3=text.indexOf('#CAPACITY_PLANNER_V3_EXPORT')>=0,isV2=text.indexOf('#CAPACITY_PLANNER_EXPORT')>=0;
    if(!isV3&&!isV2){ge('importPreview').innerHTML='<span style="color:#dc2626">Неверный формат</span>';return;}
    var periods=text.split('\n').filter(function(l){return l.indexOf('#PERIOD,')==0;}).length;
    var tasks=text.split('\n').filter(function(l){return l&&l.indexOf('#')<0;}).length;
    ge('importPreview').innerHTML='✅ '+(isV3?periods+' период(ов), ':'')+tasks+' задач';
  }else{
    var n=text.split('\n').filter(function(l){return l.trim()&&l.indexOf('#')<0;}).length;
    ge('importPreview').innerHTML=n?'Будет добавлено <b>'+n+' задач</b>':'<span style="color:#dc2626">Ничего не распознано</span>';
  }
}

// ── SAVE / LOAD ──────────────────────────────────────────────────
// Сохранение на сервер, скачивание/загрузка конфигурации и сброс — в app.js.

// ── PDF ──────────────────────────────────────────────────────────
function doPrint(){
  var now=new Date();var ds=now.toLocaleDateString('ru-RU')+' '+now.toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'});
  var th=0,tt=0;PERIODS.forEach(function(p){th+=p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).reduce(function(s,t){return s+t.h;},0);tt+=p.tasks.filter(function(t){return !t.s&&p.chk[t.w];}).length;});
  var ph=ge('printHdr');if(ph)ph.innerHTML='Планировщик ёмкости · '+ds+' · Периодов: '+PERIODS.length+' · Задач: '+tt+' ('+th.toLocaleString('ru')+'ч)';
  window.print();
}

// ── EVENTS ───────────────────────────────────────────────────────
var _csvFileEl=ge('csvFile');if(_csvFileEl)_csvFileEl.addEventListener('change',function(){var f=this.files[0];if(!f)return;var r=new FileReader();r.onload=function(e){ge('csvFullInput').value=e.target.result;};r.readAsText(f,'utf-8');});

document.addEventListener('change',function(e){
  var el=e.target,v=el.value;
  if(el.dataset.ptitle){var p=getPeriod(el.dataset.ptitle);if(p){p.name=v;refreshAll();}}
  else if(el.dataset.pdate){var pts=el.dataset.pdate.split('|');var p=getPeriod(pts[0]);if(p){p[pts[1]]=v;refreshPeriod(p.id);}}
  else if(el.dataset.tog){var pts=el.dataset.tog.split('|');var p=getPeriod(pts[0]);if(p){saveUndo();p.chk[pts[1]]=el.checked;syncLinkedChk(p,pts[1],el.checked);refreshAll();}}
  else if(el.dataset.grp){var pts=el.dataset.grp.split('|');var p=getPeriod(pts[0]);if(p){saveUndo();p.tasks.forEach(function(t){if(!t.s&&t.w.indexOf(pts[1]+'.')===0)p.chk[t.w]=el.checked;});syncLinkedGroupChk(p,pts[1],el.checked);refreshAll();}}
  else if(el.dataset.seth){var pts=el.dataset.seth.split('|');var p=getPeriod(pts[0]);if(p){saveUndo();var tk=p.tasks[+pts[1]];if(tk){tk.h=+v;var twin=findTwin(p,tk);if(twin)twin.h=+v;var lp2=findTwinLp(p);var llp2=lp2?getLinkedW(lp2):null;if(llp2&&llp2.id!==p.id){var tw2=twinIn(llp2,tk);if(tw2)tw2.h=+v;}}refreshAll();}}
  else if(el.dataset.setst){var pts=el.dataset.setst.split('|');var p=getPeriod(pts[0]);if(p){saveUndo();var tk=p.tasks[+pts[1]];if(tk&&!tk.s&&CPCalc.STATUSES.indexOf(v)>=0){
    // статус — свойство самой работы, поэтому переносится и в задачу-двойника связанной версии
    applyStatus(tk,v);copyStatus(tk,findTwin(p,tk));}refreshAll();}}
  else if(el.dataset.setr){var pts=el.dataset.setr.split('|');var p=getPeriod(pts[0]);if(p){saveUndo();var tk=p.tasks[+pts[1]];if(tk){tk.r=v;var lp=findTwinLp(p);var twin=findTwin(p,tk);if(twin&&lp){twin.r=lp.res[v]?v:'none';}}refreshAll();}}
  else if(el.dataset.resname){var pts=el.dataset.resname.split('|');var p=getPeriod(pts[0]);if(p&&p.res[pts[1]]){p.res[pts[1]].label=v;refreshPeriod(p.id);}}
  else if(el.dataset.resn){var pts=el.dataset.resn.split('|');var p=getPeriod(pts[0]);if(p&&p.res[pts[1]]){p.res[pts[1]].n=+v;refreshPeriod(p.id);}}
  else if(el.dataset.respct){var pts=el.dataset.respct.split('|');var p=getPeriod(pts[0]);if(p&&p.res[pts[1]]){p.res[pts[1]].pct=+v;refreshPeriod(p.id);}}
  else if(el.dataset.rescol){var pts=el.dataset.rescol.split('|');var p=getPeriod(pts[0]);if(p&&p.res[pts[1]]){p.res[pts[1]].color=v;refreshPeriod(p.id);}}
  else if(el.dataset.resper){var pts=el.dataset.resper.split('|');var p=getPeriod(pts[0]);if(p&&p.res[pts[1]]){p.res[pts[1]].period=v;refreshPeriod(p.id);}}
  else if(el.id==='addPeriodSel'){updateAddParentSel();}
  else if(el.id==='editMovePeriod'){updateEditMoveParent();}
  else if(el.id==='newPeriodLink'){ge('linkInfo').style.display=v?'block':'none';}
});

document.addEventListener('click',function(e){
  var el=e.target;
  var del=el.closest('[data-del]');
  if(del&&del.dataset.delpid){var p=getPeriod(del.dataset.delpid);if(p){saveUndo();var idx=+del.dataset.del;var t=p.tasks[idx];var lp=getLinkedW(p),lt=twinIn(lp,t);
    // блок удаляется вместе с потомками (строго по префиксу «WBS.», чтобы «1» не задевал «10»)
    function rmFrom(per,w,sum){var gone=per.tasks.filter(function(c){return c.w===w||(sum&&c.w.indexOf(w+'.')===0);});per.tasks=per.tasks.filter(function(c){return gone.indexOf(c)<0;});gone.forEach(function(c){delete per.chk[c.w];});}
    rmFrom(p,t.w,t.s);
    if(lt)rmFrom(lp,lt.w,lt.s);
    refreshAll();return;}}
  var dres=el.closest('[data-delres]');
  if(dres){var pts=dres.dataset.delres.split('|');deleteRes(pts[0],pts[1]);return;}
  var ct=el.closest('[data-coltog]');
  if(ct){var pts=ct.dataset.coltog.split('|');var p=getPeriod(pts[0]);if(p){p.collapsed[pts[1]]=!p.collapsed[pts[1]];renderTree(p,getDupNames());return;}}
  var fall=el.closest('[data-fall]');
  if(fall){var p=getPeriod(fall.dataset.fall);if(p){p.filter=null;renderFilter(p);renderTree(p,getDupNames());renderRight(p);return;}}
  var fres=el.closest('[data-fres]');
  if(fres){var pts=fres.dataset.fres.split('|');var p=getPeriod(pts[0]);if(p){p.filter=pts[1];renderFilter(p);renderTree(p,getDupNames());renderRight(p);return;}}
  var factive=el.closest('[data-factive]');
  if(factive){var pts=factive.dataset.factive.split('|');var p=getPeriod(pts[0]);if(p){var nv=+pts[1]===1;p.filterActive=(p.filterActive===nv?null:nv);renderFilter(p);renderTree(p,getDupNames());return;}}
  var fp=el.closest('[data-foldperiod]');
  if(fp&&el.tagName!=='INPUT'&&!el.closest('.pactions')){var p=getPeriod(fp.dataset.foldperiod);if(p){p.folded=!p.folded;renderAll();return;}}
  var at=el.closest('[data-addtask]');
  if(at){fillAddSelects(at.dataset.addtask);openOv('ovAdd');ge('addName').focus();return;}
  var ab=el.closest('[data-addblock]');
  if(ab){ge('apPeriodSel').innerHTML=periodOpts(ab.dataset.addblock);openOv('ovAddParent');ge('addParentName').focus();return;}
  var ar=el.closest('[data-addres]');
  if(ar){ge('resPidTarget').value=ar.dataset.addres;openOv('ovRes');ge('resKey').focus();return;}
  var dp=el.closest('[data-delperiod]');
  if(dp){var pid=dp.dataset.delperiod;var dpp=getPeriod(pid),dpl=dpp&&getLinked(dpp);if(dpp&&(dpp.closed||(dpl&&dpl.closed))){notify('Закрытую веху (или версию, связанную с закрытой) удалить нельзя — сначала переоткройте её');return;}confirm2('Удалить период','Удалить период и все его задачи?',function(){saveUndo();var p=getPeriod(pid);if(p&&p.linkedTo){var lp=getPeriod(p.linkedTo);if(lp)lp.linkedTo=null;}PERIODS=PERIODS.filter(function(x){return x.id!==pid;});if(!PERIODS.length){var np=mkPeriod('Период 1');np.tasks=[];PERIODS.push(np);}renderAll();});return;}
  // Sticky res chip filter
  // Кнопка + в строке блока
  var aitBtn=el.closest('[data-addintask]');
  if(aitBtn){
    e.stopPropagation();
    var pts=aitBtn.dataset.addintask.split('|');
    var aitPid=pts[0],aitW=pts[1];
    fillAddSelects(aitPid);
    // Выбираем нужный период и блок
    var psel=ge('addPeriodSel');if(psel)psel.value=aitPid;
    updateAddParentSel();
    var bsel=ge('addParent');if(bsel)bsel.value=aitW;
    openOv('ovAdd');ge('addName').focus();return;
  }
  var sfres=el.closest('[data-sfres]');
  if(sfres){var pts=sfres.dataset.sfres.split('|');var p=getPeriod(pts[0]);
    if(p){p.filter=(p.filter===pts[1])?null:pts[1];renderFilter(p);renderTree(p,getDupNames());renderRight(p);renderStickyBar(p);}return;}
  // Sticky bar background click → scroll to period
  var sp2=el.closest('[data-scrollperiod]');
  if(sp2&&!el.closest('[data-sfres]')&&!el.closest('[data-addtask]')&&!el.closest('[data-addblock]')){
    var pel=ge('period-'+sp2.dataset.scrollperiod);
    if(pel)pel.scrollIntoView({behavior:'smooth',block:'start'});return;}
  var scrollto=el.closest('[data-scrollto]');
  if(scrollto){var pel=ge('period-'+scrollto.dataset.scrollto);if(pel)pel.scrollIntoView({behavior:'smooth',block:'start'});return;}
  var bl=el.closest('[data-breaklink]');
  if(bl){breakLink(bl.dataset.breaklink);return;}
  // Новые действия (реализация — app.js): отвязка версии, закрытие/переоткрытие вехи, штат в открытые версии
  var rp=el.closest('[data-report]');if(rp){openReport(rp.dataset.report,PG_PHASE[rp.dataset.report]||'all');return;}
  var pgp=el.closest('[data-pgphase]');if(pgp){var pp=pgp.dataset.pgphase.split('|');PG_PHASE[pp[0]]=pp[1];var pq=getPeriod(pp[0]);if(pq)renderRight(pq);return;}
  var dt=el.closest('[data-detach]');if(dt){openDetach(dt.dataset.detach);return;}
  var cpb=el.closest('[data-closeperiod]');if(cpb){closePeriodUI(cpb.dataset.closeperiod);return;}
  var rob=el.closest('[data-reopen]');if(rob){reopenPeriodUI(rob.dataset.reopen);return;}
  var prb=el.closest('[data-pushres]');if(prb){pushResUI(prb.dataset.pushres);return;}
  var sa=el.closest('[data-selall]');if(sa){var p=getPeriod(sa.dataset.selall);if(p){confirm2('Выделить все','Выделить все задачи периода?',function(){saveUndo();p.tasks.forEach(function(t){if(!t.s)p.chk[t.w]=true;});refreshAll();});return;}}
  var sn=el.closest('[data-selnone]');if(sn){var p=getPeriod(sn.dataset.selnone);if(p){confirm2('Снять выделение','Снять выделение со всех задач?',function(){saveUndo();p.tasks.forEach(function(t){if(!t.s)p.chk[t.w]=false;});refreshAll();});return;}}
  if(el.classList.contains('ov')&&!el.dataset.sticky){closeOv(el.id);return;}

  var id=el.id||(el.closest('button[id]')?el.closest('button[id]').id:'')||'';
  if(id==='btnUndo'){doUndo();}
  else if(id==='btnRedo'){doRedo();}
  else if(id==='btnAddPeriod'){openAddPeriod();}
  else if(id==='btnAddPeriodOk'){doAddPeriod();}
  else if(id==='btnAddPeriodCancel'){closeOv('ovAddPeriod');}
  else if(id==='btnSave'){downloadConfig();}
  else if(id==='btnLoad'){openUpload();}
  else if(id==='btnReset'){confirm2('Сброс','Сбросить данные проекта к исходным («Релиз 2026»)? Действие можно отменить через Ctrl+Z.',resetAll);}
  else if(id==='btnImportGlobal'){var p0=editablePeriods()[0];if(!p0)return;ge('importPeriodSel').innerHTML=periodOpts(p0.id);ge('importParent').innerHTML=blockOpts(p0);openOv('ovImport');}
  else if(id==='btnExportGlobal'){exportCSV();}
  else if(id==='btnPdf'){doPrint();}
  else if(id==='btnAddCancel'){closeOv('ovAdd');}
  else if(id==='btnAddOk'){doAddTask();}
  else if(id==='btnAddParentCancel'){closeOv('ovAddParent');}
  else if(id==='btnAddParentOk'){doAddBlock();}
  else if(id==='btnEditCancel'){closeOv('ovEdit');}
  else if(id==='btnEditOk'){doEdit();}
  else if(id==='btnMakeSummary'){doMakeSummary();}
  else if(id==='btnMakeLeaf'){doMakeLeaf();}
  else if(id==='btnMoveCopy'){doMoveTask(true);}
  else if(id==='btnMoveMove'){doMoveTask(false);}
  else if(id==='btnImportCancel'){closeOv('ovImport');}
  else if(id==='btnPreview'){previewImport();}
  else if(id==='btnImportOk'){doImport();}
  else if(id==='btnResCancel'){closeOv('ovRes');}
  else if(id==='btnResOk'){doAddRes(gv('resPidTarget'));}
  else if(id==='btnConfirmNo'){closeOv('ovConfirm');}
  else if(id==='btnConfirmYes'){closeOv('ovConfirm');if(_ccb)_ccb();_ccb=null;}
  else if(id==='tabFullBtn'){switchImportTab('full');}
  else if(id==='tabTasksBtn'){switchImportTab('tasks');}
});

document.addEventListener('dblclick',function(e){var el=e.target.closest('[data-editpid]');if(el)openEdit(el.dataset.editpid,+el.dataset.editidx);});
document.addEventListener('keydown',function(e){
  var k=(e.key||'').toLowerCase();
  // в текстовых полях модальных окон оставляем штатную отмену ввода браузера
  var inModalText=e.target.closest&&e.target.closest('.ov')&&/^(INPUT|TEXTAREA)$/.test(e.target.tagName);
  if((e.ctrlKey||e.metaKey)&&!inModalText&&((k==='z'&&e.shiftKey)||(k==='y'&&!e.shiftKey))){e.preventDefault();doRedo();return;}
  if((e.ctrlKey||e.metaKey)&&k==='z'&&!e.shiftKey&&!inModalText){e.preventDefault();doUndo();return;}
  if(e.key==='Escape')['ovAdd','ovAddParent','ovEdit','ovImport','ovRes','ovConfirm','ovAddPeriod','ovDetach','ovUpload','ovUsers','ovProject'].forEach(function(id){if(ge(id))closeOv(id);});});
window.addEventListener('resize',function(){PERIODS.forEach(function(p){if(!p.folded)setTwHeight(p.id);});});
// Первичный рендер выполняет app.js после загрузки проекта с сервера.

