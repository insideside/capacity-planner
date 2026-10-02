// Дифф и слияние конфигураций проекта. Общий код для браузера и сервера.
// Сущности сопоставляются по стабильным ключам: периоды — по id (фолбэк по name), задачи — по WBS, ресурсы — по ключу.
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.CPDiff=factory();
})(this,function(){
  var FIELDS=['name','devStart','devEnd','tstStart','tstEnd','linkedTo'];
  var FIELD_LABELS={name:'Название',devStart:'Начало разработки',devEnd:'Конец разработки',tstStart:'Начало тестирования',tstEnd:'Конец тестирования',linkedTo:'Связь с версией',closed:'Статус вехи (закрыта / открыта)'};
  var VIEW=['collapsed','filter','filterActive','folded','colWidths'];
  var TASK_FIELDS=['n','h','r','s','d','rel','st','ws','dn','chk'];
  var TASK_LABELS={n:'Название',h:'Часы',r:'Ресурс',s:'Строка-итог',d:'Уровень',rel:'rel',st:'Статус',ws:'Начато',dn:'Выполнено (дата)',chk:'Галочка'};
  var RES_FIELDS=['label','n','pct','period','color'];

  function clone(x){return x===undefined?undefined:JSON.parse(JSON.stringify(x));}
  function eq(a,b){return JSON.stringify(a===undefined?null:a)===JSON.stringify(b===undefined?null:b);}
  function byId(list,id){for(var i=0;i<list.length;i++)if(list[i].id===id)return list[i];return null;}
  function taskView(p,t){var o={w:t.w,n:t.n,h:t.h,r:t.r,s:t.s,d:t.d,rel:t.rel===undefined?null:t.rel,st:t.s?null:(t.st||'new'),ws:t.ws||null,dn:t.dn||null,chk:!!p.chk[t.w]};return o;}
  function viewOf(p){var o={};VIEW.forEach(function(k){o[k]=p[k]===undefined?null:p[k];});return o;}
  function closedOf(p){return {closed:!!p.closed,frozenSnapshot:p.frozenSnapshot||null};}

  // Сопоставление периодов файла с текущими: map fileId -> curId.
  function matchPeriods(cur,file){
    var map={},used={};
    file.forEach(function(fp){if(byId(cur,fp.id)){map[fp.id]=fp.id;used[fp.id]=1;}});
    file.forEach(function(fp){
      if(map[fp.id])return;
      var c=cur.filter(function(cp){return !used[cp.id]&&!byId(file,cp.id)&&cp.name===fp.name;})[0];
      if(c){map[fp.id]=c.id;used[c.id]=1;}
    });
    return map;
  }
  // Переводит файл в пространство идентификаторов текущей версии.
  function remapFile(cur,file){
    var map=matchPeriods(cur,file);
    var taken={};cur.forEach(function(p){taken[p.id]=1;});
    // добавляемые периоды, чей id занят несопоставленным периодом, получают новый id
    file.forEach(function(fp){
      if(map[fp.id])return;
      var nid=fp.id;while(taken[nid])nid=fp.id+'_'+Math.random().toString(36).slice(2,6);
      map[fp.id]=nid;taken[nid]=1;
    });
    return clone(file).map(function(fp){
      fp.id=map[fp.id];
      if(fp.linkedTo)fp.linkedTo=map[fp.linkedTo]||null;
      return fp;
    });
  }
  function relOrderChanged(curOrder,fileOrder){
    var inCur={},inFile={};curOrder.forEach(function(w){inCur[w]=1;});fileOrder.forEach(function(w){inFile[w]=1;});
    var a=curOrder.filter(function(w){return inFile[w];}),b=fileOrder.filter(function(w){return inCur[w];});
    return a.join('\u0001')!==b.join('\u0001');
  }

  // Строит список различий. cur/file — массивы периодов (file уже в пространстве id текущей версии, см. remapFile).
  function diffPeriods(cur,file){
    var items=[];
    file.forEach(function(fp){
      var cp=byId(cur,fp.id);
      if(!cp){items.push({key:'P:'+fp.id,type:'period',status:'added',pid:fp.id,label:fp.name,file:summaryOf(fp)});return;}
    });
    cur.forEach(function(cp){
      var fp=byId(file,cp.id);
      if(!fp){items.push({key:'P:'+cp.id,type:'period',status:'removed',pid:cp.id,label:cp.name,cur:summaryOf(cp)});return;}
      var pl=cp.name;
      FIELDS.forEach(function(f){
        if(!eq(cp[f],fp[f]))items.push({key:'F:'+cp.id+':'+f,type:'field',status:'changed',pid:cp.id,plabel:pl,field:f,label:FIELD_LABELS[f],
          cur:f==='linkedTo'?linkName(cur,cp[f]):cp[f],file:f==='linkedTo'?linkName(file,fp[f]):fp[f]});
      });
      if(!eq(closedOf(cp),closedOf(fp)))items.push({key:'F:'+cp.id+':closed',type:'field',status:'changed',pid:cp.id,plabel:pl,field:'closed',label:FIELD_LABELS.closed,
        cur:cp.closed?'Закрыта':'Открыта',file:fp.closed?'Закрыта':'Открыта'});
      // ресурсы
      var keys={};Object.keys(cp.res).concat(Object.keys(fp.res)).forEach(function(k){keys[k]=1;});
      Object.keys(keys).forEach(function(k){
        var a=cp.res[k],b=fp.res[k];
        if(a&&!b)items.push({key:'R:'+cp.id+':'+k,type:'res',status:'removed',pid:cp.id,plabel:pl,rk:k,label:a.label+' ('+k+')',cur:clone(a)});
        else if(!a&&b)items.push({key:'R:'+cp.id+':'+k,type:'res',status:'added',pid:cp.id,plabel:pl,rk:k,label:b.label+' ('+k+')',file:clone(b)});
        else if(!eq(a,b)){
          var fl=RES_FIELDS.filter(function(f){return !eq(a[f],b[f]);});
          items.push({key:'R:'+cp.id+':'+k,type:'res',status:'changed',pid:cp.id,plabel:pl,rk:k,label:b.label+' ('+k+')',cur:clone(a),file:clone(b),fields:fl});
        }
      });
      // задачи
      var cw={},fw={};
      cp.tasks.forEach(function(t){cw[t.w]=t;});fp.tasks.forEach(function(t){fw[t.w]=t;});
      fp.tasks.forEach(function(t){
        if(!cw[t.w])items.push({key:'T:'+cp.id+':'+t.w,type:'task',status:'added',pid:cp.id,plabel:pl,w:t.w,label:t.w+' '+t.n,file:taskView(fp,t)});
      });
      cp.tasks.forEach(function(t){
        var ft=fw[t.w];
        if(!ft){items.push({key:'T:'+cp.id+':'+t.w,type:'task',status:'removed',pid:cp.id,plabel:pl,w:t.w,label:t.w+' '+t.n,cur:taskView(cp,t)});return;}
        var a=taskView(cp,t),b=taskView(fp,ft);
        var fl=TASK_FIELDS.filter(function(f){return !eq(a[f],b[f]);});
        if(fl.length)items.push({key:'T:'+cp.id+':'+t.w,type:'task',status:'changed',pid:cp.id,plabel:pl,w:t.w,label:t.w+' '+(b.n||a.n),cur:a,file:b,fields:fl});
      });
      // галочки по WBS, которых нет среди задач (осиротевшие) — тоже не теряем
      var orphan={};Object.keys(cp.chk).concat(Object.keys(fp.chk)).forEach(function(w){if(!cw[w]&&!fw[w])orphan[w]=1;});
      Object.keys(orphan).forEach(function(w){
        if(!eq(cp.chk[w],fp.chk[w]))items.push({key:'C:'+cp.id+':'+w,type:'chk',status:'changed',pid:cp.id,plabel:pl,w:w,label:'Галочка '+w+' (без задачи)',cur:cp.chk[w],file:fp.chk[w]});
      });
      if(relOrderChanged(cp.tasks.map(function(t){return t.w;}),fp.tasks.map(function(t){return t.w;})))
        items.push({key:'O:'+cp.id,type:'order',status:'changed',pid:cp.id,plabel:pl,label:'Порядок задач'});
      if(!eq(viewOf(cp),viewOf(fp)))
        items.push({key:'V:'+cp.id,type:'view',status:'changed',pid:cp.id,plabel:pl,label:'Настройки отображения (свёртка, фильтры, ширина колонок)'});
    });
    if(relOrderChanged(cur.map(function(p){return p.id;}),file.map(function(p){return p.id;})))
      items.push({key:'O:*',type:'porder',status:'changed',label:'Порядок версий'});
    return items;
  }
  function linkName(list,id){if(!id)return null;var p=byId(list,id);return p?p.name:id;}
  function summaryOf(p){var leaves=p.tasks.filter(function(t){return !t.s;});var on=leaves.filter(function(t){return p.chk[t.w];});
    return {name:p.name,tasks:p.tasks.length,leaves:leaves.length,checked:on.length,hours:on.reduce(function(s,t){return s+t.h;},0),closed:!!p.closed};}

  // Порядок: берём primary, недостающие элементы ставим после ближайшего предшественника из secondary.
  function mergeOrder(primary,secondary,present){
    var out=primary.filter(function(x){return present[x];});
    var inOut={};out.forEach(function(x){inOut[x]=1;});
    secondary.forEach(function(x,i){
      if(!present[x]||inOut[x])return;
      var pos=0;
      for(var j=i-1;j>=0;j--){var k=out.indexOf(secondary[j]);if(k>=0){pos=k+1;break;}}
      out.splice(pos,0,x);inOut[x]=1;
    });
    Object.keys(present).forEach(function(x){if(!inOut[x])out.push(x);});
    return out;
  }

  // Применяет выбор. choices: {key: 'cur'|'file'}; отсутствующий выбор = 'cur' (оставить текущее).
  function applyChoices(cur,file,items,choices){
    var res=clone(cur);
    function take(it){return choices[it.key]==='file';}
    items.forEach(function(it){
      if(!take(it))return;
      var cp=byId(res,it.pid),fp=it.pid?byId(file,it.pid):null;
      switch(it.type){
        case 'period':
          if(it.status==='added')res.push(clone(fp));
          else res=res.filter(function(p){return p.id!==it.pid;});
          break;
        case 'field':
          if(!cp)break;
          if(it.field==='closed'){cp.closed=!!fp.closed;if(fp.frozenSnapshot)cp.frozenSnapshot=clone(fp.frozenSnapshot);else delete cp.frozenSnapshot;}
          else cp[it.field]=clone(fp[it.field]);
          break;
        case 'res':
          if(!cp)break;
          if(it.status==='removed')delete cp.res[it.rk];else cp.res[it.rk]=clone(fp.res[it.rk]);
          break;
        case 'task':
          if(!cp)break;
          if(it.status==='removed'){cp.tasks=cp.tasks.filter(function(t){return t.w!==it.w;});if(fp&&it.w in fp.chk)cp.chk[it.w]=fp.chk[it.w];else delete cp.chk[it.w];}
          else{
            var ft=fp.tasks.filter(function(t){return t.w===it.w;})[0];
            var nt=clone(ft);
            if(it.status==='added')cp.tasks.push(nt);
            else cp.tasks=cp.tasks.map(function(t){return t.w===it.w?nt:t;});
            if(it.w in fp.chk)cp.chk[it.w]=fp.chk[it.w];else delete cp.chk[it.w];
          }
          break;
        case 'chk':
          if(!cp)break;
          if(fp.chk[it.w]===undefined)delete cp.chk[it.w];else cp.chk[it.w]=fp.chk[it.w];
          break;
        case 'view':
          if(!cp)break;
          VIEW.forEach(function(k){if(fp[k]!==undefined)cp[k]=clone(fp[k]);});
          break;
      }
    });
    // порядок задач в каждом периоде
    res.forEach(function(cp){
      var fp=byId(file,cp.id),op=byId(cur,cp.id);
      if(!fp||!op)return;
      var present={},map={};cp.tasks.forEach(function(t){present[t.w]=1;map[t.w]=t;});
      var curOrder=op.tasks.map(function(t){return t.w;}),fileOrder=fp.tasks.map(function(t){return t.w;});
      var order=choices['O:'+cp.id]==='file'?mergeOrder(fileOrder,curOrder,present):mergeOrder(curOrder,fileOrder,present);
      cp.tasks=order.map(function(w){return map[w];});
    });
    // порядок периодов
    var pp={},pm={};res.forEach(function(p){pp[p.id]=1;pm[p.id]=p;});
    var co=cur.map(function(p){return p.id;}),fo=file.map(function(p){return p.id;});
    res=(choices['O:*']==='file'?mergeOrder(fo,co,pp):mergeOrder(co,fo,pp)).map(function(id){return pm[id];});
    // ссылки на удалённые периоды обнуляем
    res.forEach(function(p){if(p.linkedTo&&!byId(res,p.linkedTo))p.linkedTo=null;});
    return res;
  }

  // Трёхстороннее слияние при конфликте ревизий (409).
  // base — то, от чего отталкивался клиент; local — его текущее состояние; remote — свежая версия с сервера.
  // Возвращает {items, choices, conflicts}: items/choices применяются к remote через applyChoices(remote, local, ...).
  function threeWay(base,local,remote){
    var lk={},rk={};
    diffPeriods(base,local).forEach(function(it){lk[it.key]=it;});
    diffPeriods(base,remote).forEach(function(it){rk[it.key]=it;});
    var items=diffPeriods(remote,local),choices={},conflicts=[];
    function pidTouched(map,pid){return Object.keys(map).some(function(k){var it=map[k];return it.pid===pid;});}
    items.forEach(function(it){
      var mine=!!lk[it.key],theirs=!!rk[it.key];
      // период удалён на сервере, а локально в нём что-то правили (или наоборот)
      if(it.type==='period'){
        if(it.status==='added'&&!mine&&rk[it.key]&&pidTouched(lk,it.pid))theirs=mine=true;
        if(it.status==='removed'&&!theirs&&lk[it.key]&&pidTouched(rk,it.pid))theirs=mine=true;
      }
      if(it.type==='view'){choices[it.key]=mine?'file':'cur';return;}
      if(mine&&theirs){conflicts.push(it);choices[it.key]='file';}
      else if(mine)choices[it.key]='file';
      else choices[it.key]='cur';
    });
    return {items:items,choices:choices,conflicts:conflicts};
  }

  return {diffPeriods:diffPeriods,applyChoices:applyChoices,remapFile:remapFile,threeWay:threeWay,mergeOrder:mergeOrder,
    TASK_LABELS:TASK_LABELS,FIELD_LABELS:FIELD_LABELS,RES_FIELDS:RES_FIELDS};
});
