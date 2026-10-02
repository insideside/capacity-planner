// Крупные операции над версиями: отвязка, закрытие/переоткрытие вехи. Общий код для браузера и сервера.
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory(require('./calc'));
  else root.CPOps=factory(root.CPCalc);
})(this,function(Calc){
  function byId(periods,id){for(var i=0;i<periods.length;i++)if(periods[i].id===id)return periods[i];return null;}
  function hasLeafDesc(tasks,w){return tasks.some(function(c){return !c.s&&c.w.indexOf(w+'.')===0;});}

  // План отвязки версии B от версии A (ничего не меняет, только считает).
  // Правило: лист t в B удаляется, если chk_B[t.w]===false И в A есть задача с тем же WBS и chk_A[t.w]===true.
  // opts.removeInactiveInSource=true — дополнительно удалять снятые в B листья, которые в A не активны/отсутствуют.
  function planDetach(periods,bId,aId,opts){
    opts=opts||{};
    var B=byId(periods,bId),A=byId(periods,aId);
    if(!B||!A)return {error:'Версия не найдена'};
    var aByW={};A.tasks.forEach(function(t){aByW[t.w]=t;});
    var remove=[],keptInactive=[];
    B.tasks.forEach(function(t){
      if(t.s)return;
      if(B.chk[t.w]!==false)return;
      var at=aByW[t.w];
      if(at&&A.chk[t.w]===true)remove.push(t.w);
      else if(opts.removeInactiveInSource)remove.push(t.w);
      else keptInactive.push(t.w);
    });
    var rm={};remove.forEach(function(w){rm[w]=1;});
    var after=B.tasks.filter(function(t){return !rm[t.w];});
    // строки-итоги, у которых были дочерние листья, а после удаления не осталось
    var emptied=B.tasks.filter(function(t){return t.s&&hasLeafDesc(B.tasks,t.w)&&!hasLeafDesc(after,t.w);}).map(function(t){return t.w;});
    return {bId:bId,aId:aId,remove:remove,removeSummaries:emptied,keptInactive:keptInactive,
      removeTasks:B.tasks.filter(function(t){return rm[t.w];}),
      keptTasks:B.tasks.filter(function(t){return keptInactive.indexOf(t.w)>=0;})};
  }
  // Применяет отвязку к массиву периодов (мутирует). Возвращает план.
  function applyDetach(periods,bId,aId,opts){
    var plan=planDetach(periods,bId,aId,opts);if(plan.error)return plan;
    var B=byId(periods,bId),A=byId(periods,aId);
    var rm={};plan.remove.concat(plan.removeSummaries).forEach(function(w){rm[w]=1;});
    B.tasks=B.tasks.filter(function(t){return !rm[t.w];});
    Object.keys(rm).forEach(function(w){delete B.chk[w];});
    if(B.linkedTo===A.id)B.linkedTo=null;
    if(A.linkedTo===B.id)A.linkedTo=null;
    return plan;
  }

  function closePeriod(periods,pid,user){
    var p=byId(periods,pid);if(!p)return {error:'Версия не найдена'};
    if(p.closed)return {error:'Версия уже закрыта'};
    p.closed=true;
    p.frozenSnapshot=Calc.makeSnapshot(p);
    p.frozenSnapshot.by=user||null;
    return {ok:true};
  }
  function reopenPeriod(periods,pid){
    var p=byId(periods,pid);if(!p)return {error:'Версия не найдена'};
    if(!p.closed)return {error:'Версия не закрыта'};
    p.closed=false;delete p.frozenSnapshot;
    return {ok:true};
  }

  // Поля, которые нельзя менять у закрытой вехи (вид — свёртка/фильтры/ширины — менять можно).
  var PROTECTED=['name','devStart','devEnd','tstStart','tstEnd','res','tasks','chk','linkedTo','frozenSnapshot'];
  function protectedSig(p){var o={};PROTECTED.forEach(function(k){o[k]=p[k]===undefined?null:p[k];});return JSON.stringify(o);}

  // Проверка: не изменены ли закрытые вехи. Возвращает текст ошибки или null.
  function checkClosedUntouched(oldPeriods,newPeriods){
    for(var i=0;i<oldPeriods.length;i++){
      var o=oldPeriods[i];if(!o.closed)continue;
      var n=byId(newPeriods,o.id);
      if(!n)return 'Закрытую веху «'+o.name+'» нельзя удалить — сначала переоткройте её';
      if(!n.closed)continue; // переоткрытие (в т.ч. через Undo) — проверяется отдельно правом
      if(protectedSig(o)!==protectedSig(n))return 'Веха «'+o.name+'» закрыта — изменения запрещены';
    }
    return null;
  }
  // Список вех, которые этим сохранением переоткрываются.
  function reopenedIds(oldPeriods,newPeriods){
    return oldPeriods.filter(function(o){var n=byId(newPeriods,o.id);return o.closed&&n&&!n.closed;}).map(function(o){return o.id;});
  }

  return {byId:byId,planDetach:planDetach,applyDetach:applyDetach,closePeriod:closePeriod,reopenPeriod:reopenPeriod,
    checkClosedUntouched:checkClosedUntouched,reopenedIds:reopenedIds,PROTECTED:PROTECTED};
});
