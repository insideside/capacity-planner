// Расчёт ёмкости — общий код для браузера и сервера.
// Формулы перенесены из исходного capacity_planner.html без изменения смысла.
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.CPCalc=factory();
})(this,function(){
  var HOL=['2026-01-01','2026-01-02','2026-01-05','2026-01-06','2026-01-07','2026-01-08',
    '2026-02-23','2026-03-09','2026-05-01','2026-05-04','2026-06-12','2026-11-04','2026-12-31',
    '2027-01-01','2027-01-02','2027-01-03','2027-01-04','2027-01-05','2027-01-06','2027-01-07','2027-01-08'];

  // Рабочие дни в окне [s..e] включительно. Считаем в UTC, чтобы результат не зависел от часового пояса.
  function wdays(s,e){
    if(!s||!e)return 0;
    var d=new Date(s+'T00:00:00Z'),en=new Date(e+'T00:00:00Z'),c=0;
    if(isNaN(d)||isNaN(en))return 0;
    while(d<=en){var ds=d.toISOString().slice(0,10);var wd=d.getUTCDay();if(wd>0&&wd<6&&HOL.indexOf(ds)<0)c++;d.setUTCDate(d.getUTCDate()+1);}
    return c;
  }
  // Ёмкость ресурса, ч: рабочие дни окна × (% загрузки / 100) × 8.
  // Для закрытой вехи берётся замороженное значение из frozenSnapshot.
  function cap(p,k){
    if(p.closed&&p.frozenSnapshot&&p.frozenSnapshot.cap&&k in p.frozenSnapshot.cap)return p.frozenSnapshot.cap[k];
    return liveCap(p,k);
  }
  function liveCap(p,k){
    var r=p.res[k];if(!r)return 0;
    var days=r.period==='tst'?wdays(p.tstStart,p.tstEnd):wdays(p.devStart,p.devEnd);
    return Math.round(days*(r.pct/100)*8);
  }
  // Загрузка по ресурсам, ч (только отмеченные листья).
  function usedP(p){
    if(p.closed&&p.frozenSnapshot&&p.frozenSnapshot.used)return Object.assign({},p.frozenSnapshot.used);
    return liveUsed(p);
  }
  function liveUsed(p){
    var u={};p.tasks.forEach(function(t){if(!t.s&&p.chk[t.w]&&t.h>0)u[t.r]=(u[t.r]||0)+t.h;});
    return u;
  }
  function totals(p){
    var leaves=p.tasks.filter(function(t){return !t.s&&p.chk[t.w];});
    return {n:leaves.length,h:leaves.reduce(function(s,t){return s+t.h;},0)};
  }
  // Снимок рассчитанных ресурсов/ёмкости на момент закрытия вехи.
  function makeSnapshot(p){
    var c={};Object.keys(p.res).forEach(function(k){c[k]=liveCap(p,k);});
    var tt=totals(p);
    return {
      at:new Date().toISOString(),
      workdays:{dev:wdays(p.devStart,p.devEnd),tst:wdays(p.tstStart,p.tstEnd)},
      res:JSON.parse(JSON.stringify(p.res)),
      cap:c,used:liveUsed(p),totalH:tt.h,nTasks:tt.n
    };
  }
  // ── Статусы задач и выполнение релиза ──
  var STATUSES=['new','wip','done'];
  var STATUS_LABELS={new:'Новое',wip:'В работе',done:'Выполнено'};
  function taskStatus(t){return STATUSES.indexOf(t.st)>=0?t.st:'new';}
  function emptyAgg(){return {total:{n:0,h:0},new:{n:0,h:0},wip:{n:0,h:0},done:{n:0,h:0}};}
  function addAgg(a,t){var s=taskStatus(t);a.total.n++;a.total.h+=t.h;a[s].n++;a[s].h+=t.h;}
  function finishAgg(a){
    a.pctN=a.total.n?Math.round(a.done.n/a.total.n*1000)/10:0;
    a.pctH=a.total.h?Math.round(a.done.h/a.total.h*1000)/10:0;
    return a;
  }
  // Фаза задачи — по окну её ресурса: 'dev' (разработка) или 'tst' (тестирование); без ресурса — null.
  var PHASE_LABELS={dev:'Разработка',tst:'Тестирование'};
  function phaseOf(p,t){var r=p.res[t.r];return r?(r.period==='tst'?'tst':'dev'):null;}
  // Выполнение релиза: учитываются только отмеченные (включённые в релиз) задачи-листья.
  // pctN — % выполненных задач, pctH — % выполненных часов.
  // phase: 'dev' | 'tst' — готовность только по разработке / тестированию; иначе — по всем задачам.
  function progress(p,phase){
    var all=emptyAgg(),byRes={},blocks=[],bmap={},cur=null;
    p.tasks.forEach(function(t){
      if(t.s&&t.d===0){cur={w:t.w,name:t.n,agg:emptyAgg()};bmap[t.w]=cur;blocks.push(cur);return;}
      if(t.s||!p.chk[t.w])return;
      if((phase==='dev'||phase==='tst')&&phaseOf(p,t)!==phase)return;
      addAgg(all,t);
      if(!byRes[t.r])byRes[t.r]=emptyAgg();
      addAgg(byRes[t.r],t);
      if(cur)addAgg(cur.agg,t);
    });
    finishAgg(all);
    Object.keys(byRes).forEach(function(k){finishAgg(byRes[k]);});
    blocks=blocks.filter(function(b){return b.agg.total.n>0;});
    blocks.forEach(function(b){finishAgg(b.agg);});
    return {all:all,byRes:byRes,blocks:blocks};
  }
  // ── Выполнение по дням ──
  function isWorkday(ds){var d=new Date(ds+'T00:00:00Z'),wd=d.getUTCDay();return wd>0&&wd<6&&HOL.indexOf(ds)<0;}
  function addDays(ds,n){var d=new Date(ds+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);}
  // Окно фазы: разработка, тестирование или (для «все») от самого раннего начала до самого позднего конца.
  function phaseWindow(p,phase){
    if(phase==='dev')return {start:p.devStart,end:p.devEnd};
    if(phase==='tst')return {start:p.tstStart,end:p.tstEnd};
    return {start:p.devStart<p.tstStart?p.devStart:p.tstStart,end:p.devEnd>p.tstEnd?p.devEnd:p.tstEnd};
  }
  // План — равномерное выполнение часов по рабочим дням окна. Факт — по датам выполнения задач (dn).
  // Выполненные задачи без даты относятся на начало окна (учтены, но не привязаны к дню).
  // today — 'YYYY-MM-DD' (передаётся снаружи, чтобы расчёт был детерминированным).
  function daily(p,phase,today){
    var win=phaseWindow(p,phase),leaves=[];
    p.tasks.forEach(function(t){
      if(t.s||!p.chk[t.w])return;
      if((phase==='dev'||phase==='tst')&&phaseOf(p,t)!==phase)return;
      leaves.push(t);
    });
    var totalH=0,totalN=leaves.length,undated=[],byDate={};
    leaves.forEach(function(t){
      totalH+=t.h;
      if(taskStatus(t)!=='done')return;
      if(t.dn&&/^\d{4}-\d{2}-\d{2}$/.test(t.dn)){(byDate[t.dn]=byDate[t.dn]||[]).push(t);}
      else undated.push(t);
    });
    var dates=Object.keys(byDate).sort();
    var first=win.start,last=win.end;
    if(dates.length&&dates[0]<first)first=dates[0];
    if(dates.length&&dates[dates.length-1]>last)last=dates[dates.length-1];
    if(today&&today>last&&today<=addDays(win.end,366))last=today;
    // ось дней: рабочие дни + любые дни, в которые что-то выполнено
    var days=[],planDays=wdays(win.start,win.end),planIdx=0;
    var undH=undated.reduce(function(s,t){return s+t.h;},0);
    var cumH=undH,cumN=undated.length;
    for(var ds=first;ds<=last;ds=addDays(ds,1)){
      var inWin=ds>=win.start&&ds<=win.end,wd=isWorkday(ds),tl=byDate[ds]||[];
      if(!wd&&!tl.length)continue;
      if(inWin&&wd)planIdx++;
      var dh=tl.reduce(function(s,t){return s+t.h;},0);
      cumH+=dh;cumN+=tl.length;
      var planH=planDays?Math.round(totalH*Math.min(planIdx,planDays)/planDays):totalH;
      days.push({date:ds,workday:wd,inWindow:inWin,tasks:tl,doneN:tl.length,doneH:dh,cumH:cumH,cumN:cumN,planH:planH,
        cumPct:totalH?Math.round(cumH/totalH*1000)/10:0,planPct:totalH?Math.round(planH/totalH*1000)/10:0});
    }
    // показатели в днях
    var doneH=cumH,remH=totalH-doneH;
    var elapsed=today?wdays(win.start,today<win.end?today:win.end):0;
    if(today&&today<win.start)elapsed=0;
    var remaining=today?(today<win.start?planDays:wdays(addDays(today,1),win.end)):planDays;
    if(today&&today>win.end)remaining=0;
    var pace=elapsed>0?doneH/elapsed:0;                 // факт, ч на рабочий день
    var needPace=remaining>0?remH/remaining:null;       // нужно, ч на рабочий день
    var planDayOfDone=totalH?doneH/totalH*planDays:0;   // какому дню плана соответствует факт
    var lagDays=Math.round((planDayOfDone-elapsed)*10)/10; // >0 — опережение, <0 — отставание
    // темп за последние 10 рабочих дней (по датам выполнения) — прогноз строится по нему
    var pace10=0;
    if(today){
      var from=today,k10=0;while(k10<10){if(isWorkday(from))k10++;if(k10<10)from=addDays(from,-1);}
      var h10=0;dates.forEach(function(ds){if(ds>=from&&ds<=today)byDate[ds].forEach(function(t){h10+=t.h;});});
      pace10=h10/10;
    }
    var fPace=pace10>0?pace10:pace;
    var forecast=null,forecastDays=null;
    if(remH<=0)forecast=dates.length?dates[dates.length-1]:today;
    else if(fPace>0&&today){
      forecastDays=Math.ceil(remH/fPace);var f=today,k=0;
      while(k<forecastDays){f=addDays(f,1);if(isWorkday(f))k++;}
      forecast=f;
    }
    return {window:win,totalH:totalH,totalN:totalN,doneH:doneH,remH:remH,undated:{n:undated.length,h:undH},
      days:days,planDays:planDays,elapsed:elapsed,remaining:remaining,pace:Math.round(pace*10)/10,pace10:Math.round(pace10*10)/10,
      needPace:needPace==null?null:Math.round(needPace*10)/10,lagDays:lagDays,forecast:forecast,forecastDays:forecastDays,
      late:!!(forecast&&forecast>win.end)};
  }
  return {daily:daily,phaseWindow:phaseWindow,isWorkday:isWorkday,addDays:addDays,
    STATUSES:STATUSES,STATUS_LABELS:STATUS_LABELS,taskStatus:taskStatus,progress:progress,phaseOf:phaseOf,PHASE_LABELS:PHASE_LABELS,
    HOL:HOL,wdays:wdays,cap:cap,liveCap:liveCap,usedP:usedP,liveUsed:liveUsed,totals:totals,makeSnapshot:makeSnapshot};
});
