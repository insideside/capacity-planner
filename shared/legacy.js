// Импорт из однофайлового планировщика (capacity_planner*.html). Общий код для браузера и скриптов.
// Поддерживаются два вида файла:
//  1) сохранённый кнопкой «💾 Сохранить» — данные в window.CP_SAVED_STATE (JSON);
//  2) исходный — данные в коде: IMPORTED_RES, IMPORTED_TASKS, IMPORTED_DATES_<rel>.
// Код из файла НЕ выполняется: литералы данных разбираются как текст и переводятся в JSON.
(function(root,factory){
  if(typeof module==='object'&&module.exports)module.exports=factory();
  else root.CPLegacy=factory();
})(this,function(){
  // Перевод JS-литерала данных ({w:"1",n:'x',s:true,...}) в JSON. Допустимы только строки, числа,
  // true/false/null, объекты и массивы; любое выражение (вызов, переменная) — ошибка.
  function literalToJson(src){
    var out='',i=0,n=src.length;
    function stripTrailingComma(){out=out.replace(/,\s*$/,'');}
    while(i<n){
      var c=src[i];
      if(c==='"'||c==="'"){
        var q=c,s='';i++;
        while(i<n&&src[i]!==q){
          if(src[i]==='\\'){var e=src[i+1];s+=e==="'"?"'":'\\'+e;i+=2;continue;}
          s+=(q==="'"&&src[i]==='"')?'\\"':src[i];i++;
        }
        if(i>=n)throw new Error('незакрытая строка');
        out+='"'+s+'"';i++;continue;
      }
      if(c==='/'&&src[i+1]==='/'){while(i<n&&src[i]!=='\n')i++;continue;}
      if(c==='/'&&src[i+1]==='*'){var end=src.indexOf('*/',i+2);if(end<0)throw new Error('незакрытый комментарий');i=end+2;continue;}
      if(/[A-Za-z_$]/.test(c)){
        var id='';while(i<n&&/[\w$]/.test(src[i]))id+=src[i++];
        var j=i;while(j<n&&/\s/.test(src[j]))j++;
        if(src[j]===':'){out+='"'+id+'"';continue;}
        if(id==='true'||id==='false'||id==='null'){out+=id;continue;}
        if(id==='undefined'){out+='null';continue;}
        throw new Error('выражение «'+id+'» не является данными');
      }
      if(c===']'||c==='}'){stripTrailingComma();out+=c;i++;continue;}
      if(/[\d\-.]/.test(c)){
        var num=/^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i,i+40));
        if(!num)throw new Error('некорректное число');
        out+=String(Number(num[0]));i+=num[0].length;continue;
      }
      if(/[\[{,:\s]/.test(c)){out+=c;i++;continue;}
      throw new Error('неожиданный символ «'+c+'»');
    }
    return out;
  }
  // Текст литерала, присвоенного переменной: var|let|const NAME = {...} / [...]
  function extractLiteral(text,name){
    var m=new RegExp('(?:var|let|const)\\s+'+name+'\\s*=\\s*([\\[{])').exec(text);
    if(!m)return null;
    var start=m.index+m[0].length-1,depth=0,i=start,q=null;
    for(;i<text.length;i++){
      var c=text[i];
      if(q){if(c==='\\'){i++;continue;}if(c===q)q=null;continue;}
      if(c==='"'||c==="'"){q=c;continue;}
      if(c==='/'&&text[i+1]==='/'){i=text.indexOf('\n',i);if(i<0)break;continue;}
      if(c==='['||c==='{')depth++;
      else if(c===']'||c==='}'){depth--;if(depth===0)return text.slice(start,i+1);}
    }
    throw new Error('не найден конец данных '+name);
  }
  function parseVar(text,name){var lit=extractLiteral(text,name);return lit==null?null:JSON.parse(literalToJson(lit));}
  // '322' → '3.2.2' (как называет версии исходный планировщик), иначе — как есть
  function relName(rel){return /^\d{2,4}$/.test(rel)?rel.split('').join('.'):rel;}

  // Возвращает {periods, source} или бросает Error с понятным текстом.
  function parseLegacyHtml(html){
    var saved=/window\.CP_SAVED_STATE=([\s\S]*?);<\/script>/.exec(html);
    if(saved)return {periods:JSON.parse(saved[1]),source:'CP_SAVED_STATE'};
    var tasks=parseVar(html,'IMPORTED_TASKS'),res=parseVar(html,'IMPORTED_RES');
    if(!tasks||!res)throw new Error('В HTML-файле не найдены данные планировщика (ни CP_SAVED_STATE, ни IMPORTED_TASKS/IMPORTED_RES)');
    var rels=[],re=/(?:var|let|const)\s+IMPORTED_DATES_(\w+)\s*=/g,m;
    while((m=re.exec(html)))if(rels.indexOf(m[1])<0)rels.push(m[1]);
    if(!rels.length)throw new Error('В HTML-файле не найдены даты версий (IMPORTED_DATES_…)');
    var periods=rels.map(function(rel,i){
      var dates=parseVar(html,'IMPORTED_DATES_'+rel)||{};
      var chk={};tasks.forEach(function(t){chk[t.w]=!t.s&&t.rel===rel;});
      return {id:'p'+(i+1),name:relName(rel),devStart:dates.devStart||'',devEnd:dates.devEnd||'',tstStart:dates.tstStart||'',tstEnd:dates.tstEnd||'',
        res:JSON.parse(JSON.stringify(res)),tasks:JSON.parse(JSON.stringify(tasks)),chk:chk,
        collapsed:{},filter:null,filterActive:null,folded:false,linkedTo:null,colWidths:{cb:32,h:46,r:98,name:0,del:18},closed:false};
    });
    // две версии из одного мастер-списка связаны, как в исходном планировщике
    if(periods.length===2){periods[0].linkedTo=periods[1].id;periods[1].linkedTo=periods[0].id;}
    return {periods:periods,source:'IMPORTED_*'};
  }
  return {parseLegacyHtml:parseLegacyHtml,literalToJson:literalToJson};
});
