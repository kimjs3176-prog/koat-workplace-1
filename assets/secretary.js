/* ═══════════════════════════════════════════════════════════════════════════
 * 서무비서 — 상황을 말하면 절차 확인 → 할 일·기한 안내 → 서식·초안 준비까지.
 *
 * 절차는 세 층을 합쳐 쓴다(뒤 층이 같은 id 를 덮어씀).
 *   공통: secretary/procedures.json(저장소 기본 탑재)
 *   기관: secretary/org.json(관리자 등록 → 모든 사용자)
 *   개인: localStorage(내 브라우저 — 보충 메모·개인 절차)
 * 처리 이력(진행 중인 건)도 localStorage 에만 저장한다.
 * 단독 페이지(index.html)용 — 원문 보기 패널·모달·토스트도 여기서 다룬다.
 * ═══════════════════════════════════════════════════════════════════════════ */
(function(){
'use strict';

const LS_PERSONAL='koat_sec_personal';   // {procedures:[], notes:{id:text}}
const LS_CASES='koat_sec_cases';         // [{id,procId,title,created,updated,dates,checks,note,drafts,status}]
const LS_SHARE='koat_sec_share';         // 기관 집단 지식에 익명 기여(기본 켜짐) — false 면 보내지 않음
const LS_EDITOR='koat_sec_editor';       // 관리자 이름(기관 저장 시 기록)
const LAYER_LABEL={common:'공통',org:'기관',personal:'개인'};
const EXAMPLES=[
  '출장 다녀와서 정산해야 해요',
  '다음 주에 해외출장 가요',
  '노트북 2대 사야 해요',
  '경조사 휴가 쓰려고요',
  '법인카드로 간담회 식대 결제했어요',
  '서무 업무를 처음 맡았어요',
];

let S={ loaded:false, loading:null, common:{procedures:[],drafts:{}}, org:{procedures:[],drafts:{}}, admin:{},
        view:'home', query:'', formsQ:'', forms:null, kd:null, regs:null,
        cfg:{org:{},service:{},terms:{},reg_aliases:{},holidays:{}}, holidays:{}, status:{}, pstatus:{}, regCount:0, dateNote:'', ai:{available:false}, aiRes:null, calYM:null, rcBusy:0, matches:[], related:null, procId:null, caseId:null, editId:null, editLayer:'personal',
        basisOpen:{}, basisCache:{}, catFilter:'' };
// 브라우저 확장(ERP 옆 사이드 패널) 안에서 열렸는지 — ?embed=ext 이고 다른 창(확장 패널)에 담겨 있을 때
const EMBED=(()=>{ try{ return new URLSearchParams(location.search).get('embed')==='ext' && window.parent!==window; }catch(e){ return false; } })();
function toExt(msg){ if(EMBED) try{ window.parent.postMessage(Object.assign({src:'koat-sec'}, msg), '*'); }catch(e){} }

// ── 저장소 ────────────────────────────────────────────────────────────────
function _ls(k, d){ try{ const v=JSON.parse(localStorage.getItem(k)||'null'); return v==null?d:v; }catch(e){ return d; } }
function _lsPut(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch(e){ toast('브라우저 저장 공간에 쓰지 못했습니다.'); return false; } }
function personal(){ const p=_ls(LS_PERSONAL,{}); p.procedures=Array.isArray(p.procedures)?p.procedures:[]; p.notes=p.notes||{}; return p; }
function savePersonal(p){ _lsPut(LS_PERSONAL,p); }
function cases(){ const c=_ls(LS_CASES,[]); return Array.isArray(c)?c:[]; }
function saveCases(c){ _lsPut(LS_CASES, c.slice(0,300)); if(typeof syncDeadlines==='function') syncDeadlines(); }
let _toastT=null;
function toast(m,ms){ const el=document.getElementById('toast'); if(!el) return; el.textContent=m; el.classList.add('show');
  clearTimeout(_toastT); _toastT=setTimeout(()=>el.classList.remove('show'), ms||2600); }
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=s=>String(s||'').replace(/\s+/g,'').toLowerCase();
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);

// ── 절차 목록(층 병합) ───────────────────────────────────────────────────
function allProcs(){
  const map=new Map();
  const put=(arr,layer)=>(arr||[]).forEach(p=>{ if(!p||!p.id) return;
    const q=layer==='personal'?deepTx(p):p;
    map.set(p.id, Object.assign({}, q, {_layer:layer, _base: map.has(p.id)?map.get(p.id)._layer:null,
      _status: layer==='personal'?(S.pstatus[p.id]||null):(S.status[layer+':'+p.id]||null)})); });
  put(S.common.procedures,'common'); put(S.org.procedures,'org'); put(personal().procedures,'personal');
  return [...map.values()].filter(p=>!p.hidden);
}
function allDrafts(){ return Object.assign({}, S.common.drafts||{}, S.org.drafts||{}); }
function getProc(id){ return allProcs().find(p=>p.id===id)||null; }
function hiddenProcs(){
  const vis=new Set(allProcs().map(p=>p.id)); const out=[];
  [['org',S.org.procedures],['personal',personal().procedures]].forEach(([l,a])=>(a||[]).forEach(p=>{ if(p.hidden&&!vis.has(p.id)) out.push(Object.assign({},p,{_layer:l})); }));
  return out;
}

async function load(force){
  if(S.loaded && !force) return;
  if(S.loading && !force) return S.loading;
  S.loading=(async()=>{
    try{ const r=await fetch('/api/secretary/procedures'+(force?'?fresh=1':'')); const d=await r.json();
      S.cfg=d.config||S.cfg; S.holidays=d.holidays||{}; S.status=d.status||{}; S.regCount=d.regs||0; S.revised=d.revised||[]; S.alio=d.alio||null; S.ai=d.ai||{available:false}; S.insights=d.insights||{available:false}; S.ins={};
      S.common=deepTx(d.common||S.common); S.org=deepTx(d.org||S.org); S.admin=d.admin||{}; S.loaded=true;
      applyBranding(); checkPersonal();
    }catch(e){ S.loaded=false; throw e; }
    finally{ S.loading=null; }
  })();
  return S.loading;
}

// ── 기관 설정: 명칭 치환·브랜드 ─────────────────────────────────────────
// 절차 문장 속 [[erp]] 같은 자리표시를 기관 설정의 명칭으로 바꾼다(다른 기관에서 그대로 쓰기 위함).
function tx(str){ return String(str).replace(/\[\[(\w+)\]\]/g,(m,k)=>{ const t=S.cfg.terms||{}, o=S.cfg.org||{};
  return t[k]||({org:o.name, short:o.short, abbr:o.abbr})[k]||m; }); }
function deepTx(v){ if(typeof v==='string') return tx(v); if(Array.isArray(v)) return v.map(deepTx);
  if(v&&typeof v==='object'){ const o={}; for(const k in v) o[k]=deepTx(v[k]); return o; } return v; }
function shade(hex, f){ const n=parseInt(hex.slice(1),16); let r=n>>16,g=n>>8&255,b=n&255;
  const mix=(c)=>Math.round(f<0?c*(1+f):c+(255-c)*f); return '#'+[mix(r),mix(g),mix(b)].map(x=>x.toString(16).padStart(2,'0')).join(''); }
function applyBranding(){
  const o=S.cfg.org||{}, v=S.cfg.service||{};
  const title=[o.short||o.name, v.title||'서무비서'].filter(Boolean).join(' ');
  document.title=title;
  const set=(id,t)=>{ const el=document.getElementById(id); if(el&&t!=null) el.textContent=t; };
  set('brandT', title); set('brandS', v.tagline); set('brandIc', v.icon||'🗂'); set('footT', title);
  set('footS', [o.name, '서무 업무 지원'].filter(Boolean).join(' ')); set('footN', v.footer);
  if(/^#[0-9a-f]{6}$/i.test(v.primary||'')){ const r=document.documentElement.style;
    r.setProperty('--g', v.primary); r.setProperty('--gd', shade(v.primary,-.15)); r.setProperty('--gl', shade(v.primary,.9)); }
}
// 개인 절차는 서버에 없으므로 호환성 점검을 따로 요청한다(저장하지 않음)
function checkPersonal(){
  const pr=personal().procedures.filter(p=>!p.hidden); if(!pr.length){ S.pstatus={}; return Promise.resolve(); }
  return fetch('/api/secretary/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({procedures:pr})})
    .then(r=>r.json()).then(d=>{ S.pstatus=(d&&d.status)||{}; }).catch(()=>{});
}

// ── 휴일·근무일 ─────────────────────────────────────────────────────────
// 기한이 토·일·공휴일(기본 공휴일 + 기관 휴일)이면 앞 근무일을 함께 안내한다.
function offInfo(d){ if(!d) return ''; if(S.holidays[d]) return S.holidays[d];
  const [y,m,dd]=d.split('-').map(Number); const w=new Date(y,m-1,dd).getDay(); return w===0?'일요일':w===6?'토요일':''; }
function prevWork(d){ let x=d; for(let i=0;i<20;i++){ x=addDays(x,-1); if(!offInfo(x)) return x; } return d; }
function offHtml(due, done){
  const off=offInfo(due); if(!off||done) return '';
  return `<span class="sec-off" title="기한일이 ${esc(off)}입니다">⚠ ${esc(off)} — 앞 근무일 ${esc(fmtDate(prevWork(due)))}까지 처리 권장</span>`;
}

// ── 문장 속 날짜 인식 ───────────────────────────────────────────────────
// "어제 출장 다녀왔어요", "10월 5일부터 7일까지", "다음 주 화요일", "10/5~10/7", "2박 3일" 등.
const WD='일월화수목금토';
const PAST_CUE=/(다녀왔|다녀 왔|다녀와|마쳤|끝났|끝냈|귀국했|복귀했|돌아왔|했어요|했습니다|했는데|했고|썼어요|결제했|받았)/;
function parseDates(q, base){
  base=base||today(); const t=String(q||''); const hits=[];
  const [by]=base.split('-').map(Number);
  const mk=(y,m,d)=>{ if(m<1||m>12||d<1||d>31) return ''; const x=new Date(y,m-1,d); if(x.getMonth()!==m-1) return ''; return ymd(x); };
  const guessYear=(m,d)=>{ let x=mk(by,m,d); if(x && x<addDays(base,-200)) x=mk(by+1,m,d); return x; };
  const add=(pos,len,d)=>{ if(d && !hits.some(h=>pos<h.pos+h.len && h.pos<pos+len)) hits.push({pos,len,d}); };
  let m;
  const R=(re,fn)=>{ re.lastIndex=0; while((m=re.exec(t))) fn(m); };
  R(/(\d{4})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})\s*일?/g, m=>add(m.index,m[0].length,mk(+m[1],+m[2],+m[3])));
  R(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g, m=>add(m.index,m[0].length,guessYear(+m[1],+m[2])));
  R(/(?<![\d.])(\d{1,2})\s*[\/.]\s*(\d{1,2})(?![\d.]|\s*(?:%|퍼센트|배))/g, m=>add(m.index,m[0].length,guessYear(+m[1],+m[2])));
  const REL={'그저께':-2,'그제':-2,'어제':-1,'오늘':0,'내일':1,'모레':2,'글피':3};
  R(/그저께|그제|어제|오늘|내일|모레|글피/g, m=>add(m.index,m[0].length,addDays(base,REL[m[0]])));
  R(/(이번|다음|담|지난|저번)\s*주\s*([일월화수목금토])요일?/g, m=>{
    const [y,mo,d]=base.split('-').map(Number); const bw=new Date(y,mo-1,d).getDay(); const mon=addDays(base, -((bw+6)%7));
    const wk={이번:0,다음:7,담:7,지난:-7,저번:-7}[m[1]]; const off=(WD.indexOf(m[2])+6)%7; add(m.index,m[0].length,addDays(mon,wk+off)); });
  R(/(\d{1,3})\s*일\s*(후|뒤|전)/g, m=>add(m.index,m[0].length,addDays(base,(m[2]==='전'?-1:1)*(+m[1]))));
  hits.sort((a,b)=>a.pos-b.pos);
  // "10월 5일부터 7일까지" — 앞 날짜의 달을 이어받는 일(日)만 있는 표현
  if(hits.length){ R(/(?<![\d월\/.])(\d{1,2})\s*일\s*(까지|~|에|부터)?/g, m=>{
      if(!m[2] && !/[~\-–]\s*$/.test(t.slice(Math.max(0,m.index-3),m.index))) return;   // "14일 이내" 같은 기간은 제외
      const prev=[...hits].reverse().find(h=>h.pos<m.index); if(!prev) return;
      const [y,mo]=prev.d.split('-').map(Number); let d=mk(y,mo,+m[1]); if(d && d<prev.d) d=mk(mo===12?y+1:y, mo===12?1:mo+1, +m[1]);
      add(m.index,m[0].length,d); }); hits.sort((a,b)=>a.pos-b.pos); }
  const out=hits.map(h=>h.d);
  const nb=t.match(/(\d{1,2})\s*박\s*(\d{1,2})?\s*일?/);       // 2박3일 → 마친 날 = 시작 + 2
  if(nb && out.length===1) out.push(addDays(out[0], +nb[1]));
  return {dates:[...new Set(out)].slice(0,3), past:PAST_CUE.test(t), from:/부터/.test(t)};
}
function assignDates(p, q){
  const pd=(p.dates||[]).map(d=>d.k); if(!pd.length) return null;
  const r=parseDates(q); if(!r.dates.length) return null;
  const out={};
  if(r.dates.length>=2){ out[pd[0]]=r.dates[0]; if(pd[1]) out[pd[1]]=r.dates[r.dates.length-1]; }
  else if(pd.length===1) out[pd[0]]=r.dates[0];
  else if(r.past && !r.from && pd.includes('end')) out.end=r.dates[0];
  else out[pd[0]]=r.dates[0];
  return out;
}

// ── 상황 → 절차 매칭 ─────────────────────────────────────────────────────
// 트리거 단어가 문장에 들어 있으면 그 길이만큼 점수(긴 표현일수록 구체적).
// 국외 표현이 있으면 국내출장은 빼고, 제목 단어도 약하게 반영한다.
const OVERSEAS=/해외|국외|출국|귀국|비자|여권/;
function match(q){
  const qn=norm(q); if(!qn) return [];
  const out=[];
  for(const p of allProcs()){
    let sc=0; const hit=[];
    for(const t of (p.triggers||[])){ const tn=norm(t); if(tn.length>=2 && qn.includes(tn)){ sc+=tn.length; hit.push(t); } }
    for(const w of String(p.title||'').split(/[\s—·,()]+/)){ const wn=norm(w); if(wn.length>=2 && qn.includes(wn) && !hit.includes(w)) sc+=1; }
    if(p.id==='domestic-trip' && OVERSEAS.test(q)) sc=Math.min(sc,1);
    if(p.id==='overseas-trip' && OVERSEAS.test(q)) sc+=4;
    if(sc>0) out.push({p, sc, hit});
  }
  out.sort((a,b)=>b.sc-a.sc);
  return out;
}

// ── 날짜·기한 ────────────────────────────────────────────────────────────
function today(){ const d=new Date(); return ymd(d); }
function ymd(d){ return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
function addDays(s, n){ const [y,m,d]=String(s).split('-').map(Number); if(!y) return ''; const t=new Date(y,m-1,d); t.setDate(t.getDate()+n); return ymd(t); }
function dday(s){ if(!s) return null; const [y,m,d]=s.split('-').map(Number); const a=new Date(y,m-1,d), b=new Date(); b.setHours(0,0,0,0);
  const n=Math.round((a-b)/86400000); return {n, label:n===0?'D-day':(n>0?'D-'+n:'D+'+(-n)), cls:n<0?'over':(n<=3?'soon':'ok')}; }
function fmtDate(s){ if(!s) return ''; const [y,m,d]=s.split('-').map(Number); const w='일월화수목금토'[new Date(y,m-1,d).getDay()]; return `${m}. ${d}.(${w})`; }
function stepDue(step, dates){
  const dl=step.deadline; if(!dl) return '';
  const base=(dates||{})[dl.ref]; if(!base) return '';
  return addDays(base, Number(dl.days)||0);
}
function deadlineText(step){
  const dl=step.deadline; if(!dl) return step.when||'';
  return dl.label || step.when || '';
}

// ── 처리 이력(건) ────────────────────────────────────────────────────────
function curCase(){ return S.caseId ? cases().find(c=>c.id===S.caseId)||null : null; }
function ensureCase(){
  let c=curCase(); if(c) return c;
  const p=getProc(S.procId); if(!p) return null;
  c={id:uid(), procId:p.id, title:p.title, created:today(), updated:Date.now(), query:S.query||'', dates:{}, checks:{}, note:'', drafts:{}, status:'open'};
  const all=cases(); all.unshift(c); saveCases(all); S.caseId=c.id; return c;
}
function updateCase(fn){
  const all=cases(); const i=all.findIndex(c=>c.id===S.caseId); if(i<0) return null;
  fn(all[i]); all[i].updated=Date.now(); saveCases(all); return all[i];
}
function caseProgress(c, p){
  const steps=(p&&p.steps)||[]; const req=steps.map((s,i)=>i).filter(i=>!steps[i].optional);
  const done=req.filter(i=>c.checks&&c.checks[i]).length;
  return {done, total:req.length, pct:req.length?Math.round(done/req.length*100):0};
}
function nextStep(c, p){
  const steps=(p&&p.steps)||[];
  for(let i=0;i<steps.length;i++){ if(steps[i].optional || (c.checks&&c.checks[i])) continue; return {i, s:steps[i], due:stepDue(steps[i], c.dates)}; }
  return null;
}
function openCasesWithNext(){
  return cases().filter(c=>c.status!=='done').map(c=>{ const p=getProc(c.procId); return {c,p,next:p?nextStep(c,p):null}; })
    .filter(x=>x.p);
}

// ── 화면 진입 ────────────────────────────────────────────────────────────
async function start(opts){
  opts=opts||{};
  const w=document.getElementById('secWrap'); if(!w) return;
  if(EMBED){ document.body.classList.add('embed');
    // 확장 → 앱: ERP 화면에서 감지한 업무로 바로 안내(패널을 다시 읽지 않아 진행 상태가 유지됨)
    window.addEventListener('message', e=>{ const m=e.data; if(e.source!==window.parent || !m || m.src!=='koat-sec-ext') return;
      if(m.type==='ask' && m.q){ S.view='home'; ask(String(m.q).slice(0,200)); }
      else if(m.type==='hello'){ S.extVersion=String(m.version||''); checkExtUpdate(); }
      else if(m.type==='inserted'){
        if(m.ok && m.mapped){ const d=allDrafts()[(S._draft||{}).key]||{}; const lb=k=>k==='_title'?'제목':k==='_body'?'본문':(((d.fields||[]).find(f=>f.k===k)||{}).l||k);
          toast(`ERP '${m.screen||'화면'}'의 ${m.filled.length}칸을 채웠습니다(${m.filled.map(lb).join(', ')}).${(m.missing||[]).length?' 못 찾은 칸: '+m.missing.map(lb).join(', '):''} 내용을 확인하세요.`, 6000); return; }
        if(m.ok){ toast('ERP 입력란에 넣었습니다. 내용을 확인하세요.'+(m.mappedButMissed?' (연결해 둔 칸을 이 화면에서 찾지 못해 마지막으로 누른 칸에 넣었습니다)':''), 4200); return; }
        // 넣을 칸을 못 찾으면 클립보드로 — ERP에서 Ctrl+V
        const t=S._lastInsert||''; const done=()=>toast((m.error?m.error+' ':'ERP에서 넣을 칸을 찾지 못했습니다. ')+'초안을 복사해 두었으니 ERP 입력란에 붙여넣기(Ctrl+V) 하세요.', 5200);
        (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(done).catch(()=>toast(m.error||'ERP 입력란을 먼저 한 번 누른 뒤 다시 시도하세요.', 4200)); }
    });
  }
  bind(w); bindViewer(); loadFormsStatus();
  try{ await load(); }
  catch(e){ w.innerHTML=`<div class="sec-empty">절차 목록을 불러오지 못했습니다. <button class="sec-btn" data-a="retry">다시 시도</button></div>`; return; }
  // 절차 목록을 다 받은 뒤에 '준비됨'을 알린다 — 그 전에 온 '이 업무 안내' 요청이 빈 목록에서 헛돌지 않게
  if(EMBED) toExt({type:'ready'});
  syncDeadlines();
  if(opts.reg) openReg(opts.reg);
  if(opts.q){ ask(opts.q); return; }
  if(opts.view && ['list','history','forms','manage','cal','ext'].includes(opts.view)) S.view=opts.view;
  render();
}

function ask(q){
  q=String(q||'').trim(); S.query=q;
  if(!q){ S.view='home'; render(); return; }
  S.matches=match(q); S.related=null; S.basisOpen={}; S.aiRes=null;
  const lp=localPlan(q, S.matches);
  if(lp) S.aiRes={q, ids:lp, local:true, summary:'여러 업무가 함께 있는 상황으로 보고 필요한 절차를 순서대로 모았습니다.'};
  else setTimeout(()=>aiUnderstand(q), 0);
  if(S.matches.length){
    const p=S.matches[0].p; const ds=assignDates(p, q); S.dateNote='';
    if(ds){ const ex=cases().find(x=>x.procId===p.id && x.status!=='done');
      const c=(ex && !Object.keys(ex.dates||{}).length)?ex:null;    // 기준일이 비어 있는 진행 건이면 이어서, 아니면 새 건
      S.procId=p.id; S.caseId=c?c.id:null; ensureCase(); updateCase(x=>{ x.dates=Object.assign({}, x.dates||{}, ds); });
      S.dateNote=(p.dates||[]).filter(d=>ds[d.k]).map(d=>`${d.l} ${fmtDate(ds[d.k])}`).join(' · ');
      selectProc(p.id, {keepQuery:true, caseId:S.caseId, keepNote:true}); return; }
    selectProc(p.id, {keepQuery:true}); return; }
  S.procId=null; S.caseId=null; S.view='nomatch'; render();
  fetch('/api/secretary/related?q='+encodeURIComponent(q)).then(r=>r.json()).then(d=>{ S.related=(d&&d.items)||[]; if(S.view==='nomatch') render(); })
    .catch(()=>{ S.related=[]; if(S.view==='nomatch') render(); });
}
function selectProc(id, o){
  o=o||{}; if(!o.keepNote) S.dateNote=''; S.procId=id; S.view='proc'; S.basisOpen={};
  if(!o.keepQuery){ S.matches=[]; }
  // 같은 절차의 진행 중인 건이 있으면 이어서, 없으면 새 건(첫 입력 시 저장)
  if(o.caseId) S.caseId=o.caseId;
  else { const c=cases().find(x=>x.procId===id && x.status!=='done'); S.caseId=c?c.id:null; }
  render();
  const w=document.getElementById('secWrap'); if(w&&o.scroll!==false) w.scrollIntoView({behavior:'smooth',block:'start'});
}

// ── 렌더 ─────────────────────────────────────────────────────────────────
function render(){
  const w=document.getElementById('secWrap'); if(!w) return;
  const tabs=[['home','🏠 안내'],...(EMBED?[]:[['ext',extInstalled()?'🧩 확장':'🧩 확장 설치']]),['cal','📅 업무 달력'],['list','📚 절차 목록'],['forms','📎 서식·규정'],['history','🕘 처리 이력'],['manage','⚙ 규정·절차 관리']];
  const active=(S.view==='proc'||S.view==='nomatch')?'home':(S.view==='edit'?'manage':S.view);
  const openN=cases().filter(c=>c.status!=='done').length;
  const nav=`<div class="sec-tabs" role="tablist">`+tabs.map(([k,l])=>`<button class="sec-tab${active===k?' on':''}" role="tab" aria-selected="${active===k}" data-a="view" data-v="${k}">${l}${k==='history'&&openN?` <span class="sec-cnt">${openN}</span>`:''}</button>`).join('')+`</div>`;
  const ask=`<form class="sec-ask" data-a="askform"><span class="sec-ask-ic" aria-hidden="true">💬</span>`+
    `<input id="secQ" class="sec-q" autocomplete="off" placeholder="무슨 일인가요? 예) 출장 다녀와서 정산해야 해요" value="${esc(S.query)}" aria-label="상황 입력">`+
    `<button class="sec-ask-btn" type="submit">안내받기</button></form>`;
  let body='';
  if(S.view==='home') body=homeView();
  else if(S.view==='proc') body=procView();
  else if(S.view==='nomatch') body=noMatchView();
  else if(S.view==='list') body=listView();
  else if(S.view==='history') body=historyView();
  else if(S.view==='forms') body=formsView();
  else if(S.view==='cal') body=calView();
  else if(S.view==='manage') body=manageView();
  else if(S.view==='edit') body=editView();
  else if(S.view==='ext') body=extView();
  w.innerHTML=ask+nav+`<div class="sec-body">${body}</div>`;
  if(S.view==='proc') loadOpenBasis();
  if(S.view==='forms') loadForms();
}

function homeView(){
  const ex=`<div class="sec-ex"><span class="sec-ex-l">이렇게 말해 보세요</span>`+EXAMPLES.map(e=>`<button class="sec-chip" data-a="ask" data-q="${esc(e)}">${esc(e)}</button>`).join('')+`</div>`;
  const open=openCasesWithNext().sort((a,b)=>{ const da=a.next&&a.next.due||'9999', db=b.next&&b.next.due||'9999'; return da<db?-1:da>db?1:b.c.updated-a.c.updated; });
  const todo=open.length?`<div class="sec-card"><div class="sec-card-h">⏰ 다음 할 일 <span class="sec-sub">진행 중인 ${open.length}건 · 기한 가까운 순</span></div><div class="sec-next-list">`+
    open.slice(0,6).map(({c,p,next})=>{ const pr=caseProgress(c,p); const dd=next&&next.due?dday(next.due):null;
      return `<button class="sec-next" data-a="case" data-id="${esc(c.id)}"><span class="sec-next-ic">${esc(p.icon||'📌')}</span>`+
        `<span class="sec-next-m"><span class="sec-next-t">${esc(c.title)}</span>`+
        `<span class="sec-next-s">${next?esc(next.s.t):'필수 단계를 모두 마쳤어요 — 완료 처리하세요'}</span></span>`+
        `${dd?`<span class="sec-dd ${dd.cls}" title="${esc(next.due)}">${dd.label}</span>`:''}<span class="sec-pct">${pr.done}/${pr.total}</span></button>`; }).join('')+`</div></div>`:'';
  const cats=catGroups();
  const grid=`<div class="sec-card"><div class="sec-card-h">📚 업무별 절차 <span class="sec-sub">눌러서 바로 보기</span></div><div class="sec-cat-grid">`+
    cats.map(([cat,ps])=>`<div class="sec-cat"><div class="sec-cat-h">${esc(cat)}</div>`+ps.map(p=>`<button class="sec-proc-l" data-a="proc" data-id="${esc(p.id)}"><span>${esc(p.icon||'📌')}</span><span>${esc(shortTitle(p.title))}</span>${p._layer!=='common'?`<span class="sec-layer ${p._layer}">${LAYER_LABEL[p._layer]}</span>`:''}</button>`).join('')+`</div>`).join('')+
    `</div></div>`;
  const how=`<div class="sec-how"><b>서무비서는 이렇게 돕습니다</b> — ① 상황을 말하면 해당 절차를 찾고 ② 기준일을 넣으면 단계별 기한을 계산해 다음 할 일을 짚어 주며 ③ 단계마다 필요한 서식(원본)과 근거 조문, 문서 초안을 바로 꺼내 줍니다. 진행 상황은 <b>처리 이력</b>에 남아 담당자가 바뀌어도 이어갈 수 있어요.</div>`;
  return extHero()+ex+todo+grid+how;
}
// ── 확장이 메인: 웹 화면은 설치 안내·보조 ─────────────────────────────────
// 확장이 설치되어 있으면 서무비서 웹 화면에 data-sec-ext(버전)를 달아 준다(확장의 marker.js).
function extInstalled(){ return document.documentElement.getAttribute('data-sec-ext')||''; }
function extHero(){
  if(EMBED) return '';
  const v=extInstalled();
  if(v) return `<div class="sec-ext-ok"><span>🧩 <b>서무비서 확장 ${esc(v)}</b>이 설치되어 있습니다 — ERP 화면에서 <b>🗂</b>(또는 <b>Alt+Shift+S</b>)로 여세요. 상신 전 점검·기한 알림도 확장이 맡습니다.</span>`+
    `<button class="sec-btn sm" data-a="extpanel">이 탭 옆에 패널 열기</button></div>`;
  if(_ls('koat_sec_herox',0)>Date.now()) return '';
  const b=browserKind();
  return `<div class="sec-ext-cta"><div class="sec-ext-cta-m"><div class="sec-ext-cta-t">🧩 서무비서는 <b>ERP 옆에서</b> 쓰는 브라우저 확장이 기본입니다</div>`+
    `<ul><li>ERP 화면을 열면 그 업무의 <b>절차·기한·반려 점검</b>을 옆 패널에 바로</li><li>만든 초안을 ERP의 <b>여러 칸에 한 번에</b> 입력</li><li><b>상신 버튼</b>을 누르면 반려 점검 항목을 먼저 확인</li><li>도구 모음 아이콘에 <b>다가오는 기한</b>, 당일 바탕화면 알림</li></ul></div>`+
    `<div class="sec-ext-cta-a">${b==='other'?`<span class="sec-sub">Chrome·Edge에서 설치할 수 있습니다</span>`:`<button class="sec-btn primary" data-a="view" data-v="ext">🧩 확장 설치하기</button>`}`+
    `<button class="sec-linkbtn" data-a="herox">웹에서 계속 쓰기</button></div></div>`;
}
// 처리 중인 건의 다가오는 기한 → 확장(아이콘 배지·바탕화면 알림). 패널 안이면 패널로, 일반 탭이면 marker.js 로.
let _dlTimer=null, _dlLast='';
function syncDeadlines(){
  if(!EMBED && !extInstalled()) return;
  clearTimeout(_dlTimer);
  _dlTimer=setTimeout(()=>{
    const lo=addDays(today(),-60), hi=addDays(today(),60);
    const items=allDeadlines().filter(d=>d.date>=lo && d.date<=hi).slice(0,200)
      .map(d=>({date:d.date, proc:d.proc, step:String(d.step||'').slice(0,80), caseId:d.caseId, i:d.i, optional:d.optional}));
    const key=JSON.stringify(items); if(key===_dlLast) return; _dlLast=key;
    if(EMBED) toExt({type:'deadlines', items});
    else window.postMessage({src:'koat-sec', type:'deadlines', items}, location.origin);
  }, 400);
}
function shortTitle(t){ return String(t||'').split(' — ')[0]; }
function catGroups(){
  const m=new Map(); allProcs().forEach(p=>{ const c=p.category||'기타'; if(!m.has(c)) m.set(c,[]); m.get(c).push(p); });
  const order=['출장','복무','물품','행사','회계','문서'];
  return [...m.entries()].sort((a,b)=>{ const ia=order.indexOf(a[0]), ib=order.indexOf(b[0]); return (ia<0?99:ia)-(ib<0?99:ib); });
}

function procView(){
  const p=getProc(S.procId); if(!p) return `<div class="sec-empty">절차를 찾을 수 없습니다.</div>`;
  const c=curCase(); const dates=(c&&c.dates)||{}; const checks=(c&&c.checks)||{};
  const pnote=personal().notes[p.id]||'';
  const planShown=S.aiRes && S.aiRes.q===S.query && (S.aiRes.ids||[]).length>1;   // 복합 안내가 있으면 후보 칩은 생략
  const alt=planShown?[]:S.matches.filter(m=>m.p.id!==p.id && m.hit.length).slice(0,4);   // 제목 단어만 겹친 약한 후보는 제외
  const altHtml=alt.length?`<div class="sec-alt">혹시 이 절차인가요? `+alt.map(m=>`<button class="sec-chip sm" data-a="proc" data-id="${esc(m.p.id)}" data-keep="1">${esc(m.p.icon||'')} ${esc(shortTitle(m.p.title))}</button>`).join('')+`</div>`:'';
  const pr=c?caseProgress(c,p):{done:0,total:(p.steps||[]).filter(s=>!s.optional).length,pct:0};
  const nx=c?nextStep(c,p):(p.steps&&p.steps.length?{i:0,s:p.steps[0],due:''}:null);
  const head=`<div class="sec-proc-h"><span class="sec-proc-ic">${esc(p.icon||'📌')}</span><div class="sec-proc-tt">`+
    `<div class="sec-proc-t">${esc(p.title)} <span class="sec-layer ${p._layer}">${LAYER_LABEL[p._layer]}${p._base?' 보충':''}</span></div>`+
    `<div class="sec-proc-s">${esc(p.summary||'')}</div></div></div>`;
  const dateIn=(p.dates&&p.dates.length)?`<div class="sec-dates"><span class="sec-dates-l">📅 기준일을 넣으면 기한을 계산해요</span>`+
    p.dates.map(d=>`<label class="sec-date"><span>${esc(d.l)}</span><input type="date" value="${esc(dates[d.k]||'')}" data-a="date" data-k="${esc(d.k)}"></label>`).join('')+`</div>`:'';
  let nextBox='';
  if(nx){ const dd=nx.due?dday(nx.due):null;
    nextBox=`<div class="sec-nextbox"><span class="sec-nextbox-l">다음 할 일</span><span class="sec-nextbox-t">${nx.i+1}. ${esc(nx.s.t)}</span>`+
      (nx.due?`<span class="sec-dd ${dd.cls}">${esc(fmtDate(nx.due))} · ${dd.label}</span>${offHtml(nx.due)}`:(nx.s.when?`<span class="sec-when">${esc(deadlineText(nx.s))}</span>`:''))+`</div>`;
  } else if(c){ nextBox=`<div class="sec-nextbox done"><span class="sec-nextbox-l">완료</span><span class="sec-nextbox-t">필수 단계를 모두 마쳤습니다.</span>${c.status!=='done'?`<button class="sec-btn primary sm" data-a="casedone">완료 처리</button>`:''}</div>`; }
  const steps=(p.steps||[]).map((s,i)=>stepHtml(p,s,i,checks,dates)).join('');
  const notes=procNotices(p, c);
  const pitHtml=pitfallsHtml(p, c);
  const forms=allForms(p);
  const formsHtml=forms.length?`<div class="sec-card"><div class="sec-card-h">📎 필요한 서식 <span class="sec-sub">원본 서식을 그대로 엽니다</span></div><div class="sec-forms">`+
    forms.map(f=>`<button class="sec-form" data-a="form" data-reg="${esc(f.reg)}" data-label="${esc(f.label)}"><span class="sec-form-t">${esc(f.title||f.label)}</span><span class="sec-form-s">${esc(f.reg)} ${esc(f.label)}</span></button>`).join('')+`</div></div>`:'';
  const tips=(p.tips&&p.tips.length)?`<div class="sec-card"><div class="sec-card-h">💡 알아 두면 좋은 점</div><ul class="sec-tips">`+p.tips.map(t=>`<li>${esc(t)}</li>`).join('')+`</ul></div>`:'';
  const approval=p.approval?`<div class="sec-approval"><span class="sec-approval-l">결재선</span><span>${esc(p.approval)}</span></div>`:'';
  const noteHtml=`<div class="sec-card"><div class="sec-card-h">📝 개인 보충 <span class="sec-sub">우리 부서 실제 결재선·담당자·팁 — 내 브라우저에 저장되고 이 절차를 열 때마다 함께 보여요</span></div>`+
    `<textarea class="sec-note" data-a="pnote" rows="3" placeholder="예) 결재선: 팀장 전결 / 정산 담당: 운영지원실 김○○(내선 1234)">${esc(pnote)}</textarea></div>`;
  const caseBar=`<div class="sec-casebar">`+
    (c?`<span class="sec-case-st">🕘 처리 이력 저장 중 · ${pr.done}/${pr.total} 단계${c.status==='done'?' · 완료':''}</span>`:`<span class="sec-case-st muted">단계를 체크하거나 기준일을 넣으면 처리 이력에 자동 저장됩니다</span>`)+
    `<span class="sec-prog"><i style="width:${pr.pct}%"></i></span>`+
    `<span class="sec-casebar-acts">`+
      (p.steps.some(s=>s.deadline)?`<button class="sec-btn sm" data-a="tocal" title="계산된 기한을 캘린더 파일(.ics)로 받아 Outlook·구글 캘린더 등에 넣습니다">📅 기한 캘린더(.ics)</button>`:'')+
      (c?`<button class="sec-btn sm ghost" data-a="newcase" title="같은 절차를 새 건으로 시작">＋ 새 건</button>`:'')+
      (c&&c.status!=='done'?`<button class="sec-btn sm ghost" data-a="casedone">완료</button>`:'')+
    `</span></div>`;
  const caseNote=c?`<div class="sec-card"><div class="sec-card-h">🗒 이 건 메모 <span class="sec-sub">처리 이력에 함께 남습니다(인계 때 유용)</span></div><textarea class="sec-note" data-a="cnote" rows="2" placeholder="예) 10/2 세종 출장, KTX 왕복 법인카드 결제">${esc(c.note||'')}</textarea></div>`:'';
  return aiBox()+altHtml+`<div class="sec-proc">`+head+notes+approval+dateIn+nextBox+caseBar+
    `<div class="sec-layout"><div class="sec-main"><div class="sec-card"><div class="sec-card-h">🔀 단계별 절차 <span class="sec-sub">선택 단계는 해당할 때만</span></div><div class="sec-steps">${steps}</div></div>${receiptHtml(p, c)}${pitHtml}${auditHtml(p, c)}${caseNote}</div>`+
    `<aside class="sec-side">${insightHtml(p)}${formsHtml}${tips}${noteHtml}</aside></div></div>`;
}

// 절차 상단 알림 — 문장에서 읽은 날짜, 근거 규정 개정, 우리 기관 규정에 연결 안 된 근거·서식, 기한 경과
function procNotices(p, c){
  const out=[]; const st=p._status;
  if(S.dateNote){ const rc=/^영수증 날짜로 /.test(S.dateNote);
    out.push(`<div class="sec-notice info">${rc?'🧾 영수증 날짜로':'🗓 문장에서 날짜를 읽어'} 기준일을 넣었어요 — <b>${esc(S.dateNote.replace(/^영수증 날짜로 /,''))}</b>. 다르면 아래에서 고쳐 주세요.</div>`); }
  if(st && st.stale && st.stale.length) out.push(`<div class="sec-notice warn">⚠ <b>근거 규정이 개정되었습니다</b> — `+
    st.stale.map(x=>`${esc(x.reg)}(확인 당시 ${esc(x.verified)} → 현재 ${esc(x.current)})`).join(', ')+
    `. 이 절차가 지금도 맞는지 원문과 다시 확인하세요.${p._layer!=='personal'?' 관리자는 확인 후 기관 층으로 다시 저장하면 이 알림이 사라집니다.':''}`+
    st.stale.filter(x=>revisedOf(x.reg)).slice(0,2).map(x=>` <button class="sec-linkbtn" data-a="impact" data-reg="${esc(x.reg)}">🔬 ${esc(x.reg)} — 무엇이 바뀌었나</button>`).join('')+`</div>`);
  if(st && st.unverified && st.unverified.length && !(st.missing||[]).length) out.push(`<div class="sec-notice info">ℹ 이 절차는 다른 규정(${esc(st.unverified.map(x=>x.verified_title).join(', '))}) 기준으로 확인되었습니다. 우리 기관 규정(${esc(st.unverified.map(x=>x.matched).join(', '))}) 원문과 대조해 주세요.${p._layer!=='personal'?' 관리자가 확인 후 기관 층으로 저장하면 이 안내가 사라집니다.':''}</div>`);
  if(st && st.missing && st.missing.length) out.push(`<div class="sec-notice warn">🔗 근거·서식 <b>${st.missing.length}건</b>이 우리 기관 규정에 연결되지 않았습니다 (`+
    st.missing.slice(0,3).map(x=>esc(x.reg+(x.art?` 제${x.art}조`:'')+(x.label?' '+x.label:''))).join(', ')+(st.missing.length>3?' 등':'')+
    `). 관리자: <button class="sec-linkbtn" data-a="view" data-v="manage">규정·절차 관리 › 규정명 매핑</button></div>`);
  if(c && c.status!=='done'){ const over=(p.steps||[]).filter((s,i)=>!s.optional && !(c.checks||{})[i] && stepDue(s,c.dates) && stepDue(s,c.dates)<today());
    if(over.length) out.push(`<div class="sec-notice over">⏰ 기한이 지난 단계가 <b>${over.length}건</b> 있습니다 — 지금 처리할 수 있는지 담당 부서에 먼저 확인하세요.</div>`); }
  return out.join('');
}
// 제출 전 반려 점검 — 규정에서 뽑은 점검 항목 + 우리 부서가 실제로 겪은 반려 기록
function rejects(pid){ return (personal().rejects||{})[pid]||[]; }
function pitfallsHtml(p, c){
  const pits=p.pitfalls||[]; const rj=rejects(p.id); const pc=(c&&c.pchecks)||{};
  if(!pits.length && !rj.length) return `<div class="sec-card"><div class="sec-card-h">🚫 제출 전 반려 점검</div>`+
    `<div class="sec-hint">아직 점검 항목이 없습니다. 반려를 겪었다면 기록해 두세요 — 다음 처리 때 점검 항목으로 보여 드립니다.</div>`+
    `<button class="sec-btn sm" data-a="rjadd">＋ 반려 사례 기록</button></div>`;
  const mine=new Set([...pits.map(x=>norm(x.t)), ...rj.map(x=>norm(x.t))]);
  const shared=((S.ins[p.id]||{}).reasons||[]).filter(x=>x.c>=2 && !mine.has(norm(x.t))).slice(0,3);
  const all=[...pits.map((x,i)=>({k:'p'+i, t:x.t, basis:x.basis||[]})), ...rj.map((x,i)=>({k:'r'+x.id, t:x.t, rj:x})), ...shared.map(x=>({k:'s'+auditSig(x.t), t:x.t, sh:x}))];
  const left=all.filter(x=>!pc[x.k]).length;
  return `<div class="sec-card sec-pit"><div class="sec-card-h">🚫 제출 전 반려 점검 <span class="sec-sub">${left?`남은 항목 ${left}개 — 결재 올리기 전에 확인하세요`:'모두 확인했어요'}</span></div>`+
    `<div class="sec-pit-list">`+all.map(x=>`<div class="sec-pit-i${pc[x.k]?' done':''}${x.rj?' rj':''}">`+
      `<button class="sec-pchk" data-a="pcheck" data-k="${esc(x.k)}" aria-pressed="${!!pc[x.k]}" aria-label="점검 ${pc[x.k]?'취소':'완료'}">${pc[x.k]?'✓':''}</button>`+
      `<span class="sec-pit-t">${esc(x.t)}${x.rj?` <span class="sec-layer personal" title="${esc(x.rj.date||'')}">우리 부서 반려 기록</span>`:''}${x.sh?` <span class="sec-layer org" title="다른 담당자들이 공유한 반려 사유">👥 기관에서 ${x.sh.c}회 반려</span>`:''}</span>`+
      (x.basis||[]).map(b=>`<button class="sec-mini" data-a="openreg" data-reg="${esc(b.reg)}" data-art="${esc(b.art||'')}" data-q="${esc(b.q||'')}">📖 ${esc(basisLabel(b))}</button>`).join('')+
      (x.rj?`<button class="sec-x" data-a="rjdel" data-id="${esc(x.rj.id)}" aria-label="반려 기록 삭제">✕</button>`:'')+`</div>`).join('')+`</div>`+
    `<div class="sec-row"><button class="sec-btn sm" data-a="rjadd">＋ 반려 사례 기록</button><span class="sec-sub">반려 사유를 적어 두면 다음 처리 때 점검 항목에 함께 나옵니다(내 브라우저 저장). 관리자는 절차 수정에서 기관 점검 항목으로 올릴 수 있어요.</span></div></div>`;
}
function allForms(p){
  const out=[], seen=new Set();
  const add=f=>{ if(!f||!f.reg||!f.label) return; const k=norm(f.reg)+'|'+norm(f.label); if(seen.has(k)) return; seen.add(k); out.push(f); };
  (p.forms||[]).forEach(add); (p.steps||[]).forEach(s=>add(s.form));
  return out;
}

function stepHtml(p, s, i, checks, dates){
  const done=!!checks[i]; const due=stepDue(s,dates); const dd=due?dday(due):null;
  const when=due?`<span class="sec-dd ${done?'ok':dd.cls}" title="${esc(deadlineText(s))}">${esc(fmtDate(due))}${done?'':' · '+dd.label}</span>`
    :(s.when||s.deadline?`<span class="sec-when">${esc(deadlineText(s))}</span>`:'');
  const off=due?offHtml(due, done):'';
  const docs=(s.docs&&s.docs.length)?`<div class="sec-docs">`+s.docs.map(d=>`<span class="sec-doc">${esc(d)}</span>`).join('')+`</div>`:'';
  const acts=[];
  (s.basis||[]).forEach((b,bi)=>acts.push(`<button class="sec-mini${S.basisOpen[i+':'+bi]?' on':''}" data-a="basis" data-i="${i}" data-bi="${bi}" title="근거 조문 펼치기">📖 ${esc(basisLabel(b))}</button>`));
  if(s.form) acts.push(`<button class="sec-mini" data-a="form" data-reg="${esc(s.form.reg)}" data-label="${esc(s.form.label)}">📎 ${esc(s.form.label)}</button>`);
  if(s.draft && allDrafts()[s.draft]) acts.push(`<button class="sec-mini primary" data-a="draft" data-d="${esc(s.draft)}">📝 초안 작성</button>`);
  if(s.act && s.act.k==='proc' && getProc(s.act.id)) acts.push(`<button class="sec-mini" data-a="proc" data-id="${esc(s.act.id)}">↗ ${esc(s.act.l||'관련 절차')}</button>`);
  const basisBoxes=(s.basis||[]).map((b,bi)=>S.basisOpen[i+':'+bi]?`<div class="sec-basis" id="secb_${i}_${bi}"><div class="assist-loading sm"><div class="spinner"></div><span>근거 불러오는 중...</span></div></div>`:'').join('');
  return `<div class="sec-step${done?' done':''}${s.optional?' opt':''}">`+
    `<button class="sec-chk" data-a="check" data-i="${i}" aria-pressed="${done}" aria-label="${i+1}단계 ${done?'완료 취소':'완료'}">${done?'✓':i+1}</button>`+
    `<div class="sec-step-m"><div class="sec-step-t">${esc(s.t)}${s.optional?'<span class="sec-opt">선택</span>':''}</div>`+
    `<div class="sec-step-meta">${when}${off}</div>${docs}${acts.length?`<div class="sec-step-acts">${acts.join('')}</div>`:''}${basisBoxes}</div></div>`;
}
function basisLabel(b){ return b.art?`${b.reg} 제${b.art}조`:`${b.reg}${b.q?' · '+b.q:''}`; }

async function loadOpenBasis(){
  const p=getProc(S.procId); if(!p) return;
  for(const key of Object.keys(S.basisOpen)){
    if(!S.basisOpen[key]) continue;
    const [i,bi]=key.split(':').map(Number); const b=((p.steps[i]||{}).basis||[])[bi]; if(!b) continue;
    const ck=JSON.stringify(b);
    let d=S.basisCache[ck];
    if(!d){ try{ const qs=new URLSearchParams({reg:b.reg}); if(b.art) qs.set('art',b.art); if(b.q) qs.set('q',b.q);
        const r=await fetch('/api/secretary/basis?'+qs); d=await r.json(); }catch(e){ d={success:false,error:'근거를 불러오지 못했습니다.'}; }
      S.basisCache[ck]=d; }
    const el=document.getElementById(`secb_${i}_${bi}`); if(!el) continue;
    if(!d.success){ el.innerHTML=`<div class="sec-basis-err">${esc(d.error||'근거를 찾지 못했습니다.')}</div>`; continue; }
    const t=String(d.text||'').replace(/^(\S.*?제\s*\d+\s*조(?:의\s*\d+)?\s*[(（][^)）]*[)）])\s*/,'');
    el.innerHTML=`<div class="sec-basis-h"><b>${esc(basisLabel(b))}${d.art_title?' ('+esc(d.art_title)+')':''}</b>${d.revision?`<span class="sec-sub">${esc(d.revision)}</span>`:''}`+
      `<button class="sec-mini" data-a="openreg" data-reg="${esc(d.reg||b.reg)}" data-art="${esc(b.art||'')}" data-q="${esc(b.q||'')}">전문에서 보기 ↗</button></div>`+
      `<div class="sec-basis-t">${esc(t.length>1400?t.slice(0,1400)+'…':t)}</div>`;
  }
}

function noMatchView(){
  const rel=S.related;
  const list=rel==null?`<div class="assist-loading"><div class="spinner"></div><span>관련 조문 찾는 중...</span></div>`:
    (rel.length?`<div class="sec-rel">`+rel.map(it=>`<button class="sec-rel-i" data-a="openreg" data-reg="${esc(it.reg)}" data-art="${esc(it.art)}">`+
      `<span class="sec-rel-h"><b>${esc(it.reg)} 제${esc(it.art)}조</b>${it.art_title?` (${esc(it.art_title)})`:''}${it.src==='semantic'?'<span class="sec-layer org">의미</span>':''}</span>`+
      `<span class="sec-rel-p">${esc(String(it.preview||'').replace(/^.*?[)）]\s*/,'').slice(0,160))}…</span></button>`).join('')+`</div>`
      :`<div class="sec-empty">관련 조문을 찾지 못했습니다. 다른 표현으로 말해 보세요.</div>`);
  return aiBox()+`<div class="sec-card"><div class="sec-card-h">🔎 "${esc(S.query)}" — 등록된 절차가 없어요</div>`+
    `<div class="sec-hint">대신 관련 있어 보이는 규정 조문을 찾았습니다. 자주 하는 일이라면 <b>규정·절차 관리</b>에서 절차로 등록해 두면 다음부터 단계별로 안내합니다.</div>${list}`+
    `<div class="sec-row"><button class="sec-btn" data-a="formsq" data-q="${esc(S.query)}">📎 서식·규정에서 찾기</button><button class="sec-btn ghost" data-a="newproc">＋ 이 상황을 절차로 등록</button><button class="sec-btn ghost" data-a="view" data-v="list">절차 목록 보기</button></div></div>`;
}

function listView(){
  const procs=allProcs(); const f=S.catFilter;
  const cats=['', ...new Set(procs.map(p=>p.category||'기타'))];
  const seg=`<div class="sec-seg">`+cats.map(c=>`<button class="sec-seg-b${f===c?' on':''}" data-a="cat" data-c="${esc(c)}">${c?esc(c):'전체'}</button>`).join('')+`</div>`;
  const items=procs.filter(p=>!f||(p.category||'기타')===f);
  return seg+`<div class="sec-list">`+items.map(p=>{ const n=(p.steps||[]).length, fm=allForms(p).length, dl=(p.steps||[]).filter(s=>s.deadline).length;
    return `<button class="sec-list-i" data-a="proc" data-id="${esc(p.id)}"><span class="sec-list-ic">${esc(p.icon||'📌')}</span>`+
      `<span class="sec-list-m"><span class="sec-list-t">${esc(p.title)} <span class="sec-layer ${p._layer}">${LAYER_LABEL[p._layer]}</span></span>`+
      `<span class="sec-list-s">${esc(p.summary||'')}</span><span class="sec-list-f">${n}단계${dl?` · 기한 ${dl}개`:''}${fm?` · 서식 ${fm}종`:''}</span></span><span class="sec-go">›</span></button>`; }).join('')+`</div>`;
}

function historyView(){
  const all=cases();
  if(!all.length) return shareToggle()+`<div class="sec-empty">🕘 아직 처리 이력이 없습니다.<br>절차를 열어 단계를 체크하거나 기준일을 넣으면 여기에 자동으로 쌓입니다.</div>`;
  const row=c=>{ const p=getProc(c.procId); const pr=p?caseProgress(c,p):{done:0,total:0,pct:0}; const nx=p&&c.status!=='done'?nextStep(c,p):null; const dd=nx&&nx.due?dday(nx.due):null;
    const ds=p&&p.dates?p.dates.filter(d=>c.dates&&c.dates[d.k]).map(d=>`${d.l} ${fmtDate(c.dates[d.k])}`).join(' · '):'';
    return `<div class="sec-hist${c.status==='done'?' done':''}"><div class="sec-hist-m" data-a="case" data-id="${esc(c.id)}" role="button" tabindex="0">`+
      `<span class="sec-hist-t">${esc(p?p.icon:'📌')} ${esc(c.title)}${c.status==='done'?' <span class="sec-layer common">완료</span>':''}</span>`+
      `<span class="sec-hist-s">시작 ${esc(c.created)}${ds?' · '+esc(ds):''}${c.note?' · 📝 '+esc(c.note.slice(0,40)):''}</span>`+
      (nx?`<span class="sec-hist-n">다음: ${esc(nx.s.t.slice(0,60))}${dd?` <span class="sec-dd ${dd.cls}">${dd.label}</span>`:''}</span>`:'')+`</div>`+
      `<span class="sec-prog sm"><i style="width:${pr.pct}%"></i></span><span class="sec-pct">${pr.done}/${pr.total}</span>`+
      `<button class="sec-x" data-a="casedel" data-id="${esc(c.id)}" title="이력 삭제" aria-label="이력 삭제">✕</button></div>`; };
  const open=all.filter(c=>c.status!=='done'), done=all.filter(c=>c.status==='done');
  return shareToggle()+`<div class="sec-hint">처리 이력은 <b>이 브라우저에만</b> 저장됩니다. 담당자가 바뀔 때는 내보내기 파일을 넘겨 주세요(받는 사람은 가져오기).</div>`+
    `<div class="sec-row"><button class="sec-btn sm" data-a="hexport">⬇ 이력 내보내기</button><label class="sec-btn sm ghost">⬆ 가져오기<input type="file" accept=".json,application/json" data-a="himport" hidden></label>`+
    `<button class="sec-btn sm ghost" data-a="draft" data-d="handover">🔁 인계 목록 초안</button></div>`+
    (open.length?`<div class="sec-card-h">진행 중 ${open.length}건</div>`+open.map(row).join(''):'')+
    (done.length?`<div class="sec-card-h" style="margin-top:14px;">완료 ${done.length}건</div>`+done.slice(0,50).map(row).join(''):'');
}

// ── 관리(층별 등록·수정·삭제) ─────────────────────────────────────────────
function manageView(){
  const procs=allProcs(); const hid=hiddenProcs();
  const orgInfo=S.org.updated?`기관 절차 ${S.org.procedures.length}건 · 최종 갱신 ${esc(S.org.updated)}${S.org.updated_by?' ('+esc(S.org.updated_by)+')':''}`:'기관 절차 없음';
  const rows=procs.map(p=>`<div class="sec-mg-i"><span class="sec-mg-t">${esc(p.icon||'📌')} ${esc(p.title)} <span class="sec-layer ${p._layer}">${LAYER_LABEL[p._layer]}${p._base?' (덮어씀)':''}</span></span>`+
    `<span class="sec-mg-acts"><button class="sec-btn sm" data-a="edit" data-id="${esc(p.id)}">수정</button>`+
    (p._layer==='common'?`<button class="sec-btn sm ghost" data-a="hide" data-id="${esc(p.id)}" title="내 화면에서 숨기기(개인 층)">숨기기</button>`
      :`<button class="sec-btn sm ghost" data-a="delproc" data-id="${esc(p.id)}" data-l="${p._layer}">${p._base?'되돌리기':'삭제'}</button>`)+`</span></div>`).join('');
  const hidRows=hid.length?`<div class="sec-card-h" style="margin-top:12px;">숨긴 절차</div>`+hid.map(p=>`<div class="sec-mg-i"><span class="sec-mg-t muted">${esc(p.title||p.id)} <span class="sec-layer ${p._layer}">${LAYER_LABEL[p._layer]}에서 숨김</span></span><span class="sec-mg-acts"><button class="sec-btn sm ghost" data-a="delproc" data-id="${esc(p.id)}" data-l="${p._layer}">다시 보이기</button></span></div>`).join(''):'';
  return tokenBar()+`<div class="sec-layers">`+
    `<div class="sec-layer-c"><span class="sec-layer common">공통</span><b>기본 탑재 규정 절차</b><span>저장소의 현행 내규에서 정리한 절차. 근거 조문은 내규 개정 시 원문에서 다시 불러옵니다.</span></div>`+
    `<div class="sec-layer-c"><span class="sec-layer org">기관</span><b>관리자 등록</b><span>관리자 토큰(내규 업로드와 같음)으로 저장하면 모든 사용자에게 보입니다. ${orgInfo}</span></div>`+
    `<div class="sec-layer-c"><span class="sec-layer personal">개인</span><b>나만의 보충</b><span>내 브라우저에만 저장. 공통·기관 절차를 내 상황에 맞게 고쳐 쓰거나 새 절차를 만듭니다.</span></div></div>`+
    `<div class="sec-row"><button class="sec-btn primary" data-a="newproc">＋ 새 절차 만들기</button>`+
    `<button class="sec-btn ghost" data-a="reload">↻ 기관 절차 새로고침</button></div>`+
    `<div class="sec-card">${rows}${hidRows}</div>`+
    healthCard()+impactCard()+insightsCard()+mappingCard()+packCard()+configCard()+
    `<div class="sec-hint">규정·지침이 개정되면: 근거 조문은 내규 원문(업로드 반영)에서 자동으로 최신본을 보여 줍니다. 근거 규정이 개정된 절차에는 '재확인 필요'가 표시되니, 원문과 대조한 뒤 <b>수정</b>해 기관 층으로 다시 저장하세요.</div>`;
}

// ── 관리: 관리자 토큰(한 번 입력하면 이 탭의 모든 기관 저장에 사용) ───────────
function tokenBar(){
  if(!S.admin.token_required) return `<div class="sec-hint">이 서버는 관리자 토큰 없이 저장합니다(로컬 실행).</div>`;
  return `<label class="sec-f sec-tokbar"><span>🔑 관리자 토큰 <span class="sec-sub">기관 층·기관 설정 저장에 필요(내규 업로드 토큰과 같음). 이 탭을 닫으면 잊습니다.</span></span>`+
    `<input type="password" id="secTokG" data-a="tokg" autocomplete="off" value="${esc(S._tok||'')}" placeholder="관리자 토큰"></label>`;
}
// ── 관리: 호환성 점검 ─────────────────────────────────────────────────────
function healthCard(){
  const ps=allProcs(); const bad=ps.filter(p=>p._status && !p._status.ok); const apx=ps.filter(p=>p._status && p._status.approx && p._status.approx.length);
  const unv=ps.filter(p=>p._status && p._status.ok && (p._status.unverified||[]).length);
  const ok=ps.length-bad.length;
  const rows=bad.map(p=>{ const st=p._status;
    const items=[...(st.missing||[]).map(x=>`🔗 ${esc(x.reg)}${x.art?` 제${esc(x.art)}조`:''}${x.label?' '+esc(x.label):''} — ${esc(x.why)}`),
      ...(st.stale||[]).map(x=>`📝 ${esc(x.reg)} 개정됨(${esc(x.verified)} → ${esc(x.current)})`+(revisedOf(x.reg)?` <button class="sec-linkbtn" data-a="impact" data-reg="${esc(x.reg)}">🔬 영향 분석</button>`:''))];
    return `<div class="sec-hc-i"><button class="sec-linkbtn" data-a="proc" data-id="${esc(p.id)}">${esc(p.icon||'📌')} ${esc(shortTitle(p.title))}</button> <span class="sec-layer ${p._layer}">${LAYER_LABEL[p._layer]}</span><ul>${items.map(x=>`<li>${x}</li>`).join('')}</ul></div>`; }).join('');
  return `<div class="sec-card"><div class="sec-card-h">🩺 호환성 점검 <span class="sec-sub">등록 규정 ${S.regCount}건 기준 · 절차 ${ps.length}개 중 정상 ${ok}개${apx.length?` · 근사 연결 ${apx.length}개`:''}</span></div>`+
    (bad.length?rows:`<div class="sec-hint">모든 절차의 근거 조문·서식이 우리 기관 규정에 연결되어 있고, 근거 규정 개정도 없습니다.</div>`)+
    (unv.length?`<div class="sec-hint">우리 기관 규정으로 확인 전 <b>${unv.length}</b>개: `+unv.map(p=>`<button class="sec-linkbtn" data-a="proc" data-id="${esc(p.id)}">${esc(shortTitle(p.title))}</button>`).join(', ')+
      ` — 다른 기관·다른 이름의 규정 기준으로 만든 절차입니다. 원문과 대조한 뒤 [수정 → 기관 층 저장]하면 확인 처리됩니다.</div>`:'')+
    (apx.length?`<div class="sec-hint">근사 연결: 이름이 비슷한 규정에 자동으로 연결했습니다. 맞는지 아래 <b>규정명 매핑</b>에서 확인해 주세요.</div>`:'')+alioHint()+`</div>`;
}
// ALIO(공공기관 경영정보 공개시스템) 공시본 대비 최신성 — scripts/alio_sync.mjs 로 확인·등록
function alioHint(){
  const a=S.alio;
  if(!a) return `<div class="sec-hint">📡 ALIO 공시 내규와 비교한 적이 없습니다. 기관 PC에서 <code>node scripts/alio_sync.mjs --apply</code>로 최신 내규를 받아 등록하세요.</div>`;
  const rev=a.items.filter(x=>x.status==='revised'), nw=a.items.filter(x=>x.status==='new');
  const when=(a.checked||'').slice(0,10);
  if(!rev.length && !nw.length) return `<div class="sec-hint">📡 ALIO 공시 내규 기준 최신입니다(${esc(when)} 확인, ${a.current}건 일치).</div>`;
  return `<div class="sec-hint">📡 ALIO 공시 내규(${esc(when)} 확인)보다 오래된 규정 <b>${rev.length}</b>건`+(nw.length?` · 서무비서에 없는 규정 <b>${nw.length}</b>건`:'')+
    `: ${[...rev.map(x=>`${esc(x.title)}(ALIO ${esc(x.alio)})`),...nw.map(x=>`🆕${esc(x.title)}`)].slice(0,12).join(', ')}${rev.length+nw.length>12?' 등':''}`+
    ` — <code>node scripts/alio_sync.mjs --apply</code>로 받아 등록하세요.</div>`;
}
// ── 관리: 규정명 매핑(다른 기관 도입의 핵심) ─────────────────────────────────
const VIA_LABEL={exact:['정확','ok'],alias:['매핑','ok'],prefix:['기관명 접두어','ok'],approx:['근사 — 확인 필요','warn'],'':['연결 안 됨','bad']};
function mappingCard(){
  if(!S.regMap){ if(!S._regMapLoading){ S._regMapLoading=true; fetch('/api/secretary/regs').then(r=>r.json()).then(d=>{ S.regMap=d; S._regMapLoading=false; if(S.view==='manage') render(); }).catch(()=>{ S._regMapLoading=false; }); }
    return `<div class="sec-card"><div class="sec-card-h">🔗 규정명 매핑</div><div class="assist-loading"><div class="spinner"></div><span>불러오는 중...</span></div></div>`; }
  const al=S._aliasDraft||Object.assign({}, S.cfg.reg_aliases||{});
  S._aliasDraft=al;
  const regs=S.regMap.regs||[];
  const opts=(cur)=>`<option value="">(자동 연결)</option>`+regs.map(r=>`<option value="${esc(r.title)}" ${cur===r.title?'selected':''}>${esc(r.title)}</option>`).join('');
  const refs=S.regMap.refs||[];
  const nBad=refs.filter(r=>!r.matched).length, nApx=refs.filter(r=>r.via==='approx').length;
  return `<div class="sec-card"><div class="sec-card-h">🔗 규정명 매핑 <span class="sec-sub">절차가 가리키는 규정명 → 우리 기관 규정. 다른 기관에서 쓸 때 여기서 연결합니다.</span></div>`+
    `<div class="sec-hint">절차 ${refs.length}개 규정명 중 연결 안 됨 <b>${nBad}</b> · 근사 연결 <b>${nApx}</b>. 우리 기관에 없는 규정은 비워 두고, 그 절차를 숨기거나 수정하세요.</div>`+
    `<div class="sec-map">`+refs.map(r=>{ const [vl,vc]=VIA_LABEL[r.via]||VIA_LABEL['']; const cur=al[r.name]||'';
      return `<div class="sec-map-r"><span class="sec-map-n">${esc(r.name)}</span><span class="sec-map-arrow">→</span>`+
        `<select data-a="alias" data-n="${esc(r.name)}" aria-label="${esc(r.name)} 연결 규정">${opts(cur)}</select>`+
        `<span class="sec-via ${cur?'ok':vc}">${cur?'매핑':esc(vl)}${!cur&&r.matched&&r.via!=='exact'?`: ${esc(r.matched)}`:''}</span></div>`; }).join('')+`</div>`+
    `<div class="sec-row"><button class="sec-btn primary sm" data-a="aliassave">매핑 저장(기관 설정)</button></div></div>`;
}
// ── 관리: 절차 팩(다른 기관·부서와 주고받기) ─────────────────────────────────
function packCard(){
  const pv=S._packPreview;
  const prev=pv?`<div class="sec-pack-pv"><b>📦 ${esc(pv.name||'절차 팩')}</b> <span class="sec-sub">${esc(pv.source_org||'')}${pv.exported?' · '+esc(pv.exported):''}</span>`+
    `<div class="sec-hint">절차 ${pv.procedures.length}개 — 우리 기관 규정에 그대로 연결되는 절차 <b>${pv.okN}</b>개, 연결 확인이 필요한 절차 <b>${pv.procedures.length-pv.okN}</b>개.`+
    (pv.dup.length?` 같은 id가 이미 있는 절차 ${pv.dup.length}개는 덮어씁니다.`:'')+`</div>`+
    `<div class="sec-row"><button class="sec-btn sm" data-a="packin" data-l="personal">개인 층에 추가</button><button class="sec-btn sm" data-a="packin" data-l="org">기관 층에 추가(관리자)</button><button class="sec-btn sm ghost" data-a="packcancel">취소</button></div></div>`:'';
  return `<div class="sec-card"><div class="sec-card-h">📦 절차 팩 <span class="sec-sub">다른 기관·부서와 절차를 주고받는 표준 파일(secretary-pack, JSON)</span></div>`+
    `<div class="sec-row"><select id="secPackScope" aria-label="내보낼 범위"><option value="all">보이는 절차 전체</option><option value="org">기관 층만</option><option value="personal">개인 층만</option></select>`+
    `<button class="sec-btn sm" data-a="packout">⬇ 내보내기</button>`+
    `<label class="sec-btn sm ghost">⬆ 가져오기<input type="file" accept=".json,application/json" data-a="packfile" hidden></label></div>`+prev+
    `<div class="sec-hint">팩에는 절차·초안 서식과, 절차가 참조하는 규정의 이름·개정 정보가 함께 들어갑니다. 받는 기관은 가져온 뒤 <b>규정명 매핑</b>으로 자기 규정에 연결합니다.</div></div>`;
}
// ── 관리: 기관 설정 ─────────────────────────────────────────────────────
function configCard(){
  const c=S._cfgDraft||JSON.parse(JSON.stringify(S.cfg)); S._cfgDraft=c;
  const o=c.org||{}, v=c.service||{}, t=c.terms||{}, h=(c.holidays||{});
  const f=(path,l,val,ph,extra)=>`<label class="sec-f"><span>${l}</span><input data-a="cfg" data-p="${path}" value="${esc(val||'')}" placeholder="${esc(ph||'')}" ${extra||''}></label>`;
  const hol=(h.extra||[]).map(x=>`${x.date} ${x.name||''}`.trim()).join('\n');
  return `<details class="sec-card sec-cfg"${S._cfgOpen?' open':''}><summary class="sec-card-h">🏢 기관 설정 <span class="sec-sub">기관명·서비스 이름·색·명칭·기관 휴일 — 다른 기관은 여기부터 바꿉니다</span></summary>`+
    `<div class="sec-eg">${f('org.name','기관명 *',o.name,'예: ○○공단')}${f('org.short','영문 약칭',o.short,'예: KOAT')}${f('org.abbr','줄임말',o.abbr,'예: 농진원')}</div>`+
    `<div class="sec-eg">${f('service.title','서비스 이름',v.title,'서무비서')}${f('service.icon','아이콘',v.icon,'🗂','maxlength="4"')}`+
      `<label class="sec-f"><span>대표 색</span><input type="color" data-a="cfg" data-p="service.primary" value="${esc(/^#[0-9a-f]{6}$/i.test(v.primary||'')?v.primary:'#256ef4')}"></label></div>`+
    f('service.tagline','한 줄 소개',v.tagline,'상황을 말하면 절차·기한·서식·근거 안내')+f('service.footer','하단 안내',v.footer,'')+
    `<div class="sec-card-h" style="margin-top:6px;">명칭 <span class="sec-sub">절차 문장의 [[erp]] 등이 이 이름으로 바뀝니다</span></div>`+
    `<div class="sec-eg">${f('terms.erp','업무 시스템',t.erp,'ERP')}${f('terms.portal','내부 포털',t.portal,'그룹웨어')}${f('terms.accounting','회계 담당 부서',t.accounting,'회계부서')}${f('terms.approval','결재 시스템',t.approval,'전자결재')}</div>`+
    `<label class="sec-f"><span>ERP·그룹웨어 주소(줄마다 하나) <span class="sec-sub">🧩 ERP 확장 배포본에 들어갑니다. 예) https://kerp.koat.or.kr</span></span><textarea data-a="cfgerp" rows="2" placeholder="https://kerp.koat.or.kr">${esc(((c.erp||{}).hosts||[]).map(h=>h.replace(/\/\*$/,'')).join('\n'))}</textarea></label>`+
    `<label class="sec-f"><span>기관 휴일(줄마다 "YYYY-MM-DD 이름") <span class="sec-sub">법정 공휴일은 기본 탑재 — 창립기념일·근로자의 날 등만 적으세요</span></span><textarea data-a="cfghol" rows="3" placeholder="2026-05-01 근로자의 날">${esc(hol)}</textarea></label>`+
    `<div class="sec-row"><button class="sec-btn primary sm" data-a="cfgsave">기관 설정 저장</button><span class="sec-sub">${S.cfg.updated?'최종 저장 '+esc(S.cfg.updated):''}</span></div></details>`;
}
async function saveConfig(cfg, okMsg){
  const tok=(document.getElementById('secTokG')||{}).value||S._tok||'';
  if(S.admin.token_required && !tok){ toast('위쪽에 관리자 토큰을 입력하세요.'); const el=document.getElementById('secTokG'); if(el) el.focus(); return false; }
  try{ const r=await fetch('/api/secretary/config',{method:'POST',headers:{'Content-Type':'application/json','X-Upload-Token':tok},
      body:JSON.stringify({config:cfg, editor:_ls(LS_EDITOR,'')})});
    const d=await r.json(); if(!d.success){ toast(d.error||'저장하지 못했습니다.', 4200); return false; }
    S._tok=tok; S._cfgDraft=null; S._aliasDraft=null; S.regMap=null; toast(okMsg||d.message, 4200);
    await load(true); render(); return true;
  }catch(e){ toast('서버에 저장하지 못했습니다.'); return false; }
}
function packOut(){
  const scope=(document.getElementById('secPackScope')||{}).value||'all';
  const src=scope==='org'?(S.org.procedures||[]).map(p=>Object.assign({},p,{_layer:'org'})):scope==='personal'?personal().procedures.map(p=>Object.assign({},p,{_layer:'personal'})):allProcs();
  const procs=src.filter(p=>!p.hidden).map(p=>{ const o=JSON.parse(JSON.stringify(p)); Object.keys(o).forEach(k=>{ if(k.startsWith('_')) delete o[k]; }); return o; });
  if(!procs.length){ toast('내보낼 절차가 없습니다.'); return; }
  const drafts={}; const ad=allDrafts(); procs.forEach(p=>(p.steps||[]).forEach(s=>{ if(s.draft&&ad[s.draft]) drafts[s.draft]=ad[s.draft]; }));
  const regs={}; procs.forEach(p=>{ (p.steps||[]).forEach(s=>{ (s.basis||[]).concat(s.form?[s.form]:[]).forEach(b=>regs[b.reg]=regs[b.reg]||(p.verified||{})[b.reg]||''); });
    (p.forms||[]).forEach(f=>regs[f.reg]=regs[f.reg]||(p.verified||{})[f.reg]||''); });
  const o=S.cfg.org||{};
  download(`서무비서_절차팩_${o.short||o.name||''}_${today()}.json`, {kind:'secretary-pack', schema_version:1,
    name:`${o.name||''} 서무 절차`, source_org:o.name||'', exported:today(), procedures:procs, drafts,
    regs:Object.entries(regs).map(([name,revision])=>({name, revision}))});
}
function packRead(d){
  // 절차 팩 또는 예전 '개인 절차 내보내기' 파일 둘 다 받는다
  const procs=Array.isArray(d&&d.procedures)?d.procedures.filter(p=>p&&p.id&&p.title):null;
  if(!procs||!procs.length){ toast('절차 팩 파일이 아닙니다.'); return; }
  const have=new Set(allProcs().map(p=>p.id));
  fetch('/api/secretary/check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({procedures:procs})}).then(r=>r.json()).then(r=>{
    const st=(r&&r.status)||{};
    S._packPreview={name:d.name, source_org:d.source_org, exported:d.exported, procedures:procs, drafts:d.drafts||{}, notes:d.notes||null,
      okN:procs.filter(p=>st[p.id]&&!(st[p.id].missing||[]).length).length, dup:procs.filter(p=>have.has(p.id)).map(p=>p.id)};
    render(); }).catch(()=>toast('점검하지 못했습니다.'));
}
async function packIn(layer){
  const pv=S._packPreview; if(!pv) return;
  if(layer==='personal'){ const per=personal(); const ids=new Set(pv.procedures.map(p=>p.id));
    per.procedures=per.procedures.filter(p=>!ids.has(p.id)).concat(pv.procedures); if(pv.notes) per.notes=Object.assign({}, per.notes, pv.notes);
    savePersonal(per); S._packPreview=null; await checkPersonal(); toast(`개인 층에 절차 ${pv.procedures.length}개를 추가했습니다.`); render(); return; }
  const tok=(document.getElementById('secTokG')||{}).value||S._tok||'';
  const ids=new Set(pv.procedures.map(p=>p.id));
  S.org.drafts=Object.assign({}, S.org.drafts||{}, pv.drafts||{});
  if(await saveOrg((S.org.procedures||[]).filter(p=>!ids.has(p.id)).concat(pv.procedures), tok)){ S._packPreview=null; S.regMap=null; render(); }
}

function blankProc(){ return {id:'p-'+uid().slice(-6), icon:'📌', category:'기타', title:S.query||'', summary:'', approval:'', triggers:S.query?[S.query]:[], dates:[], steps:[{t:''}], forms:[], tips:[]}; }
function editView(){
  const src=S.editId?getProc(S.editId):null; const p=S._draftProc||(src?JSON.parse(JSON.stringify(src)):blankProc());
  S._draftProc=p;
  const lay=S.editLayer;
  const f=(k,l,v,ph,extra)=>`<label class="sec-f"><span>${l}</span><input data-a="ef" data-k="${k}" value="${esc(v||'')}" placeholder="${esc(ph||'')}" ${extra||''}></label>`;
  const stepRows=(p.steps||[]).map((s,i)=>`<div class="sec-es"><div class="sec-es-h"><b>${i+1}단계</b>`+
      `<label class="sec-es-o"><input type="checkbox" data-a="es" data-i="${i}" data-k="optional" ${s.optional?'checked':''}> 선택 단계</label>`+
      `<span class="sec-es-acts"><button class="sec-mini" data-a="esmove" data-i="${i}" data-d="-1" title="위로">▲</button><button class="sec-mini" data-a="esmove" data-i="${i}" data-d="1" title="아래로">▼</button><button class="sec-mini" data-a="esdel" data-i="${i}" title="삭제">✕</button></span></div>`+
    `<textarea data-a="es" data-i="${i}" data-k="t" rows="2" placeholder="할 일(예: 운임·숙박비 증빙을 갖춰 정산을 신청합니다)">${esc(s.t||'')}</textarea>`+
    `<div class="sec-es-g">`+
      `<label class="sec-f"><span>시점</span><input data-a="es" data-i="${i}" data-k="when" value="${esc(s.when||'')}" placeholder="예: 마친 날 다음 날부터 14일 이내"></label>`+
      `<label class="sec-f"><span>기한 계산</span><span class="sec-dl"><select data-a="es" data-i="${i}" data-k="dlref"><option value="">없음</option>${(p.dates||[]).map(d=>`<option value="${esc(d.k)}" ${s.deadline&&s.deadline.ref===d.k?'selected':''}>${esc(d.l)}</option>`).join('')}</select>`+
        `<input type="number" data-a="es" data-i="${i}" data-k="dldays" value="${s.deadline?esc(s.deadline.days):''}" placeholder="±일" style="width:70px"></span></label>`+
      `<label class="sec-f"><span>근거(쉼표)</span><input data-a="es" data-i="${i}" data-k="basis" value="${esc((s.basis||[]).map(b=>b.art?`${b.reg} 제${b.art}조`:`${b.reg}#${b.q||''}`).join(', '))}" placeholder="여비규정 제8조, 복무규정 제8조"></label>`+
      `<label class="sec-f"><span>필요 서류(쉼표)</span><input data-a="es" data-i="${i}" data-k="docs" value="${esc((s.docs||[]).join(', '))}" placeholder="영수증, 매출전표"></label>`+
      `<label class="sec-f"><span>서식</span><input data-a="es" data-i="${i}" data-k="form" value="${esc(s.form?s.form.reg+' '+s.form.label:'')}" placeholder="문서규칙 별지 제9호 서식"></label>`+
      `<label class="sec-f"><span>초안</span><select data-a="es" data-i="${i}" data-k="draft"><option value="">없음</option>${Object.entries(allDrafts()).map(([k,d])=>`<option value="${esc(k)}" ${s.draft===k?'selected':''}>${esc(d.title)}</option>`).join('')}</select></label>`+
    `</div></div>`).join('');
  return `<div class="sec-card"><div class="sec-card-h">${src?'✏ 절차 수정':'＋ 새 절차'} <span class="sec-sub">${src?`원본: ${LAYER_LABEL[src._layer]} 층`:''}</span></div>`+
    `<div class="sec-eg">`+f('title','제목 *',p.title,'예: 국내출장 — 신청부터 정산까지')+f('id','ID *',p.id,'영문 소문자·숫자·하이픈 (예: my-trip)', src?'readonly':'')+
      f('icon','아이콘',p.icon,'📌','maxlength="4"')+f('category','분류',p.category,'출장·복무·물품·행사·회계·문서')+`</div>`+
    `<label class="sec-f"><span>요약</span><input data-a="ef" data-k="summary" value="${esc(p.summary||'')}" placeholder="한 줄 요약"></label>`+
    `<label class="sec-f"><span>이런 말에 반응(쉼표)</span><input data-a="ef" data-k="triggers" value="${esc((p.triggers||[]).join(', '))}" placeholder="출장, 정산, 여비, 복명"></label>`+
    `<label class="sec-f"><span>결재선</span><input data-a="ef" data-k="approval" value="${esc(p.approval||'')}" placeholder="예: 팀장 전결(위임전결규칙 별표 5.복무관리)"></label>`+
    `<label class="sec-f"><span>기준일(쉼표, 최대 3개)</span><input data-a="ef" data-k="dates" value="${esc((p.dates||[]).map(d=>d.l).join(', '))}" placeholder="출발일, 출장 마친 날"></label>`+
    `<label class="sec-f"><span>서식(쉼표)</span><input data-a="ef" data-k="forms" value="${esc((p.forms||[]).map(x=>x.reg+' '+x.label).join(', '))}" placeholder="공무국외출장 관리규칙 별지 제5호 서식"></label>`+
    `<label class="sec-f"><span>제출 전 반려 점검(줄마다 하나) <span class="sec-sub">자주 반려되는 사유를 확인 질문으로 — 기관 층에 저장하면 모든 사용자에게 보입니다</span></span>`+
      `<textarea data-a="ef" data-k="pitfalls" rows="3" placeholder="예) 숙박 영수증에 숙박일·인원이 적혀 있나요?">${esc((p.pitfalls||[]).map(x=>x.t).join('\n'))}</textarea></label>`+
    (rejects(p.id).length?`<div class="sec-row"><button class="sec-btn sm ghost" data-a="rjpromote">⬆ 내 반려 기록 ${rejects(p.id).length}건을 점검 항목에 넣기</button></div>`:'')+
    `<label class="sec-f"><span>팁(줄마다 하나)</span><textarea data-a="ef" data-k="tips" rows="2">${esc((p.tips||[]).join('\n'))}</textarea></label>`+
    `</div><div class="sec-card"><div class="sec-card-h">단계</div>${stepRows}<button class="sec-btn sm" data-a="esadd">＋ 단계 추가</button></div>`+
    `<div class="sec-card sec-save"><div class="sec-card-h">저장 위치</div>`+
      `<label class="sec-radio"><input type="radio" name="secLay" value="personal" data-a="lay" ${lay==='personal'?'checked':''}> <span class="sec-layer personal">개인</span> 내 브라우저에만</label>`+
      `<label class="sec-radio"><input type="radio" name="secLay" value="org" data-a="lay" ${lay==='org'?'checked':''}> <span class="sec-layer org">기관</span> 모든 사용자 (관리자)</label>`+
      (lay==='org'?`<div class="sec-eg">${S.admin.token_required&&!S._tok?`<label class="sec-f"><span>관리자 토큰</span><input type="password" id="secTok" autocomplete="off" placeholder="내규 업로드 토큰"></label>`:''}`+
        `<label class="sec-f"><span>작성자</span><input id="secEditor" value="${esc(_ls(LS_EDITOR,''))}" placeholder="운영지원실 홍길동"></label></div>`:'')+
      `<div class="sec-row"><button class="sec-btn primary" data-a="save">저장</button><button class="sec-btn ghost" data-a="cancel">취소</button></div>`+
      `<div class="sec-hint">근거는 「규정명 제N조」 형식으로 적으면 저장소의 내규 원문에서 조문을 찾아 보여 줍니다. 조문 번호가 없는 지침은 「규정명#찾을 말」로 적어 주세요.</div></div>`;
}

function parseRefs(str, isForm){
  return String(str||'').split(/[,，]/).map(x=>x.trim()).filter(Boolean).map(x=>{
    if(isForm){ const m=x.match(/^(.*?)\s*((?:별지|별표)\s*(?:제\s*)?\d+(?:의\d+)?\s*호?\s*(?:서식)?)$/); return m?{reg:m[1].trim(), label:m[2].replace(/\s+/g,' ').trim()}:null; }
    let m=x.match(/^(.*?)\s*제\s*(\d+(?:\s*의\s*\d+)?)\s*조/); if(m) return {reg:m[1].trim(), art:m[2].replace(/\s+/g,'')};
    m=x.match(/^(.*?)#(.+)$/); if(m) return {reg:m[1].trim(), q:m[2].trim()};
    return {reg:x, q:''};
  }).filter(r=>r && r.reg && (isForm || r.art || r.q));
}
function editorField(el){
  const p=S._draftProc; if(!p) return;
  const k=el.dataset.k, v=el.value;
  if(el.dataset.a==='ef'){
    if(k==='triggers') p.triggers=v.split(/[,，]/).map(s=>s.trim()).filter(Boolean);
    else if(k==='dates'){ const ls=v.split(/[,，]/).map(s=>s.trim()).filter(Boolean).slice(0,3); const keys=['start','end','extra'];
      p.dates=ls.map((l,i)=>({k:(p.dates&&p.dates[i]&&p.dates[i].k)||keys[i], l})); }
    else if(k==='forms') p.forms=parseRefs(v,true);
    else if(k==='tips') p.tips=v.split('\n').map(s=>s.trim()).filter(Boolean);
    else if(k==='pitfalls'){ const prev=new Map((p.pitfalls||[]).map(x=>[x.t,x]));   // 문구가 그대로면 근거 유지
      p.pitfalls=v.split('\n').map(s=>s.trim()).filter(Boolean).map(t=>prev.get(t)||{t}); }
    else p[k]=v;
    return;
  }
  const i=Number(el.dataset.i); const s=p.steps[i]; if(!s) return;
  if(k==='optional') s.optional=el.checked||undefined;
  else if(k==='dlref'){ if(v) s.deadline=Object.assign({days:0}, s.deadline||{}, {ref:v}); else delete s.deadline; }
  else if(k==='dldays'){ if(s.deadline) s.deadline.days=Number(v)||0; }
  else if(k==='basis') s.basis=parseRefs(v,false);
  else if(k==='docs') s.docs=v.split(/[,，]/).map(x=>x.trim()).filter(Boolean);
  else if(k==='form'){ const f=parseRefs(v,true)[0]; if(f) s.form=f; else delete s.form; }
  else if(k==='draft'){ if(v) s.draft=v; else delete s.draft; }
  else s[k]=v;
}
function cleanForSave(p){
  const o=JSON.parse(JSON.stringify(p)); Object.keys(o).forEach(k=>{ if(k.startsWith('_')) delete o[k]; });
  o.steps=(o.steps||[]).filter(s=>String(s.t||'').trim());
  return o;
}
async function saveEditor(){
  const p=cleanForSave(S._draftProc||{});
  p.id=String(p.id||'').trim().toLowerCase();
  if(!p.title||!String(p.title).trim()){ toast('제목을 입력하세요.'); return; }
  if(!/^[a-z0-9][a-z0-9\-]{1,47}$/.test(p.id)){ toast('ID는 영문 소문자·숫자·하이픈 2~48자로 입력하세요.'); return; }
  if(!p.steps.length){ toast('단계를 하나 이상 입력하세요.'); return; }
  if(!S.editId && allProcs().some(x=>x.id===p.id)){ toast('이미 있는 ID입니다. 다른 ID를 쓰세요.'); return; }
  if(S.editLayer==='personal'){
    const per=personal(); per.procedures=per.procedures.filter(x=>x.id!==p.id); per.procedures.push(p); savePersonal(per);
    toast('개인 절차로 저장했습니다.'); S._draftProc=null; S.editId=null; selectProc(p.id); return;
  }
  const list=(S.org.procedures||[]).filter(x=>x.id!==p.id).concat([p]);
  if(await saveOrg(list)){ S._draftProc=null; S.editId=null; selectProc(p.id); }
}
async function saveOrg(list, tokArg){
  const tokEl=document.getElementById('secTok')||document.getElementById('secTokG'); const tok=tokArg!=null&&tokArg!==''?tokArg:(tokEl&&tokEl.value.trim())||S._tok||'';
  const edEl=document.getElementById('secEditor'); const editor=edEl?edEl.value.trim():_ls(LS_EDITOR,'');
  if(S.admin.token_required && !tok){ toast('관리자 토큰을 입력하세요.'); if(tokEl) tokEl.focus(); return false; }
  if(editor) _lsPut(LS_EDITOR, editor);
  try{
    const r=await fetch('/api/secretary/org',{method:'POST',headers:{'Content-Type':'application/json','X-Upload-Token':tok},
      body:JSON.stringify({procedures:list, drafts:S.org.drafts||{}, editor})});
    const d=await r.json();
    if(!d.success){ toast(d.error||'저장하지 못했습니다.', 4200); return false; }
    S._tok=tok; S.org=deepTx(d.org); toast(d.message||'기관 절차를 저장했습니다.', 4200);
    try{ await load(true); }catch(e){} return true;
  }catch(e){ toast('서버에 저장하지 못했습니다.'); return false; }
}

// ── 초안(문서 준비) ──────────────────────────────────────────────────────
function fillTemplate(tpl, vals){
  // {{키}} · {{키|list}}(줄마다 "  - ") · {{키|list|기본값}} · {{키|text|기본값}} — 비면 기본값, 없으면 ○○
  return String(tpl||'').replace(/\{\{(\w+)(?:\|(\w+))?(?:\|([^}]*))?\}\}/g, (m,k,mod,def)=>{
    const v=String(vals[k]==null?'':vals[k]).trim();
    const fb=def!=null?def:'○○';
    if(mod==='list'){
      const lines=v.split('\n').map(x=>x.trim().replace(/^[-·•○]\s*/,'')).filter(Boolean);
      return (lines.length?lines:[fb]).map(x=>'  - '+x).join('\n');
    }
    return v||fb;
  });
}
function draftAuto(d, c, p){
  const out={}; const dates=(c&&c.dates)||{};
  (d.fields||[]).forEach(f=>{
    if(f.auto==='period' && dates.start){ out[f.k]=fmtLong(dates.start)+(dates.end&&dates.end!==dates.start?' ~ '+fmtLong(dates.end):''); }
    else if(f.auto==='period' && dates.end){ out[f.k]=fmtLong(dates.end); }
    else if(f.auto==='start' && dates.start){ out[f.k]=fmtLong(dates.start); }
    else if(f.auto==='history'){ const lines=openCasesWithNext().map(({c,next})=>`${c.title}${next?' — 다음: '+next.s.t.slice(0,40)+(next.due?' ('+fmtLong(next.due)+'까지)':''):''}`); if(lines.length) out[f.k]=lines.join('\n'); }
  });
  return out;
}
function fmtLong(s){ const [y,m,d]=String(s).split('-').map(Number); if(!y) return s; const w='일월화수목금토'[new Date(y,m-1,d).getDay()]; return `${y}. ${m}. ${d}.(${w})`; }
function openDraft(key){
  const d=allDrafts()[key]; if(!d){ toast('초안 서식을 찾을 수 없습니다.'); return; }
  const c=(S.view==='proc')?curCase():null; const p=getProc(S.procId);
  const saved=(c&&c.drafts&&c.drafts[key])||{};
  const vals=Object.assign({}, draftAuto(d,c,p), receiptDraftVals(key, c), saved);   // 기준일·증빙에서 자동 → 저장한 값 우선
  S._draft={key, vals};
  const body=modal('secDraftModal','📝 '+esc(d.title)+' 초안');
  body.innerHTML=`<div class="sec-draft"><div class="sec-draft-f">`+(d.fields||[]).map(f=>`<label class="sec-f"><span>${esc(f.l)}</span>`+
      (f.multi?`<textarea data-dk="${esc(f.k)}" rows="3" placeholder="${esc(f.ph||'')}">${esc(vals[f.k]||'')}</textarea>`:`<input data-dk="${esc(f.k)}" value="${esc(vals[f.k]||'')}" placeholder="${esc(f.ph||'')}">`)+`</label>`).join('')+`</div>`+
    `<div class="sec-draft-p"><div class="sec-draft-ph">미리보기 <span class="sec-sub">비워 둔 칸은 ○○로 남습니다</span></div><pre id="secDraftOut" class="sec-draft-out"></pre>`+
    `<div class="sec-row">${EMBED?`<button class="sec-btn primary" data-da="erp" title="ERP 맞춤으로 연결한 칸들에 한 번에 넣고, 연결이 없으면 ERP에서 마지막으로 누른 칸에 넣습니다">📥 ERP에 넣기</button>`:''}<button class="sec-btn ${EMBED?'':'primary'}" data-da="copy">📋 복사</button>${(S.kd||{}).available?'':`<button class="sec-btn" data-da="hwpx">📄 한글(.hwpx)</button>`}<button class="sec-btn ghost" data-da="txt">⬇ 텍스트</button>${c?`<button class="sec-btn ghost" data-da="keep">이력에 저장</button>`:''}</div>`+
    `<div id="secFormsRow">${formsRow(key)}</div>`+
    `<div class="sec-hint">ERP·한글 기안문 본문에 붙여넣어 쓰세요. 원본 서식이 필요한 문서는 절차 화면의 📎 서식에서 여세요.</div></div></div>`;
  const out=()=>{ const o=document.getElementById('secDraftOut'); if(o) o.textContent=fillTemplate(d.template, S._draft.vals); };
  body.querySelectorAll('[data-dk]').forEach(el=>el.addEventListener('input',()=>{ S._draft.vals[el.dataset.dk]=el.value; out(); }));
  body.addEventListener('change', e=>{ const el=e.target; if(el.dataset.da!=='ffile') return; const f=el.files&&el.files[0]; el.value=''; if(f) formsUpload(key, d, f); });
  body.addEventListener('click', e=>{ const b=e.target.closest('[data-da]'); if(!b) return; const txt=fillTemplate(d.template, S._draft.vals);
    if(b.dataset.da==='copy'){ (navigator.clipboard?navigator.clipboard.writeText(txt):Promise.reject()).then(()=>toast('복사했습니다.')).catch(()=>{ const ta=document.createElement('textarea'); ta.value=txt; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy'); toast('복사했습니다.');}catch(_){} ta.remove(); }); }
    else if(b.dataset.da==='erp'){ S._lastInsert=txt;
      // ERP 맞춤(칸 연결)이 있는 화면이면 항목별로 여러 칸에 — 항목 값과 초안 전체를 함께 보낸다
      const vals={}; (d.fields||[]).forEach(f=>{ const v=String(S._draft.vals[f.k]||'').trim(); if(v) vals[f.k]=v; });
      toExt({type:'insert', text:txt, draft:key, values:vals}); }
    else if(b.dataset.da==='hwpx'){ downloadHwpx(d.title, txt); }
    else if(b.dataset.da==='txt'){ const blob=new Blob([txt],{type:'text/plain;charset=utf-8'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=d.title.replace(/[\\/:*?"<>|]/g,'')+'.txt'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000); }
    else if(b.dataset.da==='fgen'){ formsGenerate(d, S._draft.vals); }
    else if(b.dataset.da==='fgian'){ formsGian(d, S._draft.vals); }
    else if(b.dataset.da==='fmine'){ formsFill(key, d, S._draft.vals); }
    else if(b.dataset.da==='fforget'){ myForms(key, null); document.getElementById('secFormsRow').innerHTML=formsRow(key); toast('이 초안의 내 서식을 지웠습니다.'); }
    else if(b.dataset.da==='keep'){ updateCase(cc=>{ cc.drafts=cc.drafts||{}; cc.drafts[key]=Object.assign({}, S._draft.vals); }); toast('처리 이력에 초안 입력값을 저장했습니다.'); }
  });
  out();
}

// ── 원문 보기 패널(규정 전문·서식) ──────────────────────────────────────
function modal(id, title){
  let bg=document.getElementById(id);
  if(!bg){ bg=document.createElement('div'); bg.id=id; bg.className='modal-bg';
    bg.addEventListener('click', e=>{ if(e.target===bg) closeModal(id); }); document.body.appendChild(bg); }
  bg.innerHTML=`<div class="modal" role="dialog" aria-modal="true" aria-label="${esc(title).replace(/<[^>]+>/g,'')}"><div class="modal-h"><span class="modal-t">${title}</span>`+
    `<button class="viewer-x" type="button" data-close="${id}" aria-label="닫기">✕</button></div><div class="modal-b"></div></div>`;
  bg.querySelector('[data-close]').addEventListener('click', ()=>closeModal(id));
  bg.classList.add('show'); return bg.querySelector('.modal-b');
}
function closeModal(id){ const bg=document.getElementById(id); if(bg) bg.classList.remove('show'); }
const _origCache={};
async function regInfo(reg){
  const k=norm(reg); if(k in _origCache) return _origCache[k];
  try{ const r=await fetch('/api/internal/original?name='+encodeURIComponent(reg)); const d=await r.json(); _origCache[k]=(d&&d.found&&d.html_url)?d:null; }
  catch(e){ return null; }
  return _origCache[k];
}
// 원문 HTML(같은 출처)을 패널에 띄우고, 조문·별표·검색어 위치로 스크롤한다.
async function openViewer(reg, target){
  const info=await regInfo(reg);
  if(!info){ toast(`「${reg}」 원문을 찾지 못했습니다.`, 3000); return; }
  const v=document.getElementById('viewer'), fr=document.getElementById('viewerFrame');
  document.getElementById('viewerTitle').innerHTML=`📄 ${esc(info.title||reg)}${info.revision?`<small>${esc(info.revision)}</small>`:''}`;
  document.getElementById('viewerExt').href=info.html_url;
  v.classList.add('open'); document.getElementById('viewerDim').classList.add('show');
  const go=()=>setTimeout(()=>{ try{ scrollFrame(fr, target||{}); }catch(e){} }, 120);
  const want=new URL(info.html_url, location.href).href;
  if(fr.src===want && fr.contentDocument && fr.contentDocument.readyState==='complete') go();
  else { fr.addEventListener('load', go, {once:true}); fr.src=info.html_url; }
  document.getElementById('viewerClose').focus();
}
function closeViewer(){
  const v=document.getElementById('viewer'); if(!v||!v.classList.contains('open')) return false;
  v.classList.remove('open'); document.getElementById('viewerDim').classList.remove('show'); return true;
}
function flash(el){ if(!el) return; el.scrollIntoView({behavior:'smooth',block:'start'}); const prev=el.style.backgroundColor;
  el.style.backgroundColor='#fff3a3'; setTimeout(()=>{ el.style.backgroundColor=prev||''; }, 2400); }
function scrollFrame(fr, t){
  const doc=fr.contentDocument; if(!doc||!doc.body) return;
  const blocks=[...doc.body.querySelectorAll('p,div,td,th,h1,h2,h3,li')].filter(el=>!el.querySelector('p,div,td,table'));
  const txt=el=>(el.textContent||'').replace(/\s+/g,' ').trim();
  if(t.art){   // 제N조(제목) 로 시작하는 단락 — 목차(짧은 줄)보다 본문(긴 단락)을 우선
    const [n,m]=String(t.art).split('의');
    const re=new RegExp('^제\\s*'+n+'\\s*조'+(m?'\\s*의\\s*'+m:'(?!\\s*의)')+'\\s*[(（]');
    const hits=blocks.filter(el=>re.test(txt(el)));
    flash(hits.find(el=>txt(el).length>60)||hits[0]); return;
  }
  if(t.annex){   // 별표·별지: 괄호로 둘러싼 서식 머리 → 라벨로 시작하는 짧은 요소 → 라벨 포함 마지막 요소
    const key=String(t.annex).replace(/\s+/g,''); const mm=key.match(/^(별[표지])(?:제)?(\d+(?:의\d+)?)?/); if(!mm) return;
    // 번호 없는 「별표」는 번호가 붙지 않은 머리(〔별표〕)만 — "별표 1" 등에 걸리지 않게
    const re=new RegExp(mm[1][0]+'\\s*'+mm[1][1]+(mm[2]?'\\s*(?:제)?\\s*'+mm[2]+'(?![\\d의])\\s*호?':'(?!\\s*(?:제\\s*)?\\d)'));
    const reHead=new RegExp('^[\\[〔【［(（<〈]\\s*'+re.source);
    let el=blocks.find(b=>{ const x=txt(b); return x.length<=80 && reHead.test(x); });
    if(!el) blocks.forEach(b=>{ const x=txt(b); if(x.length<=60 && re.test(x.slice(0,20))) el=b; });
    if(!el) blocks.forEach(b=>{ if(re.test(txt(b))) el=b; });
    flash(el); return;
  }
  if(t.q){ const q=String(t.q).replace(/\s+/g,''); flash(blocks.find(el=>txt(el).replace(/\s+/g,'').includes(q))); }
}
function bindViewer(){
  document.getElementById('viewerClose').addEventListener('click', closeViewer);
  document.getElementById('viewerDim').addEventListener('click', closeViewer);
  document.addEventListener('keydown', e=>{ if(e.key!=='Escape') return;
    const m=document.querySelector('.modal-bg.show'); if(m){ m.classList.remove('show'); return; }
    closeViewer(); });
}
function openForm(reg, label){ return openViewer(reg, {annex:label}); }
function openReg(reg, art, q){ return openViewer(reg, art?{art}:(q?{q}:{})); }

// ── 서식·규정 찾기 ───────────────────────────────────────────────────────
function loadForms(){
  if(S.forms==null){ S.forms=false;
    fetch('/api/internal/forms').then(r=>r.json()).then(d=>{ S.forms=(d&&d.forms)||[]; if(S.view==='forms') renderFormsList(); }).catch(()=>{ S.forms=[]; if(S.view==='forms') renderFormsList(); });
    fetch('/api/regs/names').then(r=>r.json()).then(d=>{ S.regs=(d&&d.names)||[]; if(S.view==='forms') renderFormsList(); }).catch(()=>{ S.regs=[]; });
  } else renderFormsList();
}
function formsView(){
  return `<div class="sec-card"><div class="sec-card-h">📎 서식·규정 찾기 <span class="sec-sub">규정의 별표·별지 서식과 규정 원문을 바로 엽니다</span></div>`+
    `<input id="secFormsQ" class="sec-fq" data-a="formsin" placeholder="서식명·규정명 (예: 귀국보고서, 청구서, 여비)" value="${esc(S.formsQ)}" aria-label="서식·규정 검색">`+
    `<div id="secFormsList"><div class="assist-loading"><div class="spinner"></div><span>서식 목록 불러오는 중...</span></div></div></div>`;
}
function renderFormsList(){
  const box=document.getElementById('secFormsList'); if(!box) return;
  if(!S.forms){ return; }
  const q=norm(S.formsQ);
  const regs=(S.regs||[]).filter(r=>q && norm(r.title).includes(q)).slice(0,12);
  const forms=S.forms.filter(f=>!q || norm(f.reg+f.label+f.title).includes(q));
  const regHtml=regs.length?`<div class="sec-card-h" style="margin-top:12px;">📖 규정 원문 <span class="sec-sub">${regs.length}건</span></div><div class="sec-forms">`+
    regs.map(r=>`<button class="sec-form" data-a="openreg" data-reg="${esc(r.title)}"><span class="sec-form-t">${esc(r.title)}</span><span class="sec-form-s">${esc(r.category||'')}${r.revision?' · '+esc(r.revision):''}</span></button>`).join('')+`</div>`:'';
  const formHtml=`<div class="sec-card-h" style="margin-top:12px;">📎 서식 <span class="sec-sub">${forms.length}건${q?` (전체 ${S.forms.length}건 중)`:''}</span></div>`+
    (forms.length?`<div class="sec-forms sec-forms-grid">`+forms.slice(0,200).map(f=>`<button class="sec-form" data-a="form" data-reg="${esc(f.reg)}" data-label="${esc(f.label)}"><span class="sec-form-t">${esc(f.title)}</span><span class="sec-form-s">${esc(f.reg)} ${esc(f.label)}</span></button>`).join('')+`</div>`+
      (forms.length>200?`<div class="sec-hint">상위 200건만 표시 — 검색어로 좁혀 주세요.</div>`:''):`<div class="sec-empty">검색 결과가 없습니다.</div>`);
  box.innerHTML=regHtml+formHtml;
}

// ── 기한 → 캘린더 파일(.ics) ──────────────────────────────────────────────
function icsEsc(t){ return String(t).replace(/[\\;,]/g,m=>'\\'+m).replace(/\n/g,'\\n'); }
function addDeadlinesToCalendar(){
  const p=getProc(S.procId); const c=curCase(); if(!p) return;
  if(!c || !Object.keys(c.dates||{}).length){ toast('먼저 기준일(출발일·마친 날 등)을 넣어 주세요.'); return; }
  const ev=[];
  (p.steps||[]).forEach((s,i)=>{ const due=stepDue(s,c.dates); if(!due || (c.checks&&c.checks[i])) return;
    const d=due.replace(/-/g,''); const nx=addDays(due,1).replace(/-/g,'');
    ev.push(['BEGIN:VEVENT','UID:'+c.id+'-'+i+'@koat-secretary','DTSTAMP:'+new Date().toISOString().replace(/[-:]/g,'').slice(0,15)+'Z',
      'DTSTART;VALUE=DATE:'+d,'DTEND;VALUE=DATE:'+nx,'SUMMARY:'+icsEsc(`[서무] ${shortTitle(p.title)} — ${s.t.replace(/[.。]$/,'').slice(0,50)}`),
      'DESCRIPTION:'+icsEsc(deadlineText(s)+(s.basis&&s.basis.length?' / 근거: '+s.basis.map(basisLabel).join(', '):'')),'END:VEVENT'].join('\r\n')); });
  if(!ev.length){ toast('남은 기한이 없습니다(완료했거나 기준일이 필요한 단계가 없음).'); return; }
  const ics=['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//KOAT//Secretary//KO','CALSCALE:GREGORIAN',...ev,'END:VCALENDAR'].join('\r\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([ics],{type:'text/calendar;charset=utf-8'}));
  a.download=`서무비서_${shortTitle(p.title)}_기한.ics`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  toast(`📅 기한 ${ev.length}건을 캘린더 파일로 받았습니다. Outlook·구글 캘린더에서 열어 추가하세요.`, 4200);
}
function download(name, obj){ const blob=new Blob([JSON.stringify(obj,null,1)],{type:'application/json'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000); }
function readJsonFile(input, cb){ const f=input.files&&input.files[0]; if(!f) return; const r=new FileReader();
  r.onload=()=>{ try{ cb(JSON.parse(r.result)); }catch(e){ toast('JSON 파일을 읽지 못했습니다.'); } input.value=''; }; r.readAsText(f,'utf-8'); }

// ── 이벤트(패널 위임) ────────────────────────────────────────────────────
function bind(panel){
  if(panel._secBound) return; panel._secBound=true;
  panel.addEventListener('toggle', e=>{ if(e.target.classList&&e.target.classList.contains('sec-cfg')) S._cfgOpen=e.target.open; }, true);
  panel.addEventListener('submit', e=>{ const f=e.target.closest('[data-a="askform"]'); if(!f) return; e.preventDefault(); const q=document.getElementById('secQ'); ask(q?q.value:''); });
  panel.addEventListener('click', e=>{
    const b=e.target.closest('[data-a]'); if(!b || !panel.contains(b)) return;
    const a=b.dataset.a, D=b.dataset;
    if(['date','pnote','cnote','ef','es','lay','himport','pimport','askform','formsin','tokg','alias','cfg','cfghol','packfile','rcfile','rcf'].includes(a)) return;
    e.preventDefault();
    switch(a){
      case 'retry': start(); break;
      case 'view': S.view=D.v; if(D.v==='home'){ S.procId=null; S.query=''; S.matches=[]; } render(); break;
      case 'ask': ask(D.q); break;
      case 'proc': selectProc(D.id, {keepQuery:!!D.keep}); break;
      case 'case': { const c=cases().find(x=>x.id===D.id); if(c){ S.query=''; S.matches=[]; selectProc(c.procId,{caseId:c.id}); } break; }
      case 'check': { const i=Number(D.i); ensureCase(); updateCase(c=>{ c.checks=c.checks||{}; c.checkAt=c.checkAt||{}; c.checks[i]=!c.checks[i]; if(c.checks[i]) c.checkAt[i]=today(); else { delete c.checks[i]; delete c.checkAt[i]; } }); render(); break; }
      case 'pcheck': ensureCase(); updateCase(c=>{ c.pchecks=c.pchecks||{}; c.pchecks[D.k]=!c.pchecks[D.k]; if(!c.pchecks[D.k]) delete c.pchecks[D.k]; }); render(); break;
      case 'rjadd': { const t=(prompt('반려 사유를 적어 주세요.\n예) 숙박 영수증에 숙박일·인원이 없어 반려')||'').trim(); if(!t) break;
        const per=personal(); per.rejects=per.rejects||{}; (per.rejects[S.procId]=per.rejects[S.procId]||[]).push({id:uid(), t:t.slice(0,300), date:today()});
        savePersonal(per); if(curCase()) updateCase(c=>{ (c.rejected=c.rejected||[]).push({t:t.slice(0,300), date:today()}); });
        if(canShare() && confirm('이 반려 사유를 기관 전체에 익명으로 공유할까요?\n다른 담당자의 점검 항목에 "우리 기관에서 자주 반려된 사유"로 보입니다. 이름·전화번호·금액은 지워서 보냅니다.')) shareReject(S.procId, t);
        toast('반려 사례를 기록했습니다. 다음 처리 때 점검 항목에 나옵니다.'); render(); break; }
      case 'rjdel': { const per=personal(); if(per.rejects&&per.rejects[S.procId]){ per.rejects[S.procId]=per.rejects[S.procId].filter(x=>x.id!==D.id); savePersonal(per); } render(); break; }
      case 'basis': { const k=D.i+':'+D.bi; S.basisOpen[k]=!S.basisOpen[k]; render(); break; }
      case 'form': openForm(D.reg, D.label); break;
      case 'openreg': openReg(D.reg, D.art, D.q); break;
      case 'draft': openDraft(D.d); break;
      case 'aliassave': { const c=JSON.parse(JSON.stringify(S.cfg)); c.reg_aliases=Object.fromEntries(Object.entries(S._aliasDraft||{}).filter(([k,v])=>v));
        saveConfig(c, '규정명 매핑을 저장했습니다. 절차의 근거·서식이 새 연결로 열립니다.'); break; }
      case 'cfgsave': { const c=S._cfgDraft||S.cfg; if(!String((c.org||{}).name||'').trim()){ toast('기관명을 입력하세요.'); break; } S._cfgOpen=true; saveConfig(c, '기관 설정을 저장했습니다.'); break; }
      case 'packout': packOut(); break;
      case 'packin': packIn(D.l); break;
      case 'packcancel': S._packPreview=null; render(); break;
      case 'calmove': { const n=Number(D.d); if(!n){ S.calYM=null; } else { let {y,m}=S.calYM; m+=n; if(m<1){m=12;y--;} if(m>12){m=1;y++;} S.calYM={y,m}; } render(); break; }
      case 'calics': calIcs(); break;
      case 'aiask': aiUnderstand(S.query, true); break;
      case 'aiopen': openWithDates(D.id, S.query); break;
      case 'rcdel': updateCase(c=>{ c.receipts=(c.receipts||[]).filter(r=>r.id!==D.id); }); render(); break;
      case 'audit': runAudit(); break;
      case 'auack': updateCase(c=>{ if(!c.audit) return; c.audit.ack=c.audit.ack||{}; c.audit.ack[D.id]=!c.audit.ack[D.id]; if(!c.audit.ack[D.id]) delete c.audit.ack[D.id]; }); render(); break;
      case 'impact': openImpact(D.reg); break;
      case 'sharetg': _lsPut(LS_SHARE, !canShare(true)); render(); toast(canShare(true)?'기관 통계에 익명으로 기여합니다.':'이제 기관 통계로 아무것도 보내지 않습니다.'); break;
      case 'insrj': promoteReason(D.id, D.t); break;
      case 'insdel': deleteReason(D.id, D.t); break;
      case 'insall': S.insAll=null; loadInsAll(); break;
      case 'herox': _lsPut('koat_sec_herox', Date.now()+30*86400000); render(); break;
      case 'extpanel': window.postMessage({src:'koat-sec', type:'openPanel'}, location.origin); toast('확장 패널을 엽니다. 열리지 않으면 도구 모음의 서무비서 아이콘을 누르세요.'); break;
      case 'copyext': { const t=D.t||''; (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(()=>toast(t+' 를 복사했습니다. 주소창에 붙여넣으세요.')).catch(()=>toast('주소창에 '+t+' 를 직접 입력하세요.')); break; }
      case 'formsq': S.formsQ=D.q||''; S.view='forms'; render(); break;
      case 'tocal': addDeadlinesToCalendar(); break;
      case 'newcase': S.caseId=null; render(); toast('새 건으로 시작합니다. 체크하거나 기준일을 넣으면 저장돼요.'); break;
      case 'casedone': { const p0=getProc(S.procId); const cc=curCase()||{}; const pc=cc.pchecks||{};
        const left=p0?[...(p0.pitfalls||[]).map((x,i)=>'p'+i), ...rejects(p0.id).map(x=>'r'+x.id)].filter(k=>!pc[k]).length:0;
        if(left && !confirm(`제출 전 반려 점검 ${left}개가 아직 확인되지 않았습니다. 그래도 완료 처리할까요?`)) break;
        const hi=auditOpen(cc).filter(f=>f.severity==='high').length;
        if(hi && !confirm(`사전 감사에서 '높음' 지적 ${hi}건이 아직 확인되지 않았습니다. 그래도 완료 처리할까요?`)) break; }
        ensureCase(); updateCase(c=>{ c.status='done'; c.doneAt=today(); }); shareDone(curCase()); toast('완료 처리했습니다. 처리 이력에서 다시 볼 수 있어요.'); render(); break;
      case 'casedel': if(confirm('이 처리 이력을 삭제할까요?')){ saveCases(cases().filter(c=>c.id!==D.id)); if(S.caseId===D.id) S.caseId=null; render(); } break;
      case 'hexport': download('서무비서_처리이력_'+today()+'.json', {kind:'koat-secretary-cases', exported:today(), cases:cases(), notes:personal().notes, rejects:personal().rejects||{}}); break;
      case 'pexport': download('서무비서_개인절차_'+today()+'.json', {kind:'koat-secretary-personal', exported:today(), procedures:personal().procedures, notes:personal().notes}); break;
      case 'reload': load(true).then(()=>{ render(); toast('기관 절차를 다시 불러왔습니다.'); }).catch(()=>toast('불러오지 못했습니다.')); break;
      case 'cat': S.catFilter=D.c; render(); break;
      case 'newproc': S.editId=null; S._draftProc=null; S.editLayer='personal'; S.view='edit'; render(); break;
      case 'edit': S.editId=D.id; S._draftProc=null; { const p=getProc(D.id); S.editLayer=(p&&p._layer==='org')?'org':'personal'; } S.view='edit'; render(); break;
      case 'hide': { const per=personal(); per.procedures=per.procedures.filter(x=>x.id!==D.id); per.procedures.push({id:D.id, hidden:true, title:(getProc(D.id)||{}).title||D.id}); savePersonal(per); toast('내 화면에서 숨겼습니다.'); render(); break; }
      case 'delproc': {
        if(D.l==='personal'){ const per=personal(); per.procedures=per.procedures.filter(x=>x.id!==D.id); savePersonal(per); toast('개인 층에서 지웠습니다.'); render(); }
        else if(D.l==='org'){ if(!confirm('기관 층에서 이 절차를 지울까요? 모든 사용자에게 반영됩니다.')) break;
          let tok=S._tok||''; if(S.admin.token_required && !tok){ tok=(prompt('관리자 토큰(내규 업로드 토큰)을 입력하세요.')||'').trim(); if(!tok) break; }
          saveOrg((S.org.procedures||[]).filter(x=>x.id!==D.id), tok).then(ok=>{ if(ok) render(); }); }
        break; }
      case 'rjpromote': { const dp=S._draftProc; if(!dp) break; const have=new Set((dp.pitfalls||[]).map(x=>x.t));
        dp.pitfalls=(dp.pitfalls||[]).concat(rejects(dp.id).filter(x=>!have.has(x.t)).map(x=>({t:x.t}))); render(); toast('반려 기록을 점검 항목에 넣었습니다. 저장해야 반영됩니다.'); break; }
      case 'esadd': S._draftProc.steps.push({t:''}); render(); break;
      case 'esdel': S._draftProc.steps.splice(Number(D.i),1); render(); break;
      case 'esmove': { const st=S._draftProc.steps, i=Number(D.i), j=i+Number(D.d); if(j>=0&&j<st.length){ [st[i],st[j]]=[st[j],st[i]]; render(); } break; }
      case 'save': saveEditor(); break;
      case 'cancel': S._draftProc=null; S.editId=null; S.view='manage'; render(); break;
    }
  });
  panel.addEventListener('change', e=>{
    const el=e.target; const a=el.dataset&&el.dataset.a;
    if(a==='date'){ ensureCase(); updateCase(c=>{ c.dates=c.dates||{}; if(el.value) c.dates[el.dataset.k]=el.value; else delete c.dates[el.dataset.k]; }); render(); }
    else if(a==='lay'){ S.editLayer=el.value; render(); }
    else if(a==='alias'){ S._aliasDraft=S._aliasDraft||{}; if(el.value) S._aliasDraft[el.dataset.n]=el.value; else delete S._aliasDraft[el.dataset.n]; }
    else if(a==='packfile') readJsonFile(el, packRead);
    else if(a==='rcfile'){ const fs=[...(el.files||[])].filter(f=>/^image\//.test(f.type)); el.value=''; if(fs.length) addReceipts(fs); }
    else if(a==='rcf'){ const k=el.dataset.k; let v=el.value; if(k==='amount'||k==='nights') v=Number(String(v).replace(/[^\d]/g,''))||0;
      updateCase(c=>{ const r=(c.receipts||[]).find(x=>x.id===el.dataset.id); if(r){ r[k]=v; if(k!=='note') r.edited=true; } }); render(); }
    else if(a==='es' && (el.type==='checkbox'||el.tagName==='SELECT')){ editorField(el); if(el.dataset.k==='dlref') render(); }
    else if(a==='himport') readJsonFile(el, d=>{ if(!d||!Array.isArray(d.cases)){ toast('처리 이력 파일이 아닙니다.'); return; }
      const cur=cases(); const ids=new Set(cur.map(c=>c.id)); const add=d.cases.filter(c=>c&&c.id&&!ids.has(c.id)); saveCases(add.concat(cur));
      if(d.notes||d.rejects){ const per=personal(); per.notes=Object.assign({}, d.notes||{}, per.notes);
        per.rejects=per.rejects||{}; for(const k in (d.rejects||{})){ const ids=new Set((per.rejects[k]||[]).map(x=>x.id)); per.rejects[k]=(per.rejects[k]||[]).concat((d.rejects[k]||[]).filter(x=>x&&x.id&&!ids.has(x.id))); }
        savePersonal(per); }
      toast(`처리 이력 ${add.length}건을 가져왔습니다.`); render(); });
    else if(a==='pimport') readJsonFile(el, d=>{ if(!d||!Array.isArray(d.procedures)){ toast('개인 절차 파일이 아닙니다.'); return; }
      const per=personal(); const ids=new Set(d.procedures.map(p=>p.id)); per.procedures=per.procedures.filter(p=>!ids.has(p.id)).concat(d.procedures.filter(p=>p&&p.id));
      if(d.notes) per.notes=Object.assign({}, per.notes, d.notes); savePersonal(per); toast(`개인 절차 ${d.procedures.length}건을 가져왔습니다.`); render(); });
  });
  panel.addEventListener('input', e=>{
    const el=e.target; const a=el.dataset&&el.dataset.a;
    if(a==='formsin'){ S.formsQ=el.value; renderFormsList(); return; }
    if(a==='tokg'){ S._tok=el.value.trim(); return; }
    if(a==='cfg'){ const c=S._cfgDraft=S._cfgDraft||JSON.parse(JSON.stringify(S.cfg)); const [g,k]=el.dataset.p.split('.'); c[g]=c[g]||{}; c[g][k]=el.value; return; }
    if(a==='cfgerp'){ const c=S._cfgDraft=S._cfgDraft||JSON.parse(JSON.stringify(S.cfg)); c.erp=Object.assign({}, c.erp||{}, {hosts:el.value.split('\n').map(x=>x.trim()).filter(Boolean)}); return; }
    if(a==='cfghol'){ const c=S._cfgDraft=S._cfgDraft||JSON.parse(JSON.stringify(S.cfg)); c.holidays=c.holidays||{};
      c.holidays.extra=el.value.split('\n').map(l=>l.trim().match(/^(\d{4}-\d{2}-\d{2})\s*(.*)$/)).filter(Boolean).map(m=>({date:m[1], name:m[2]||'기관 휴일'})); return; }
    if(a==='pnote'){ const per=personal(); if(el.value.trim()) per.notes[S.procId]=el.value; else delete per.notes[S.procId]; savePersonal(per); }
    else if(a==='cnote'){ updateCase(c=>{ c.note=el.value; }); }
    else if(a==='ef' || (a==='es' && el.type!=='checkbox' && el.tagName!=='SELECT')) editorField(el);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// ① 업무 달력 — 진행 중인 모든 건의 기한을 한 달 달력과 '이번 주 할 일'로
// ═══════════════════════════════════════════════════════════════════════════
function allDeadlines(){
  const out=[];
  cases().filter(c=>c.status!=='done').forEach(c=>{ const p=getProc(c.procId); if(!p) return;
    (p.steps||[]).forEach((s,i)=>{ if((c.checks||{})[i]) return; const due=stepDue(s,c.dates); if(!due) return;
      out.push({date:due, caseId:c.id, procId:p.id, icon:p.icon||'📌', proc:shortTitle(p.title), step:s.t, i, optional:!!s.optional}); }); });
  return out.sort((a,b)=>a.date<b.date?-1:a.date>b.date?1:0);
}
function weekRange(d){ const [y,m,dd]=d.split('-').map(Number); const w=new Date(y,m-1,dd).getDay(); const mon=addDays(d,-((w+6)%7)); return [mon, addDays(mon,6)]; }
function calView(){
  const t=today(); if(!S.calYM){ const [y,m]=t.split('-').map(Number); S.calYM={y, m}; }
  const {y,m}=S.calYM; const first=`${y}-${String(m).padStart(2,'0')}-01`;
  const startW=new Date(y,m-1,1).getDay(); const days=new Date(y,m,0).getDate();
  const ev=allDeadlines(); const by={}; ev.forEach(e=>{ (by[e.date]=by[e.date]||[]).push(e); });
  const cells=[];
  for(let i=0;i<startW;i++) cells.push(`<div class="sec-cal-c out"></div>`);
  for(let d=1; d<=days; d++){ const ds=`${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const w=(startW+d-1)%7; const hol=S.holidays[ds]; const list=by[ds]||[];
    const cls=['sec-cal-c', ds===t?'today':'', w===0||hol?'sun':'', w===6&&!hol?'sat':'', ds<t&&list.length?'past':''].filter(Boolean).join(' ');
    cells.push(`<div class="${cls}"><div class="sec-cal-d"><b>${d}</b>${hol?`<span class="sec-cal-h">${esc(hol)}</span>`:''}</div>`+
      list.slice(0,3).map(e=>`<button class="sec-cal-e${e.date<t?' over':''}${e.optional?' opt':''}" data-a="case" data-id="${esc(e.caseId)}" title="${esc(e.proc+' — '+e.step)}">${esc(e.icon)} ${esc(e.proc)}</button>`).join('')+
      (list.length>3?`<span class="sec-cal-more">+${list.length-3}</span>`:'')+`</div>`); }
  const [ws,we]=weekRange(t);
  const over=ev.filter(e=>e.date<t && !e.optional), week=ev.filter(e=>e.date>=t && e.date<=we), next=ev.filter(e=>e.date>we && e.date<=addDays(we,7));
  const row=e=>{ const dd=dday(e.date); return `<button class="sec-next" data-a="case" data-id="${esc(e.caseId)}"><span class="sec-next-ic">${esc(e.icon)}</span>`+
    `<span class="sec-next-m"><span class="sec-next-t">${esc(e.proc)}</span><span class="sec-next-s">${esc(e.i+1+'. '+e.step)}</span></span>`+
    `<span class="sec-dd ${dd.cls}">${esc(fmtDate(e.date))} · ${dd.label}</span>${offHtml(e.date)}</button>`; };
  const sec=(h,arr,empty)=>`<div class="sec-card-h" style="margin-top:6px;">${h} <span class="sec-sub">${arr.length}건</span></div>`+
    (arr.length?`<div class="sec-next-list">${arr.map(row).join('')}</div>`:`<div class="sec-hint">${empty}</div>`);
  return `<div class="sec-layout sec-cal-layout"><div class="sec-main"><div class="sec-card">`+
    `<div class="sec-cal-top"><button class="sec-btn sm ghost" data-a="calmove" data-d="-1" aria-label="이전 달">‹</button>`+
    `<b class="sec-cal-title">${y}년 ${m}월</b><button class="sec-btn sm ghost" data-a="calmove" data-d="1" aria-label="다음 달">›</button>`+
    `<button class="sec-btn sm ghost" data-a="calmove" data-d="0">오늘</button><span class="sec-sp"></span>`+
    `<button class="sec-btn sm" data-a="calics" ${ev.length?'':'disabled'}>📅 전체 기한 캘린더(.ics)</button></div>`+
    `<div class="sec-cal" role="grid" aria-label="${y}년 ${m}월 업무 기한">${'일월화수목금토'.split('').map((w,i)=>`<div class="sec-cal-w${i===0?' sun':i===6?' sat':''}">${w}</div>`).join('')}${cells.join('')}</div>`+
    `<div class="sec-hint">처리 중인 건의 단계 기한이 표시됩니다(기준일을 넣은 건만). 빨간 날은 일요일·공휴일·기관 휴일입니다.</div></div></div>`+
    `<aside class="sec-side"><div class="sec-card">`+
      (over.length?sec('⏰ 기한 지남',over,''):'')+sec('📌 이번 주 할 일',week,'이번 주에 기한이 있는 일이 없습니다.')+sec('🗓 다음 주',next,'다음 주 기한이 없습니다.')+
    `</div></aside></div>`;
}
function calIcs(){
  const ev=allDeadlines(); if(!ev.length){ toast('기한이 있는 진행 건이 없습니다.'); return; }
  const o=S.cfg.org||{};
  const body=ev.map(e=>{ const d=e.date.replace(/-/g,''), nx=addDays(e.date,1).replace(/-/g,'');
    return ['BEGIN:VEVENT',`UID:${e.caseId}-${e.i}@secretary`,'DTSTAMP:'+new Date().toISOString().replace(/[-:]/g,'').slice(0,15)+'Z',
      'DTSTART;VALUE=DATE:'+d,'DTEND;VALUE=DATE:'+nx,'SUMMARY:'+icsEsc(`[서무] ${e.proc} — ${e.step.replace(/[.。]$/,'').slice(0,50)}`),'END:VEVENT'].join('\r\n'); });
  const ics=['BEGIN:VCALENDAR','VERSION:2.0',`PRODID:-//${o.short||'ORG'}//Secretary//KO`,'CALSCALE:GREGORIAN',...body,'END:VCALENDAR'].join('\r\n');
  const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([ics],{type:'text/calendar;charset=utf-8'}));
  a.download=`서무비서_전체기한_${today()}.ics`; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000);
  toast(`📅 기한 ${ev.length}건을 캘린더 파일로 받았습니다.`, 3600);
}

// ═══════════════════════════════════════════════════════════════════════════
// ② 증빙(영수증) 첨부·인식 — 사진에서 날짜·금액을 읽어 기준일·초안·증빙 점검에 반영
//   원본 이미지는 서버에 저장하지 않는다(AI 분석 후 버림). 브라우저에는 작은 미리보기만 남긴다.
// ═══════════════════════════════════════════════════════════════════════════
const RC_KINDS=['운임','숙박','식비','회의비','물품','기타'];
const RC_PAY=['법인카드','개인카드','현금','기타','알수없음'];
const RC_RE=/영수증|매출전표|세금계산서|승차권|탑승권|증빙|거래명세서/;
function wantsReceipts(p){ return (p.steps||[]).some(s=>(s.docs||[]).some(d=>RC_RE.test(d))) || ['corp-card','event','daily-expense'].includes(p.id); }
function receipts(c){ return (c&&c.receipts)||[]; }
function won(n){ return (Number(n)||0).toLocaleString('ko-KR'); }
function imgToJpeg(file, max, q){
  return new Promise((res,rej)=>{ const url=URL.createObjectURL(file); const im=new Image();
    im.onload=()=>{ const s=Math.min(1, max/Math.max(im.width, im.height)); const cv=document.createElement('canvas');
      cv.width=Math.round(im.width*s); cv.height=Math.round(im.height*s); const g=cv.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,cv.width,cv.height);
      g.drawImage(im,0,0,cv.width,cv.height); URL.revokeObjectURL(url); res(cv.toDataURL('image/jpeg', q)); };
    im.onerror=()=>{ URL.revokeObjectURL(url); rej(new Error('이미지를 열 수 없습니다.')); }; im.src=url; });
}
async function addReceipts(files){
  const p=getProc(S.procId); if(!p||!files||!files.length) return;
  ensureCase(); const n0=receipts(curCase()).length;
  if(n0+files.length>20){ toast('한 건에 증빙은 20장까지 넣을 수 있습니다.'); return; }
  S.rcBusy=(S.rcBusy||0)+files.length; render();
  const year=((curCase().dates||{}).start||today()).slice(0,4);
  for(const f of files){
    const r={id:uid(), name:String(f.name||'증빙').slice(0,60), date:'', end_date:'', amount:0, vendor:'', kind:'기타', payment:'알수없음', nights:0, route:'', items:'', note:'', confidence:'', ai:false};
    try{
      r.thumb=await imgToJpeg(f, 220, .7);
      if(S.ai.available){
        const big=await imgToJpeg(f, 1600, .85);
        const resp=await fetch('/api/secretary/ai/receipt',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:big, context:p.title, year})});
        const d=await resp.json();
        if(d.success){ Object.assign(r, d.receipt, {ai:true}); } else { r.note=d.error||'인식하지 못했습니다 — 직접 입력하세요.'; }
      }
    }catch(e){ r.note='이미지를 읽지 못했습니다 — 직접 입력하세요.'; }
    updateCase(c=>{ (c.receipts=c.receipts||[]).push(r); });
    S.rcBusy--; render();
  }
  // 영수증 날짜로 비어 있는 기준일 채우기(출장: 첫날~마지막 날, 그 밖: 첫 날짜)
  const c=curCase(); const ds=receipts(c).flatMap(x=>[x.date, x.end_date]).filter(Boolean).sort();
  const keys=(p.dates||[]).map(d=>d.k);
  if(ds.length && keys.length && !Object.keys(c.dates||{}).length){
    const fill={}; fill[keys[0]]=ds[0]; if(keys[1]) fill[keys[1]]=ds[ds.length-1];
    updateCase(x=>{ x.dates=fill; });
    S.dateNote='영수증 날짜로 '+(p.dates||[]).filter(d=>fill[d.k]).map(d=>`${d.l} ${fmtDate(fill[d.k])}`).join(' · ');
    render();
  }
}
// 증빙 점검 — 규정 근거 점검 항목을 '자동으로' 미리 확인해 주는 부분
function receiptChecks(p, c){
  const rs=receipts(c); if(!rs.length) return [];
  const out=[]; const d=(c&&c.dates)||{};
  const trip=['domestic-trip','overseas-trip','training'].includes(p.id);
  if(trip){
    if(!rs.some(r=>r.kind==='운임')) out.push(['warn','운임(승차권·항공권) 증빙이 아직 없습니다.']);
    const nights=d.start&&d.end?Math.round((new Date(d.end)-new Date(d.start))/86400000):0;
    if(nights>0 && !rs.some(r=>r.kind==='숙박')) out.push(['warn',`출장이 ${nights}박인데 숙박 영수증이 없습니다(자가 숙박이면 사유를 적어 두세요).`]);
    if(d.start&&d.end) rs.filter(r=>r.date && (r.date<addDays(d.start,-1) || r.date>addDays(d.end,1)))
      .forEach(r=>out.push(['warn',`${r.vendor||r.name}: 이용일 ${fmtDate(r.date)}이 출장 기간(${fmtDate(d.start)}~${fmtDate(d.end)}) 밖입니다.`]));
  }
  if(['domestic-trip','overseas-trip','corp-card','event'].includes(p.id)){
    const non=rs.filter(r=>r.payment==='개인카드'||r.payment==='현금');
    if(non.length) out.push(['warn',`법인카드가 아닌 결제 ${non.length}건 — 법인카드를 쓰지 못한 사유를 적어 두세요(「여비규정」 제8조).`]);
  }
  rs.filter(r=>!r.date||!r.amount).forEach(r=>out.push(['info',`${r.vendor||r.name}: 날짜·금액을 확인해 입력하세요.`]));
  rs.filter(r=>r.confidence==='low'||r.note).forEach(r=>{ if(r.note) out.push(['info',`${r.vendor||r.name}: ${r.note}`]); });
  if(!out.some(x=>x[0]==='warn')) out.unshift(['ok','증빙 점검에서 걸리는 항목이 없습니다.']);
  return out;
}
function receiptHtml(p, c){
  if(!wantsReceipts(p)) return '';
  const rs=receipts(c); const busy=S.rcBusy||0;
  const sums={}; rs.forEach(r=>{ sums[r.kind]=(sums[r.kind]||0)+(Number(r.amount)||0); });
  const total=rs.reduce((a,r)=>a+(Number(r.amount)||0),0);
  const rows=rs.map(r=>`<div class="sec-rc">`+(r.thumb?`<img class="sec-rc-img" src="${esc(r.thumb)}" alt="${esc(r.name)}">`:`<span class="sec-rc-img ph">🧾</span>`)+
    `<div class="sec-rc-f">`+
      `<label><span>날짜</span><input type="date" value="${esc(r.date)}" data-a="rcf" data-id="${esc(r.id)}" data-k="date"></label>`+
      `<label><span>금액(원)</span><input inputmode="numeric" value="${r.amount?esc(won(r.amount)):''}" data-a="rcf" data-id="${esc(r.id)}" data-k="amount" placeholder="0"></label>`+
      `<label><span>가맹점</span><input value="${esc(r.vendor)}" data-a="rcf" data-id="${esc(r.id)}" data-k="vendor" placeholder="코레일"></label>`+
      `<label><span>종류</span><select data-a="rcf" data-id="${esc(r.id)}" data-k="kind">${RC_KINDS.map(k=>`<option ${r.kind===k?'selected':''}>${k}</option>`).join('')}</select></label>`+
      `<label><span>결제</span><select data-a="rcf" data-id="${esc(r.id)}" data-k="payment">${RC_PAY.map(k=>`<option ${r.payment===k?'selected':''}>${k}</option>`).join('')}</select></label>`+
      (r.kind==='숙박'?`<label><span>숙박 지역</span><select data-a="rcf" data-id="${esc(r.id)}" data-k="region"><option value="">선택</option>${lodgingCaps().map(x=>`<option ${r.region===x.name?'selected':''} value="${esc(x.name)}">${esc(x.name)} (${won(x.cap)})</option>`).join('')}</select></label>`+
        `<label><span>박수</span><input inputmode="numeric" value="${r.nights?esc(r.nights):''}" data-a="rcf" data-id="${esc(r.id)}" data-k="nights" placeholder="1"></label>`:'')+
    `</div><div class="sec-rc-m">${r.ai?`<span class="sec-layer org" title="AI가 읽은 값 — 확인 후 고쳐 주세요">✦ AI ${r.confidence==='high'?'인식':'인식(확인 필요)'}</span>`:''}`+
      `${r.route?`<span class="sec-sub">${esc(r.route)}</span>`:''}${r.items?`<span class="sec-sub">${esc(r.items)}</span>`:''}`+
      `<button class="sec-x" data-a="rcdel" data-id="${esc(r.id)}" aria-label="증빙 삭제">✕</button></div></div>`).join('');
  const checks=receiptChecks(p, c);
  return `<div class="sec-card sec-rcard"><div class="sec-card-h">🧾 증빙 첨부 <span class="sec-sub">${S.ai.available?'영수증·승차권 사진을 올리면 AI가 날짜·금액을 읽습니다':'사진을 올리고 날짜·금액을 입력하세요(AI 인식은 관리자가 AI 키를 설정하면 켜집니다)'}</span></div>`+
    `<label class="sec-drop"><input type="file" accept="image/*" multiple data-a="rcfile" hidden>`+
      `<span>📷 사진 선택 또는 촬영</span><span class="sec-sub">여러 장 가능 · 사진은 서버에 저장하지 않습니다${S.ai.available?' (AI 분석에만 사용)':''}</span></label>`+
    (busy?`<div class="assist-loading sm"><div class="spinner"></div><span>증빙 ${busy}장 읽는 중...</span></div>`:'')+
    (rs.length?`<div class="sec-rc-list">${rows}</div>`+
      `<div class="sec-rc-sum">합계 <b>${won(total)}원</b> `+Object.entries(sums).map(([k,v])=>`<span class="sec-doc">${esc(k)} ${won(v)}원</span>`).join('')+`</div>`+
      `<div class="sec-rc-chk">`+checks.map(([lv,t])=>`<div class="sec-rc-ck ${lv}">${lv==='ok'?'✓':lv==='warn'?'⚠':'ℹ'} ${esc(t)}</div>`).join('')+`</div>`:'')+`</div>`;
}
// 초안 자동 채움 — 증빙에서 운임·숙박 합계, 증빙 목록, 사용일·장소·금액
function receiptDraftVals(key, c){
  const rs=receipts(c); if(!rs.length) return {};
  const sum=k=>rs.filter(r=>r.kind===k).reduce((a,r)=>a+(Number(r.amount)||0),0);
  const cnt={}; rs.forEach(r=>{ cnt[r.kind]=(cnt[r.kind]||0)+1; });
  const label={운임:'승차권·운임 영수증',숙박:'숙박 영수증',식비:'식비 영수증',회의비:'회의비 영수증',물품:'물품 영수증',기타:'기타 증빙'};
  const pays=[...new Set(rs.map(r=>r.payment).filter(x=>x&&x!=='알수없음'))];
  const v={};
  if(key==='travel-settle'){ if(sum('운임')) v.fare=won(sum('운임')); if(sum('숙박')) v.lodging=won(sum('숙박'));
    if(pays.length) v.card=pays.join(' / '); v.evid=Object.entries(cnt).map(([k,n])=>`${label[k]} ${n}매`).join(', '); }
  if(key==='card-evidence'){ const r=rs[0]; if(r.vendor) v.place=r.vendor; if(r.amount) v.amount=won(rs.reduce((a,x)=>a+(Number(x.amount)||0),0)); if(r.date) v.date=fmtLong(r.date); }
  return v;
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ AI 상황 이해 — 등록 절차에 없는 표현·여러 업무가 섞인 문장을 절차 목록 안에서 해석
// ═══════════════════════════════════════════════════════════════════════════
const COMPOUND=/하고|가서|그리고|및|겸|하면서|이랑|랑 |, |그 다음|다음에|후에|전에/;
// 여러 업무가 섞인 문장 — 트리거로 각각 찾은 절차를 문장에 나온 순서대로(같은 분류는 최고점 하나)
function localPlan(q, matches){
  if(!COMPOUND.test(q)) return null;
  const qn=norm(q); const seen=new Set(); const out=[];
  matches.filter(m=>m.hit.length).forEach(m=>{ if(seen.has(m.p.category)) return; seen.add(m.p.category);
    out.push({id:m.p.id, pos:Math.min(...m.hit.map(h=>qn.indexOf(norm(h))).filter(i=>i>=0))}); });
  return out.length>=2 ? out.sort((a,b)=>a.pos-b.pos).slice(0,4).map(x=>x.id) : null;
}
function needAI(q, matches){
  if(!S.ai.available) return false;
  if(!matches.length) return true;
  if(COMPOUND.test(q)) return !localPlan(q, matches);   // 섞인 문장인데 절차를 하나밖에 못 찾았으면 AI로
  return matches[0].sc<4;      // 약한 매칭(짧은 단어 하나)이면 AI로 확인
}
async function aiUnderstand(q, force){
  if(!S.ai.available || (!force && !needAI(q, S.matches))) return;
  S.aiRes={q, loading:true}; render();
  const procs=allProcs().map(p=>({id:p.id, title:p.title, summary:p.summary||'', triggers:(p.triggers||[]).slice(0,15)}));
  try{ const r=await fetch('/api/secretary/ai/understand',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q, procedures:procs})});
    const d=await r.json(); if(S.query!==q) return;
    S.aiRes=d.success?{q, ids:(d.procedure_ids||[]).filter(id=>getProc(id)), summary:d.summary, uncovered:d.uncovered}:{q, error:d.error||'AI가 이해하지 못했습니다.'};
  }catch(e){ if(S.query===q) S.aiRes={q, error:'AI에 연결하지 못했습니다.'}; }
  // 등록 절차를 못 찾았는데 AI가 하나를 골랐다면 바로 그 절차로
  if(S.view==='nomatch' && S.aiRes.ids && S.aiRes.ids.length===1){ openWithDates(S.aiRes.ids[0], q); return; }
  render();
}
function openWithDates(pid, q){
  const p=getProc(pid); if(!p) return; const ds=assignDates(p, q||S.query); S.dateNote='';
  if(ds){ const ex=cases().find(x=>x.procId===p.id && x.status!=='done'); const c=(ex&&!Object.keys(ex.dates||{}).length)?ex:null;
    S.procId=p.id; S.caseId=c?c.id:null; ensureCase(); updateCase(x=>{ x.dates=Object.assign({}, x.dates||{}, ds); });
    S.dateNote=(p.dates||[]).filter(d=>ds[d.k]).map(d=>`${d.l} ${fmtDate(ds[d.k])}`).join(' · ');
    selectProc(p.id,{keepQuery:true, caseId:S.caseId, keepNote:true}); return; }
  selectProc(p.id,{keepQuery:true});
}
function aiBox(){
  const a=S.aiRes; if(!a || a.q!==S.query) return S.ai.available&&S.query?`<div class="sec-ai-re"><button class="sec-linkbtn" data-a="aiask">✦ AI로 상황 다시 이해하기</button></div>`:'';
  if(a.loading) return `<div class="sec-notice ai"><div class="assist-loading sm"><div class="spinner"></div><span>✦ AI가 상황을 이해하는 중...</span></div></div>`;
  if(a.error) return `<div class="sec-notice ai">✦ ${esc(a.error)}</div>`;
  if(!a.ids.length) return `<div class="sec-notice ai">✦ ${esc(a.summary||'등록된 절차 가운데 맞는 것을 찾지 못했습니다.')}${a.uncovered?` <span class="sec-sub">(${esc(a.uncovered)})</span>`:''}</div>`;
  const ps=a.ids.map(getProc).filter(Boolean);
  if(ps.length===1 && ps[0].id===S.procId) return `<div class="sec-notice ai">✦ AI도 이 절차로 이해했습니다 — ${esc(a.summary)}</div>`;
  const plan=ps.length>1?`<div class="sec-plan">`+ps.map((p,n)=>{ const c=cases().find(x=>x.procId===p.id&&x.status!=='done'); const nx=c?nextStep(c,p):{i:0,s:p.steps[0]};
      return `<div class="sec-plan-i"><span class="sec-plan-n">${n+1}</span><div class="sec-plan-m"><b>${esc(p.icon||'')} ${esc(shortTitle(p.title))}</b>`+
        `<span class="sec-sub">${nx&&nx.s?'먼저: '+esc(nx.s.t.slice(0,70)):''}</span></div><button class="sec-btn sm" data-a="aiopen" data-id="${esc(p.id)}">${p.id===S.procId?'보는 중':'열기'}</button></div>`; }).join('')+`</div>`:
    `<div class="sec-row"><button class="sec-btn sm primary" data-a="aiopen" data-id="${esc(ps[0].id)}">${esc(ps[0].icon||'')} ${esc(shortTitle(ps[0].title))} 열기</button></div>`;
  return `<div class="sec-notice ai"><div>${a.local?'🧩 <b>여러 업무가 섞인 상황</b>':'✦ <b>AI가 이해한 상황</b>'} — ${esc(a.summary)}${ps.length>1?` <span class="sec-sub">절차 ${ps.length}개를 순서대로 처리하세요</span>`:''}</div>${plan}`+
    (a.uncovered?`<div class="sec-sub">등록 절차로 안내되지 않는 부분: ${esc(a.uncovered)}</div>`:'')+`</div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ② 결재 전 사전 감사 — 규칙 감사(서버) + AI 감사(키가 있을 때). 근거 조문이 없는 AI 지적은 '참고'로만.
// ═══════════════════════════════════════════════════════════════════════════
const LODGING_CAPS=[{name:'서울특별시',cap:100000},{name:'광역시·제주',cap:80000},{name:'그 밖의 지역',cap:70000}];
function lodgingCaps(){ const a=(S.cfg.audit||{}).lodging_caps; return Array.isArray(a)&&a.length?a:LODGING_CAPS; }
const SEV={high:['높음','over'],medium:['보통','warn'],low:['참고','info']};
function procDraftKeys(p){ return [...new Set((p.steps||[]).map(s=>s.draft).filter(k=>k&&allDrafts()[k]))]; }
// 감사 입력 — 바뀌었는지(다시 감사 필요) 비교할 때도 쓴다. 사진(thumb)은 보내지 않는다.
function auditInput(p, c){
  c=c||{}; const dv={}, dt={};
  procDraftKeys(p).forEach(k=>{ const saved=(c.drafts||{})[k]; if(!saved) return;   // '이력에 저장'한 초안만 감사
    const d=allDrafts()[k]; const v=Object.assign({}, draftAuto(d,c,p), receiptDraftVals(k,c), saved); dv[k]=v; dt[d.title||k]=fillTemplate(d.template, v); });
  return {dates:c.dates||{}, checks:c.checks||{}, note:c.note||'', draft_values:dv, drafts:dt,
    receipts:receipts(c).map(r=>{ const o=Object.assign({}, r); delete o.thumb; delete o.name; return o; })};
}
function auditSig(inp){ const x=JSON.stringify(inp); let h=0; for(let i=0;i<x.length;i++) h=(h*31+x.charCodeAt(i))|0; return String(h); }
function auditOpen(c){ const a=c&&c.audit; if(!a) return []; return (a.findings||[]).filter(f=>!(a.ack||{})[f.id]); }
async function runAudit(){
  const p=getProc(S.procId); if(!p) return; ensureCase(); const c=curCase();
  const inp=auditInput(p, c); const sig=auditSig(inp); const id=c.id;
  const proc={}; Object.keys(p).filter(k=>k[0]!=='_').forEach(k=>proc[k]=p[k]);
  S.auditBusy=id; render();
  try{ const r=await fetch('/api/secretary/audit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({procedure:proc, case:inp, today:today(), ai:!!S.ai.available})});
    const d=await r.json(); if(!d.success) throw new Error(d.error||'감사하지 못했습니다.');
    const prev=(c.audit&&c.audit.ack)||{};
    updateCase(x=>{ x.audit={at:today(), sig, findings:d.findings, counts:d.counts, summary:d.summary||'', ai_used:!!d.ai_used, ai_error:d.ai_error||'',
      ack:Object.fromEntries(Object.entries(prev).filter(([k])=>d.findings.some(f=>f.id===k)))}; });
    toast(d.findings.length?`지적 ${d.findings.length}건 — 높음 ${d.counts.high} · 보통 ${d.counts.medium} · 참고 ${d.counts.low}`:'걸리는 항목이 없습니다.');
  }catch(e){ toast(e.message||'감사 서버에 연결하지 못했습니다.'); }
  S.auditBusy=null; render();
}
function auditHtml(p, c){
  const a=c&&c.audit; const busy=c&&S.auditBusy===c.id;
  const stale=a && a.sig!==auditSig(auditInput(p, c));
  const intro=`<span class="sec-sub">${S.ai.available?'기한·숙박비 상한·증빙·초안 필수 항목을 규칙으로 점검하고, AI 감사관이 근거 조문과 대조합니다':'기한·숙박비 상한·증빙·초안 필수 항목을 규칙으로 점검합니다(AI 감사는 관리자가 AI 키를 설정하면 켜집니다)'}</span>`;
  const btn=`<button class="sec-btn sm ${a?'':'primary'}" data-a="audit" ${busy?'disabled':''}>${a?'🔁 다시 감사':'🔍 감사 실행'}</button>`;
  let body='';
  if(busy) body=`<div class="assist-loading sm"><div class="spinner"></div><span>${S.ai.available?'규칙 점검 + AI 감사관이 조문과 대조하는 중...':'점검하는 중...'}</span></div>`;
  else if(!a) body=`<div class="sec-hint">결재를 올리기 전에 눌러 보세요. 증빙을 첨부하고 초안을 '이력에 저장'해 두면 함께 점검합니다.</div>`;
  else {
    const fs=a.findings||[]; const ack=a.ack||{}; const open=auditOpen(c);
    body=(stale?`<div class="sec-rc-ck warn">✎ 감사 뒤 기준일·체크·증빙·초안이 바뀌었습니다 — 다시 감사하세요.</div>`:'')+
      (a.ai_error?`<div class="sec-rc-ck info">✦ ${esc(a.ai_error)} 규칙 점검 결과만 보여 드립니다.</div>`:'')+
      (fs.length?`<div class="sec-au-sum">${a.at} 감사 · 남은 지적 <b>${open.length}</b>/${fs.length}건${a.ai_used?' · ✦ AI 감사 포함':''}${a.summary?` — ${esc(a.summary)}`:''}</div>`+
        `<div class="sec-au-list">`+fs.map(f=>{ const [lb,cls]=SEV[f.severity]||SEV.low; const done=!!ack[f.id];
          return `<div class="sec-au ${cls}${done?' done':''}"><div class="sec-au-h"><span class="sec-au-sev ${cls}">${lb}</span><b class="sec-au-t">${esc(f.title)}</b>`+
            `<span class="sec-au-src">${f.source==='ai'?'✦ AI':'규칙'}</span></div>`+
            (f.detail?`<div class="sec-au-d">${esc(f.detail)}</div>`:'')+(f.fix?`<div class="sec-au-fix">→ ${esc(f.fix)}</div>`:'')+
            `<div class="sec-au-a">`+(f.basis?`<button class="sec-mini" data-a="openreg" data-reg="${esc(f.basis.reg)}" data-art="${esc(f.basis.art||'')}" data-q="${esc(f.basis.q||'')}">📖 ${esc(basisLabel(f.basis))}</button>`:(f.source==='ai'?'<span class="sec-sub">근거 조문 없음 — 참고만 하세요</span>':''))+
            `<button class="sec-mini ${done?'':'primary'}" data-a="auack" data-id="${esc(f.id)}">${done?'↩ 되돌리기':'✓ 확인·조치함'}</button></div></div>`; }).join('')+`</div>`
      :`<div class="sec-rc-ck ok">✓ ${a.at} 감사에서 걸리는 항목이 없습니다.${a.ai_used&&a.summary?' '+esc(a.summary):''}</div>`);
  }
  return `<div class="sec-card sec-audit"><div class="sec-card-h">🔍 결재 전 사전 감사 ${intro}</div>${body}<div class="sec-row">${btn}<span class="sec-sub">감사는 결재를 대신하지 않습니다. 지적의 📖 근거를 열어 원문을 확인하세요.</span></div></div>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ③ 규정 개정 영향 분석 — 이전 개정본과 조문 단위 비교 → 영향받는 절차 단계 → 고칠 안을 골라 기관 층에 적용
// ═══════════════════════════════════════════════════════════════════════════
function revisedOf(reg){ const n=norm(reg); return (S.revised||[]).find(r=>norm(r.title)===n || norm(r.title).includes(n) || n.includes(norm(r.title)))||null; }
function impactCard(){
  const rv=S.revised||[];
  return `<div class="sec-card"><div class="sec-card-h">🔬 규정 개정 영향 분석 <span class="sec-sub">개정본을 /upload로 올리면 이전본과 조문 단위로 비교해, 고쳐야 할 절차 단계와 고칠 안을 보여 줍니다</span></div>`+
    (rv.length?`<div class="sec-imp-regs">`+rv.map(r=>`<button class="sec-chip sm" data-a="impact" data-reg="${esc(r.title)}">${esc(r.title)} <span class="sec-sub">${esc(r.from||'이전')} → ${esc(r.revision||'현재')}</span></button>`).join('')+`</div>`
      :`<div class="sec-hint">아직 화면으로 개정된 규정이 없습니다. 개정본을 <a href="/upload" target="_blank" rel="noopener">/upload</a>로 올리면 여기에 나타납니다.</div>`)+`</div>`;
}
const IMP_KIND={changed:['내용 개정','warn'],moved:['조문 번호 이동','info'],removed:['조문 삭제','over']};
async function openImpact(reg, withAI){
  const body=modal('secImpModal','🔬 '+esc(reg)+' 개정 영향 분석');
  body.innerHTML=`<div class="assist-loading"><div class="spinner"></div><span>${withAI?'✦ AI가 단계 문장 갱신안을 만드는 중...':'이전 개정본과 조문을 비교하는 중...'}</span></div>`;
  let d; try{ const r=await fetch('/api/secretary/impact?reg='+encodeURIComponent(reg)+(withAI?'&ai=1':'')); d=await r.json(); }catch(e){ d={success:false, error:'서버에 연결하지 못했습니다.'}; }
  if(!d.success){ body.innerHTML=`<div class="sec-notice warn">${esc(d.error||'분석하지 못했습니다.')}</div>`; return; }
  S._imp=d; renderImpact(body);
}
function impLoc(h){ return h.where==='step'?`${h.i+1}단계`:h.where==='pitfall'?`반려 점검 ${h.i+1}`:'서식'; }
function impProp(x){
  if(x.type==='art') return `근거 <b>제${esc(x.from)}조 → 제${esc(x.to)}조</b>`;
  if(x.type==='days') return `기한 <b>${esc(x.from)}일 → ${esc(x.to)}일</b>`;
  return `${x.type==='when'?'기한 문구':'문장'}${x.ai?' <span class="sec-layer org">✦ AI</span>':''}<div class="sec-imp-tx"><del>${esc(x.from)}</del><ins>${esc(x.to)}</ins></div>`;
}
function renderImpact(body){
  const d=S._imp; const ct=d.counts||{};
  const arts=`<details class="sec-imp-arts"${d.changed.length<=3?' open':''}><summary>바뀐 조문 ${ct.articles}개 — 내용 개정 ${d.changed.length} · 번호 이동 ${Object.keys(d.moved).length} · 신설 ${d.added.length} · 삭제 ${d.removed.length}</summary>`+
    d.changed.map(c=>`<div class="sec-imp-art"><b>제${esc(c.no)}조${c.to!==c.no?' → 제'+esc(c.to)+'조':''}(${esc(c.title)})</b>`+c.sents.map(x=>`<div class="sec-imp-tx">${x.old?`<del>${esc(x.old)}</del>`:''}${x.new?`<ins>${esc(x.new)}</ins>`:''}</div>`).join('')+`</div>`).join('')+
    (Object.keys(d.moved).length?`<div class="sec-sub">번호 이동: `+Object.entries(d.moved).slice(0,12).map(([a,b])=>`제${esc(a)}조→제${esc(b)}조`).join(', ')+(Object.keys(d.moved).length>12?' …':'')+`</div>`:'')+
    (d.added.length?`<div class="sec-sub">신설: `+d.added.map(x=>`제${esc(x.no)}조(${esc(x.title)})`).join(', ')+`</div>`:'')+
    (d.removed.length?`<div class="sec-sub">삭제: `+d.removed.map(x=>`제${esc(x.no)}조(${esc(x.title)})`).join(', ')+`</div>`:'')+`</details>`;
  const procs=d.procedures.map((it,pi)=>`<div class="sec-imp-p"><label class="sec-imp-ph"><input type="checkbox" data-ip="${pi}" checked> ${esc(it.icon||'📌')} <b>${esc(shortTitle(it.title))}</b> <span class="sec-layer ${it.layer}">${LAYER_LABEL[it.layer]}</span> <span class="sec-sub">기관 층으로 저장(확인 처리)</span></label>`+
    it.hits.map((h,hi)=>{ const [kl,kc]=IMP_KIND[h.kind]||IMP_KIND.changed;
      return `<div class="sec-imp-h"><div><span class="sec-au-sev ${kc}">${kl}</span> <b>${impLoc(h)}</b> · 근거 ${esc(basisLabel(h.ref))} <span class="sec-sub">${esc(String(h.text||'').slice(0,80))}</span></div>`+
        (h.proposals.length?h.proposals.map((x,xi)=>`<label class="sec-imp-x"><input type="checkbox" data-ix="${pi}.${hi}.${xi}" checked><span>${impProp(x)}<span class="sec-sub">${esc(x.why||'')}</span></span></label>`).join('')
          :`<div class="sec-sub">자동 제안 없음 — ${h.kind==='removed'?'근거 조문이 삭제되었습니다. 절차를 열어 근거를 고치세요.':'바뀐 조문과 단계 내용을 대조해 주세요.'}</div>`)+`</div>`; }).join('')+`</div>`).join('');
  const audit=(d.audit||[]).length?`<div class="sec-notice warn">🔍 사전 감사 기준(숙박비 상한 등)이 이 규정을 근거로 씁니다. 기관 설정(config.json의 <code>audit</code>)의 금액·조문 번호가 개정 내용과 맞는지 확인하세요.</div>`:'';
  body.innerHTML=`<div class="sec-imp"><div class="sec-imp-top"><b>${esc(d.reg)}</b> ${esc(d.from)} → ${esc(d.to)} · 영향받는 절차 <b>${ct.procedures}</b>개 · 갱신 제안 <b>${ct.proposals}</b>건${d.ai_used?' · ✦ AI 제안 포함':''}</div>`+
    (d.ai_error?`<div class="sec-rc-ck info">✦ ${esc(d.ai_error)}</div>`:'')+arts+audit+
    (d.procedures.length?procs:`<div class="sec-rc-ck ok">✓ 등록된 절차가 근거로 쓰는 조문은 바뀌지 않았습니다.</div>`)+
    `<div class="sec-row">`+(d.procedures.length?`<button class="sec-btn primary" data-ia="apply">선택한 제안 적용 → 기관 층 저장</button>`:'')+
      (S.ai.available&&!d.ai_used&&d.procedures.length?`<button class="sec-btn" data-ia="ai">✦ AI 문장 갱신안 받기</button>`:'')+
      `<span class="sec-sub">적용 전 원문과 대조하세요. 저장하면 이 개정을 확인한 것으로 기록되어 '재확인 필요' 알림이 사라집니다.</span></div>`+
    (S.admin.token_required?`<label class="sec-f"><span>🔑 관리자 토큰</span><input type="password" id="secTokI" autocomplete="off" value="${esc(S._tok||'')}"></label>`:'')+`</div>`;
  body.onclick=e=>{ const b=e.target.closest('[data-ia]'); if(!b) return;
    if(b.dataset.ia==='ai') openImpact(d.reg, true); else applyImpact(body); };
}
async function applyImpact(body){
  const d=S._imp; const pick=new Set([...body.querySelectorAll('[data-ix]:checked')].map(x=>x.dataset.ix));
  const keepP=new Set([...body.querySelectorAll('[data-ip]:checked')].map(x=>Number(x.dataset.ip)));
  if(!keepP.size){ toast('저장할 절차를 고르세요.'); return; }
  let raw; try{ raw=await (await fetch('/api/secretary/procedures?fresh=1')).json(); }catch(e){ toast('절차를 불러오지 못했습니다.'); return; }
  // 자리표시([[erp]] 등)를 지키기 위해 서버 원본 절차에 적용한다
  const list=JSON.parse(JSON.stringify(raw.org.procedures||[]));
  let n=0;
  d.procedures.forEach((it,pi)=>{ if(!keepP.has(pi)) return;
    let p=list.find(x=>x.id===it.id); if(!p){ const c=(raw.common.procedures||[]).find(x=>x.id===it.id); if(!c) return; p=JSON.parse(JSON.stringify(c)); list.push(p); }
    it.hits.forEach((h,hi)=>h.proposals.forEach((x,xi)=>{ if(!pick.has(`${pi}.${hi}.${xi}`)) return;
      const obj=h.where==='step'?(p.steps||[])[h.i]:(p.pitfalls||[])[h.i]; if(!obj) return;
      if(x.type==='art'){ (obj.basis||[]).forEach(b=>{ if(b.reg===h.ref.reg && String(b.art)===String(x.from)) b.art=String(x.to); }); n++; }
      else if(x.type==='days' && obj.deadline){ obj.deadline.days=x.to; n++; }
      else if(x.type==='text' && obj.t===x.from){ obj.t=x.to; n++; }
      else if(x.type==='when' && obj.when===x.from){ obj.when=x.to; n++; }
    }));
  });
  const tokI=document.getElementById('secTokI');
  if(await saveOrg(list, tokI?tokI.value.trim():'')){ closeModal('secImpModal'); toast(`제안 ${n}건을 반영해 기관 층에 저장했습니다.`, 4200); render(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// ④ 기관 집단 지식 — 처리한 건의 익명 숫자(완료까지 일수·기한 넘긴 단계·감사 항목 종류)와
//    담당자가 직접 공유한 반려 사유를 모아, 같은 업무를 처음 하는 사람에게 돌려준다.
//    이름·금액·메모·초안 내용·영수증은 보내지 않는다. 처리 이력 화면에서 끌 수 있다.
// ═══════════════════════════════════════════════════════════════════════════
const AU_KIND={due:'기한 경과', soon:'기한 임박', lodge:'숙박비 상한 초과', pay:'법인카드 외 결제', 'no-fare':'운임 증빙 누락', 'no-lodge':'숙박 증빙 누락', out:'기간 밖 증빙', draft:'초안 필수 항목 누락'};
function canShare(ignoreAvail){ return (ignoreAvail||S.insights.available) && _ls(LS_SHARE, true)!==false; }
function shareToggle(){
  if(!S.insights.available) return '';
  const on=canShare();
  return `<div class="sec-share"><span>👥 <b>기관 집단 지식</b> — 완료한 건의 처리 일수·기한을 넘긴 단계·감사 항목 종류를 <b>익명 숫자로만</b> 기관 통계에 보탭니다. 이름·금액·메모·초안·영수증은 보내지 않습니다.</span>`+
    `<button class="sec-btn sm ${on?'':'primary'}" data-a="sharetg" aria-pressed="${on}">${on?'기여 중 — 끄기':'꺼짐 — 켜기'}</button></div>`;
}
function caseFacts(c, p){
  const ds=Object.values(c.dates||{}).filter(d=>d && d<=c.doneAt).sort(); const base=ds.length?ds[ds.length-1]:c.created;
  const days=Math.max(0, Math.round((new Date(c.doneAt)-new Date(base))/86400000));
  const late=[], ontime=[];
  (p.steps||[]).forEach((s,i)=>{ const due=stepDue(s, c.dates); if(!due) return;
    const at=(c.checkAt||{})[i];
    if((c.checks||{})[i]){ if(at){ (at>due?late:ontime).push(i); } }
    else if(!s.optional && due<c.doneAt) late.push(i); });
  const kind=id=>/^no-(fare|lodge)$/.test(id)?id:String(id).split('-')[0];
  const audit=[...new Set(((c.audit||{}).findings||[]).filter(f=>f.source==='rule').map(f=>kind(f.id)).filter(k=>AU_KIND[k]))];
  return {days, late, ontime, audit};
}
function shareDone(c){
  const p=c&&getProc(c.procId); if(!p || !canShare() || c.shared) return;
  const f=caseFacts(c, p);
  fetch('/api/secretary/insights/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({type:'done', procedure:p.id}, f))})
    .then(r=>r.json()).then(d=>{ if(d.success){ updateCase(x=>{ x.shared=true; }); delete S.ins[p.id]; } }).catch(()=>{});
}
function shareReject(pid, t){
  fetch('/api/secretary/insights/event',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({type:'reject', procedure:pid, text:t})})
    .then(r=>r.json()).then(d=>{ if(d.success){ delete S.ins[pid]; toast('기관에 익명으로 공유했습니다. 고맙습니다.'); } }).catch(()=>{});
}
function loadIns(pid){
  if(!S.insights.available || S.ins[pid]) return;
  S.ins[pid]={loading:true};
  fetch('/api/secretary/insights?procedure='+encodeURIComponent(pid)).then(r=>r.json()).then(d=>{ S.ins[pid]=d.success&&d.available?d:{none:true}; if(S.view==='proc'&&S.procId===pid) render(); })
    .catch(()=>{ S.ins[pid]={none:true}; });
}
function insightHtml(p){
  if(!S.insights.available) return '';
  const d=S.ins[p.id]; if(!d){ loadIns(p.id); return ''; }
  if(d.loading||d.none) return '';
  const rows=[];
  if(d.enough){
    if(d.days) rows.push(`<li>완료까지 보통 <b>${d.days.median}일</b> · 80%가 ${d.days.p80}일 안에 끝냈습니다 <span class="sec-sub">(기준일 이후, ${d.days.n}건)</span></li>`);
    (d.late||[]).forEach(x=>{ const s=(p.steps||[])[x.i]; if(s) rows.push(`<li><b>${x.i+1}단계</b>에서 <b>${Math.round(x.rate*100)}%</b>가 기한을 넘겼습니다 <span class="sec-sub">— ${esc(s.t.slice(0,40))}…</span></li>`); });
    (d.audit||[]).slice(0,2).forEach(x=>rows.push(`<li>사전 감사에서 자주 걸린 항목: <b>${esc(AU_KIND[x.k]||x.k)}</b> <span class="sec-sub">(${x.c}건)</span></li>`));
  }
  const rs=(d.reasons||[]).slice(0,3);
  if(!rows.length && !rs.length) return `<div class="sec-card sec-ins"><div class="sec-card-h">👥 우리 기관 데이터</div><div class="sec-hint">아직 데이터가 적습니다(${d.n}/${d.min_n}건). 완료 처리한 건이 ${d.min_n}건 이상 모이면 처리 기간·자주 넘기는 기한을 알려 드립니다.</div></div>`;
  return `<div class="sec-card sec-ins"><div class="sec-card-h">👥 우리 기관 데이터 <span class="sec-sub">${d.n}건 익명 통계</span></div>`+
    (rows.length?`<ul class="sec-tips">${rows.join('')}</ul>`:`<div class="sec-hint">처리 통계는 ${d.min_n}건 이상 모이면 보여 드립니다(지금 ${d.n}건).</div>`)+
    (rs.length?`<div class="sec-ins-rj"><div class="sec-sub">담당자들이 공유한 반려 사유</div>`+rs.map(x=>`<div class="sec-ins-r">🚫 ${esc(x.t)} <span class="sec-sub">${x.c}회</span></div>`).join('')+`</div>`:'')+`</div>`;
}
function loadInsAll(){
  if(!S.insights.available || S.insAll) return; S.insAll={loading:true};
  fetch('/api/secretary/insights').then(r=>r.json()).then(d=>{ S.insAll=d; if(S.view==='manage') render(); }).catch(()=>{ S.insAll={error:'불러오지 못했습니다.'}; });
}
function insightsCard(){
  const head=`<div class="sec-card-h">👥 기관 집단 지식 <span class="sec-sub">담당자들이 완료한 건의 익명 통계 · 공유된 반려 사유를 기관 점검 항목으로 올릴 수 있습니다</span></div>`;
  if(!S.insights.available) return `<div class="sec-card">${head}<div class="sec-hint">저장소가 설정되지 않아 꺼져 있습니다. Vercel에서는 Upstash Redis(Vercel KV)를 연결하면 <code>UPSTASH_REDIS_REST_URL</code>·<code>UPSTASH_REDIS_REST_TOKEN</code>(또는 <code>KV_REST_API_URL</code>·<code>KV_REST_API_TOKEN</code>)이 생겨 켜집니다. 내부 서버는 별도 설정 없이 <code>secretary/insights.json</code>에 저장합니다.</div></div>`;
  const a=S.insAll; if(!a){ loadInsAll(); return `<div class="sec-card">${head}<div class="assist-loading sm"><div class="spinner"></div><span>불러오는 중...</span></div></div>`; }
  if(a.loading) return `<div class="sec-card">${head}<div class="assist-loading sm"><div class="spinner"></div><span>불러오는 중...</span></div></div>`;
  if(a.error||!a.available) return `<div class="sec-card">${head}<div class="sec-hint">${esc(a.error||'저장소에 연결하지 못했습니다.')}</div></div>`;
  const ents=Object.entries(a.procedures||{}).map(([id,v])=>({id,v,p:getProc(id)})).filter(x=>x.p).sort((x,y)=>y.v.n-x.v.n);
  if(!ents.length) return `<div class="sec-card">${head}<div class="sec-hint">아직 모인 데이터가 없습니다. 담당자가 절차를 <b>완료</b> 처리하거나 반려 사유를 공유하면 쌓입니다. 통계는 절차별 ${a.min_n}건 이상일 때 보입니다.</div></div>`;
  return `<div class="sec-card">${head}<div class="sec-ins-tb">`+ents.map(({id,v,p})=>{
    const late=(v.late||[])[0];
    return `<div class="sec-ins-row"><div class="sec-ins-rh"><b>${esc(p.icon||'📌')} ${esc(shortTitle(p.title))}</b> <span class="sec-sub">${v.n}건${v.enough?'':` (통계는 ${a.min_n}건부터)`}</span>`+
      (v.days?` <span class="sec-doc">보통 ${v.days.median}일 · 80% ${v.days.p80}일</span>`:'')+
      (late?` <span class="sec-doc warn">${late.i+1}단계 기한 초과 ${Math.round(late.rate*100)}%</span>`:'')+
      ((v.audit||[])[0]?` <span class="sec-doc">감사 최다: ${esc(AU_KIND[v.audit[0].k]||v.audit[0].k)}</span>`:'')+`</div>`+
      (v.reasons||[]).map(r=>`<div class="sec-ins-r">🚫 ${esc(r.t)} <span class="sec-sub">${r.c}회</span>`+
        `<button class="sec-mini primary" data-a="insrj" data-id="${esc(id)}" data-t="${esc(r.t)}" title="기관 층 절차의 반려 점검 항목으로 추가">점검 항목으로</button>`+
        `<button class="sec-mini" data-a="insdel" data-id="${esc(id)}" data-t="${esc(r.t)}">삭제</button></div>`).join('')+`</div>`; }).join('')+
    `</div><div class="sec-row"><button class="sec-btn sm ghost" data-a="insall">↻ 새로고침</button><span class="sec-sub">저장소: ${a.backend==='redis'?'Upstash Redis':'서버 파일'}</span></div></div>`;
}
async function deleteReason(pid, t, quiet){
  const tok=(document.getElementById('secTokG')||{}).value||S._tok||'';
  if(!quiet && !confirm('이 반려 사유를 기관 공유 목록에서 지울까요?')) return false;
  try{ const r=await fetch('/api/secretary/insights/reason',{method:'DELETE',headers:{'Content-Type':'application/json','X-Upload-Token':tok},body:JSON.stringify({procedure:pid, text:t})});
    const d=await r.json(); if(!d.success){ toast(d.error||'지우지 못했습니다.'); return false; }
  }catch(e){ toast('서버에 연결하지 못했습니다.'); return false; }
  S.insAll=null; delete S.ins[pid]; if(!quiet){ toast('지웠습니다.'); render(); } return true;
}
async function promoteReason(pid, t){
  let raw; try{ raw=await (await fetch('/api/secretary/procedures?fresh=1')).json(); }catch(e){ toast('절차를 불러오지 못했습니다.'); return; }
  const list=JSON.parse(JSON.stringify(raw.org.procedures||[]));
  let p=list.find(x=>x.id===pid);
  if(!p){ const c=[...(raw.common.procedures||[])].find(x=>x.id===pid); if(!c){ toast('기관·공통 절차에서만 올릴 수 있습니다.'); return; } p=JSON.parse(JSON.stringify(c)); list.push(p); }
  p.pitfalls=p.pitfalls||[]; if(!p.pitfalls.some(x=>norm(x.t)===norm(t))) p.pitfalls.push({t});
  if(await saveOrg(list)){ await deleteReason(pid, t, true); toast('기관 점검 항목으로 올렸습니다.'); render(); }
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑥ 한글 서식 작성(kordoc) — 공문 '보고서' 서식 생성 · 표준 간이기안문 · 우리 기관 서식(.hwpx)에 채우기
//    서버에 kordoc 이 있을 때만 켜진다(없으면 위의 내장 .hwpx 초안).
// ═══════════════════════════════════════════════════════════════════════════
const LS_FORMS='koat_sec_forms';   // {초안키: {name, b64}} — 내 서식(브라우저에만)
// 기관 서식의 칸 이름이 초안 항목 이름과 다를 때를 위한 다른 이름들(정확히 같은 라벨만 채운다)
const FIELD_ALIASES={name:['출장자','성명','이름','신청자','작성자','강사'], dept:['소속','부서','소속부서','소속(부서)'], period:['출장기간','기간','일시','출장일시','교육기간','휴가기간'],
  place:['출장지','장소','출장장소','행사장소'], purpose:['출장목적','목적','사유'], content:['주요내용','출장내용','내용','결과','주요 내용'], follow:['향후조치','조치사항','향후계획','건의사항','향후 조치'],
  amount:['금액','합계','사용금액'], date:['일자','사용일','사용일자'], reason:['사유','사용사유'], fare:['운임'], lodging:['숙박비'], evid:['증빙서류','증빙'], card:['결제수단']};
function loadFormsStatus(){
  if(S.kd) return; S.kd={available:false};
  fetch('/api/secretary/forms/status').then(r=>r.ok?r.json():{}).then(d=>{ S.kd={available:!!d.available}; }).catch(()=>{});
}
function myForms(key, v){
  const all=_ls(LS_FORMS,{}); if(v===undefined) return all[key]||null;
  if(v) all[key]=v; else delete all[key];
  if(!_lsPut(LS_FORMS, all)){ toast('브라우저 저장 공간이 부족해 서식을 기억하지 못했습니다.'); return null; } return v;
}
function formsRow(key){
  if(!(S.kd||{}).available) return '';
  const mine=myForms(key);
  return `<div class="sec-forms-row"><span class="sec-sub">한글 서식</span>`+
    `<button class="sec-btn primary sm" data-da="fgen" title="공문 보고서 서식(표·항목 번호)으로 만듭니다">📄 공문 서식(.hwpx)</button>`+
    `<button class="sec-btn sm" data-da="fgian" title="표준 간이기안문(결재란·제목·요약)에 채웁니다">📑 간이기안문</button>`+
    (mine?`<button class="sec-btn sm" data-da="fmine" title="기억해 둔 내 서식에 채웁니다">📂 ${esc(mine.name.slice(0,24))}에 채우기</button><button class="sec-x" data-da="fforget" aria-label="내 서식 지우기" title="내 서식 지우기">✕</button>`:'')+
    `<label class="sec-btn ghost sm" title="우리 기관 출장복명서 등 .hwpx 서식을 올리면 칸 이름(라벨·누름틀)을 찾아 채웁니다">📂 우리 서식에 채우기<input type="file" accept=".hwpx" data-da="ffile" hidden></label>`+
    `</div>`;
}
function draftRows(d, vals){
  // 비워 둔 항목은 템플릿의 기본값({{follow|list|해당 없음}})을 쓴다
  const def={}; String(d.template||'').replace(/\{\{(\w+)\|\w+\|([^}]*)\}\}/g,(m,k,v)=>{ def[k]=v; return m; });
  return (d.fields||[]).map(f=>({label:f.l, value:String(vals[f.k]||'').trim()||def[f.k]||'', multi:!!f.multi}));
}
function draftClosing(d, vals){
  // 템플릿에서 마지막 항목 뒤의 맺음말(위와 같이 … 보고합니다 / 붙임 … 끝)
  const lines=String(d.template||'').split('\n'); let last=-1; lines.forEach((l,i)=>{ if(/\{\{/.test(l)) last=i; });
  return lines.slice(last+1).map(l=>fillTemplate(l, vals).trim()).filter(Boolean);
}
async function formsCall(action, body, fname){
  toast('한글 서식을 만드는 중...');
  try{
    const r=await fetch('/api/secretary/forms/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(Object.assign({filename:fname}, body))});
    if(!r.ok){ let m='서식을 만들지 못했습니다.'; try{ m=(await r.json()).error||m; }catch(e){} toast(m, 4200); return null; }
    let rep={}; try{ rep=JSON.parse(decodeURIComponent(r.headers.get('X-Form-Report')||'%7B%7D')); }catch(e){}
    const blob=await r.blob(); const a=document.createElement('a'); a.href=URL.createObjectURL(blob);
    a.download=String(fname||'서식').replace(/[\\/:*?"<>|]/g,'')+'.hwpx'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),4000);
    return rep;
  }catch(e){ toast('서버에 연결하지 못했습니다.'); return null; }
}
async function formsGenerate(d, vals){
  const rep=await formsCall('generate', {title:d.title.replace(/\(.*\)$/,'').trim()||d.title, rows:draftRows(d, vals), closing:draftClosing(d, vals)}, d.title);
  if(rep) toast('공문 서식(.hwpx)을 받았습니다. 한글에서 열어 확인하세요.', 4200);
}
async function formsGian(d, vals){
  const o=S.cfg.org||{}; const one=draftRows(d, vals).filter(r=>!r.multi && r.value);
  const t=new Date(); const today=`${t.getFullYear()}. ${t.getMonth()+1}. ${t.getDate()}.`;
  const subj=d.title.replace(/\(.*\)$/,'').trim()+(vals.purpose?` — ${String(vals.purpose).slice(0,40)}`:'');
  const values={'제목':subj, '요약설명':one.slice(0,4).map(r=>`${r.label}: ${r.value}`).join(' / ').slice(0,300), '작성일':today,
    '작성기관':[o.name, vals.dept].filter(Boolean).join(' '), '공개구분':'비공개'};
  const rep=await formsCall('gian', {template:'gian-simple', values}, d.title+'_간이기안문');
  if(rep) toast('간이기안문(.hwpx)을 받았습니다. 본문은 공문 서식으로 붙이세요.', 4200);
}
function formValues(d, vals){
  const out={};
  (d.fields||[]).forEach(f=>{ const v=String(vals[f.k]||'').trim(); if(!v) return;
    [f.l, f.l.replace(/\s+/g,''), ...(FIELD_ALIASES[f.k]||[])].forEach(k=>{ if(!(k in out)) out[k]=v; }); });
  return out;
}
async function formsFill(key, d, vals){
  const mine=myForms(key); if(!mine) return;
  const rep=await formsCall('fill', {form:mine.b64, values:formValues(d, vals)}, d.title);
  if(!rep) return;
  const got=new Set(rep.filled||[]);
  const miss=(d.fields||[]).filter(f=>String(vals[f.k]||'').trim() && ![f.l, f.l.replace(/\s+/g,''), ...(FIELD_ALIASES[f.k]||[])].some(k=>got.has(k))).map(f=>f.l);
  toast(got.size?`서식에 ${(d.fields||[]).length-miss.length-(d.fields||[]).filter(f=>!String(vals[f.k]||'').trim()).length}개 항목을 채웠습니다.${miss.length?' 못 찾은 칸: '+miss.join(', '):''}`
    :'서식에서 같은 이름의 칸을 찾지 못했습니다. 서식의 칸 이름(예: 출장자·출장기간)을 확인하세요.', 6000);
}
function formsUpload(key, d, file){
  if(!/\.hwpx$/i.test(file.name)){ toast('한글 .hwpx 서식만 올릴 수 있습니다. .hwp 는 한글에서 다른 이름으로 저장 → .hwpx 로 바꿔 주세요.', 5200); return; }
  if(file.size>5*1024*1024){ toast('서식 파일은 5MB까지입니다.'); return; }
  const r=new FileReader();
  r.onload=()=>{ const b64=String(r.result).replace(/^data:[^,]*,/,'');
    myForms(key, {name:file.name.replace(/\.hwpx$/i,''), b64});
    const row=document.getElementById('secFormsRow'); if(row) row.innerHTML=formsRow(key);
    formsFill(key, d, S._draft.vals); };
  r.readAsDataURL(file);
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑦ 🧩 ERP 확장 — 설치 페이지(이 서버 주소·기관 ERP 주소가 들어간 배포본) · 새 버전 알림
// ═══════════════════════════════════════════════════════════════════════════
function loadExtInfo(){
  if(S.extInfo) return Promise.resolve(S.extInfo);
  return fetch('/api/secretary/extension/info').then(r=>r.json()).then(d=>{ S.extInfo=d.success?d:{error:true}; return S.extInfo; }).catch(()=>{ S.extInfo={error:true}; return S.extInfo; });
}
const verLt=(a,b)=>{ const x=String(a).split('.').map(Number), y=String(b).split('.').map(Number); for(let i=0;i<3;i++){ if((x[i]||0)!==(y[i]||0)) return (x[i]||0)<(y[i]||0); } return false; };
function checkExtUpdate(){
  loadExtInfo().then(i=>{ if(i.version && S.extVersion && verLt(S.extVersion, i.version))
    toast(`서무비서 확장 새 버전 ${i.version}이 있습니다(지금 ${S.extVersion}). 🧩 ERP 확장 탭에서 받아 주세요.`, 6000); });
}
function browserKind(){ const u=navigator.userAgent; return /Edg\//.test(u)?'edge':/Whale\//.test(u)?'whale':/Chrome\//.test(u)?'chrome':'other'; }
function extView(){
  const i=S.extInfo; if(!i){ loadExtInfo().then(()=>{ if(S.view==='ext') render(); }); return `<div class="assist-loading"><div class="spinner"></div><span>불러오는 중...</span></div>`; }
  const b=browserKind();
  const page=b==='edge'?'edge://extensions':b==='whale'?'whale://extensions':'chrome://extensions';
  const bname={edge:'Microsoft Edge',chrome:'Chrome',whale:'네이버 웨일',other:'Chrome 또는 Edge'}[b];
  const hosts=(i.erp_hosts||[]).map(h=>h.replace(/\/\*$/,''));
  const dev=b==='edge'?"왼쪽 메뉴(또는 아래쪽)의 <b>개발자 모드</b>를 켭니다.":"오른쪽 위의 <b>개발자 모드</b>를 켭니다.";
  const load=b==='edge'?"<b>압축을 푼 파일 로드</b>(압축 해제된 항목 로드)를 누르고":"<b>압축해제된 확장 프로그램을 로드합니다</b>를 누르고";
  const step=(n,html)=>`<li class="sec-ext-st"><span class="sec-plan-n">${n}</span><div>${html}</div></li>`;
  const installed=EMBED&&S.extVersion;
  return `<div class="sec-card sec-ext-hero"><div class="sec-ext-ic">🧩</div><div><div class="sec-card-h">서무비서 ERP 확장 <span class="sec-sub">${esc(bname)}용 · 버전 ${esc(i.version||'')}</span></div>`+
      `<ul class="sec-tips"><li>ERP·그룹웨어 화면 <b>옆 패널</b>에서 절차·기한·서식·근거·사전 감사를 봅니다.</li>`+
      `<li>ERP에서 출장·휴가·지출결의 같은 화면을 열면 <b>이 업무 안내</b>를 바로 띄웁니다.</li>`+
      `<li>만든 초안을 <b>ERP의 여러 칸에 한 번에</b> 넣습니다(제목·기간·출장지·본문…).</li>`+
      `<li>어떤 ERP든 <b>🔧 ERP 맞춤</b>으로 화면 구조를 분석해 칸을 연결합니다.</li>`+
      `<li>ERP에서 <b>상신 버튼</b>을 누르면 반려 점검 항목을 먼저 보여 줍니다.</li>`+
      `<li>도구 모음 아이콘에 <b>다가오는 기한</b>을 표시하고, 오늘·내일 기한은 바탕화면으로 알립니다.</li></ul></div></div>`+
    (installed?`<div class="sec-notice ${verLt(S.extVersion,i.version)?'warn':'info'}">${verLt(S.extVersion,i.version)?`⚠ 설치된 확장 ${esc(S.extVersion)} — 새 버전 ${esc(i.version)}을 받아 같은 폴더에 덮어쓴 뒤 확장 페이지에서 ↻ 새로고침하세요.`:`✓ 확장 ${esc(S.extVersion)}이 설치되어 있습니다(최신).`}</div>`:'')+
    (b==='other'?`<div class="sec-notice warn">이 브라우저에서는 확장을 쓸 수 없습니다. <b>Chrome</b>이나 <b>Microsoft Edge</b>로 이 페이지를 여세요.</div>`:'')+
    `<div class="sec-card"><div class="sec-card-h">설치 순서 <span class="sec-sub">약 1분 · 관리자 권한 필요 없음</span></div><ol class="sec-ext-steps">`+
      step(1,`<a class="sec-btn primary" href="/api/secretary/extension.zip" download>⬇ 확장 프로그램 받기 (v${esc(i.version||'')})</a>`+
        `<div class="sec-sub">이 서무비서 주소${hosts.length?`와 ERP 주소(${esc(hosts.join(', '))})`:''}가 미리 들어 있어 따로 설정하지 않아도 됩니다.</div>`)+
      step(2,`받은 <code>secretary-extension-${esc(i.version||'')}.zip</code>을 <b>압축 풀기</b> → <code>secretary-extension</code> 폴더가 생깁니다. 지우지 말고 둘 곳(예: 문서 폴더)에 두세요.`)+
      step(3,`주소창에 <code>${page}</code>를 입력해 엽니다. <button class="sec-btn sm ghost" data-a="copyext" data-t="${page}">📋 주소 복사</button>`)+
      step(4,dev)+
      step(5,`${load} <code>secretary-extension</code> 폴더를 고릅니다.`)+
      step(6,`도구 모음의 퍼즐 조각(확장) 아이콘 → <b>서무비서</b> 옆 📌로 고정합니다. ERP를 열고 오른쪽 아래 <b>🗂</b>나 <b>Alt+Shift+S</b>로 엽니다.`)+
    `</ol><div class="sec-hint">새 버전이 나오면 1번에서 다시 받아 같은 폴더에 덮어쓰고, ${page} 에서 서무비서의 ↻(새로고침)을 누르면 됩니다. 처리 이력 등은 그대로 남습니다.</div></div>`+
    `<div class="sec-card"><div class="sec-card-h">🔧 우리 ERP에 맞추기 <span class="sec-sub">어떤 ERP·그룹웨어든</span></div><ol class="sec-ext-steps">`+
      step(1,`ERP에서 맞출 화면(예: 출장복명서 작성)을 엽니다.`)+
      step(2,`서무비서 패널 위의 <b>🔧</b>(ERP 맞춤) → <b>이 화면 구조 분석</b>. 화면의 입력란·편집기·제목을 찾고, 이름이 맞는 칸은 초안 항목과 자동으로 연결해 둡니다.`)+
      step(3,`연결을 고치고(👁로 위치 확인, 🎯로 화면에서 직접 고르기) <b>▶ 시험 채우기</b>로 확인합니다.`)+
      step(4,`<b>내 브라우저에 저장</b> — 나만 쓰기. 관리자는 <b>기관 전체에 공유</b>하면 모든 직원의 확장이 같은 규칙을 받습니다.`)+
    `</ol></div>`+
    `<details class="sec-card"><summary class="sec-card-h">관리자: 기관 PC 일괄 배포</summary><div class="sec-hint">`+
      `· 확장에 들어갈 ERP 주소는 <button class="sec-linkbtn" data-a="view" data-v="manage">⚙ 규정·절차 관리 › 🏢 기관 설정</button>의 'ERP·그룹웨어 주소'에서 바꿉니다.<br>`+
      `· 직원마다 설치하지 않으려면 받은 zip을 Chrome 웹 스토어·Edge 추가 기능에 <b>비공개(조직 한정)</b>로 올리고, 그룹 정책 <code>ExtensionInstallForcelist</code>에 확장 ID를 넣어 일괄 설치합니다.<br>`+
      `· 개발자 모드 설치는 일부 기관 보안 정책에서 막혀 있을 수 있습니다. 그때는 위 일괄 배포를 쓰세요.</div></details>`;
}

// ═══════════════════════════════════════════════════════════════════════════
// ⑤ 초안 → 한글(.hwpx)
// ═══════════════════════════════════════════════════════════════════════════
function downloadHwpx(title, text){
  // 일반 폼 전송(숨은 iframe)으로 받는다 — 서버가 붙인 파일명이 그대로 쓰이고, 비동기 뒤 클릭 제약도 없다
  if(!String(text||'').trim()){ toast('초안 내용이 비어 있습니다.'); return; }
  let fr=document.getElementById('secDlFrame');
  if(!fr){ fr=document.createElement('iframe'); fr.id=fr.name='secDlFrame'; fr.hidden=true; fr.title='파일 받기'; document.body.appendChild(fr); }
  const f=document.createElement('form'); f.method='POST'; f.action='/api/secretary/draft/hwpx'; f.target='secDlFrame'; f.hidden=true;
  [['title',title||'초안'],['text',text]].forEach(([k,v])=>{ const i=document.createElement('textarea'); i.name=k; i.value=v; f.appendChild(i); });
  document.body.appendChild(f); f.submit(); f.remove();
  toast('한글(.hwpx) 파일을 받습니다.');
}

// ── 공개 ─────────────────────────────────────────────────────────────────
window.Secretary={start, ask:q=>ask(q), openReg};
window._secMatch=function(q){ return match(q).map(m=>({id:m.p.id, title:m.p.title, score:m.sc})); };   // 시험·디버그용
window._secLoad=load;
window._secParseDates=parseDates;   // 시험용
// 기본 화면이므로 스크립트가 읽히자마자 절차를 미리 받는다 — 본문 스크립트의 법령 확인 요청들보다
// 먼저 보내야 HTTP/1.1 동시 연결 한도에 막혀 첫 화면이 늦어지지 않는다.
load().catch(()=>{});
})();
