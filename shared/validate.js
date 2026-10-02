// Валидация конфигурации проекта (schema capacity-planner/v1). Общий код для браузера и сервера.
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.CPValidate=factory();
})(this,function(){
  var SCHEMA='capacity-planner/v1';
  var RE_ID=/^[A-Za-z0-9_-]{1,64}$/;
  var RE_KEY=/^[^\s"'<>&|\\]{1,40}$/;
  var RE_WBS=/^[^\s"'<>&|\\]{1,80}$/;
  var RE_DATE=/^\d{4}-\d{2}-\d{2}$/;
  var RE_COLOR=/^#[0-9a-fA-F]{3,8}$/;
  var LIMITS={periods:200,tasks:5000,res:100,name:300};

  function isObj(x){return x&&typeof x==='object'&&!Array.isArray(x);}
  function isNum(x){return typeof x==='number'&&isFinite(x);}

  // Возвращает массив ошибок (пустой — всё в порядке).
  function validatePeriods(periods){
    var errs=[];
    function err(m){if(errs.length<50)errs.push(m);}
    if(!Array.isArray(periods)){err('periods должен быть массивом');return errs;}
    if(periods.length>LIMITS.periods)err('слишком много периодов');
    var ids={};
    periods.forEach(function(p,pi){
      var at='periods['+pi+']';
      if(!isObj(p)){err(at+': не объект');return;}
      if(typeof p.id!=='string'||!RE_ID.test(p.id))err(at+'.id некорректен');
      else if(ids[p.id])err(at+'.id повторяется: '+p.id);else ids[p.id]=1;
      if(typeof p.name!=='string'||p.name.length>LIMITS.name)err(at+'.name некорректно');
      ['devStart','devEnd','tstStart','tstEnd'].forEach(function(k){if(typeof p[k]!=='string'||!(p[k]===''||RE_DATE.test(p[k])))err(at+'.'+k+' — дата YYYY-MM-DD');});
      if(!isObj(p.res))err(at+'.res должен быть объектом');
      else{
        var rk=Object.keys(p.res);if(rk.length>LIMITS.res)err(at+': слишком много ресурсов');
        rk.forEach(function(k){
          var r=p.res[k];
          if(!RE_KEY.test(k))err(at+'.res: недопустимый ключ «'+k+'»');
          if(!isObj(r)){err(at+'.res.'+k+' не объект');return;}
          if(typeof r.label!=='string'||r.label.length>LIMITS.name)err(at+'.res.'+k+'.label');
          if(!isNum(r.n)||r.n<0||r.n>10000)err(at+'.res.'+k+'.n');
          if(!isNum(r.pct)||r.pct<0||r.pct>100000)err(at+'.res.'+k+'.pct');
          if(r.period!=='dev'&&r.period!=='tst')err(at+'.res.'+k+'.period (dev|tst)');
          if(typeof r.color!=='string'||!RE_COLOR.test(r.color))err(at+'.res.'+k+'.color');
        });
      }
      if(!Array.isArray(p.tasks))err(at+'.tasks должен быть массивом');
      else{
        if(p.tasks.length>LIMITS.tasks)err(at+': слишком много задач');
        var ws={};
        p.tasks.forEach(function(t,ti){
          var tat=at+'.tasks['+ti+']';
          if(!isObj(t)){err(tat+' не объект');return;}
          if(typeof t.w!=='string'||!RE_WBS.test(t.w))err(tat+'.w (WBS) некорректен');
          else if(ws[t.w])err(tat+': WBS повторяется: '+t.w);else ws[t.w]=1;
          if(typeof t.n!=='string'||t.n.length>LIMITS.name)err(tat+'.n');
          if(!isNum(t.h)||t.h<0||t.h>1000000)err(tat+'.h');
          if(typeof t.r!=='string'||!(t.r==='none'||RE_KEY.test(t.r)))err(tat+'.r');
          if(typeof t.s!=='boolean')err(tat+'.s');
          if(!isNum(t.d)||t.d<0||t.d>50||Math.floor(t.d)!==t.d)err(tat+'.d');
          if(t.rel!==undefined&&t.rel!==null&&(typeof t.rel!=='string'||t.rel.length>20))err(tat+'.rel');
          if(t.st!==undefined&&t.st!=='new'&&t.st!=='wip'&&t.st!=='done')err(tat+'.st (new|wip|done)');
          if(t.ws!==undefined&&t.ws!==null&&!RE_DATE.test(t.ws))err(tat+'.ws — дата начала YYYY-MM-DD');
          if(t.dn!==undefined&&t.dn!==null&&!RE_DATE.test(t.dn))err(tat+'.dn — дата выполнения YYYY-MM-DD');
        });
      }
      if(!isObj(p.chk))err(at+'.chk должен быть объектом');
      else Object.keys(p.chk).forEach(function(k){if(typeof p.chk[k]!=='boolean')err(at+'.chk['+k+'] не boolean');});
      if(p.collapsed!==undefined&&!isObj(p.collapsed))err(at+'.collapsed');
      if(p.filter!==undefined&&p.filter!==null&&typeof p.filter!=='string')err(at+'.filter');
      if(p.filterActive!==undefined&&p.filterActive!==null&&typeof p.filterActive!=='boolean')err(at+'.filterActive');
      if(p.folded!==undefined&&typeof p.folded!=='boolean')err(at+'.folded');
      if(p.linkedTo!==undefined&&p.linkedTo!==null&&(typeof p.linkedTo!=='string'||!RE_ID.test(p.linkedTo)))err(at+'.linkedTo');
      if(p.colWidths!==undefined){
        if(!isObj(p.colWidths))err(at+'.colWidths');
        else Object.keys(p.colWidths).forEach(function(k){if(!isNum(p.colWidths[k]))err(at+'.colWidths.'+k);});
      }
      if(p.closed!==undefined&&typeof p.closed!=='boolean')err(at+'.closed');
      if(p.frozenSnapshot!==undefined&&p.frozenSnapshot!==null&&!isObj(p.frozenSnapshot))err(at+'.frozenSnapshot');
    });
    periods.forEach(function(p,pi){if(isObj(p)&&p.linkedTo&&!ids[p.linkedTo])err('periods['+pi+'].linkedTo ссылается на несуществующий период');});
    return errs;
  }

  // Приводит период к полному набору полей (заполняет отсутствующие значения по умолчанию).
  function normalizePeriod(p){
    if(!isObj(p.collapsed))p.collapsed={};
    if(p.filter===undefined)p.filter=null;
    if(p.filterActive===undefined)p.filterActive=null;
    if(typeof p.folded!=='boolean')p.folded=false;
    if(p.linkedTo===undefined)p.linkedTo=null;
    if(!isObj(p.colWidths))p.colWidths={cb:32,h:46,r:98,name:0,del:18};
    if(!isObj(p.chk))p.chk={};
    if(p.closed===undefined)p.closed=false;
    return p;
  }

  // Принимает содержимое файла (объект проекта или «голый» массив периодов из старой версии)
  // и возвращает {project, errors}.
  function parseProjectFile(obj){
    var project;
    if(Array.isArray(obj))project={schema:SCHEMA,name:'Импортированный проект',periods:obj};
    else if(isObj(obj))project=obj;
    else return {project:null,errors:['Файл не содержит объект проекта']};
    if(project.schema!==undefined&&project.schema!==SCHEMA)return {project:null,errors:['Неизвестная схема: '+project.schema]};
    var errs=validatePeriods(project.periods);
    if(!errs.length)project.periods.forEach(normalizePeriod);
    if(project.name!==undefined&&(typeof project.name!=='string'||project.name.length>LIMITS.name))errs.push('name некорректно');
    return {project:project,errors:errs};
  }

  return {SCHEMA:SCHEMA,validatePeriods:validatePeriods,normalizePeriod:normalizePeriod,parseProjectFile:parseProjectFile,RE_ID:RE_ID,RE_KEY:RE_KEY,RE_WBS:RE_WBS};
});
