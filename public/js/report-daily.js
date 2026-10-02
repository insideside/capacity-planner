// Отчёт о выполнении — раздел «По дням»: показатели в днях, накопленное выполнение против плана,
// выполненные часы по дням и таблица по дням. Использует CPCalc.daily().
var RD={};
var WD=['вс','пн','вт','ср','чт','пт','сб'];
function rdDate(s){return s.slice(8,10)+'.'+s.slice(5,7)+'.'+s.slice(0,4);}
function rdShort(s){return s.slice(8,10)+'.'+s.slice(5,7);}
function rdWd(s){return WD[new Date(s+'T00:00:00Z').getUTCDay()];}
function rdToday(){var d=new Date();return d.getFullYear()+'-'+('0'+(d.getMonth()+1)).slice(-2)+'-'+('0'+d.getDate()).slice(-2);}
// Шкала: «круглый» шаг (1/2/2,5/5 × 10^n), 3–5 делений, максимум — ближайшее кратное шагу.
function niceScale(v){
  if(v<=0)v=10;
  var raw=v/4,e=Math.pow(10,Math.floor(Math.log10(raw))),m=raw/e;
  var step=(m<=1?1:m<=2?2:m<=2.5?2.5:m<=5?5:10)*e;
  return {step:step,max:step*Math.ceil(v/step)};
}
function fmtNum(v){return (v<0?'−':'')+Math.abs(v).toLocaleString('ru');}

// HTML раздела; графики дорисовываются в rdAttach() после вставки в DOM.
function renderDailyHtml(p,phase,allDays){
  var d=CPCalc.daily(p,phase,rdToday());
  RD={d:d,p:p};
  if(!d.totalH)return '';
  var lag=d.lagDays,lagTxt=(lag>0?'+':'')+fmtNum(lag);
  var html='<h2>По дням</h2>'
    +'<div class="kpis">'
    +'<div class="kpi '+(lag>=0?'good':'bad')+'"><div class="v">'+lagTxt+' дн.</div><div class="l">'+(lag>=0?'опережение':'отставание')+' от равномерного плана (раб. дни)</div></div>'
    +'<div class="kpi"><div class="v">'+d.remaining+'</div><div class="l">рабочих дней осталось из '+d.planDays+' (окно '+rdShort(d.window.start)+' — '+rdShort(d.window.end)+')</div></div>'
    +'<div class="kpi"><div class="v">'+(d.needPace==null?'—':d.needPace.toLocaleString('ru'))+'</div><div class="l">ч/день нужно · факт: '+d.pace10.toLocaleString('ru')+' за 10 дн., '+d.pace.toLocaleString('ru')+' в среднем</div></div>'
    +'<div class="kpi '+(d.remH<=0?'good':d.late?'bad':'good')+'"><div class="v">'+(d.forecast?rdShort(d.forecast):'—')+'</div><div class="l">'
      +(d.remH<=0?'всё выполнено':d.forecast?'прогноз завершения'+(d.late?' — позже окна':' — в срок')+(d.forecast.slice(0,4)!==d.window.end.slice(0,4)?' ('+d.forecast.slice(0,4)+')':''):'прогноз: нет выполненных задач с датами')+'</div></div>'
    +'</div>';
  if(d.undated.n)html+='<div class="note">Выполнено без даты: '+d.undated.n+' задач ('+d.undated.h.toLocaleString('ru')+' ч) — учтены с начала окна. Дату можно указать в окне редактирования задачи (двойной клик).</div>';
  html+='<div class="chart-title">Накопленное выполнение, ч — факт против равномерного плана</div>'
    +'<div class="legend"><span><i class="lk lk-fact"></i>Факт</span><span><i class="lk lk-plan"></i>План</span></div>'
    +'<div class="chart" id="chBurn"></div>'
    +'<div class="chart-title">Выполнено за день, ч</div>'
    +'<div class="chart" id="chDaily"></div>';
  // таблица
  var rows=d.days.filter(function(x){return allDays?(x.workday||x.doneN):x.doneN;});
  html+='<table class="days"><thead><tr><th>Дата</th><th>Задач</th><th>Часов</th><th>Накоплено, ч</th><th>Факт</th><th>План</th><th>Откл., ч</th></tr></thead><tbody>'
    +(rows.length?rows.map(function(x){
      var dev=x.cumH-x.planH;
      return '<tr class="'+(x.doneN?'act':'')+'"><td>'+rdDate(x.date)+' <span class="muted">'+rdWd(x.date)+'</span></td>'
        +'<td>'+(x.doneN||'')+'</td><td>'+(x.doneH?x.doneH.toLocaleString('ru'):'')+'</td><td>'+x.cumH.toLocaleString('ru')+'</td>'
        +'<td>'+x.cumPct+'%</td><td>'+(x.inWindow?x.planPct+'%':'—')+'</td>'
        +'<td class="'+(dev<0?'neg':'pos')+'">'+(dev>0?'+':'')+fmtNum(dev)+'</td></tr>'
        +(x.doneN?'<tr class="dtasks"><td colspan="7">'+x.tasks.map(function(t){return escH(t.n)+' <span class="muted">('+t.h+' ч)</span>';}).join(' · ')+'</td></tr>':'');
    }).join(''):'<tr><td colspan="7" class="muted" style="text-align:center">Нет выполненных задач с датами</td></tr>')
    +'</tbody></table>';
  return html;
}

// ── SVG-графики ──
var SVGNS='http://www.w3.org/2000/svg';
function el(tag,attrs,parent){var e=document.createElementNS(SVGNS,tag);for(var k in attrs)e.setAttribute(k,attrs[k]);if(parent)parent.appendChild(e);return e;}
function txt(parent,x,y,s,cls,anchor){var t=el('text',{x:x,y:y,'class':cls||'ax','text-anchor':anchor||'start'},parent);t.textContent=s;return t;}

function rdAttach(){
  var d=RD.d;if(!d||!d.totalH)return;
  burnChart(ge('chBurn'),d);
  dailyChart(ge('chDaily'),d);
}
function frame(host,H){
  var W=Math.max(320,host.clientWidth||700);
  var svg=el('svg',{viewBox:'0 0 '+W+' '+H,width:'100%',height:H,role:'img'},null);
  host.innerHTML='';host.appendChild(svg);
  return {svg:svg,W:W,H:H,L:46,R:W-14,T:10,B:H-24};
}
function xAxis(f,days,xOf){
  var g=el('g',{},f.svg),n=days.length,step=Math.max(1,Math.ceil(n/8)),last=-99;
  days.forEach(function(x,i){
    var first=i===0||days[i-1].date.slice(5,7)!==x.date.slice(5,7);
    if((i%step===0||first)&&i-last>=step*0.6){txt(g,xOf(i),f.B+15,rdShort(x.date),'ax','middle');last=i;}
  });
}
function yAxis(f,sc,fmt){
  var g=el('g',{},f.svg),n=Math.round(sc.max/sc.step);
  for(var k=0;k<=n;k++){
    var v=sc.step*k,y=f.B-(f.B-f.T)*k/n;
    el('line',{x1:f.L,x2:f.R,y1:y,y2:y,'class':k?'grid':'base'},g);
    txt(g,f.L-6,y+3,fmt(v),'ax','end');
  }
}
function tipShow(e,lines){
  var t=ge('chartTip');t.innerHTML='';
  lines.forEach(function(l){var r=document.createElement('div');if(l.key){var k=document.createElement('i');k.className='lk '+l.key;r.appendChild(k);}
    var b=document.createElement('b');b.textContent=l.v;r.appendChild(b);if(l.l){var s=document.createElement('span');s.textContent=' '+l.l;r.appendChild(s);}t.appendChild(r);});
  t.style.display='block';
  var x=e.clientX+14,y=e.clientY+12;if(x+t.offsetWidth>window.innerWidth-8)x=e.clientX-t.offsetWidth-14;
  t.style.left=x+'px';t.style.top=y+'px';
}
function tipHide(){ge('chartTip').style.display='none';}

function burnChart(host,d){
  var days=d.days,n=days.length;if(!n)return;
  var f=frame(host,230),sc=niceScale(d.totalH),max=sc.max;
  var xOf=function(i){return n<2?(f.L+f.R)/2:f.L+(f.R-f.L)*i/(n-1);};
  var yOf=function(v){return f.B-(f.B-f.T)*v/max;};
  yAxis(f,sc,function(v){return v.toLocaleString('ru');});
  // объём релиза
  el('line',{x1:f.L,x2:f.R,y1:yOf(d.totalH),y2:yOf(d.totalH),'class':'scope'},f.svg);
  txt(f.svg,f.L+4,yOf(d.totalH)-4,'объём '+d.totalH.toLocaleString('ru')+' ч','lbl');
  // сегодня и конец окна
  var today=rdToday();
  [[today,'сегодня'],[d.window.end,'конец окна']].forEach(function(m){
    var i=days.findIndex(function(x){return x.date>=m[0];});
    if(i<0||(m[0]===today&&days[days.length-1].date<today))return;
    el('line',{x1:xOf(i),x2:xOf(i),y1:f.T,y2:f.B,'class':'marker'},f.svg);
    txt(f.svg,xOf(i)+(i>n*0.85?-3:3),f.T+9,m[1],'lbl',i>n*0.85?'end':'start');
  });
  // факт — только до сегодняшнего дня
  var factIdx=days.map(function(x,i){return x.date<=today?i:-1;}).filter(function(i){return i>=0;});
  var plan=days.map(function(x,i){return xOf(i)+','+yOf(x.planH);}).join(' ');
  el('polyline',{points:plan,'class':'l-plan'},f.svg);
  if(factIdx.length){
    var pts=factIdx.map(function(i){return xOf(i)+','+yOf(days[i].cumH);});
    el('polygon',{points:xOf(factIdx[0])+','+f.B+' '+pts.join(' ')+' '+xOf(factIdx[factIdx.length-1])+','+f.B,'class':'a-fact'},f.svg);
    el('polyline',{points:pts.join(' '),'class':'l-fact'},f.svg);
    var li=factIdx[factIdx.length-1];
    el('circle',{cx:xOf(li),cy:yOf(days[li].cumH),r:4,'class':'dot-fact'},f.svg);
    txt(f.svg,xOf(li)-6,yOf(days[li].cumH)-8,days[li].cumH.toLocaleString('ru')+' ч ('+days[li].cumPct+'%)','vlbl','end');
  }
  xAxis(f,days,xOf);
  // перекрестие + подсказка
  var cross=el('line',{x1:0,x2:0,y1:f.T,y2:f.B,'class':'cross',visibility:'hidden'},f.svg);
  var hit=el('rect',{x:f.L,y:f.T,width:f.R-f.L,height:f.B-f.T,fill:'transparent'},f.svg);
  hit.addEventListener('pointermove',function(e){
    var r=f.svg.getBoundingClientRect(),x=(e.clientX-r.left)*f.W/r.width;
    var i=Math.max(0,Math.min(n-1,Math.round(n<2?0:(x-f.L)/(f.R-f.L)*(n-1)))),dd=days[i];
    cross.setAttribute('x1',xOf(i));cross.setAttribute('x2',xOf(i));cross.setAttribute('visibility','visible');
    var lines=[{v:rdDate(dd.date)+' ('+rdWd(dd.date)+')'}];
    if(dd.date<=today)lines.push({key:'lk-fact',v:dd.cumH.toLocaleString('ru')+' ч',l:'факт, '+dd.cumPct+'%'});
    lines.push({key:'lk-plan',v:dd.planH.toLocaleString('ru')+' ч',l:'план, '+dd.planPct+'%'});
    if(dd.doneN)lines.push({v:'+'+dd.doneH+' ч',l:'за день ('+dd.doneN+' задач)'});
    tipShow(e,lines);
  });
  hit.addEventListener('pointerleave',function(){cross.setAttribute('visibility','hidden');tipHide();});
}

function dailyChart(host,d){
  var days=d.days,n=days.length;if(!n)return;
  var f=frame(host,150),maxV=0;days.forEach(function(x){if(x.doneH>maxV)maxV=x.doneH;});
  var sc=niceScale(Math.max(maxV,d.needPace||0,1)),max=sc.max;
  var slot=(f.R-f.L)/n,bw=Math.max(1.5,Math.min(24,slot-2));
  var xOf=function(i){return f.L+slot*(i+0.5);};
  var yOf=function(v){return f.B-(f.B-f.T)*v/max;};
  yAxis(f,sc,function(v){return v.toLocaleString('ru');});
  if(d.needPace){
    el('line',{x1:f.L,x2:f.R,y1:yOf(d.needPace),y2:yOf(d.needPace),'class':'l-need'},f.svg);
    txt(f.svg,f.R-2,yOf(d.needPace)-4,'нужно '+d.needPace.toLocaleString('ru')+' ч/день','lbl','end');
  }
  days.forEach(function(x,i){
    var g=el('g',{'class':'bar-g'},f.svg);
    if(x.doneH>0){
      var h=Math.max(1,f.B-yOf(x.doneH)),y=f.B-h,r=Math.min(4,bw/2,h);
      el('path',{d:'M'+(xOf(i)-bw/2)+','+f.B+'V'+(y+r)+'Q'+(xOf(i)-bw/2)+','+y+' '+(xOf(i)-bw/2+r)+','+y+'H'+(xOf(i)+bw/2-r)+'Q'+(xOf(i)+bw/2)+','+y+' '+(xOf(i)+bw/2)+','+(y+r)+'V'+f.B+'Z','class':'bar'},g);
    }
    var hit=el('rect',{x:f.L+slot*i,y:f.T,width:slot,height:f.B-f.T,fill:'transparent'},g);
    hit.addEventListener('pointermove',function(e){tipShow(e,[{v:rdDate(x.date)+' ('+rdWd(x.date)+')'},{key:'lk-fact',v:x.doneH+' ч',l:x.doneN?'выполнено, задач: '+x.doneN:'ничего не выполнено'}]);});
    hit.addEventListener('pointerleave',tipHide);
  });
  xAxis(f,days,xOf);
}
