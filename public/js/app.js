// Планировщик ёмкости — серверный слой клиента:
// вход и сессия, проекты, автосохранение на сервер с контролем ревизий, Undo/Redo,
// загрузка конфигурации с разрешением конфликтов, отвязка версий, закрытие вех, админка.
// Источник истины — сервер; localStorage/sessionStorage не используются.

var App={
  user:null,csrf:null,config:{},projects:[],
  project:null,          // {projectId,name,revision,updatedAt,updatedBy}
  access:null,           // 'edit' | 'read'
  serverFull:null,       // JSON периодов, подтверждённый сервером (база для слияния)
  lastFull:null,         // JSON текущего локального состояния
  lastData:null,         // то же без полей отображения — для Undo/Redo
  undo:[],redo:[],
  saving:false,saveTimer:null,retryTimer:null,saveError:null,
  conflictOpen:false
};
var UNDO_MAX=100;
var VIEW_FIELDS=['collapsed','filter','filterActive','folded','colWidths'];
var CAN_REOPEN=false;

// ══ API ═══════════════════════════════════════════════════════════
function api(method,url,body){
  var opts={method:method,headers:{},credentials:'same-origin',cache:'no-store'};
  if(body!==undefined){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(body);}
  if(method!=='GET'&&App.csrf)opts.headers['X-CSRF-Token']=App.csrf;
  return fetch(url,opts).then(function(r){
    return r.text().then(function(t){
      var data=null;try{data=t?JSON.parse(t):null;}catch(e){data={message:t};}
      if(r.status===401&&url!=='/api/auth/login')onUnauthorized();
      if(!r.ok){var err=new Error((data&&data.message)||('Ошибка HTTP '+r.status));err.status=r.status;err.data=data;throw err;}
      return data;
    });
  });
}

// ══ Уведомления и статус ══════════════════════════════════════════
function notify(msg,kind,ms){
  var box=ge('toasts');if(!box)return;
  var d=document.createElement('div');d.className='toast '+(kind||'warn');d.textContent=msg;
  box.appendChild(d);
  setTimeout(function(){if(d.parentNode)d.parentNode.removeChild(d);},ms||(kind==='err'?9000:5000));
}
function setStatus(){
  var el=ge('saveStatus');if(!el)return;
  if(!App.project){el.className='sstat';el.textContent='—';return;}
  if(READONLY){el.className='sstat ro';el.textContent='👁 Только чтение · ред. '+App.project.revision;return;}
  if(App.saveError){el.className='sstat err';el.textContent='⚠ '+App.saveError;return;}
  if(App.saving||App.saveTimer||dirty()){el.className='sstat pending';el.textContent='⏳ Сохранение…';return;}
  el.className='sstat ok';el.textContent='✓ Сохранено · ред. '+App.project.revision;
  el.title='Последнее изменение: '+(App.project.updatedAt?new Date(App.project.updatedAt).toLocaleString('ru-RU'):'')+(App.project.updatedBy?' ('+App.project.updatedBy+')':'');
}
function updateUndoBtn(){
  var b=ge('btnUndo'),r=ge('btnRedo');
  if(b){b.title='Отменить ('+App.undo.length+' шагов)  Ctrl+Z';b.disabled=!App.undo.length;}
  if(r){r.title='Повторить ('+App.redo.length+' шагов)  Ctrl+Shift+Z / Ctrl+Y';r.disabled=!App.redo.length;}
}
function flashBtn(id){var btn=ge(id);if(btn){btn.style.background='#fee2e2';setTimeout(function(){btn.style.background='';},300);}}

// Оверлеи: последнее открытое окно — поверх остальных.
var _ovZ=10000;
var _openOvBase=openOv;
openOv=function(id){_openOvBase(id);ge(id).style.zIndex=String(++_ovZ);};

// ══ Снимки состояния ══════════════════════════════════════════════
function stripView(p){var o={};Object.keys(p).forEach(function(k){if(VIEW_FIELDS.indexOf(k)<0)o[k]=p[k];});return o;}
function dataSig(periods){return JSON.stringify(periods.map(stripView));}
function dirty(){return !!App.project&&App.lastFull!==App.serverFull;}

// Фиксирует действие пользователя: шаг Undo (если изменились данные) + сохранение на сервер.
function checkpoint(){
  if(!App.project||READONLY)return;
  var data=dataSig(PERIODS);
  if(data!==App.lastData){
    App.undo.push(App.lastData);if(App.undo.length>UNDO_MAX)App.undo.shift();
    App.redo=[];App.lastData=data;
  }
  var full=JSON.stringify(PERIODS);
  if(full!==App.lastFull){App.lastFull=full;scheduleSave();}
  updateUndoBtn();
}
function restoreData(str){
  var data=JSON.parse(str),views={};
  PERIODS.forEach(function(p){var v={};VIEW_FIELDS.forEach(function(k){v[k]=p[k];});views[p.id]=v;});
  data.forEach(function(p){if(views[p.id])Object.assign(p,views[p.id]);CPValidate.normalizePeriod(p);});
  PERIODS=data;
  App.lastData=dataSig(PERIODS);App.lastFull=JSON.stringify(PERIODS);
  renderAll();scheduleSave();updateUndoBtn();
}
function doUndo(){
  if(READONLY||!App.undo.length){flashBtn('btnUndo');return;}
  App.redo.push(App.lastData);restoreData(App.undo.pop());
}
function doRedo(){
  if(READONLY||!App.redo.length){flashBtn('btnRedo');return;}
  App.undo.push(App.lastData);restoreData(App.redo.pop());
}

// ══ Сохранение на сервер ══════════════════════════════════════════
function scheduleSave(delay){
  if(READONLY||!App.project)return;
  clearTimeout(App.saveTimer);
  App.saveTimer=setTimeout(doSave,delay==null?300:delay);
  setStatus();
}
function doSave(){
  clearTimeout(App.saveTimer);App.saveTimer=null;
  if(!App.project||READONLY||App.conflictOpen||!App.csrf)return setStatus();
  if(App.saving){return;}
  if(!dirty()){App.saveError=null;return setStatus();}
  var sent=App.lastFull,periods=JSON.parse(sent);
  var errs=CPValidate.validatePeriods(periods);
  if(errs.length){
    notify('Изменение отклонено — данные некорректны:\n'+errs.slice(0,3).join('\n'),'err');
    setPeriods(JSON.parse(App.serverFull));
    if(App.undo.length)App.undo.pop();
    return;
  }
  var pid=App.project.projectId;
  App.saving=true;App.saveError=null;setStatus();
  api('PUT','/api/projects/'+encodeURIComponent(pid),{baseRevision:App.project.revision,periods:periods})
    .then(function(d){
      App.saving=false;
      if(!App.project||App.project.projectId!==pid)return;
      takeMeta(d.project);App.serverFull=sent;
      if(dirty())doSave();else setStatus();
    })
    .catch(function(e){
      App.saving=false;
      if(!App.project||App.project.projectId!==pid)return;
      if(e.status===409){handleConcurrent(e.data.current);return;}
      if(e.status===401){App.saveError='Требуется вход';setStatus();return;}
      if(!e.status){ // нет связи — данные остаются в памяти, повторяем
        App.saveError='Нет связи с сервером — повтор…';setStatus();
        clearTimeout(App.retryTimer);App.retryTimer=setTimeout(function(){App.retryTimer=null;doSave();},3000);
        return;
      }
      notify('Сервер отклонил изменение: '+e.message,'err');
      reloadProject(false);
    });
}
function takeMeta(p){
  App.project.revision=p.revision;App.project.updatedAt=p.updatedAt;App.project.updatedBy=p.updatedBy;App.project.name=p.name;
  var it=App.projects.filter(function(x){return x.projectId===p.projectId;})[0];if(it){it.name=p.name;it.revision=p.revision;}
}
function setPeriods(periods){
  periods.forEach(CPValidate.normalizePeriod);
  PERIODS=periods;
  App.lastFull=JSON.stringify(PERIODS);App.lastData=dataSig(PERIODS);
  renderAll();setStatus();
}
// Дожидается сохранения всех локальных изменений.
function flushSave(){
  return new Promise(function(resolve,reject){
    var t0=Date.now();
    (function wait(){
      if(App.conflictOpen)return reject(new Error('Сначала завершите разрешение конфликта'));
      if(!App.project||READONLY||(!dirty()&&!App.saving))return resolve();
      if(App.saveError&&Date.now()-t0>8000)return reject(new Error(App.saveError));
      if(!App.saving&&!App.retryTimer)doSave();
      setTimeout(wait,60);
    })();
  });
}

// Конфликт ревизий (409): трёхстороннее слияние base/local/remote.
function handleConcurrent(current){
  var base=JSON.parse(App.serverFull),local=JSON.parse(App.lastFull),remote=current.periods;
  var tw=CPDiff.threeWay(base,local,remote);
  // локальные правки внутри вех, закрытых на сервере, не применяются
  var dropped=0;
  tw.items.forEach(function(it){
    var rp=it.pid&&CPOps.byId(remote,it.pid);
    if(rp&&rp.closed&&it.type!=='view'&&!(it.type==='field'&&it.field==='closed')&&tw.choices[it.key]==='file'){tw.choices[it.key]='cur';dropped++;}
  });
  var conflicts=tw.conflicts.filter(function(it){return tw.choices[it.key]==='file';});
  function finish(){
    var merged=CPDiff.applyChoices(remote,local,tw.items,tw.choices);
    takeMeta(current);
    App.serverFull=JSON.stringify(remote);
    App.undo=[];App.redo=[];
    setPeriods(merged);updateUndoBtn();
    notify('Проект одновременно изменил'+(current.updatedBy?' пользователь «'+current.updatedBy+'»':'и')+'. Изменения объединены с вашими.'
      +(dropped?'\nПравки в закрытых вехах ('+dropped+') отклонены.':'')+'\nИстория отмены очищена.','warn',9000);
    scheduleSave(0);
  }
  if(!conflicts.length){finish();return;}
  openConflictModal({
    title:'Одновременное редактирование',
    hint:'Пока вы редактировали, пользователь «'+(current.updatedBy||'?')+'» сохранил свою версию. Неперекрывающиеся изменения объединены автоматически. '
      +'Ниже — пункты, которые изменили вы оба: выберите, чью версию оставить.',
    curName:'На сервере',fileName:'Мои изменения',items:conflicts,choices:tw.choices,cancelable:false,
    onApply:function(ch){Object.assign(tw.choices,ch);finish();}
  });
}

// Перечитать проект с сервера.
function reloadProject(announce){
  if(!App.project)return Promise.resolve();
  var pid=App.project.projectId;
  return api('GET','/api/projects/'+encodeURIComponent(pid)).then(function(d){
    if(!App.project||App.project.projectId!==pid)return;
    applyProject(d.project,d.access,true);
    if(announce)notify('Проект обновлён: изменения от «'+(d.project.updatedBy||'?')+'». История отмены очищена.','warn');
  }).catch(function(e){
    if(e.status===404){notify('Проект больше недоступен','err');loadProjects().then(pickProject);}
  });
}

// ══ Проекты ═══════════════════════════════════════════════════════
function applyProject(project,access,resetUndo){
  App.project={projectId:project.projectId,name:project.name,revision:project.revision,updatedAt:project.updatedAt,updatedBy:project.updatedBy};
  App.access=access;App.saveError=null;
  READONLY=access!=='edit';
  CAN_REOPEN=!READONLY&&(!App.config.reopenRequiresAdmin||App.user.role==='admin');
  document.body.classList.toggle('ro',READONLY);
  document.body.classList.remove('noproj');
  ge('emptyState').style.display='none';
  App.serverFull=JSON.stringify(project.periods);
  if(resetUndo){App.undo=[];App.redo=[];}
  setPeriods(JSON.parse(App.serverFull));
  App.serverFull=App.lastFull;
  renderProjSel();updateUndoBtn();
}
function loadProjects(){
  return api('GET','/api/projects').then(function(d){App.projects=d.projects;renderProjSel();});
}
function renderProjSel(){
  var sel=ge('projSel');if(!sel)return;
  sel.innerHTML=App.projects.map(function(p){
    return '<option value="'+escH(p.projectId)+'"'+(App.project&&p.projectId===App.project.projectId?' selected':'')+'>'+escH(p.name)+(p.access==='read'?' (чтение)':'')+'</option>';
  }).join('');
}
function hashProject(){var m=/[#&]p=([^&]+)/.exec(location.hash);return m?decodeURIComponent(m[1]):null;}
function pickProject(){
  var want=hashProject()||(App.project&&App.project.projectId);
  var p=App.projects.filter(function(x){return x.projectId===want;})[0]||App.projects[0];
  if(!p){
    App.project=null;PERIODS=[];renderAll();
    document.body.classList.add('noproj');
    var es=ge('emptyState');es.style.display='';
    es.textContent=App.user.role==='admin'?'Проектов пока нет — создайте проект кнопкой «+ Проект».':'Нет доступных проектов. Обратитесь к администратору за правами.';
    setStatus();return Promise.resolve();
  }
  return openProject(p.projectId);
}
function openProject(id){
  return flushSave().then(function(){
    return api('GET','/api/projects/'+encodeURIComponent(id));
  }).then(function(d){
    applyProject(d.project,d.access,true);
    if(hashProject()!==id)history.replaceState(null,'','#p='+encodeURIComponent(id));
  }).catch(function(e){notify(e.message,'err');renderProjSel();});
}

// ══ Вход / пользователь ═══════════════════════════════════════════
function showLogin(){ge('loginScreen').classList.add('on');setTimeout(function(){ge('loginName').focus();},50);}
function hideLogin(){ge('loginScreen').classList.remove('on');ge('loginErr').textContent='';ge('loginPass').value='';}
function onUnauthorized(){App.csrf=null;showLogin();}
function boot(){
  return api('GET','/api/auth/me').then(function(d){
    App.user=d.user;App.csrf=d.csrf;App.config=d.config||{};
    hideLogin();startPolling();
    document.body.classList.toggle('admin',App.user.role==='admin');
    document.body.classList.toggle('noseed',!App.config.hasSeed);
    ge('userChip').textContent='👤 '+App.user.login+(App.user.role==='admin'?' · админ':'');
    if(App.user.mustChangePassword){openPassword(true);return;}
    // повторный вход после истечения сессии — состояние в памяти сохраняется и досохраняется
    if(App.project&&dirty()){loadProjects();App.saveError=null;doSave();return;}
    return loadProjects().then(pickProject);
  }).catch(function(e){if(e.status!==401)notify('Сервер недоступен: '+e.message,'err');});
}
ge('loginForm').addEventListener('submit',function(e){
  e.preventDefault();
  ge('loginErr').textContent='';
  api('POST','/api/auth/login',{login:ge('loginName').value.trim(),password:ge('loginPass').value})
    .then(function(){boot();})
    .catch(function(err){ge('loginErr').textContent=err.message;});
});
function openPassword(forced){
  ['pwdOld','pwdNew','pwdNew2'].forEach(function(id){ge(id).value='';});
  ge('pwdErr').textContent='';
  ge('pwdHint').style.display=forced?'':'none';
  ge('btnPwdCancel').style.display=forced?'none':'';
  ge('ovPassword').dataset.forced=forced?'1':'';
  openOv('ovPassword');ge('pwdOld').focus();
}
function doChangePassword(){
  var n=ge('pwdNew').value;
  if(n!==ge('pwdNew2').value){ge('pwdErr').textContent='Пароли не совпадают';return;}
  api('POST','/api/auth/password',{oldPassword:ge('pwdOld').value,newPassword:n}).then(function(d){
    App.user=d.user;closeOv('ovPassword');notify('Пароль изменён','ok');
    if(ge('ovPassword').dataset.forced)loadProjects().then(pickProject);
  }).catch(function(e){ge('pwdErr').textContent=e.message;});
}

// ══ Действия панели проекта ═══════════════════════════════════════
var _projMode='new';
function openProjectModal(mode){
  _projMode=mode;
  ge('projModalTitle').textContent=mode==='new'?'Новый проект':'Переименовать проект';
  ge('projSeedRow').style.display=mode==='new'?'':'none';
  ge('projName').value=mode==='new'?'':(App.project?App.project.name:'');
  openOv('ovProject');ge('projName').focus();
}
function doProjectModal(){
  var name=ge('projName').value.trim();
  if(!name){notify('Введите название');return;}
  if(_projMode==='new'){
    api('POST','/api/projects',{name:name,fromSeed:gv('projSeed')==='seed'}).then(function(d){
      closeOv('ovProject');return loadProjects().then(function(){return openProject(d.project.projectId);});
    }).catch(function(e){notify(e.message,'err');});
  }else{
    flushSave().then(function(){
      return api('PUT','/api/projects/'+encodeURIComponent(App.project.projectId),{baseRevision:App.project.revision,name:name});
    }).then(function(d){
      takeMeta(d.project);renderProjSel();setStatus();closeOv('ovProject');notify('Проект переименован','ok');
    }).catch(function(e){
      if(e.status===409){reloadProject(true);notify('Проект только что изменён другим пользователем — повторите переименование','warn');}
      else notify(e.message,'err');
    });
  }
}
function deleteProjectUI(){
  if(!App.project)return;
  var p=App.project;
  confirm2('Удалить проект','Удалить проект «'+p.name+'»? Файл будет перемещён в DATA_DIR/trash на сервере.',function(){
    api('DELETE','/api/projects/'+encodeURIComponent(p.projectId)).then(function(){
      App.project=null;history.replaceState(null,'','#');
      notify('Проект удалён','ok');return loadProjects().then(pickProject);
    }).catch(function(e){notify(e.message,'err');});
  });
}
function downloadConfig(){
  if(!App.project)return;
  flushSave().then(function(){
    var a=document.createElement('a');
    a.href='/api/projects/'+encodeURIComponent(App.project.projectId)+'/download';
    a.download='';document.body.appendChild(a);a.click();document.body.removeChild(a);
  }).catch(function(e){notify(e.message,'err');});
}
function resetAll(){
  if(READONLY)return;
  if(PERIODS.some(function(p){return p.closed;})){notify('В проекте есть закрытые вехи — сброс невозможен. Сначала переоткройте их.');return;}
  var prev=App.lastData;
  api('GET','/api/seed').then(function(d){
    setPeriods(d.project.periods);
    checkpointFrom(prev);
    notify('Данные проекта сброшены к исходным. Отмена: Ctrl+Z','ok');
  }).catch(function(e){notify(e.message,'err');});
}
// checkpoint для асинхронных замен состояния: prevData — состояние до изменения
function checkpointFrom(prevData){
  if(prevData&&prevData!==App.lastData){App.undo.push(prevData);if(App.undo.length>UNDO_MAX)App.undo.shift();App.redo=[];}
  scheduleSave();updateUndoBtn();
}

// ══ Загрузка конфигурации ═════════════════════════════════════════
function openUpload(){
  if(READONLY||!App.project&&App.user.role!=='admin')return;
  ge('uploadFile').value='';ge('uploadInfo').textContent='';
  var radios=document.getElementsByName('uploadMode');
  radios[0].checked=!!App.project;radios[1].checked=!App.project;
  openOv('ovUpload');
}
function readUploadFile(){
  return new Promise(function(resolve,reject){
    var f=ge('uploadFile').files[0];
    if(!f)return reject(new Error('Выберите файл'));
    var maxB=(App.config.maxUploadMb||5)*1024*1024;
    if(f.size>maxB)return reject(new Error('Файл больше '+(App.config.maxUploadMb||5)+' МБ'));
    var r=new FileReader();
    r.onerror=function(){reject(new Error('Не удалось прочитать файл'));};
    r.onload=function(){
      try{
        var text=String(r.result).replace(/^﻿/,'').trim();
        var obj;
        if(text.charAt(0)==='<'){
          // HTML однофайловой версии со вшитым состоянием
          var m=/window\.CP_SAVED_STATE=([\s\S]*?);<\/script>/.exec(text);
          if(!m)throw new Error('В HTML-файле нет встроенных данных (CP_SAVED_STATE)');
          obj={schema:CPValidate.SCHEMA,name:f.name.replace(/\.[^.]+$/,''),periods:JSON.parse(m[1])};
        }else obj=JSON.parse(text);
        var parsed=CPValidate.parseProjectFile(obj);
        if(parsed.errors.length)throw new Error('Файл не прошёл проверку:\n'+parsed.errors.slice(0,5).join('\n'));
        resolve({obj:parsed.project,name:f.name});
      }catch(e){reject(e.name==='SyntaxError'?new Error('Файл не является корректным JSON'):e);}
    };
    r.readAsText(f,'utf-8');
  });
}
function doUpload(){
  var mode=document.querySelector('input[name=uploadMode]:checked').value;
  readUploadFile().then(function(up){
    if(mode==='new'){
      return api('POST','/api/projects',{project:up.obj,name:up.obj.name||up.name.replace(/\.[^.]+$/,'')}).then(function(d){
        closeOv('ovUpload');notify('Создан проект «'+d.project.name+'»','ok');
        return loadProjects().then(function(){return openProject(d.project.projectId);});
      });
    }
    if(!App.project)throw new Error('Нет текущего проекта');
    var prev;
    return flushSave().then(function(){
      prev=App.lastData;
      return api('POST','/api/projects/'+encodeURIComponent(App.project.projectId)+'/upload',{file:up.obj});
    }).then(function(d){
      closeOv('ovUpload');
      if(!d.items.length){notify('Файл совпадает с текущим проектом — изменений нет','ok');return;}
      openConflictModal({
        title:'Загрузка конфигурации: разрешение конфликтов',
        hint:'Файл «'+up.name+'» сравнён с текущей версией проекта (ред. '+d.baseRevision+'). Сопоставление: версии — по id (или имени), задачи — по WBS, ресурсы — по ключу. '
          +'Для каждого отличающегося пункта выберите: оставить текущее или взять из файла.',
        curName:'Текущее',fileName:'Из файла',items:d.items,choices:{},cancelable:true,defaultChoice:'file',
        onApply:function(choices){
          api('POST','/api/projects/'+encodeURIComponent(App.project.projectId)+'/merge',{uploadId:d.uploadId,baseRevision:d.baseRevision,choices:choices})
            .then(function(r){
              applyServerProject(r.project,prev);
              notify('Конфигурация загружена: применено пунктов из файла — '+r.applied+'. Отмена: Ctrl+Z','ok');
            }).catch(function(e){
              if(e.status===409){reloadProject(true);notify(e.message,'warn');}else notify(e.message,'err');
            });
        }
      });
    });
  }).catch(function(e){ge('uploadInfo').textContent=e.message;notify(e.message,'err');});
}
// Применяет проект, возвращённый серверной операцией; prevData — состояние до неё (шаг Undo).
function applyServerProject(project,prevData){
  takeMeta(project);
  App.serverFull=JSON.stringify(project.periods);
  setPeriods(project.periods);
  App.serverFull=App.lastFull;
  checkpointFrom(prevData);
  setStatus();
}

// ══ Окно разрешения конфликтов ════════════════════════════════════
var CF=null;
var ST_LABEL={added:'Добавлено',removed:'Удалено',changed:'Изменено'};
function openConflictModal(o){
  CF={o:o,choices:{}};
  o.items.forEach(function(it){
    CF.choices[it.key]=o.choices[it.key]||(it.type==='view'?'cur':(o.defaultChoice||'file'));
  });
  ge('cfTitle').textContent=o.title;ge('cfHint').textContent=o.hint;
  document.querySelectorAll('.cfCurName').forEach(function(e){e.textContent=o.curName.toLowerCase();});
  document.querySelectorAll('.cfFileName').forEach(function(e){e.textContent=o.fileName.toLowerCase();});
  ge('btnCfCancel').style.display=o.cancelable?'':'none';
  ge('cfShowView').checked=false;
  App.conflictOpen=true;
  renderCf();openOv('ovConflict');
}
function cfVisible(){var sv=ge('cfShowView').checked;return CF.o.items.filter(function(it){return sv||it.type!=='view';});}
function renderCf(){
  var items=cfVisible(),o=CF.o;
  var cnt={added:0,removed:0,changed:0};items.forEach(function(it){cnt[it.status]++;});
  ge('cfSum').innerHTML='<span>Различий: <b>'+items.length+'</b></span>'
    +['added','removed','changed'].map(function(s){return cnt[s]?'<span class="st '+s+'">'+ST_LABEL[s]+': '+cnt[s]+'</span>':'';}).join(' ');
  var groups=[],gmap={};
  items.forEach(function(it){var g=it.plabel||(it.type==='period'?'Версии проекта':'Проект');
    if(!gmap[g]){gmap[g]={name:g,items:[]};groups.push(gmap[g]);}gmap[g].items.push(it);});
  ge('cfBody').innerHTML=groups.map(function(g,gi){
    return '<div class="cf-group"><div class="cf-ghdr"><span style="flex:1">'+escH(g.name)+' <span class="muted" style="font-weight:400">· '+g.items.length+'</span></span>'
      +'<button class="btn" data-cfgrp="'+gi+'|cur">все в группе: '+escH(o.curName.toLowerCase())+'</button>'
      +'<button class="btn" data-cfgrp="'+gi+'|file">все в группе: '+escH(o.fileName.toLowerCase())+'</button></div>'
      +'<table class="cf"><colgroup><col style="width:92px"><col style="width:30%"><col><col></colgroup>'
      +'<thead><tr><th>Статус</th><th>Пункт</th><th>'+escH(o.curName)+'</th><th>'+escH(o.fileName)+'</th></tr></thead><tbody>'
      +g.items.map(function(it){
        var c=CF.choices[it.key];
        return '<tr><td><span class="st '+it.status+'">'+ST_LABEL[it.status]+'</span></td>'
          +'<td>'+escH(itemTitle(it))+'</td>'
          +cfCell(it,'cur',c)+cfCell(it,'file',c)+'</tr>';
      }).join('')+'</tbody></table></div>';
  }).join('')||'<div class="empty">Нет различий</div>';
  CF.groups=groups;
}
function itemTitle(it){
  if(it.type==='task')return (it.cur&&it.cur.s||it.file&&it.file.s?'Блок ':'Задача ')+it.label;
  if(it.type==='res')return 'Ресурс '+it.label;
  if(it.type==='field')return it.label;
  if(it.type==='period')return 'Версия «'+it.label+'»';
  return it.label;
}
function cfCell(it,side,choice){
  var v=side==='cur'?it.cur:it.file,html;
  var absent=(side==='cur'&&it.status==='added')||(side==='file'&&it.status==='removed');
  var verb=side==='cur'?(it.status==='added'?'не добавлять':'оставить'):(it.status==='removed'?'удалить':it.status==='added'?'добавить':'взять');
  if(absent)html='<span class="muted">— отсутствует —</span>';
  else if(it.type==='task')html=fmtTask(it,v);
  else if(it.type==='res')html=fmtRes(it,v);
  else if(it.type==='period')html=v?escH(v.leaves+' задач, отмечено '+v.checked+', '+v.hours.toLocaleString('ru')+' ч'+(v.closed?', закрыта':'')):'';
  else if(it.type==='field'||it.type==='chk')html=escH(fmtVal(v));
  else html='<span class="muted">'+(side==='cur'?'текущий вариант':'вариант из файла')+'</span>';
  return '<td class="ch'+(choice===side?' sel':'')+'" data-cfpick="'+escH(it.key)+'|'+side+'"><label><input type="radio" name="cf_'+escH(it.key)+'"'+(choice===side?' checked':'')+'><span><b style="font-weight:600">'+verb+'</b><br>'+html+'</span></label></td>';
}
function fmtVal(v){if(v===null||v===undefined||v==='')return '—';if(v===true)return '✓';if(v===false)return '✗';return String(v);}
function fmtTask(it,v){
  var f=it.fields||['n','h','r','chk','rel'];
  return f.map(function(k){
    var val=v[k];
    if(k==='chk')val=val?'✓ отмечена':'✗ снята';
    else if(k==='h')val=val+' ч';
    else if(k==='s')val=val?'да':'нет';
    return '<span class="cf-f">'+escH(CPDiff.TASK_LABELS[k])+': <b>'+escH(fmtVal(val))+'</b></span>';
  }).join('');
}
function fmtRes(it,v){
  var f=it.fields||CPDiff.RES_FIELDS,L={label:'Название',n:'Штат',pct:'%',period:'Период',color:'Цвет'};
  return f.map(function(k){var val=v[k];if(k==='period')val=val==='tst'?'тестирование':'разработка';
    return '<span class="cf-f">'+L[k]+': <b>'+escH(fmtVal(val))+'</b></span>';}).join('');
}
function cfApply(){
  var o=CF.o,choices=CF.choices;
  App.conflictOpen=false;closeOv('ovConflict');CF=null;
  o.onApply(choices);
}
function cfCancel(){App.conflictOpen=false;closeOv('ovConflict');CF=null;}

// ══ Отвязка версий ════════════════════════════════════════════════
function openDetach(pid){
  var p=getPeriod(pid),lp=p&&getLinked(p);
  if(!p||!lp)return;
  if(p.closed||lp.closed){notify('Нельзя отвязывать закрытую веху — сначала переоткройте её');return;}
  ge('detachDir').innerHTML='<option value="'+p.id+'|'+lp.id+'">Отвязать «'+escH(p.name)+'» от «'+escH(lp.name)+'»</option>'
    +'<option value="'+lp.id+'|'+p.id+'">Отвязать «'+escH(lp.name)+'» от «'+escH(p.name)+'»</option>';
  ge('detachInactive').checked=!!App.config.detachRemoveInactiveInSource;
  renderDetachPreview();openOv('ovDetach');
}
function detachArgs(){var v=gv('detachDir').split('|');return {b:v[0],a:v[1],inactive:ge('detachInactive').checked};}
function renderDetachPreview(){
  var x=detachArgs(),B=getPeriod(x.b),A=getPeriod(x.a);
  var plan=CPOps.planDetach(PERIODS,x.b,x.a,{removeInactiveInSource:x.inactive});
  ge('detachRule').innerHTML='Из версии <b>«'+escH(B.name)+'»</b> будут удалены задачи, которые в ней <b>сняты</b>, а в версии <b>«'+escH(A.name)+'»</b> есть задача с тем же WBS и она там <b>активна</b>. '
    +'Затем удаляются ставшие пустыми строки-итоги, и связь снимается с обеих сторон. Операцию можно отменить (Ctrl+Z).';
  var h=function(list){return list.reduce(function(s,t){return s+t.h;},0).toLocaleString('ru');};
  var li=function(list){return list.length?'<div class="detach-list">'+list.map(function(t){return escH(t.w+' — '+t.n+' ('+t.h+' ч)');}).join('<br>')+'</div>':'';};
  ge('detachPreview').innerHTML='<div>Будет удалено задач: <b>'+plan.remove.length+'</b> ('+h(plan.removeTasks)+' ч)</div>'+li(plan.removeTasks)
    +'<div>Будет удалено опустевших строк-итогов: <b>'+plan.removeSummaries.length+'</b></div>'
    +'<div style="margin-top:6px">Останутся снятыми (в «'+escH(A.name)+'» не активны или отсутствуют): <b>'+plan.keptInactive.length+'</b></div>'+li(plan.keptTasks)
    +'<div class="notice">Отмеченные в «'+escH(B.name)+'» задачи не затрагиваются.</div>';
}
function doDetach(){
  var x=detachArgs();closeOv('ovDetach');
  serverOp('/periods/'+encodeURIComponent(x.b)+'/detach',{fromId:x.a,removeInactiveInSource:x.inactive},function(d){
    var r=d.result||{};return 'Версия отвязана: удалено задач '+r.removed+', пустых блоков '+r.removedSummaries+', оставлено снятых '+r.keptInactive+'. Отмена: Ctrl+Z';
  });
}

// ══ Закрытие / переоткрытие вехи ══════════════════════════════════
function closePeriodUI(pid){
  var p=getPeriod(pid);if(!p||READONLY)return;
  confirm2('Закрыть веху','Веха «'+p.name+'» станет доступна только для чтения, ресурсы и ёмкость будут заморожены на текущих значениях. Переоткрыть можно отдельным действием.',function(){
    serverOp('/periods/'+encodeURIComponent(pid)+'/close',{},function(){return 'Веха «'+p.name+'» закрыта. Отмена: Ctrl+Z';});
  });
}
function reopenPeriodUI(pid){
  var p=getPeriod(pid);if(!p||!CAN_REOPEN)return;
  confirm2('Переоткрыть веху','Переоткрыть веху «'+p.name+'»? Она снова станет редактируемой, ресурсы будут пересчитываться по текущим данным.',function(){
    serverOp('/periods/'+encodeURIComponent(pid)+'/reopen',{},function(){return 'Веха «'+p.name+'» переоткрыта. Отмена: Ctrl+Z';});
  });
}
function serverOp(path,body,okMsg){
  if(!App.project||READONLY)return;
  var prev;
  flushSave().then(function(){
    prev=App.lastData;
    return api('POST','/api/projects/'+encodeURIComponent(App.project.projectId)+path,Object.assign({baseRevision:App.project.revision},body||{}));
  }).then(function(d){
    applyServerProject(d.project,prev);notify(okMsg(d),'ok');
  }).catch(function(e){
    if(e.status===409){reloadProject(false);notify('Проект только что изменён другим пользователем — данные обновлены, повторите действие','warn');}
    else notify(e.message,'err');
  });
}

// ══ Отчёт о выполнении ════════════════════════════════════════════
// Открывается отдельной страницей (report.html), которая сама читает проект с сервера и обновляется.
function openReport(pid,phase){
  if(!App.project)return;
  var w=window.open('about:blank','_blank');
  flushSave().catch(function(){}).then(function(){
    var url='/report.html#p='+encodeURIComponent(App.project.projectId)+'&v='+encodeURIComponent(pid)+(phase&&phase!=='all'?'&f='+phase:'');
    if(w){w.opener=null;w.location.href=url;}else location.href=url;
  });
}

// ══ Штат в открытые версии ════════════════════════════════════════
function pushResUI(pid){
  var src=getPeriod(pid);if(!src||READONLY)return;
  var targets=PERIODS.filter(function(p){return p.id!==pid&&!p.closed;});
  var closedN=PERIODS.filter(function(p){return p.id!==pid&&p.closed;}).length;
  if(!targets.length){notify('Нет других открытых версий'+(closedN?' (закрытые вехи не изменяются)':''));return;}
  confirm2('Штат в открытые версии','Скопировать штат и % загрузки ресурсов версии «'+src.name+'» в: '+targets.map(function(p){return '«'+p.name+'»';}).join(', ')
    +'. Отсутствующие ресурсы будут добавлены.'+(closedN?' Закрытые вехи ('+closedN+') не затрагиваются.':''),function(){
    targets.forEach(function(t){
      Object.keys(src.res).forEach(function(k){
        if(t.res[k]){t.res[k].n=src.res[k].n;t.res[k].pct=src.res[k].pct;}
        else t.res[k]=JSON.parse(JSON.stringify(src.res[k]));
      });
    });
    refreshAll();
  });
}

// ══ Обновление из git (админ) ═════════════════════════════════════
var UPD=null;
function fmtDT(s){try{return new Date(s).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});}catch(e){return s;}}
function openUpdate(){openOv('ovUpdate');checkUpdate();}
function checkUpdate(){
  ge('updBody').innerHTML='<span class="muted">Проверка обновлений…</span>';ge('btnUpdApply').disabled=true;
  api('GET','/api/admin/update').then(function(s){UPD=s;renderUpdate();}).catch(function(e){ge('updBody').textContent=e.message;});
}
function renderUpdate(){
  var s=UPD,h='<div>Версия: <b>'+escH(s.version)+'</b>'+(s.current?' · коммит <code>'+escH(s.current.hash)+'</code> от '+fmtDT(s.current.date)+' — '+escH(s.current.subject):'')+'</div>';
  if(s.branch)h+='<div class="muted">Ветка '+escH(s.branch)+(s.upstream?' → '+escH(s.upstream):'')+(s.checkedAt?' · проверено '+fmtDT(s.checkedAt):'')+'</div>';
  if(!s.available){h+='<div class="link-info" style="margin-top:8px">'+escH(s.reason)+'</div>';}
  else if(s.dirty.length){h+='<div class="link-info" style="margin-top:8px">Файлы приложения изменены локально — автоматическое обновление невозможно:<br><code>'+s.dirty.map(escH).join('<br>')+'</code></div>';}
  else if(s.ahead){h+='<div class="link-info" style="margin-top:8px">Локальная ветка опережает репозиторий на '+s.ahead+' коммит(ов) — нужна ручная синхронизация.</div>';}
  else if(!s.behind){h+='<div style="margin-top:8px;color:#1a7f37;font-weight:700">✓ Установлена последняя версия</div>';}
  else{
    h+='<div style="margin-top:8px;font-weight:700">Доступно обновлений: '+s.behind+'</div><div class="detach-list">'
      +s.commits.map(function(c){return '<code>'+escH(c.hash)+'</code> '+fmtDT(c.date)+' — '+escH(c.subject)+' <span class="muted">('+escH(c.author)+')</span>';}).join('<br>')+'</div>';
    ge('btnUpdApply').disabled=false;
  }
  ge('updBody').innerHTML=h;
}
function applyUpdate(){
  ge('btnUpdApply').disabled=true;ge('btnUpdCheck').disabled=true;
  ge('updBody').innerHTML='<b>Обновление…</b> <span class="muted">получение кода'+(UPD&&UPD.behind?' ('+UPD.behind+' коммит.)':'')+', при необходимости — установка зависимостей</span>';
  flushSave().catch(function(){}).then(function(){return api('POST','/api/admin/update');}).then(function(r){
    ge('updBody').innerHTML='✓ Обновлено: <code>'+escH(r.from)+'</code> → <code>'+escH(r.to)+'</code>'+(r.npm?' (зависимости обновлены)':'')
      +'<br><b>Перезапуск сервера…</b> <span class="muted" id="updWait"></span>';
    waitRestart(r.to,0);
  }).catch(function(e){ge('btnUpdCheck').disabled=false;ge('updBody').innerHTML='<div class="link-info">'+escH(e.message).replace(/\n/g,'<br>')+'</div>';});
}
// ждём, пока новый процесс сервера поднимется, и перезагружаем страницу
function waitRestart(to,n){
  setTimeout(function(){
    var w=ge('updWait');if(w)w.textContent='ожидание '+(n+1)+' с';
    fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store'}).then(function(r){
      if(r.ok||r.status===401){location.reload();return;}
      throw new Error();
    }).catch(function(){
      if(n<90)waitRestart(to,n+1);
      else ge('updBody').innerHTML+='<div class="link-info">Сервер не поднялся за 90 с. Проверьте logs/server.log и запустите его скриптом start.</div>';
    });
  },n<2?1500:1000);
}

// ══ Пользователи (админ) ══════════════════════════════════════════
var USERS=[];
function openUsers(){
  Promise.all([api('GET','/api/users'),loadProjects()]).then(function(r){
    USERS=r[0].users;renderUsers();openOv('ovUsers');
  }).catch(function(e){notify(e.message,'err');});
}
function renderUsers(){
  var projs=App.projects;
  var head='<thead><tr><th>Логин</th><th>Роль</th>'+projs.map(function(p){return '<th title="'+escH(p.name)+'">'+escH(p.name.length>22?p.name.slice(0,21)+'…':p.name)+'</th>';}).join('')+'<th></th></tr></thead>';
  var rows=USERS.map(function(u){
    var me=u.id===App.user.id;
    return '<tr><td><b>'+escH(u.login)+'</b>'+(me?' <span class="muted">(вы)</span>':'')+(u.mustChangePassword?' <span class="muted" title="Сменит пароль при входе">🔑</span>':'')+'</td>'
      +'<td><select data-urole="'+escH(u.id)+'"><option value="user"'+(u.role==='user'?' selected':'')+'>Пользователь</option><option value="admin"'+(u.role==='admin'?' selected':'')+'>Администратор</option></select></td>'
      +projs.map(function(p){
        if(u.role==='admin')return '<td class="muted">полный</td>';
        var a=(u.perms||{})[p.projectId]||'';
        return '<td><select data-uperm="'+escH(u.id)+'|'+escH(p.projectId)+'">'
          +'<option value=""'+(a===''?' selected':'')+'>нет доступа</option>'
          +'<option value="read"'+(a==='read'?' selected':'')+'>чтение</option>'
          +'<option value="edit"'+(a==='edit'?' selected':'')+'>редактирование</option></select></td>';
      }).join('')
      +'<td><button class="btn" data-upwd="'+escH(u.id)+'" title="Задать новый пароль">🔑 Пароль</button> '
      +(me?'':'<button class="btn btnd" data-udel="'+escH(u.id)+'">✕</button>')+'</td></tr>';
  }).join('');
  ge('usersTable').innerHTML=head+'<tbody>'+rows+'</tbody>';
}
function userById(id){return USERS.filter(function(u){return u.id===id;})[0];}
function updateUser(id,patch,msg){
  return api('PUT','/api/users/'+encodeURIComponent(id),patch).then(function(d){
    var i=USERS.findIndex(function(u){return u.id===id;});if(i>=0)USERS[i]=d.user;
    if(id===App.user.id){App.user=d.user;}
    renderUsers();if(msg)notify(msg,'ok',2500);
  }).catch(function(e){notify(e.message,'err');renderUsers();});
}
function createUser(){
  api('POST','/api/users',{login:ge('nuLogin').value.trim(),password:ge('nuPass').value,role:gv('nuRole')}).then(function(d){
    USERS.push(d.user);ge('nuLogin').value='';ge('nuPass').value='';renderUsers();
    notify('Пользователь «'+d.user.login+'» создан. Назначьте права на проекты в таблице.','ok');
  }).catch(function(e){notify(e.message,'err');});
}
var _promptCb=null;
function prompt2(title,type,cb){
  ge('promptTitle').textContent=title;var inp=ge('promptInput');inp.type=type||'text';inp.value='';
  _promptCb=cb;openOv('ovPrompt');inp.focus();
}

// ══ События ═══════════════════════════════════════════════════════
// Блокировка изменений в закрытых вехах и в режиме «только чтение» (дополнительно к проверке на сервере).
var MUT_SEL='[data-del],[data-delres],[data-addtask],[data-addblock],[data-addres],[data-delperiod],[data-addintask],[data-breaklink],[data-detach],[data-selall],[data-selnone],[data-closeperiod]';
var RO_SEL='#btnAddPeriod,#btnReset,#btnLoad,#btnImportGlobal,#btnUndo,#btnRedo,#btnProjRename,[data-reopen],[data-pushres],[data-closeperiod]';
function cardPeriod(el){var c=el&&el.closest&&el.closest('.period-card');return c?getPeriod(c.id.slice(7)):null;}
function stopEv(e){e.stopImmediatePropagation();e.preventDefault();}
document.addEventListener('click',function(e){
  var p=cardPeriod(e.target);
  if(p&&isLocked(p)&&e.target.closest(MUT_SEL))return stopEv(e);
  if(READONLY&&e.target.closest&&e.target.closest(RO_SEL))return stopEv(e);
},true);
document.addEventListener('change',function(e){
  var p=cardPeriod(e.target);
  if(p&&isLocked(p)){stopEv(e);renderAll();}
},true);
document.addEventListener('dblclick',function(e){var p=cardPeriod(e.target);if(p&&isLocked(p))stopEv(e);},true);
document.addEventListener('dragstart',function(e){var p=cardPeriod(e.target);if(p&&isLocked(p))stopEv(e);},true);

// После любого действия пользователя — фиксируем шаг и сохраняем.
['change','click','drop','mouseup'].forEach(function(t){
  document.addEventListener(t,function(){setTimeout(checkpoint,0);});
});
// Набор текста/чисел: микробатч ~300 мс, чтобы правка ушла на сервер, даже если поле не потеряло фокус.
var _liveTimer=null;
document.addEventListener('input',function(e){
  var el=e.target;
  if(!el.dataset||!(el.dataset.ptitle||el.dataset.seth||el.dataset.resname||el.dataset.resn||el.dataset.respct))return;
  clearTimeout(_liveTimer);
  _liveTimer=setTimeout(function(){applyLive(el);checkpoint();},300);
});
function applyLive(el){
  var v=el.value,pts,p;
  if(el.dataset.ptitle){p=getPeriod(el.dataset.ptitle);if(p&&!isLocked(p))p.name=v;return;}
  if(el.dataset.seth){
    pts=el.dataset.seth.split('|');p=getPeriod(pts[0]);if(!p||isLocked(p))return;
    var tk=p.tasks[+pts[1]];if(!tk)return;
    tk.h=+v;var twin=findTwin(p,tk);if(twin)twin.h=+v;return;
  }
  var key=el.dataset.resname||el.dataset.resn||el.dataset.respct;
  pts=key.split('|');p=getPeriod(pts[0]);if(!p||isLocked(p)||!p.res[pts[1]])return;
  if(el.dataset.resname)p.res[pts[1]].label=v;
  else if(el.dataset.resn)p.res[pts[1]].n=+v;
  else p.res[pts[1]].pct=+v;
}

document.addEventListener('click',function(e){
  var el=e.target;
  var pick=el.closest('[data-cfpick]');
  if(pick&&CF){var i=pick.dataset.cfpick.lastIndexOf('|');CF.choices[pick.dataset.cfpick.slice(0,i)]=pick.dataset.cfpick.slice(i+1);renderCf();return;}
  var grp=el.closest('[data-cfgrp]');
  if(grp&&CF){var g=grp.dataset.cfgrp.split('|');CF.groups[+g[0]].items.forEach(function(it){CF.choices[it.key]=g[1];});renderCf();return;}
  var ud=el.closest('[data-udel]');
  if(ud){var u=userById(ud.dataset.udel);confirm2('Удалить пользователя','Удалить пользователя «'+u.login+'»?',function(){
    api('DELETE','/api/users/'+encodeURIComponent(u.id)).then(function(){USERS=USERS.filter(function(x){return x.id!==u.id;});renderUsers();notify('Пользователь удалён','ok');}).catch(function(err){notify(err.message,'err');});
  });return;}
  var up=el.closest('[data-upwd]');
  if(up){var u2=userById(up.dataset.upwd);prompt2('Новый пароль для «'+u2.login+'» (мин. 8 символов)','password',function(v){updateUser(u2.id,{password:v},'Пароль изменён'+(u2.id===App.user.id?'':' — пользователь сменит его при входе'));});return;}

  var id=el.id||(el.closest('button[id]')?el.closest('button[id]').id:'')||'';
  if(id==='btnLogout'){flushSave().catch(function(){}).then(function(){return api('POST','/api/auth/logout');}).then(function(){location.reload();},function(){location.reload();});}
  else if(id==='btnChangePwd'){openPassword(false);}
  else if(id==='btnPwdOk'){doChangePassword();}
  else if(id==='btnPwdCancel'){closeOv('ovPassword');}
  else if(id==='btnProjNew'){openProjectModal('new');}
  else if(id==='btnProjRename'){if(App.project)openProjectModal('rename');}
  else if(id==='btnProjOk'){doProjectModal();}
  else if(id==='btnProjCancel'){closeOv('ovProject');}
  else if(id==='btnProjDelete'){deleteProjectUI();}
  else if(id==='btnUploadOk'){doUpload();}
  else if(id==='btnUploadCancel'){closeOv('ovUpload');}
  else if(id==='btnCfAllCur'){CF.o.items.forEach(function(it){CF.choices[it.key]='cur';});renderCf();}
  else if(id==='btnCfAllFile'){CF.o.items.forEach(function(it){CF.choices[it.key]='file';});renderCf();}
  else if(id==='btnCfApply'){cfApply();}
  else if(id==='btnCfCancel'){cfCancel();}
  else if(id==='btnDetachOk'){doDetach();}
  else if(id==='btnDetachCancel'){closeOv('ovDetach');}
  else if(id==='btnUsers'){openUsers();}
  else if(id==='btnUpdate'){openUpdate();}
  else if(id==='btnUpdClose'){closeOv('ovUpdate');}
  else if(id==='btnUpdCheck'){ge('btnUpdCheck').disabled=false;checkUpdate();}
  else if(id==='btnUpdApply'){confirm2('Обновление','Обновить приложение до последней версии и перезапустить сервер? Пользователи увидят кратковременную недоступность (несколько секунд).',applyUpdate);}
  else if(id==='btnUsersClose'){closeOv('ovUsers');}
  else if(id==='btnNuAdd'){createUser();}
  else if(id==='btnPromptOk'){var v=ge('promptInput').value;closeOv('ovPrompt');if(_promptCb)_promptCb(v);_promptCb=null;}
  else if(id==='btnPromptCancel'){closeOv('ovPrompt');_promptCb=null;}
});
document.addEventListener('change',function(e){
  var el=e.target;
  if(el.id==='projSel'){var v=el.value;openProject(v);}
  else if(el.id==='cfShowView'){renderCf();}
  else if(el.id==='detachDir'||el.id==='detachInactive'){renderDetachPreview();}
  else if(el.dataset.urole){updateUser(el.dataset.urole,{role:el.value},'Роль изменена');}
  else if(el.dataset.uperm){
    var pts=el.dataset.uperm.split('|'),u=userById(pts[0]);if(!u)return;
    var perms=Object.assign({},u.perms||{});if(el.value)perms[pts[1]]=el.value;else delete perms[pts[1]];
    updateUser(u.id,{perms:perms},'Права обновлены');
  }
});
document.addEventListener('keydown',function(e){
  if(e.key==='Enter'&&e.target.id==='promptInput'){ge('btnPromptOk').click();}
  if(e.key==='Escape'&&ge('ovPassword').dataset.forced){openOv('ovPassword');}
  if(e.key==='Enter'&&e.target.id==='projName'){ge('btnProjOk').click();}
  if(e.key==='Enter'&&(e.target.id==='pwdNew2')){ge('btnPwdOk').click();}
});
window.addEventListener('hashchange',function(){var id=hashProject();if(id&&(!App.project||id!==App.project.projectId))openProject(id);});
window.addEventListener('beforeunload',function(e){if(dirty()||App.saving){doSave();e.preventDefault();e.returnValue='';}});
document.addEventListener('visibilitychange',function(){if(document.hidden&&dirty())doSave();else if(!document.hidden)poll();});

// Сверка с сервером: подтягиваем изменения других пользователей.
function poll(){
  if(!App.project||!App.csrf||App.saving||dirty()||App.conflictOpen||document.hidden)return;
  var pid=App.project.projectId,rev=App.project.revision;
  api('GET','/api/projects/'+encodeURIComponent(pid)+'/revision').then(function(d){
    if(App.project&&App.project.projectId===pid&&App.project.revision===rev&&d.revision!==rev&&!dirty()&&!App.saving)reloadProject(true);
  }).catch(function(e){if(e.status===404){notify('Доступ к проекту закрыт','err');loadProjects().then(pickProject);}});
}
var _pollTimer=null;
function startPolling(){if(_pollTimer)return;_pollTimer=setInterval(poll,Math.max(2,App.config.pollIntervalSec||10)*1000);}

boot();
