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
        view:'home', query:'', formsQ:'', forms:null, regs:null, matches:[], related:null, procId:null, caseId:null, editId:null, editLayer:'personal',
        basisOpen:{}, basisCache:{}, catFilter:'' };

// ── 저장소 ────────────────────────────────────────────────────────────────
function _ls(k, d){ try{ const v=JSON.parse(localStorage.getItem(k)||'null'); return v==null?d:v; }catch(e){ return d; } }
function _lsPut(k, v){ try{ localStorage.setItem(k, JSON.stringify(v)); return true; }
  catch(e){ toast('브라우저 저장 공간에 쓰지 못했습니다.'); return false; } }
function personal(){ const p=_ls(LS_PERSONAL,{}); p.procedures=Array.isArray(p.procedures)?p.procedures:[]; p.notes=p.notes||{}; return p; }
function savePersonal(p){ _lsPut(LS_PERSONAL,p); }
function cases(){ const c=_ls(LS_CASES,[]); return Array.isArray(c)?c:[]; }
function saveCases(c){ _lsPut(LS_CASES, c.slice(0,300)); }
let _toastT=null;
function toast(m,ms){ const el=document.getElementById('toast'); if(!el) return; el.textContent=m; el.classList.add('show');
  clearTimeout(_toastT); _toastT=setTimeout(()=>el.classList.remove('show'), ms||2600); }
const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const norm=s=>String(s||'').replace(/\s+/g,'').toLowerCase();
const uid=()=>Date.now().toString(36)+Math.random().toString(36).slice(2,6);

// ── 절차 목록(층 병합) ───────────────────────────────────────────────────
function allProcs(){
  const map=new Map();
  const put=(arr,layer)=>(arr||[]).forEach(p=>{ if(p&&p.id) map.set(p.id, Object.assign({}, p, {_layer:layer, _base: map.has(p.id)?map.get(p.id)._layer:null})); });
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
      S.common=d.common||S.common; S.org=d.org||S.org; S.admin=d.admin||{}; S.loaded=true;
    }catch(e){ S.loaded=false; throw e; }
    finally{ S.loading=null; }
  })();
  return S.loading;
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
  bind(w); bindViewer();
  try{ await load(); }
  catch(e){ w.innerHTML=`<div class="sec-empty">절차 목록을 불러오지 못했습니다. <button class="sec-btn" data-a="retry">다시 시도</button></div>`; return; }
  if(opts.reg) openReg(opts.reg);
  if(opts.q){ ask(opts.q); return; }
  if(opts.view && ['list','history','forms','manage'].includes(opts.view)) S.view=opts.view;
  render();
}

function ask(q){
  q=String(q||'').trim(); S.query=q;
  if(!q){ S.view='home'; render(); return; }
  S.matches=match(q); S.related=null; S.basisOpen={};
  if(S.matches.length){ selectProc(S.matches[0].p.id, {keepQuery:true}); return; }
  S.procId=null; S.caseId=null; S.view='nomatch'; render();
  fetch('/api/secretary/related?q='+encodeURIComponent(q)).then(r=>r.json()).then(d=>{ S.related=(d&&d.items)||[]; if(S.view==='nomatch') render(); })
    .catch(()=>{ S.related=[]; if(S.view==='nomatch') render(); });
}
function selectProc(id, o){
  o=o||{}; S.procId=id; S.view='proc'; S.basisOpen={};
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
  const tabs=[['home','🏠 안내'],['list','📚 절차 목록'],['forms','📎 서식·규정'],['history','🕘 처리 이력'],['manage','⚙ 규정·절차 관리']];
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
  else if(S.view==='manage') body=manageView();
  else if(S.view==='edit') body=editView();
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
  return ex+todo+grid+how;
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
  const alt=S.matches.filter(m=>m.p.id!==p.id && m.hit.length).slice(0,4);   // 제목 단어만 겹친 약한 후보는 제외
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
      (nx.due?`<span class="sec-dd ${dd.cls}">${esc(fmtDate(nx.due))} · ${dd.label}</span>`:(nx.s.when?`<span class="sec-when">${esc(deadlineText(nx.s))}</span>`:''))+`</div>`;
  } else if(c){ nextBox=`<div class="sec-nextbox done"><span class="sec-nextbox-l">완료</span><span class="sec-nextbox-t">필수 단계를 모두 마쳤습니다.</span>${c.status!=='done'?`<button class="sec-btn primary sm" data-a="casedone">완료 처리</button>`:''}</div>`; }
  const steps=(p.steps||[]).map((s,i)=>stepHtml(p,s,i,checks,dates)).join('');
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
  return altHtml+`<div class="sec-proc">`+head+approval+dateIn+nextBox+caseBar+
    `<div class="sec-layout"><div class="sec-main"><div class="sec-card"><div class="sec-card-h">🔀 단계별 절차 <span class="sec-sub">선택 단계는 해당할 때만</span></div><div class="sec-steps">${steps}</div></div>${caseNote}</div>`+
    `<aside class="sec-side">${formsHtml}${tips}${noteHtml}</aside></div></div>`;
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
    `<div class="sec-step-meta">${when}</div>${docs}${acts.length?`<div class="sec-step-acts">${acts.join('')}</div>`:''}${basisBoxes}</div></div>`;
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
  return `<div class="sec-card"><div class="sec-card-h">🔎 "${esc(S.query)}" — 등록된 절차가 없어요</div>`+
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
  if(!all.length) return `<div class="sec-empty">🕘 아직 처리 이력이 없습니다.<br>절차를 열어 단계를 체크하거나 기준일을 넣으면 여기에 자동으로 쌓입니다.</div>`;
  const row=c=>{ const p=getProc(c.procId); const pr=p?caseProgress(c,p):{done:0,total:0,pct:0}; const nx=p&&c.status!=='done'?nextStep(c,p):null; const dd=nx&&nx.due?dday(nx.due):null;
    const ds=p&&p.dates?p.dates.filter(d=>c.dates&&c.dates[d.k]).map(d=>`${d.l} ${fmtDate(c.dates[d.k])}`).join(' · '):'';
    return `<div class="sec-hist${c.status==='done'?' done':''}"><div class="sec-hist-m" data-a="case" data-id="${esc(c.id)}" role="button" tabindex="0">`+
      `<span class="sec-hist-t">${esc(p?p.icon:'📌')} ${esc(c.title)}${c.status==='done'?' <span class="sec-layer common">완료</span>':''}</span>`+
      `<span class="sec-hist-s">시작 ${esc(c.created)}${ds?' · '+esc(ds):''}${c.note?' · 📝 '+esc(c.note.slice(0,40)):''}</span>`+
      (nx?`<span class="sec-hist-n">다음: ${esc(nx.s.t.slice(0,60))}${dd?` <span class="sec-dd ${dd.cls}">${dd.label}</span>`:''}</span>`:'')+`</div>`+
      `<span class="sec-prog sm"><i style="width:${pr.pct}%"></i></span><span class="sec-pct">${pr.done}/${pr.total}</span>`+
      `<button class="sec-x" data-a="casedel" data-id="${esc(c.id)}" title="이력 삭제" aria-label="이력 삭제">✕</button></div>`; };
  const open=all.filter(c=>c.status!=='done'), done=all.filter(c=>c.status==='done');
  return `<div class="sec-hint">처리 이력은 <b>이 브라우저에만</b> 저장됩니다. 담당자가 바뀔 때는 내보내기 파일을 넘겨 주세요(받는 사람은 가져오기).</div>`+
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
  return `<div class="sec-layers">`+
    `<div class="sec-layer-c"><span class="sec-layer common">공통</span><b>기본 탑재 규정 절차</b><span>저장소의 현행 내규에서 정리한 절차. 근거 조문은 내규 개정 시 원문에서 다시 불러옵니다.</span></div>`+
    `<div class="sec-layer-c"><span class="sec-layer org">기관</span><b>관리자 등록</b><span>관리자 토큰(내규 업로드와 같음)으로 저장하면 모든 사용자에게 보입니다. ${orgInfo}</span></div>`+
    `<div class="sec-layer-c"><span class="sec-layer personal">개인</span><b>나만의 보충</b><span>내 브라우저에만 저장. 공통·기관 절차를 내 상황에 맞게 고쳐 쓰거나 새 절차를 만듭니다.</span></div></div>`+
    `<div class="sec-row"><button class="sec-btn primary" data-a="newproc">＋ 새 절차 만들기</button><button class="sec-btn ghost" data-a="pexport">⬇ 개인 절차 내보내기</button>`+
    `<label class="sec-btn ghost">⬆ 개인 절차 가져오기<input type="file" accept=".json,application/json" data-a="pimport" hidden></label>`+
    `<button class="sec-btn ghost" data-a="reload">↻ 기관 절차 새로고침</button></div>`+
    `<div class="sec-card">${rows}${hidRows}</div>`+
    `<div class="sec-hint">규정·지침이 개정되면: 근거 조문은 내규 원문(업로드 반영)에서 자동으로 최신본을 보여 줍니다. 기한·단계가 바뀐 경우에만 해당 절차를 <b>수정</b>해 기관 층으로 저장하세요.</div>`;
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
  const tokEl=document.getElementById('secTok'); const tok=tokArg!=null?tokArg:(tokEl&&tokEl.value.trim())||S._tok||'';
  const edEl=document.getElementById('secEditor'); const editor=edEl?edEl.value.trim():_ls(LS_EDITOR,'');
  if(S.admin.token_required && !tok){ toast('관리자 토큰을 입력하세요.'); if(tokEl) tokEl.focus(); return false; }
  if(editor) _lsPut(LS_EDITOR, editor);
  try{
    const r=await fetch('/api/secretary/org',{method:'POST',headers:{'Content-Type':'application/json','X-Upload-Token':tok},
      body:JSON.stringify({procedures:list, drafts:S.org.drafts||{}, editor})});
    const d=await r.json();
    if(!d.success){ toast(d.error||'저장하지 못했습니다.', 4200); return false; }
    S._tok=tok; S.org=d.org; toast(d.message||'기관 절차를 저장했습니다.', 4200); return true;
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
  const vals=Object.assign({}, draftAuto(d,c,p), saved);
  S._draft={key, vals};
  const body=modal('secDraftModal','📝 '+esc(d.title)+' 초안');
  body.innerHTML=`<div class="sec-draft"><div class="sec-draft-f">`+(d.fields||[]).map(f=>`<label class="sec-f"><span>${esc(f.l)}</span>`+
      (f.multi?`<textarea data-dk="${esc(f.k)}" rows="3" placeholder="${esc(f.ph||'')}">${esc(vals[f.k]||'')}</textarea>`:`<input data-dk="${esc(f.k)}" value="${esc(vals[f.k]||'')}" placeholder="${esc(f.ph||'')}">`)+`</label>`).join('')+`</div>`+
    `<div class="sec-draft-p"><div class="sec-draft-ph">미리보기 <span class="sec-sub">비워 둔 칸은 ○○로 남습니다</span></div><pre id="secDraftOut" class="sec-draft-out"></pre>`+
    `<div class="sec-row"><button class="sec-btn primary" data-da="copy">📋 복사</button><button class="sec-btn" data-da="txt">⬇ 텍스트 저장</button>${c?`<button class="sec-btn ghost" data-da="keep">이력에 저장</button>`:''}</div>`+
    `<div class="sec-hint">ERP·한글 기안문 본문에 붙여넣어 쓰세요. 원본 서식이 필요한 문서는 절차 화면의 📎 서식에서 여세요.</div></div></div>`;
  const out=()=>{ const o=document.getElementById('secDraftOut'); if(o) o.textContent=fillTemplate(d.template, S._draft.vals); };
  body.querySelectorAll('[data-dk]').forEach(el=>el.addEventListener('input',()=>{ S._draft.vals[el.dataset.dk]=el.value; out(); }));
  body.addEventListener('click', e=>{ const b=e.target.closest('[data-da]'); if(!b) return; const txt=fillTemplate(d.template, S._draft.vals);
    if(b.dataset.da==='copy'){ (navigator.clipboard?navigator.clipboard.writeText(txt):Promise.reject()).then(()=>toast('복사했습니다.')).catch(()=>{ const ta=document.createElement('textarea'); ta.value=txt; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy'); toast('복사했습니다.');}catch(_){} ta.remove(); }); }
    else if(b.dataset.da==='txt'){ const blob=new Blob([txt],{type:'text/plain;charset=utf-8'}); const a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download=d.title.replace(/[\\/:*?"<>|]/g,'')+'.txt'; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),2000); }
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
  panel.addEventListener('submit', e=>{ const f=e.target.closest('[data-a="askform"]'); if(!f) return; e.preventDefault(); const q=document.getElementById('secQ'); ask(q?q.value:''); });
  panel.addEventListener('click', e=>{
    const b=e.target.closest('[data-a]'); if(!b || !panel.contains(b)) return;
    const a=b.dataset.a, D=b.dataset;
    if(['date','pnote','cnote','ef','es','lay','himport','pimport','askform','formsin'].includes(a)) return;
    e.preventDefault();
    switch(a){
      case 'retry': start(); break;
      case 'view': S.view=D.v; if(D.v==='home'){ S.procId=null; S.query=''; S.matches=[]; } render(); break;
      case 'ask': ask(D.q); break;
      case 'proc': selectProc(D.id, {keepQuery:!!D.keep}); break;
      case 'case': { const c=cases().find(x=>x.id===D.id); if(c){ S.query=''; S.matches=[]; selectProc(c.procId,{caseId:c.id}); } break; }
      case 'check': { const i=Number(D.i); ensureCase(); updateCase(c=>{ c.checks=c.checks||{}; c.checks[i]=!c.checks[i]; if(!c.checks[i]) delete c.checks[i]; }); render(); break; }
      case 'basis': { const k=D.i+':'+D.bi; S.basisOpen[k]=!S.basisOpen[k]; render(); break; }
      case 'form': openForm(D.reg, D.label); break;
      case 'openreg': openReg(D.reg, D.art, D.q); break;
      case 'draft': openDraft(D.d); break;
      case 'formsq': S.formsQ=D.q||''; S.view='forms'; render(); break;
      case 'tocal': addDeadlinesToCalendar(); break;
      case 'newcase': S.caseId=null; render(); toast('새 건으로 시작합니다. 체크하거나 기준일을 넣으면 저장돼요.'); break;
      case 'casedone': ensureCase(); updateCase(c=>{ c.status='done'; c.doneAt=today(); }); toast('완료 처리했습니다. 처리 이력에서 다시 볼 수 있어요.'); render(); break;
      case 'casedel': if(confirm('이 처리 이력을 삭제할까요?')){ saveCases(cases().filter(c=>c.id!==D.id)); if(S.caseId===D.id) S.caseId=null; render(); } break;
      case 'hexport': download('서무비서_처리이력_'+today()+'.json', {kind:'koat-secretary-cases', exported:today(), cases:cases(), notes:personal().notes}); break;
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
    else if(a==='es' && (el.type==='checkbox'||el.tagName==='SELECT')){ editorField(el); if(el.dataset.k==='dlref') render(); }
    else if(a==='himport') readJsonFile(el, d=>{ if(!d||!Array.isArray(d.cases)){ toast('처리 이력 파일이 아닙니다.'); return; }
      const cur=cases(); const ids=new Set(cur.map(c=>c.id)); const add=d.cases.filter(c=>c&&c.id&&!ids.has(c.id)); saveCases(add.concat(cur));
      if(d.notes){ const per=personal(); per.notes=Object.assign({}, d.notes, per.notes); savePersonal(per); }
      toast(`처리 이력 ${add.length}건을 가져왔습니다.`); render(); });
    else if(a==='pimport') readJsonFile(el, d=>{ if(!d||!Array.isArray(d.procedures)){ toast('개인 절차 파일이 아닙니다.'); return; }
      const per=personal(); const ids=new Set(d.procedures.map(p=>p.id)); per.procedures=per.procedures.filter(p=>!ids.has(p.id)).concat(d.procedures.filter(p=>p&&p.id));
      if(d.notes) per.notes=Object.assign({}, per.notes, d.notes); savePersonal(per); toast(`개인 절차 ${d.procedures.length}건을 가져왔습니다.`); render(); });
  });
  panel.addEventListener('input', e=>{
    const el=e.target; const a=el.dataset&&el.dataset.a;
    if(a==='formsin'){ S.formsQ=el.value; renderFormsList(); return; }
    if(a==='pnote'){ const per=personal(); if(el.value.trim()) per.notes[S.procId]=el.value; else delete per.notes[S.procId]; savePersonal(per); }
    else if(a==='cnote'){ updateCase(c=>{ c.note=el.value; }); }
    else if(a==='ef' || (a==='es' && el.type!=='checkbox' && el.tagName!=='SELECT')) editorField(el);
  });
}

// ── 공개 ─────────────────────────────────────────────────────────────────
window.Secretary={start, ask:q=>ask(q), openReg};
window._secMatch=function(q){ return match(q).map(m=>({id:m.p.id, title:m.p.title, score:m.sc})); };   // 시험·디버그용
window._secLoad=load;
// 기본 화면이므로 스크립트가 읽히자마자 절차를 미리 받는다 — 본문 스크립트의 법령 확인 요청들보다
// 먼저 보내야 HTTP/1.1 동시 연결 한도에 막혀 첫 화면이 늦어지지 않는다.
load().catch(()=>{});
})();
