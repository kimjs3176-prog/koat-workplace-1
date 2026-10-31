/* ═══════════════════════════════════════════════════════════════════════════
 * 지출결의서 본문 작성기 — 구분(일반·여비·업무추진비)별 ERP 본문·한글(.hwpx) 생성,
 * 국내여비 자동 계산, 출장 증빙 서식(Excel) 자동 작성(증빙 사진 OCR), 템플릿·자주 쓰는 문구.
 * agro-law(KOAT Work Place)에서 이관. 서무비서 화면의 '🧾 지출결의서' 탭에서 Expense.mount(el)로 그린다.
 * 입력값·템플릿·거래처·문구는 이 브라우저(localStorage)에만 저장하고, 증빙 사진·OCR은 서버로 보내지 않는다.
 * 인라인 onclick 에서 부르므로 함수는 전역에 둔다(이름은 _exp*·_trav*·_rcpt*·_ocr*·_snip* 로 구분).
 * ═══════════════════════════════════════════════════════════════════════════ */
// ── 공용 도우미 ─────────────────────────────────────────────────────────────
function escHtml(s){
  if(typeof s!=='string') return '';
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function escAttr(s){
  return String(s==null?'':s)
    .replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
    .replace(/</g,'&lt;').replace(/>/g,'&gt;');
}
// 서무비서 화면의 토스트(#toast)를 같이 쓴다
let _toastT=null;
function _toast(msg, ms){
  const t=document.getElementById('toast'); if(!t) return;
  t.textContent=msg; t.classList.add('show');
  clearTimeout(_toastT); _toastT=setTimeout(()=>t.classList.remove('show'), ms||3500);
}
let _lsWarnAt=0;
// 저장 실패(주로 용량 초과·사생활 보호 모드) 시 사용자에게 1회 안내. critical=서버 백업 없는 데이터(템플릿 등)
function _lsSet(key, val, opts){
  try{ localStorage.setItem(key, val); return true; }
  catch(e){
    const critical=opts&&opts.critical, now=Date.now();
    if(critical || now-_lsWarnAt>8000){ _lsWarnAt=now;
      _toast(critical
        ? '저장 공간이 부족해 저장하지 못했습니다. 이 데이터는 서버 백업이 없으니 브라우저 저장 공간을 정리한 뒤 다시 시도하세요.'
        : '브라우저 저장 공간이 부족해 저장하지 못했습니다.', critical?6000:3500);
    }
    return false;
  }
}
let _modalPrevFocus=null;
function _modalFocusIn(id){ _modalPrevFocus=document.activeElement; setTimeout(()=>{ const bg=document.getElementById(id); const f=bg&&bg.querySelector('input,button'); if(f) try{ f.focus(); }catch(e){} },30); }
function _modalFocusOut(){ try{ if(_modalPrevFocus&&_modalPrevFocus.focus) _modalPrevFocus.focus(); }catch(e){} _modalPrevFocus=null; }

// ── 지출결의서 본문 작성기 — 구분(일반·여비·업무추진비)별 ERP 본문 생성 ────────
// 전체 서식은 ERP에 있으므로 '본문에 붙여넣을 내용'만 만들어 복사/인쇄한다.
const EXP_KEY='expenseBody';
const EXP_METHODS=['계좌이체','현금','법인카드','어음','기타'];
const EXP_PER_LIMIT=50000;    // 업무추진비 1인당 한도
let _expState=null, _expPlain='', _expRich='', _expRendering=false;
function _wonGeum(n){ return '금'+(Math.round(Number(n)||0)).toLocaleString('ko-KR')+'원'; }
function _dotDate(iso){ const m=String(iso||'').match(/(\d{4})-(\d{2})-(\d{2})/); return m?`${m[1]}. ${+m[2]}. ${+m[3]}.`:String(iso||''); }
function _today(){ const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); }
const _GANADA=['가','나','다','라','마','바','사','아','자','차','카','타','파','하'];
// 여비 계산기 기본값 — 공무원 국내여비(참고) 기준. 소속기관 「여비규정」에 맞게 수정해 사용.
const TRAV_LODGE={seoul:'100000', metro:'80000', etc:'70000'};
function _tcalcDefault(){ return {open:false, days:'1', nights:'0', region:'etc', ilbi:'25000', meal:'25000', lodge:'70000', km:'', kmRate:''}; }
function _expDefault(){ return {type:'general',
  general:{vendor:'',bno:'',ceo:'',desc:'',budget:'',supply:'',vat:'',method:'계좌이체',bank:'',holder:'',account:'',
           related:'',attach:'',bnoStatus:'',bnoStatusCls:'',
           multi:false, vendors:[{vendor:'',bno:'',ceo:'',desc:'',amt:'',budget:'',method:'계좌이체',status:'',statusCls:''}]},
  travel:{name:'',dept:'',rows:[{date:_today(),place:'',content:'',amt:''}]},
  tcalc:_tcalcDefault(),
  receipt:{user:'',dept:'',region:'',summary:'',rows:[],init:false},
  promo:{basis:'',purpose:'',date:_today(),place:'',targetsExt:'',peopleExt:'',targetsInt:'',peopleInt:'',total:'',note:''}}; }
function _expLoadState(){ try{ const s=JSON.parse(localStorage.getItem(EXP_KEY)||'null'); if(s&&s.type){ const d=_expDefault();
    const st=Object.assign(d,s,{general:Object.assign(d.general,s.general),travel:Object.assign(d.travel,s.travel),tcalc:Object.assign(d.tcalc,s.tcalc||{}),receipt:Object.assign(d.receipt,s.receipt||{}),promo:Object.assign(d.promo,s.promo)});
    // 마이그레이션: 구 버전의 단일 집행대상(targets/people) → 외부 항목으로 이관
    const p=st.promo; if(p && (p.targets||p.people) && !p.targetsExt && !p.targetsInt){ p.targetsExt=p.targets||''; p.peopleExt=p.people||''; }
    if(p){ delete p.targets; delete p.people; }
    // 마이그레이션: 다건 거래처에 개별 지출과목·지급방식 필드 보정
    if(st.general && Array.isArray(st.general.vendors))
      st.general.vendors=st.general.vendors.map(v=>Object.assign(_expVNew(),v||{}));
    return st; } }catch(e){} return _expDefault(); }
function _expSaveState(){ _lsSet(EXP_KEY, JSON.stringify(_expState)); }
// ── 지출결의서 템플릿(프리셋) — 반복 서식을 이름 붙여 저장/적용 ──────────────
const _EXP_TPL_KEY='koat_exp_templates';
const _EXP_TYPE_LABEL={general:'일반',travel:'여비',promo:'업무추진비'};
function _expTplGet(){ try{ const a=JSON.parse(localStorage.getItem(_EXP_TPL_KEY)||'[]'); return Array.isArray(a)?a:[]; }catch{ return []; } }
function _expTplSet(a){ _lsSet(_EXP_TPL_KEY, JSON.stringify(a), {critical:true}); }
function _expTplSave(){
  _expSync();
  const def=(_EXP_TYPE_LABEL[_expState.type]||'')+' 서식';
  const name=prompt('템플릿 이름:', def); if(name===null) return;
  const nm=String(name).trim()||def;
  const a=_expTplGet();
  a.unshift({id:'t'+Date.now().toString(36), name:nm, type:_expState.type, state:JSON.parse(JSON.stringify(_expState)), ts:_today()});
  if(a.length>30) a.length=30; _expTplSet(a);
  if(typeof _toast==='function') _toast('템플릿 "'+nm+'" 저장됨.', 2600);
  _expTplRender();
}
function _expTplApply(id){
  const t=_expTplGet().find(x=>x.id===id); if(!t) return;
  const d=_expDefault();
  const s=t.state||{};
  _expState=Object.assign(d, s, {general:Object.assign(d.general,s.general||{}),
    travel:Object.assign(d.travel,s.travel||{}), tcalc:Object.assign(d.tcalc,s.tcalc||{}),
    promo:Object.assign(d.promo,s.promo||{})});
  // 구 단일 집행대상 → 외부 이관(마이그레이션 일관성)
  const p=_expState.promo; if(p&&(p.targets||p.people)&&!p.targetsExt&&!p.targetsInt){ p.targetsExt=p.targets||''; p.peopleExt=p.people||''; }
  if(p){ delete p.targets; delete p.people; }
  _expSaveState();
  document.querySelectorAll('#expSeg .exp-seg').forEach((b,i)=>b.classList.toggle('active',['general','travel','promo'][i]===_expState.type));
  _expRenderFields(); _expUpdate();
  if(typeof _toast==='function') _toast('템플릿 "'+t.name+'" 적용됨.', 2400);
}
function _expTplDel(id){ _expTplSet(_expTplGet().filter(x=>x.id!==id)); _expTplRender(); }
function _expTplRender(){
  const bar=document.getElementById('expTplBar'); if(!bar) return;
  const list=_expTplGet();
  const chips=list.map(t=>`<span class="saved-chip-wrap"><button class="rec-chip" title="${escAttr((_EXP_TYPE_LABEL[t.type]||'')+' · '+(t.ts||''))}" onclick="_expTplApply('${t.id}')">${escHtml(t.name)}</button><button class="saved-del" title="삭제" onclick="_expTplDel('${t.id}')" aria-label="삭제">✕</button></span>`).join('');
  bar.innerHTML=`<button class="exp-tpl-save" onclick="_expTplSave()" title="현재 입력 내용을 템플릿으로 저장">템플릿 저장</button>`+
    (list.length?`<span class="exp-tpl-list">${chips}</span>`:`<span class="saved-empty">반복 서식을 저장해 한 번에 불러올 수 있어요.</span>`);
}
function _won(n){ return '₩'+(Math.round(Number(n)||0)).toLocaleString('ko-KR'); }
function _digits(v){ return parseInt(String(v||'').replace(/[^\d]/g,''),10)||0; }
function _hanAmount(n){
  n=Math.floor(Math.abs(Number(n))||0); if(n===0) return '영';
  const dig=['','일','이','삼','사','오','육','칠','팔','구'];
  const su=['','십','백','천'], bu=['','만','억','조','경'];
  let res='', gi=0;
  while(n>0){ let part=n%10000; n=Math.floor(n/10000);
    if(part){ let s='',p=part,u=0; while(p>0){ const d=p%10; if(d) s=dig[d]+su[u]+s; p=Math.floor(p/10); u++; } res=s+bu[gi]+res; }
    gi++; }
  return res;
}
function _fmtKDate(iso){ const m=String(iso||'').match(/(\d{4})-(\d{2})-(\d{2})/); return m?`${m[1]}.${m[2]}.${m[3]}`:String(iso||''); }

let _expMountEl=null;
function openExpense(el){
  if(el) _expMountEl=el;
  const p=_expMountEl||document.getElementById('expMount'); if(!p) return;
  _expState=_expLoadState();
  const T=[['general','일반'],['travel','여비'],['promo','업무추진비']];
  const seg=T.map(([v,l])=>`<button class="exp-seg${_expState.type===v?' active':''}" onclick="_expSetType('${v}')">${l}</button>`).join('');
  p.innerHTML=`<div class="assist-head"><span class="assist-h-ic" aria-hidden="true">🧾</span>`+
    `<span class="assist-h-t">지출결의서 본문 작성</span>`+
    `<span class="assist-h-hint">구분을 고르고 입력하면 ERP 본문에 붙여넣을 내용이 완성됩니다. 서식은 ERP를 사용하세요.</span></div>`+
    `<div class="exp-segset" id="expSeg">${seg}</div>`+
    `<div class="exp-tplbar" id="expTplBar"></div>`+
    `<div class="exp-wrap">`+
      `<div class="exp-form" id="expForm"><div id="expFields"></div>`+
        `<div class="exp-actions"><button class="exp-print" onclick="_expCopy(this)">본문 복사</button>`+
          `<button class="exp-mini2" onclick="downloadHwpx(this)" title="표 서식을 한글(.hwpx) 파일로 저장">한글(.hwpx)</button>`+
          `<button class="exp-mini2" onclick="openSnippets()" title="자주 쓰는 문구를 입력칸에 삽입">문구</button>`+
          `<button class="exp-clear" onclick="_expReset()">초기화</button></div>`+
        `<div class="exp-hint2">여비·업무추진비의 <b>표</b>는 한글(HWP)·워드·ERP <b>서식 편집기</b>에 붙여넣어야 표로 유지됩니다. 표가 그대로 필요하면 <b>한글(.hwpx)</b>로 받으세요.</div>`+
      `</div>`+
      `<div class="exp-preview"><div class="exp-doc" id="expDoc"></div></div>`+
    `</div>`;
  const form=document.getElementById('expForm');
  if(form){ const h=(e)=>{ if(_expRendering) return;
      const tgt=e&&e.target, cl=tgt&&tgt.classList;
      if(cl&&cl.contains('exp-money')) _expMoneyInput(tgt);
      if(e&&e.type==='change'&&cl){
        if(cl.contains('exp-vname')&&_expVendorAutofill(tgt)) return;   // 기억된 거래처로 자동채움(재렌더)
        if(cl.contains('exp-bno')){ const info=_expScopeOf(tgt.id); if(info){ _expSync(); _expBnoStatus(info.scope,info.idx); } }
      }
      _expSync(); _expUpdate(); _expSaveState(); };
    form.addEventListener('input', h); form.addEventListener('change', h); }
  _expRenderFields(); _expUpdate(); _expTplRender();
}
function _expSetType(t){ _expSync(); _expState.type=t; _expSaveState();
  document.querySelectorAll('#expSeg .exp-seg').forEach((b,i)=>b.classList.toggle('active',['general','travel','promo'][i]===t));
  _expRenderFields(); _expUpdate();
}
function _ev(v){ return escHtml(v==null?'':String(v)); }
function _expRenderFields(){
  const box=document.getElementById('expFields'); if(!box) return;
  if(document.activeElement&&box.contains(document.activeElement)) try{document.activeElement.blur();}catch(e){}
  _expRendering=true;
  const t=_expState.type;
  if(t==='general'){
    const g=_expState.general; const methods=EXP_METHODS.map(m=>`<option${g.method===m?' selected':''}>${m}</option>`).join('');
    const modeToggle=`<div class="exp-fg"><div class="exp-fgt">거래처 수 <span class="exp-hint2">여러 곳이면 하단에 표로 정리됩니다</span></div>`+
      `<div class="exp-segset exp-genmode">`+
        `<button type="button" class="exp-seg${!g.multi?' active':''}" onclick="_expGenMode(false)">단일 거래처</button>`+
        `<button type="button" class="exp-seg${g.multi?' active':''}" onclick="_expGenMode(true)">여러 거래처</button>`+
      `</div></div>`;
    const pay=`<div class="exp-fg"><div class="exp-fgt">지급</div><div class="exp-frow">`+
        `<label>결제방식<select id="gMethod">${methods}</select></label>`+
        `<label>은행<input id="gBank" value="${_ev(g.bank)}" placeholder="예: 농협"></label></div>`+
        `<div class="exp-frow"><label>예금주<input id="gHolder" value="${_ev(g.holder)}"></label>`+
        `<label>계좌번호<input id="gAccount" value="${_ev(g.account)}"></label></div></div>`;
    if(!g.multi){
      box.innerHTML=modeToggle+
        `<div class="exp-fg"><div class="exp-fgt">관련 근거</div>`+
          `<label class="exp-full">관련 문서<input id="gRelated" value="${_ev(g.related)}" placeholder="예: 기술거래이전팀-000(2026.9.22.)호"></label></div>`+
        `<div class="exp-fg"><div class="exp-fgt">거래처</div><div class="exp-frow">`+
          `<label>거래처(상호)<input id="gVendor" class="exp-vname" list="expVendorDL" value="${_ev(g.vendor)}" placeholder="예: (주)그린애그로텍"></label>`+
          `<label>사업자등록번호<span class="exp-bnowrap"><input id="gBno" class="exp-bno" value="${_ev(g.bno)}" placeholder="000-00-00000"><button type="button" class="exp-bizbtn" onclick="_expBizLookup('single',0)" title="상호로 사업자번호 조회">조회</button></span></label></div>`+
          `<span id="gBnoStatus" class="exp-bnostat ${_ev(g.bnoStatusCls)}" style="${g.bnoStatus?'':'display:none'}">${_ev(g.bnoStatus)}</span>`+
          `<div id="gBizPop" class="exp-bizpop"></div>`+_expVendorDLHtml()+`</div>`+
        `<div class="exp-fg"><div class="exp-fgt">거래 내용</div>`+
          `<label class="exp-full">거래내용(적요)<textarea id="gDesc" rows="2" placeholder="예: 스마트팜 실증 기자재 구매">${_ev(g.desc)}</textarea></label>`+
          `<div class="exp-frow"><label>지출과목(예산과목)<input id="gBudget" value="${_ev(g.budget)}" placeholder="예: 자산취득비"></label></div></div>`+
        `<div class="exp-fg"><div class="exp-fgt">금액</div><div class="exp-frow">`+
          `<label>공급가액(원)<input id="gSupply" class="exp-money" inputmode="numeric" value="${_ev(_commaFmt(g.supply))}"></label>`+
          `<label>부가세(원)<input id="gVat" class="exp-money" inputmode="numeric" value="${_ev(_commaFmt(g.vat))}"></label></div>`+
          `<div class="exp-vatrow"><button type="button" class="exp-mini" onclick="_expVatAuto()">부가세 10% 자동</button></div></div>`+
        pay+
        `<div class="exp-fg"><div class="exp-fgt">붙임</div>`+
          `<label class="exp-full">붙임(첨부)<input id="gAttach" value="${_ev(g.attach)}" placeholder="예: 견적서 1부, 거래명세서 1부"></label></div>`;
    } else {
      _expNormVendors(g);
      const mOpts=v=>EXP_METHODS.map(m=>`<option${(v.method||'계좌이체')===m?' selected':''}>${m}</option>`).join('');
      const rows=g.vendors.map((v,i)=>`<div class="exp-vrow">`+
        `<span class="exp-trn">${i+1}</span>`+
        `<input class="exp-vin v-nm exp-vname" id="gvVendor${i}" list="expVendorDL" value="${_ev(v.vendor)}" placeholder="거래처(상호)">`+
        `<input class="exp-vin v-bno exp-bno" id="gvBno${i}" value="${_ev(v.bno)}" placeholder="사업자번호">`+
        `<button type="button" class="exp-bizbtn v-biz" onclick="_expBizLookup('multi',${i})" title="상호로 사업자번호 조회">조회</button>`+
        `<input class="exp-vin v-ceo" id="gvCeo${i}" value="${_ev(v.ceo)}" placeholder="대표자">`+
        `<input class="exp-vin v-amt exp-money" id="gvAmt${i}" inputmode="numeric" value="${_ev(_commaFmt(v.amt))}" placeholder="금액(원)">`+
        `<button type="button" class="exp-trdel" onclick="_expVendorDel(${i})" title="행 삭제" ${g.vendors.length<=1?'disabled':''}>✕</button>`+
        `<input class="exp-vin v-desc" id="gvDesc${i}" value="${_ev(v.desc)}" placeholder="거래내용(적요)">`+
        `<input class="exp-vin v-budget" id="gvBudget${i}" value="${_ev(v.budget)}" placeholder="지출과목(예산과목)">`+
        `<select class="exp-vin v-method" id="gvMethod${i}" title="지급방식">${mOpts(v)}</select>`+
        `<span id="gvStat${i}" class="exp-vstat ${_ev(v.statusCls)}" style="${v.status?'':'display:none'}">${_ev(v.status)}</span>`+
        `</div>`).join('');
      const gtot=g.vendors.reduce((a,v)=>a+_digits(v.amt),0);
      box.innerHTML=modeToggle+
        `<div class="exp-fg"><div class="exp-fgt">거래처 목록 <span class="exp-hint2">거래처별 상호·사업자번호·대표자·금액 / 거래내용·지출과목·지급방식</span></div>`+
          `<div id="gvRows">${rows}</div>`+
          `<div id="gvBizPop" class="exp-bizpop"></div>`+
          `<button type="button" class="exp-addrow" onclick="_expVendorAdd()">＋ 거래처 추가</button>`+
          `<div class="exp-limit" id="gvTotal">합계 ${_won(gtot)} · 거래처 ${g.vendors.length}곳</div></div>`+
        _expVendorDLHtml();
    }
  } else if(t==='travel'){
    const tv=_expState.travel; if(!tv.rows||!tv.rows.length) tv.rows=[{date:_today(),place:'',content:'',amt:''}];
    const rows=tv.rows.map((r,i)=>`<div class="exp-trow">`+
      `<span class="exp-trn">${i+1}</span>`+
      `<input class="exp-tin td" id="tvDate${i}" type="date" value="${_ev(r.date)}">`+
      `<input class="exp-tin tp" id="tvPlace${i}" value="${_ev(r.place)}" placeholder="출장지">`+
      `<input class="exp-tin ta exp-money" id="tvAmt${i}" inputmode="numeric" value="${_ev(_commaFmt(r.amt))}" placeholder="금액(원)">`+
      `<button type="button" class="exp-trdel" onclick="_expTravelDel(${i})" title="행 삭제" ${tv.rows.length<=1?'disabled':''}>✕</button>`+
      `<input class="exp-tin tc" id="tvContent${i}" value="${_ev(r.content)}" placeholder="출장목적 / 용무">`+
      `</div>`).join('');
    box.innerHTML=
      `<div class="exp-zone-h"><span class="exp-zone-no">1</span>지출결의서 본문(여비) 입력 <span class="exp-hint2">오른쪽 미리보기·ERP 본문에 반영</span></div>`+
      `<div class="exp-fg"><div class="exp-fgt">출장자</div><div class="exp-frow">`+
        `<label>성명<input id="tvName" value="${_ev(tv.name)}"></label>`+
        `<label>소속<input id="tvDept" value="${_ev(tv.dept)}" placeholder="예: 기술사업부"></label></div></div>`+
      _travCalcHtml()+
      `<div class="exp-fg"><div class="exp-fgt">출장 내역 <span class="exp-hint2">건별 일자·출장지·목적·금액 (다건이면 행 추가)</span></div>`+
        `<div id="tvRows">${rows}</div>`+
        `<button type="button" class="exp-addrow" onclick="_expTravelAdd()">＋ 행 추가</button></div>`+
      _rcptSectionHtml();
  } else {
    const pm=_expState.promo;
    box.innerHTML=
      `<div class="exp-fg"><div class="exp-fgt">문서 정보</div>`+
        `<label class="exp-full">관련근거<input id="pmBasis" value="${_ev(pm.basis)}" placeholder="관련 근거 문서·번호"></label>`+
        `<label class="exp-full">집행목적<textarea id="pmPurpose" rows="2" placeholder="집행 목적">${_ev(pm.purpose)}</textarea></label></div>`+
      `<div class="exp-fg"><div class="exp-fgt">일시·장소</div><div class="exp-frow">`+
        `<label>일시<input id="pmDate" type="date" value="${_ev(pm.date)}"></label>`+
        `<label>장소<input id="pmPlace" value="${_ev(pm.place)}" placeholder="집행 장소"></label></div></div>`+
      `<div class="exp-fg"><div class="exp-fgt">집행대상 및 금액 <span class="exp-hint2">외부·내부 참석자를 구분해 입력 (인원 합계로 1인당 계산)</span></div>`+
        `<div class="exp-subh">외부 (외부 기관·손님 등)</div>`+
        `<label class="exp-full">외부 참석자<textarea id="pmTargetsExt" rows="2" placeholder="외부 참석자·소속·직위 (예: ○○기업 △△팀장 등)">${_ev(pm.targetsExt)}</textarea></label>`+
        `<div class="exp-frow"><label>외부 인원(명)<input id="pmPeopleExt" inputmode="numeric" value="${_ev(pm.peopleExt)}"></label></div>`+
        `<div class="exp-subh">내부 (우리 기관 직원)</div>`+
        `<label class="exp-full">내부 참석자<textarea id="pmTargetsInt" rows="2" placeholder="내부 참석자·부서·직위 (예: 기술사업부 □□과장 등)">${_ev(pm.targetsInt)}</textarea></label>`+
        `<div class="exp-frow"><label>내부 인원(명)<input id="pmPeopleInt" inputmode="numeric" value="${_ev(pm.peopleInt)}"></label>`+
        `<label>금액(원)<input id="pmTotal" class="exp-money" inputmode="numeric" value="${_ev(_commaFmt(pm.total))}"></label></div>`+
        `<div class="exp-limit" id="pmLimit"></div></div>`+
      `<div class="exp-fg"><div class="exp-fgt">비고</div>`+
        `<label class="exp-full"><input id="pmNote" value="${_ev(pm.note)}" placeholder="(선택)"></label></div>`;
  }
  _expRendering=false;
}
function _expSync(){
  const g=id=>((document.getElementById(id)||{}).value||'').trim();
  const t=_expState.type;
  // 렌더 중이거나 현재 구분의 입력이 DOM에 없으면 무시(다른 구분 상태 훼손 방지)
  // general은 단일/다중 앵커가 다르다(다중엔 공통 지출과목/지급란이 없음)
  const anchor=(t==='general')?(_expState.general.multi?'gvVendor0':'gVendor')
    :{travel:'tvName',promo:'pmDate'}[t];
  if(_expRendering || (anchor && !document.getElementById(anchor))) return;
  if(t==='general'){
    const gg=_expState.general;
    if(gg.multi){
      const n=(gg.vendors||[]).length; const vs=[];
      for(let i=0;i<n;i++){ vs.push({vendor:g('gvVendor'+i),bno:g('gvBno'+i),ceo:g('gvCeo'+i),desc:g('gvDesc'+i),
        amt:g('gvAmt'+i),budget:g('gvBudget'+i),method:g('gvMethod'+i)||'계좌이체'}); }
      if(vs.length) gg.vendors=vs;
    } else {
      Object.assign(gg, {vendor:g('gVendor'),bno:g('gBno'),desc:g('gDesc'),budget:g('gBudget'),
        related:g('gRelated'),attach:g('gAttach'),
        supply:g('gSupply'),vat:g('gVat'),method:g('gMethod'),bank:g('gBank'),holder:g('gHolder'),account:g('gAccount')});
    }
  } else if(t==='travel'){
    const n=(_expState.travel.rows||[]).length;
    const rows=[]; for(let i=0;i<n;i++){ rows.push({date:g('tvDate'+i),place:g('tvPlace'+i),content:g('tvContent'+i),amt:g('tvAmt'+i)}); }
    _expState.travel={name:g('tvName'),dept:g('tvDept'),rows:rows.length?rows:_expState.travel.rows};
  } else {
    _expState.promo={basis:g('pmBasis'),purpose:g('pmPurpose'),date:g('pmDate'),place:g('pmPlace'),targetsExt:g('pmTargetsExt'),peopleExt:g('pmPeopleExt'),targetsInt:g('pmTargetsInt'),peopleInt:g('pmPeopleInt'),total:g('pmTotal'),note:g('pmNote')};
  }
}
function _expVatAuto(){ _expSync(); _expState.general.vat=String(Math.round(_digits(_expState.general.supply)*0.1));
  const el=document.getElementById('gVat'); if(el) el.value=_commaFmt(_expState.general.vat); _expUpdate(); _expSaveState(); }
// ── 일반 지출: 거래처 단일/다중 모드 ─────────────────────────────────────────
function _expVNew(){ return {vendor:'',bno:'',ceo:'',desc:'',amt:'',budget:'',method:'계좌이체',status:'',statusCls:''}; }
function _expNormVendors(g){ if(!g.vendors||!g.vendors.length){ g.vendors=[_expVNew()]; return; }
  g.vendors=g.vendors.map(v=>Object.assign(_expVNew(),v||{})); }
// ── 금액 천단위 콤마 자동표시 (상태에는 콤마 포함 저장 — _digits가 제거하므로 계산은 안전) ──
function _commaFmt(v){ const d=String(v==null?'':v).replace(/[^\d]/g,''); return d?Number(d).toLocaleString('en-US'):''; }
function _expMoneyInput(el){ if(!el) return; const before=String(el.value||''); const start=el.selectionStart||0;
  const dBefore=before.slice(0,start).replace(/[^\d]/g,'').length; const fmt=_commaFmt(before);
  if(fmt===before) return; el.value=fmt;
  let pos=0,seen=0; while(pos<fmt.length&&seen<dBefore){ const c=fmt.charCodeAt(pos); if(c>=48&&c<=57) seen++; pos++; }
  try{ el.setSelectionRange(pos,pos); }catch(e){} }
// ── 거래처·사업자번호 기억(자동완성) — 로컬 저장, 서버 전송 없음 ──
const _EXP_VENDOR_KEY='koat_exp_vendors';
function _expVendorsMem(){ try{ const a=JSON.parse(localStorage.getItem(_EXP_VENDOR_KEY)||'[]'); return Array.isArray(a)?a:[]; }catch(e){ return []; } }
function _expRememberVendor(v){ if(!v) return; const nm=(v.vendor||'').trim(), bno=(v.bno||'').trim();
  if(!nm||!bno) return; const key=nm.replace(/\s+/g,'');
  let a=_expVendorsMem().filter(x=>(x.vendor||'').replace(/\s+/g,'')!==key);
  a.unshift({vendor:nm,bno:bno,ceo:(v.ceo||'').trim()}); a=a.slice(0,50);
  try{ localStorage.setItem(_EXP_VENDOR_KEY, JSON.stringify(a)); }catch(e){} }
function _expRememberFromState(){ const g=_expState&&_expState.general; if(!g) return;
  if(g.multi){ (g.vendors||[]).forEach(v=>_expRememberVendor(v)); } else { _expRememberVendor({vendor:g.vendor,bno:g.bno,ceo:g.ceo}); } }
function _expVendorDLHtml(){ const opts=_expVendorsMem().map(v=>`<option value="${_ev(v.vendor)}">${_ev([_bnoFmt(v.bno),v.ceo].filter(Boolean).join(' · '))}</option>`).join(''); return `<datalist id="expVendorDL">${opts}</datalist>`; }
function _expScopeOf(id){ if(id==='gVendor'||id==='gBno') return {scope:'single',idx:0};
  const m=/^gv(?:Vendor|Bno)(\d+)$/.exec(id||''); return m?{scope:'multi',idx:parseInt(m[1],10)}:null; }
function _expVendorAutofill(el){ const info=_expScopeOf(el&&el.id); if(!info) return false;
  const name=(el.value||'').trim(); if(!name) return false;
  const key=name.replace(/\s+/g,''); const mem=_expVendorsMem().find(v=>(v.vendor||'').replace(/\s+/g,'')===key);
  if(!mem||!mem.bno) return false;
  _expSync();
  if(info.scope==='single'){ const g=_expState.general; if(g.bno) return false; g.bno=_bnoFmt(mem.bno); if(!g.ceo&&mem.ceo) g.ceo=mem.ceo; }
  else { const v=_expState.general.vendors[info.idx]; if(!v||v.bno) return false; v.bno=_bnoFmt(mem.bno); if(!v.ceo&&mem.ceo) v.ceo=mem.ceo; }
  _expRenderFields(); _expUpdate(); _expSaveState(); _expBnoStatus(info.scope,info.idx);
  if(typeof _toast==='function') _toast('기억된 거래처 정보를 불러왔습니다.',2000); return true; }
// ── 사업자 상태(국세청) 배지 — /api/expense/biz?query=<10자리> (mode:bno) ──
function _bnoStatusCls(text, closed){ const t=String(text||''); if(closed||/폐업/.test(t)) return 'dead'; if(/휴업/.test(t)) return 'warn'; if(/계속/.test(t)) return 'ok'; return 'warn'; }
function _expFetchBnoStatus(bno){ const d=String(bno||'').replace(/\D/g,''); if(d.length!==10) return Promise.resolve(null);
  return fetch('/api/expense/biz',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:d})}).then(r=>r.json()).then(j=>{
    if(!j||j.success===false) return null;
    if(j.mode==='bno'){ if((j.count||0)===0) return {text:'국세청 상태 정보 없음',cls:'warn'}; const it=(j.items||[])[0]||{};
      return {text:it.biz||'상태 확인됨', cls:_bnoStatusCls(it.biz||'', it.closed)}; }
    return null; }).catch(()=>null); }
function _setStatEl(id, s, base){ const el=document.getElementById(id); if(!el) return;
  el.className=base+' '+((s&&s.cls)||''); el.textContent=(s&&s.text)||''; el.style.display=(s&&s.text)?'':'none'; }
function _expBnoStatus(scope, idx){
  if(scope==='single'){ const g=_expState.general; _setStatEl('gBnoStatus',{text:'확인 중...',cls:'load'},'exp-bnostat');
    _expFetchBnoStatus(g.bno).then(s=>{ g.bnoStatus=s?s.text:''; g.bnoStatusCls=s?s.cls:''; _setStatEl('gBnoStatus',s,'exp-bnostat'); _expSaveState(); }); }
  else { const v=_expState.general.vendors[idx]; if(!v) return; _setStatEl('gvStat'+idx,{text:'확인 중...',cls:'load'},'exp-vstat');
    _expFetchBnoStatus(v.bno).then(s=>{ v.status=s?s.text:''; v.statusCls=s?s.cls:''; _setStatEl('gvStat'+idx,s,'exp-vstat'); _expSaveState(); }); } }
function _expGenMode(multi){ _expSync(); const g=_expState.general; g.multi=!!multi;
  if(multi){
    _expNormVendors(g);
    const empty=g.vendors.every(v=>!(v.vendor||v.bno||v.ceo||v.desc||v.amt));
    if(empty && (g.vendor||g.desc||g.supply||g.vat)){   // 단일 입력을 첫 행으로 이관(지출과목·지급방식 포함)
      g.vendors=[Object.assign(_expVNew(),{vendor:g.vendor||'',bno:g.bno||'',ceo:g.ceo||'',desc:g.desc||'',
        amt:String((_digits(g.supply)+_digits(g.vat))||''),budget:g.budget||'',method:g.method||'계좌이체'})];
    }
  }
  _expRenderFields(); _expUpdate(); _expSaveState();
}
function _expVendorAdd(){ _expSync(); _expState.general.vendors.push(_expVNew()); _expRenderFields(); _expUpdate(); _expSaveState(); }
function _expVendorDel(i){ _expSync(); const vs=_expState.general.vendors; vs.splice(i,1); if(!vs.length) _expState.general.vendors=[_expVNew()]; _expRenderFields(); _expUpdate(); _expSaveState(); }
// ── 사업자번호 공공데이터 조회(회사명 → 사업자번호·대표자) — /api/expense/biz ──
function _bnoFmt(b){ const d=String(b||'').replace(/\D/g,''); return d.length===10?`${d.slice(0,3)}-${d.slice(3,5)}-${d.slice(5)}`:String(b||''); }
function _expBizPopEl(scope){ return document.getElementById(scope==='multi'?'gvBizPop':'gBizPop'); }
function _expBizMsg(scope,msg){ const el=_expBizPopEl(scope); if(el){ el.className='exp-bizpop on'; el.innerHTML=`<div class="exp-bizmsg">${escHtml(msg)}</div>`; } }
function _expBizClose(scope){ const el=_expBizPopEl(scope); if(el){ el.className='exp-bizpop'; el.innerHTML=''; el.removeAttribute('data-items'); el.removeAttribute('data-idx'); } }
function _expBizLookup(scope, idx){
  _expSync();
  const nm=((document.getElementById(scope==='multi'?('gvVendor'+idx):'gVendor')||{}).value||'').trim();
  if(!nm){ _expBizMsg(scope,'거래처(상호)를 먼저 입력하세요.'); return; }
  _expBizMsg(scope,'"'+nm+'" 사업자번호 조회 중...');
  fetch('/api/expense/biz',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:nm})}).then(r=>r.json()).then(d=>{   // 거래처명을 주소에 싣지 않는다
    if(d&&d.need_key){ _expBizMsg(scope,'공공데이터 서비스키(DATA_GO_KR_KEY)가 설정되지 않았습니다.'); return; }
    if(!d||d.success===false){ _expBizMsg(scope,'조회 실패: '+((d&&d.error)||'네트워크 오류')); return; }
    const items=(d.items||[]).filter(it=>it.bno);
    if(!items.length){ _expBizMsg(scope,'사업자번호가 확인되는 기업이 없습니다. (개인·소규모 사업자는 공공데이터 미등록일 수 있어요)'); return; }
    _expBizShowResults(scope, idx, items);
  }).catch(()=>_expBizMsg(scope,'조회 실패 — 잠시 후 다시 시도하세요.'));
}
function _expBizShowResults(scope, idx, items){
  const el=_expBizPopEl(scope); if(!el) return;
  const list=items.slice(0,8);
  el.dataset.items=JSON.stringify(list); el.dataset.idx=String(idx);
  const head=(scope==='multi'?('행 '+(idx+1)+' · '):'')+'거래처 후보를 선택하세요';
  el.className='exp-bizpop on';
  el.innerHTML=`<div class="exp-bizhd"><span>${escHtml(head)}</span><button type="button" class="exp-bizx" onclick="_expBizClose('${scope}')" title="닫기">✕</button></div>`+
    list.map((it,k)=>`<button type="button" class="exp-bizit" onclick="_expBizPick('${scope}',${k})">`+
      `<span class="exp-bizn">${escHtml(it.name||'')}</span>`+
      `<span class="exp-bizb">${escHtml(_bnoFmt(it.bno))}${it.ceo?(' · 대표 '+escHtml(it.ceo)):''}${it.addr?(' · '+escHtml(it.addr)):''}</span></button>`).join('');
}
function _expBizPick(scope, k){
  const el=_expBizPopEl(scope); if(!el) return;
  let list=[]; try{ list=JSON.parse(el.dataset.items||'[]'); }catch(e){}
  const idx=parseInt(el.dataset.idx||'0',10)||0; const it=list[k]; if(!it) return;
  _expSync();
  const bno=_bnoFmt(it.bno);
  if(scope==='multi'){ const v=_expState.general.vendors[idx]; if(v){ v.bno=bno; if(!v.ceo&&it.ceo) v.ceo=it.ceo; if(!v.vendor&&it.name) v.vendor=it.name; } }
  else { const g=_expState.general; g.bno=bno; if(!g.ceo&&it.ceo) g.ceo=it.ceo; if(!g.vendor&&it.name) g.vendor=it.name; }
  _expBizClose(scope); _expRenderFields(); _expUpdate(); _expSaveState();
  const nm=(scope==='multi'?(_expState.general.vendors[idx]||{}).vendor:_expState.general.vendor)||it.name;
  _expRememberVendor({vendor:nm,bno:bno,ceo:it.ceo});   // 거래처 기억(자동완성)
  _expBnoStatus(scope, idx);                            // 국세청 상태 배지
  if(typeof _toast==='function') _toast('사업자번호를 불러왔습니다.',2200);
}
function _expTravelDel(i){ _expSync(); const rs=_expState.travel.rows; rs.splice(i,1); if(!rs.length) rs.push({date:_today(),place:'',content:'',amt:''}); _expRenderFields(); _expUpdate(); _expSaveState(); }
function _expTravelAdd(){ _expSync(); _expState.travel.rows.push({date:_today(),place:'',content:'',amt:''}); _expRenderFields(); _expUpdate(); _expSaveState(); }
// ── 국내여비 자동 계산 ─────────────────────────────────────────────────
// 일비·식비·숙박비·자가용 이동비를 편집 가능한 단가로 산정. 서버·AI 없음.
function _tc(){ if(!_expState.tcalc) _expState.tcalc=_tcalcDefault(); return _expState.tcalc; }
function _travCalc(){ const c=_tc();
  const days=_digits(c.days), nights=_digits(c.nights);
  const ilbi=days*_digits(c.ilbi), meal=days*_digits(c.meal), lodge=nights*_digits(c.lodge);
  const km=_digits(c.km), kmRate=_digits(c.kmRate), car=km*kmRate;
  return {days,nights,ilbi,meal,lodge,km,kmRate,car,total:ilbi+meal+lodge+car}; }
function _travCalcHtml(){ const c=_tc(); const r=_travCalc();
  const regionOpt=[['seoul','서울'],['metro','광역시'],['etc','그 밖']].map(([v,l])=>`<option value="${v}"${c.region===v?' selected':''}>${l}</option>`).join('');
  const li=(label,val)=>`<div class="tcz-li"><span>${label}</span><b>${_won(val)}</b></div>`;
  return `<div class="exp-fg tcalc"><div class="exp-fgt"><button type="button" class="tcz-toggle" onclick="_travCalcToggle()">${c.open?'▾':'▸'} 국내여비 자동 계산 <span class="exp-hint2">(단가는 편집 가능 · 소속기관 「여비규정」에 맞게 확인)</span></button></div>`+
    (c.open?`<div class="tcz-body">
      <div class="tcz-grid">
        <label>출장일수(일)<input id="tcDays" inputmode="numeric" value="${_ev(c.days)}" oninput="_travCalcSync()"></label>
        <label>숙박일수(박)<input id="tcNights" inputmode="numeric" value="${_ev(c.nights)}" oninput="_travCalcSync()"></label>
        <label>숙박지역(상한)<select id="tcRegion" onchange="_travCalcRegion(this.value)">${regionOpt}</select></label>
        <label>일비(1일)<input id="tcIlbi" inputmode="numeric" value="${_ev(c.ilbi)}" oninput="_travCalcSync()"></label>
        <label>식비(1일)<input id="tcMeal" inputmode="numeric" value="${_ev(c.meal)}" oninput="_travCalcSync()"></label>
        <label>숙박비(1박 상한)<input id="tcLodge" inputmode="numeric" value="${_ev(c.lodge)}" oninput="_travCalcSync()"></label>
        <label>자가용 이동(km)<input id="tcKm" inputmode="numeric" value="${_ev(c.km)}" oninput="_travCalcSync()" placeholder="선택"></label>
        <label>km당 단가(원)<input id="tcKmRate" inputmode="numeric" value="${_ev(c.kmRate)}" oninput="_travCalcSync()" placeholder="기관 기준"></label>
      </div>
      <div class="tcz-sum" id="tcSum">
        ${li('일비 ('+r.days+'일)',r.ilbi)}${li('식비 ('+r.days+'일)',r.meal)}${li('숙박비 ('+r.nights+'박)',r.lodge)}${r.car?li('자가용 ('+r.km+'km)',r.car):''}
        <div class="tcz-li total"><span>합계</span><b>${_won(r.total)}</b></div>
      </div>
      <button type="button" class="exp-addrow tcz-add" onclick="_travCalcAdd()">＋ 계산 결과를 출장 내역에 추가</button>
      <div class="tcz-note">※ 기본값은 참고용(공무원 국내여비 기준)이며 실제 지급 기준·상한은 소속기관 「여비규정」을 따릅니다. 운임(교통비)은 실비로 별도 입력하세요.</div>
    </div>`:'')+`</div>`;
}
function _travCalcToggle(){ _tc().open=!_tc().open; _expRenderFields(); _expSaveState(); }
function _travCalcRegion(v){ const c=_tc(); c.region=v; c.lodge=TRAV_LODGE[v]||c.lodge; _expRenderFields(); _expSaveState(); }
function _travCalcReadInputs(){ const c=_tc(); const g=id=>((document.getElementById(id)||{}).value||'');
  c.days=g('tcDays'); c.nights=g('tcNights'); c.ilbi=g('tcIlbi'); c.meal=g('tcMeal'); c.lodge=g('tcLodge'); c.km=g('tcKm'); c.kmRate=g('tcKmRate'); }
function _travCalcSync(){ _travCalcReadInputs(); try{ _expSync(); }catch(e){} const r=_travCalc();
  const sum=document.getElementById('tcSum'); if(sum){
    const li=(label,val)=>`<div class="tcz-li"><span>${label}</span><b>${_won(val)}</b></div>`;
    sum.innerHTML=li('일비 ('+r.days+'일)',r.ilbi)+li('식비 ('+r.days+'일)',r.meal)+li('숙박비 ('+r.nights+'박)',r.lodge)+(r.car?li('자가용 ('+r.km+'km)',r.car):'')+`<div class="tcz-li total"><span>합계</span><b>${_won(r.total)}</b></div>`;
  }
  _expSaveState();
}
function _travCalcAdd(){ _travCalcReadInputs(); const r=_travCalc();
  if(r.total<=0){ alert('계산할 금액이 없습니다. 일수·단가를 입력하세요.'); return; }
  const parts=[]; if(r.ilbi)parts.push('일비 '+r.days+'일'); if(r.meal)parts.push('식비 '+r.days+'일'); if(r.lodge)parts.push('숙박 '+r.nights+'박'); if(r.car)parts.push('이동 '+r.km+'km');
  _expSync();
  const rowsArr=_expState.travel.rows;
  const blank=rowsArr.find(x=>!x.content&&!x.amt);
  const row={date:_today(), place:'', content:'국내여비('+parts.join('·')+')', amt:String(r.total)};
  if(blank){ Object.assign(blank,row); } else { rowsArr.push(row); }
  _expRenderFields(); _expUpdate(); _expSaveState();
}
// ── 출장 증빙 서식(Excel) 자동 작성 ─────────────────────────────────────────
// 증빙 사진 첨부 → 브라우저 OCR로 금액·일자 인식 → 사용내역 자동 입력 → 기관 '출장 증빙 서식'(.xlsx) 내려받기.
// 사진·인식 모두 브라우저에서 처리한다(서버 전송 없음).
let _rcptImages=[];   // 첨부 증빙 사진 dataURL (메모리 전용, localStorage 미저장 — 용량 보호)
let _rcptOcr=[];      // _rcptImages와 같은 순서의 인식 상태 {st:'wait'|'run'|'ok'|'fail', amt, date, kind, row}
let _rcptAutoOcr=true;
function _rcpt(){ if(!_expState.receipt) _expState.receipt={user:'',dept:'',region:'',summary:'',rows:[],init:false}; return _expState.receipt; }
// 국내여비 자동 계산으로 넣은 행(일비·식비·숙박)은 영수증이 아니므로 증빙 서식의 '대중교통비'에 넣지 않는다
const _RCPT_CALC_RX=/^국내여비\(|일비|식비/;
function _rcptEnsure(){
  const rc=_rcpt(); if(rc.init) return rc;
  const tv=_expState.travel||{};
  const trows=(tv.rows||[]).filter(r=>r.content||r.amt||r.date||r.place);
  if(!rc.region) rc.region=[...new Set(trows.map(r=>String(r.place||'').trim()).filter(Boolean))].join(', ');
  if(!rc.summary) rc.summary=trows[0]?String(trows[0].content||''):'';
  if(!rc.rows||!rc.rows.length){
    rc.rows= trows.length? trows.map(r=>({content:r.content||'', date:r.date||'', transit:_RCPT_CALC_RX.test(r.content||'')?'':String(r.amt||''), lodging:''}))
                         : [{content:'',date:_today(),transit:'',lodging:''}];
  }
  rc.init=true; _expSaveState(); return rc;
}
// 증빙 서식의 사용자·부서명: ③에 적은 값이 있으면 그것, 없으면 ①의 출장자 성명·소속(처음 그릴 때가 아니라 쓸 때마다 본다 —
// 보통 ①을 채우기 전에 ②가 먼저 그려지므로 한 번만 베끼면 빈 채 남는다)
function _rcptUserDept(){ const rc=_rcpt(), tv=_expState.travel||{};
  return {user:(rc.user||'').trim()||(tv.name||'').trim(), dept:(rc.dept||'').trim()||(tv.dept||'').trim()}; }
function _rcptSectionHtml(){
  const rc=_rcptEnsure();
  return `<div class="rcpt-zone"><div class="rcpt-zone-h"><span class="exp-zone-no">2</span><div><div class="rcpt-zone-t">증빙 사진 첨부 · 증빙 서식(Excel) 생성</div>`+
    `<div class="rcpt-zone-s">영수증·승차권 사진을 올리면 <b>금액·일자를 자동 인식(OCR)</b>해 기관 서식에 채워 내려받습니다. 지출결의서 본문과 별개 문서입니다.</div></div></div>`+
    `<ol class="rcpt-steps"><li>사진 첨부</li><li>금액·일자 자동 인식</li><li>확인·수정</li><li>엑셀 다운로드</li></ol>`+
    `<div id="rcptBox">${_rcptInnerHtml(rc)}</div></div>`;
}
function _rcptInnerHtml(rc){
  const f=(id,label,val,ph)=>`<label class="rcpt-f">${label}<input id="rc_${id}" value="${_ev(val)}" placeholder="${_ev(ph||'')}" oninput="_rcptField('${id}',this.value)"></label>`;
  const tv=_expState.travel||{};
  const head=`<div class="rcpt-frow">${f('user','사용자',rc.user,tv.name?'비우면 출장자 '+tv.name:'성명')}${f('dept','부서명',rc.dept,tv.dept?'비우면 소속 '+tv.dept:'예: 기술사업부')}</div>`+
    `<div class="rcpt-frow">${f('region','사용지역',rc.region,'예: 세종특별자치시')}${f('summary','적요',rc.summary,'출장 목적 요약')}</div>`;
  const imgs=`<div class="rcpt-imgs" id="rcptImgs">${_rcptThumbsHtml()}</div>`+
    `<div class="rcpt-imgbar"><label class="rcpt-attach">＋ 증빙 사진 첨부<input type="file" accept="image/*" multiple style="display:none" onchange="_rcptPickImages(this)"></label>`+
    `<label class="rcpt-auto"><input type="checkbox" ${_rcptAutoOcr?'checked':''} onchange="_rcptAutoOcr=this.checked"> 첨부 시 금액·일자 자동 인식</label></div>`+
    `<div class="rcpt-ocrstat" id="rcptOcrStat">${_rcptOcrStatText()}</div>`;
  const table=`<div class="rcpt-thead"><span>내용</span><span>날짜</span><span>대중교통비</span><span>숙박비용</span><span></span></div><div id="rcptRows">${_rcptRowsHtml(rc)}</div>`+
    `<button type="button" class="exp-addrow" onclick="_rcptAddRow()">＋ 내역 행 추가</button>`;
  return `<div class="rcpt-sec-t">① 증빙 사진</div>${imgs}`+
    `<div class="rcpt-sec-t">② 사용내역 <span class="exp-hint2">자동 인식 값은 <mark class="rcpt-mk">표시</mark>됨 · 반드시 사진과 대조해 확인</span></div>${table}`+
    `<div class="rcpt-sec-t">③ 문서 정보</div>${head}`+
    `<div class="rcpt-actions"><button type="button" class="rcpt-gen" onclick="_rcptGenerate(this)">증빙 엑셀 생성·다운로드</button></div>`+
    `<div class="tcz-note">첨부한 사진은 <b>서버로 전송하지 않고</b> 브라우저에서 글자 인식·엑셀 삽입까지 처리해 바로 내려받습니다(로컬 처리). 자동 인식은 사진 상태에 따라 틀릴 수 있습니다.</div>`;
}
function _rcptRowsHtml(rc){
  return (rc.rows||[]).map((r,i)=>{ const o=r.ocr?' ocr':'';
    return `<div class="rcpt-trow${o}">`+
    `<input class="rcpt-tin rc-c" value="${_ev(r.content)}" placeholder="내용" oninput="_rcptRow(${i},'content',this.value)">`+
    `<input class="rcpt-tin rc-d" value="${_ev(r.date)}" placeholder="날짜" oninput="_rcptRow(${i},'date',this.value)">`+
    `<input class="rcpt-tin rc-a" inputmode="numeric" value="${_ev(r.transit)}" placeholder="대중교통비" oninput="_rcptRow(${i},'transit',this.value)">`+
    `<input class="rcpt-tin rc-a" inputmode="numeric" value="${_ev(r.lodging)}" placeholder="숙박비용" oninput="_rcptRow(${i},'lodging',this.value)">`+
    `<button type="button" class="exp-trdel" onclick="_rcptDelRow(${i})" title="행 삭제" ${rc.rows.length<=1?'disabled':''}>✕</button></div>`; }).join('');
}
function _rcptField(id,val){ _rcpt()[id]=val; _expSaveState(); }
function _rcptRow(i,k,val){ const rc=_rcpt(); if(rc.rows[i]){ rc.rows[i][k]=val; _expSaveState(); } }
function _rcptAddRow(){ _rcpt().rows.push({content:'',date:_today(),transit:'',lodging:''}); _rcptRenderRows(); _expSaveState(); }
function _rcptDelRow(i){ const rc=_rcpt(); rc.rows.splice(i,1); if(!rc.rows.length) rc.rows=[{content:'',date:_today(),transit:'',lodging:''}];
  _rcptOcr.forEach(o=>{ if(o.row===i) o.row=-1; else if(o.row>i) o.row--; });
  _rcptRenderRows(); _expSaveState(); }
function _rcptRerender(){ const b=document.getElementById('rcptBox'); if(b) b.innerHTML=_rcptInnerHtml(_rcpt()); }
function _rcptRenderRows(){ const el=document.getElementById('rcptRows'); if(el) el.innerHTML=_rcptRowsHtml(_rcpt()); }
function _rcptThumbsHtml(){
  if(!_rcptImages.length) return `<div class="rcpt-empty">첨부한 증빙 사진이 없습니다. 영수증·승차권·숙박 영수증 사진을 담으세요.</div>`;
  return _rcptImages.map((d,i)=>{ const o=_rcptOcr[i]||{st:'idle'};
    let cap;
    if(o.st==='run') cap='<span class="rc-cap run">인식 중…</span>';
    else if(o.st==='wait') cap='<span class="rc-cap run">대기 중</span>';
    else if(o.st==='ok') cap=`<span class="rc-cap ok">${o.amt?_won(o.amt):'금액 미인식'}<br>${o.date?_ev(o.date):'일자 미인식'}</span>`;
    else if(o.st==='fail') cap='<span class="rc-cap bad">인식 실패</span>';
    else cap='<span class="rc-cap">미인식</span>';
    const busy=o.st==='run'||o.st==='wait';
    return `<div class="rcpt-thumb"><div class="rc-img"><img src="${d}" alt="증빙${i+1}"><button type="button" class="rc-del" onclick="_rcptDelImage(${i})" title="삭제">✕</button></div>`+
      `${cap}<button type="button" class="rc-ocr" onclick="_rcptOcrQueue([${i}])" ${busy?'disabled':''}>${o.st==='ok'||o.st==='fail'?'↻ 다시 인식':'금액·일자 인식'}</button></div>`; }).join('');
}
function _rcptRenderThumbs(){ const el=document.getElementById('rcptImgs'); if(el) el.innerHTML=_rcptThumbsHtml(); }
function _rcptPickImages(input){
  const files=[...(input.files||[])]; if(!files.length) return;
  let pending=files.length; const added=[];
  const done=()=>{ pending--; if(pending<=0){ _rcptRenderThumbs(); if(_rcptAutoOcr&&added.length) _rcptOcrQueue(added); } };
  files.forEach(f=>{
    if(!/^image\//.test(f.type)){ if(typeof _toast==='function')_toast('이미지 파일만 첨부할 수 있습니다.',2600); return done(); }
    if(f.size>8*1024*1024){ if(typeof _toast==='function')_toast('8MB 이하 이미지만 첨부할 수 있습니다.',3000); return done(); }
    const rd=new FileReader();
    rd.onload=()=>{ if(_rcptImages.length<20){ _rcptImages.push(rd.result); _rcptOcr.push({st:'idle',row:-1}); added.push(_rcptImages.length-1); } done(); };
    rd.onerror=()=>done();
    rd.readAsDataURL(f);
  });
  input.value='';
}
function _rcptDelImage(i){ _rcptImages.splice(i,1); _rcptOcr.splice(i,1); _rcptRenderThumbs(); _rcptOcrStatus(); }
// ── 증빙 사진 OCR(금액·일자) — tesseract.js(앱에 내장된 로컬 파일, 한국어 모델)로 브라우저에서 인식 ──
let _ocrLibP=null, _ocrWorkerP=null, _ocrBusy=false, _ocrQ=[], _ocrMsg='';
function _rcptOcrStatText(){ return _ocrMsg?_ev(_ocrMsg):''; }
function _rcptOcrStatus(msg){ if(msg!==undefined) _ocrMsg=msg; const el=document.getElementById('rcptOcrStat'); if(el) el.textContent=_ocrMsg; }
function _loadTesseract(){
  if(window.Tesseract) return Promise.resolve(window.Tesseract);
  if(_ocrLibP) return _ocrLibP;
  _ocrLibP=new Promise((res,rej)=>{ const s=document.createElement('script'); s.src='/assets/ocr/tesseract.min.js';
    s.onload=()=>window.Tesseract?res(window.Tesseract):rej(new Error('OCR 라이브러리 로드 실패'));
    s.onerror=()=>{ _ocrLibP=null; rej(new Error('OCR 라이브러리를 불러오지 못했습니다.')); }; document.head.appendChild(s); });
  return _ocrLibP;
}
function _ocrWorker(){
  if(_ocrWorkerP) return _ocrWorkerP;
  const abs=p=>new URL(p,location.origin).href;
  _ocrWorkerP=_loadTesseract().then(T=>T.createWorker('kor',1,{
    workerPath:abs('/assets/ocr/worker.min.js'), corePath:abs('/assets/ocr/core'), langPath:abs('/assets/ocr/lang'),
    workerBlobURL:false,
    logger:m=>{ if(m&&m.status&&/load|initializ/i.test(m.status)) _rcptOcrStatus('인식 엔진 준비 중… '+Math.round((m.progress||0)*100)+'%'); }
  })).catch(e=>{ _ocrWorkerP=null; throw e; });
  return _ocrWorkerP;
}
// 큰 휴대폰 사진은 축소·흑백 처리해 인식 속도·정확도를 높인다(원본은 엑셀용으로 그대로 둔다)
function _ocrPrep(dataURL){ return new Promise(res=>{ const im=new Image();
  im.onload=()=>{ try{ const max=1800; let w=im.naturalWidth, h=im.naturalHeight; const k=Math.min(1, max/Math.max(w,h)); w=Math.round(w*k); h=Math.round(h*k);
      const cv=document.createElement('canvas'); cv.width=w; cv.height=h; const cx=cv.getContext('2d');
      cx.filter='grayscale(1) contrast(1.25)'; cx.drawImage(im,0,0,w,h); res(cv); }catch(e){ res(dataURL); } };
  im.onerror=()=>res(dataURL); im.src=dataURL; }); }
function _rcptOcrQueue(idxs){
  const imgs=idxs.map(i=>_rcptImages[i]).filter(Boolean);
  imgs.forEach(src=>{ const i=_rcptImages.indexOf(src); if(i>=0){ _rcptOcr[i]=Object.assign(_rcptOcr[i]||{row:-1},{st:'wait'}); if(!_ocrQ.includes(src)) _ocrQ.push(src); } });
  _rcptRenderThumbs(); _rcptOcrRun();
}
async function _rcptOcrRun(){
  if(_ocrBusy) return; _ocrBusy=true;
  let n=0, okCnt=0;
  try{
    while(_ocrQ.length){
      const src=_ocrQ.shift(); let i=_rcptImages.indexOf(src); if(i<0) continue;   // 대기 중 삭제된 사진
      n++; _rcptOcr[i].st='run'; _rcptRenderThumbs(); _rcptOcrStatus('증빙 사진 글자 인식 중… ('+n+'/'+(n+_ocrQ.length)+')');
      try{
        const w=await _ocrWorker();
        const {data}=await w.recognize(await _ocrPrep(src));
        i=_rcptImages.indexOf(src); if(i<0) continue;
        const p=_ocrParseReceipt((data&&data.text)||'');
        Object.assign(_rcptOcr[i],{st:'ok',amt:p.amount,date:p.date,kind:p.kind});
        if(p.amount||p.date){ _rcptApplyOcr(i,p); okCnt++; }
      }catch(e){
        i=_rcptImages.indexOf(src); if(i>=0) _rcptOcr[i].st='fail';
        _rcptOcrStatus('인식 실패: '+(e.message||e));
      }
      _rcptRenderThumbs();
    }
    if(n) _rcptOcrStatus(okCnt?`자동 인식 완료 — ${okCnt}건을 사용내역에 채웠습니다. 금액·일자를 사진과 대조해 확인하세요.`
                              :'금액·일자를 찾지 못했습니다. 사진을 밝고 반듯하게 다시 찍거나 직접 입력하세요.');
  } finally { _ocrBusy=false; }
}
// 인식 결과를 사용내역 행에 반영: 같은 사진을 다시 인식하면 그 행을 갱신, 아니면 빈 행 → 새 행 순
function _rcptApplyOcr(i,p){
  const rc=_rcpt(), o=_rcptOcr[i];
  const isBlank=r=>!String(r.content||'').trim()&&!_digits(r.transit)&&!_digits(r.lodging);
  let row=(o.row>=0&&rc.rows[o.row])?rc.rows[o.row]:null;
  if(!row){ const bi=rc.rows.findIndex(isBlank); if(bi>=0){ row=rc.rows[bi]; o.row=bi; } else { row={content:'',date:'',transit:'',lodging:''}; rc.rows.push(row); o.row=rc.rows.length-1; } }
  const lodge=p.kind==='lodging';
  row.content=p.label||row.content||('증빙 '+(i+1));
  if(p.date) row.date=p.date;
  if(p.amount){ const v=String(p.amount); if(lodge){ row.lodging=v; row.transit=''; } else { row.transit=v; row.lodging=''; } }
  row.ocr=true;
  _rcptRenderRows(); _expSaveState();
}
// 영수증 텍스트에서 금액·일자·종류 추출(휴리스틱)
function _ocrParseReceipt(raw){
  const text=String(raw||'').replace(/[，]/g,',').replace(/[．]/g,'.').replace(/[－–—]/g,'-').replace(/[￦₩]/g,'원 ');
  const lines=text.split(/\n+/).map(s=>s.trim()).filter(Boolean);
  const flat=lines.join(' ').replace(/\s+/g,'');
  // 종류
  let kind='transit', label='교통비';
  const KINDS=[[/호텔|모텔|숙박|리조트|펜션|게스트하우스|객실|체크인|HOTEL|RESORT/i,'lodging','숙박비'],
    [/KTX|SRT|ITX|코레일|korail|승차권|열차|철도|무궁화|새마을/i,'transit','철도 승차권'],
    [/고속버스|시외버스|버스|티머니|BUS/i,'transit','버스 승차권'],
    [/택시|TAXI|카카오T/i,'transit','택시비'],
    [/항공|탑승권|boarding|AIR/i,'transit','항공 운임'],
    [/지하철|도시철도|메트로/i,'transit','지하철'],
    [/통행료|하이패스|톨게이트|주유|주차/i,'transit','자가용 경비']];
  for(const [re,k,l] of KINDS){ if(re.test(flat)){ kind=k; label=l; break; } }
  // 금액: 합계·결제금액 등 키워드 줄의 숫자 우선, 없으면 '원'·천단위 쉼표 숫자 중 최댓값
  const numIn=s=>{ const out=[];
    const re=/(\d{1,3}(?:[,.]\d{3})+|\d{3,8})(?:\s*원)?/g; let m;
    while((m=re.exec(s))){ const before=s.slice(Math.max(0,m.index-1),m.index), after=s.slice(m.index+m[0].length, m.index+m[0].length+1);
      if(/[-:\/]/.test(before)||/^[-:\/]/.test(after)) continue;              // 날짜·시각·전화·사업자번호 조각
      const v=parseInt(m[1].replace(/[,.]/g,''),10);
      if(!/[,.]/.test(m[1])&&!/원/.test(m[0])&&m[1].length>6) continue;      // 쉼표·원 없는 긴 숫자(승인번호 등)
      if(v>=100&&v<=20000000) out.push(v); }
    return out; };
  const SKIP=/부가|세액|VAT|과세|면세|공급가|할인|잔액|포인트|거스름|받은금액|마일리지|승인번호|카드번호|사업자|전화|TEL/i;
  const KEYS=[/결제금액|총결제|합계금액|총합계|받을금액|승인금액|청구금액|총금액|총액|합계|운임|결제/, /금액|요금|판매/];
  let amount=0;
  for(const key of KEYS){
    for(let li=0;li<lines.length&&!amount;li++){
      const ln=lines[li], c=ln.replace(/\s+/g,'');
      if(!key.test(c)||SKIP.test(c)) continue;
      let nums=numIn(ln); if(!nums.length&&lines[li+1]&&!SKIP.test(lines[li+1].replace(/\s+/g,''))) nums=numIn(lines[li+1]);
      if(nums.length) amount=Math.max(...nums);
    }
    if(amount) break;
  }
  if(!amount){ const cand=[]; lines.forEach(ln=>{ if(SKIP.test(ln.replace(/\s+/g,''))) return;
      const re=/(\d{1,3}(?:,\d{3})+)|(\d{3,7})\s*원/g; let m; while((m=re.exec(ln))){ const v=parseInt((m[1]||m[2]).replace(/,/g,''),10); if(v>=100&&v<=20000000) cand.push(v); } });
    if(cand.length) amount=Math.max(...cand); }
  // 일자: 거래일·이용일 등 키워드 줄 우선, 없으면 처음 나온 유효 날짜
  const fmt=(y,mo,d)=>{ y=+y; mo=+mo; d=+d; if(y<100) y+=2000; if(y<2000||y>2100||mo<1||mo>12||d<1||d>31) return '';
    return y+'-'+String(mo).padStart(2,'0')+'-'+String(d).padStart(2,'0'); };
  const dateIn=s=>{ let m;
    if((m=/(?:^|[^\d])(\d{4})\s*[.\-\/년]\s*(\d{1,2})\s*[.\-\/월]\s*(\d{1,2})/.exec(s))){
      const y=+m[1]; return fmt((y>=2000&&y<=2100)?y:new Date().getFullYear(),m[2],m[3]); }   // 연도 오인식(2026→2226 등)은 올해로 보정
    if((m=/(?:^|[^\d])(\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})(?!\d)/.exec(s))) return fmt(m[1],m[2],m[3]);
    if((m=/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?!\d)/.exec(s))) return fmt(m[1],m[2],m[3]);
    if((m=/(\d{1,2})\s*월\s*(\d{1,2})\s*일/.exec(s))) return fmt(new Date().getFullYear(),m[1],m[2]);
    return ''; };
  let date='';
  const DKEY=/거래일|거래일시|결제일|승인일|이용일|승차일|출발|탑승일|체크인|발행일|일시|날짜/;
  for(const ln of lines){ if(DKEY.test(ln.replace(/\s+/g,''))){ date=dateIn(ln); if(date) break; } }
  if(!date) for(const ln of lines){ date=dateIn(ln); if(date) break; }
  return {amount, date, kind, label};
}
// exceljs 지연 로드(앱에 내장된 로컬 파일) — 첨부 사진을 서버로 보내지 않고 브라우저에서 처리
let _exceljsP=null;
function _loadExcelJS(){
  if(window.ExcelJS) return Promise.resolve(window.ExcelJS);
  if(_exceljsP) return _exceljsP;
  _exceljsP=new Promise((res,rej)=>{ const s=document.createElement('script'); s.src='/assets/exceljs.min.js';
    s.onload=()=>window.ExcelJS?res(window.ExcelJS):rej(new Error('엑셀 라이브러리 로드 실패'));
    s.onerror=()=>rej(new Error('엑셀 라이브러리를 불러오지 못했습니다.')); document.head.appendChild(s); });
  return _exceljsP;
}
function _imgDims(dataURL){ return new Promise(res=>{ const im=new Image();
  im.onload=()=>res({w:im.naturalWidth||300,h:im.naturalHeight||200}); im.onerror=()=>res({w:300,h:200}); im.src=dataURL; }); }
async function _rcptGenerate(btn){
  const rc=_rcpt();
  const rows=(rc.rows||[]).filter(r=>r.content||r.date||r.transit||r.lodging);
  if(!_rcptUserDept().user && !rows.length && !_rcptImages.length){ alert('사용자·내역 또는 증빙 사진 중 하나 이상을 입력/첨부해 주세요.'); return; }
  const orig=btn?btn.textContent:''; if(btn){ btn.disabled=true; btn.textContent='생성 중...'; }
  try{
    const ExcelJS=await _loadExcelJS();
    const resp=await fetch('/assets/expense_receipt_template.xlsx');
    if(!resp.ok) throw new Error('증빙 서식 템플릿을 불러오지 못했습니다.');
    const buf=await resp.arrayBuffer();
    const wb=new ExcelJS.Workbook(); await wb.xlsx.load(buf);
    const ws=wb.worksheets[0];
    const digits=v=>parseInt(String(v||'').replace(/[^\d]/g,''),10)||0;
    const ud=_rcptUserDept();
    ws.getCell('B3').value=ud.user;
    ws.getCell('G3').value=ud.dept;              // 템플릿에 들어 있는 부서명 기본값이 남지 않게 비어 있어도 덮어쓴다
    ws.getCell('B4').value=rc.region||'';
    ws.getCell('B5').value=rc.summary||'';
    const BASE_FIRST=8, BASE_LAST=10, BASE_SUM=11;
    const extra=Math.max(0, rows.length-(BASE_LAST-BASE_FIRST+1));
    if(extra){
      ws.spliceRows(BASE_LAST+1, 0, ...Array.from({length:extra},()=>[]));   // 합계행 위로 빈 행 삽입
      for(let k=0;k<extra;k++){
        const dr=BASE_LAST+1+k;
        try{ ws.getRow(dr).height=ws.getRow(BASE_FIRST).height; }catch(e){}
        for(let col=1;col<=10;col++){ try{ ws.getRow(dr).getCell(col).style=JSON.parse(JSON.stringify(ws.getRow(BASE_FIRST).getCell(col).style||{})); }catch(e){} }
        ['C{r}:D{r}','E{r}:G{r}','H{r}:J{r}'].forEach(m=>{ try{ ws.mergeCells(m.replace(/\{r\}/g,dr)); }catch(e){} });
      }
    }
    let st=0, sl=0;
    rows.forEach((r,i)=>{ const rr=BASE_FIRST+i;
      ws.getRow(rr).getCell(2).value=r.content||'';
      ws.getRow(rr).getCell(3).value=r.date||'';
      const tv=digits(r.transit), lv=digits(r.lodging);
      if(tv) ws.getRow(rr).getCell(5).value=tv;
      if(lv) ws.getRow(rr).getCell(8).value=lv;
      st+=tv; sl+=lv;
    });
    const sumRow=BASE_SUM+extra;
    if(st) ws.getRow(sumRow).getCell(5).value=st;
    if(sl) ws.getRow(sumRow).getCell(8).value=sl;
    // 증빙 사진: '<증빙>' 라벨(합계행+2) 다음 행부터 세로 배치 — 전부 브라우저에서 삽입
    let anchor=sumRow+3;   // 1-based
    for(const d of _rcptImages.slice(0,20)){
      const dim=await _imgDims(d);
      let w=dim.w, h=dim.h; const maxw=600; if(w>maxw){ h=Math.round(h*maxw/w); w=maxw; }
      const mm=/^data:image\/([a-zA-Z0-9.+-]+);base64,([\s\S]*)$/.exec(d); if(!mm) continue;
      let ext=(mm[1]||'png').toLowerCase(); if(ext==='jpg') ext='jpeg'; if(ext!=='png'&&ext!=='jpeg'&&ext!=='gif') ext='png';
      const id=wb.addImage({base64:mm[2], extension:ext});
      ws.addImage(id, {tl:{col:0, row:anchor-1}, ext:{width:w, height:h}, editAs:'oneCell'});
      anchor += Math.max(2, Math.round(h/20)+2);
    }
    const outBuf=await wb.xlsx.writeBuffer();
    const blob=new Blob([outBuf],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
    const fn='출장증빙서식_'+_today()+'.xlsx';
    const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=fn;
    document.body.appendChild(a); a.click(); document.body.removeChild(a); setTimeout(()=>URL.revokeObjectURL(url),2000);   // 바로 해제하면 파일 이름이 "download"로 바뀔 수 있다
    if(typeof _toast==='function') _toast('증빙 엑셀을 내려받았습니다(사진은 서버 전송 없이 로컬 처리).',3200);
  }catch(e){ alert('증빙 엑셀 생성 실패: '+(e.message||e)); }
  finally{ if(btn){ btn.disabled=false; btn.textContent=orig||'증빙 엑셀 생성·다운로드'; } }
}
function _expBuild(){
  const t=_expState.type; let html='', text=''; _expRich='';
  if(t==='general'){
    const g=_expState.general;
    if(g.multi){
      _expNormVendors(g);
      const vs=(g.vendors||[]).filter(v=>v.vendor||v.bno||v.ceo||v.desc||v.amt||v.budget);
      const total=vs.reduce((a,v)=>a+_digits(v.amt),0);
      const te=document.getElementById('gvTotal'); if(te) te.textContent='합계 '+_won(total)+' · 거래처 '+(g.vendors||[]).length+'곳';
      // 출력 표는 순번·거래처·거래내용·과목·금액 5열로 정리(사업자번호·대표자·지급방식은 입력만 유지, 표엔 미표시)
      const trHtml=vs.map((v,i)=>`<tr><td>${i+1}</td><td class="tl">${_ev(v.vendor)}</td><td class="tl">${_ev(v.desc)}</td><td class="tl">${_ev(v.budget)}</td><td class="tr">${_won(_digits(v.amt))}</td></tr>`).join('')
        || `<tr><td colspan="5" class="expd-empty">거래처를 입력하세요</td></tr>`;
      html=`<div class="expd-tag">일반 지출 · 여러 거래처</div>`+
        `<table class="expd-tbl"><thead><tr><th>순번</th><th>거래처</th><th>거래내용</th><th>과목</th><th>금액</th></tr></thead>`+
        `<tbody>${trHtml}</tbody><tfoot><tr><td colspan="4">합계</td><td class="tr">${_won(total)}</td></tr></tfoot></table>`+
        `<div class="expd-sum">합계 일금 ${_hanAmount(total)}원정 (${_won(total)})</div>`;
      // 붙여넣기용(HWP·ERP 리치에디터에 표 유지) — 인라인 스타일
      const tci='border:1px solid #808080;padding:6px 10px;font-size:14px;vertical-align:middle;';
      const tch='background:#efefef;font-weight:bold;text-align:center;white-space:nowrap;'+tci;
      const rr=vs.map((v,i)=>`<tr><td style="${tci};text-align:center">${i+1}</td><td style="${tci}">${_ev(v.vendor)}</td><td style="${tci}">${_ev(v.desc)}</td><td style="${tci}">${_ev(v.budget)}</td><td style="${tci};text-align:right">${_won(_digits(v.amt))}</td></tr>`).join('');
      _expRich='<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;width:100%"><tbody>'+
        `<tr><th style="${tch}">순번</th><th style="${tch}">거래처</th><th style="${tch}">거래내용</th><th style="${tch}">과목</th><th style="${tch}">금액</th></tr>`+
        (rr||`<tr><td style="${tci};text-align:center" colspan="5">(내역 없음)</td></tr>`)+
        `<tr><td style="${tch}" colspan="4">합계</td><td style="${tci};text-align:right;font-weight:bold">${_won(total)}</td></tr></tbody></table>`;
      const tlines=vs.map((v,i)=>`  ${i+1}) ${v.vendor||'-'} | ${v.desc||'-'} | ${v.budget||'-'} | ${_won(_digits(v.amt))}`).join('\n');
      text='[일반 지출 · 여러 거래처]\n'+
        `· 거래처 내역 (거래처 | 거래내용 | 과목 | 금액)\n${tlines||'  (내역 없음)'}\n· 합계: 일금 ${_hanAmount(total)}원정 (${_won(total)})`;
    } else {
      const sup=_digits(g.supply), vat=_digits(g.vat), total=sup+vat;
      const vendor=[g.vendor||'—', g.bno&&('사업자 '+g.bno)].filter(Boolean).join(', ');
      const acct=[g.bank,g.account,g.holder&&('예금주 '+g.holder)].filter(Boolean).join(' ');
      const amt=`일금 ${_hanAmount(total)}원정 (${_won(total)})`+((sup&&vat)?`  [공급가액 ${_won(sup)} + 부가세 ${_won(vat)}]`:'');
      const L=[g.related&&['관련',g.related],['거래처',vendor],['거래내용',g.desc],['지출과목',g.budget],['금액',amt],['결제방식',[g.method,acct&&('('+acct+')')].filter(Boolean).join(' ')],g.attach&&['붙임',g.attach]].filter(Boolean).filter(x=>x[1]);
      html=`<div class="expd-tag">일반 지출</div>`+_expLines(L,true);
      text='[일반 지출]\n'+L.map((x,i)=>`${_GANADA[i]||'·'}. ${x[0]}: ${x[1]}`).join('\n');
    }
  } else if(t==='travel'){
    const tv=_expState.travel; const rows=(tv.rows||[]).filter(r=>r.content||r.amt||r.date||r.place);
    const total=rows.reduce((a,r)=>a+_digits(r.amt),0);
    const head=[['출장자',[tv.name, tv.dept&&('('+tv.dept+')')].filter(Boolean).join(' ')]].filter(x=>x[1]);
    const trHtml=rows.map((r,i)=>`<tr><td>${i+1}</td><td>${_ev(_fmtKDate(r.date))}</td><td>${_ev(r.place)}</td><td class="tl">${_ev(r.content)}</td><td class="tr">${_won(_digits(r.amt))}</td></tr>`).join('')
      || `<tr><td colspan="5" class="expd-empty">출장 내역을 입력하세요</td></tr>`;
    html=`<div class="expd-tag">여비(출장비)</div>`+(head.length?_expLines(head):'')+
      `<table class="expd-tbl"><thead><tr><th>순번</th><th>일자</th><th>출장지</th><th>출장목적</th><th>금액</th></tr></thead>`+
      `<tbody>${trHtml}</tbody><tfoot><tr><td colspan="4">합계</td><td class="tr">${_won(total)}</td></tr></tfoot></table>`+
      `<div class="expd-sum">합계 일금 ${_hanAmount(total)}원정 (${_won(total)})</div>`;
    // 붙여넣기용(HWP·ERP 리치에디터에 표 유지) — 인라인 스타일 표
    const tci='border:1px solid #808080;padding:6px 10px;font-size:14px;vertical-align:middle;';
    const tch='background:#efefef;font-weight:bold;text-align:center;white-space:nowrap;'+tci;
    const rr=rows.map((r,i)=>`<tr><td style="${tci};text-align:center">${i+1}</td><td style="${tci};text-align:center">${_ev(_fmtKDate(r.date))}</td><td style="${tci}">${_ev(r.place)}</td><td style="${tci}">${_ev(r.content)}</td><td style="${tci};text-align:right">${_won(_digits(r.amt))}</td></tr>`).join('');
    const trHead=head.length?`<p style="margin:0 0 6px;font-size:14px">${head.map(x=>_ev(x[0])+': '+_ev(x[1])).join(' / ')}</p>`:'';
    _expRich=trHead+'<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;width:100%"><tbody>'+
      `<tr><th style="${tch}">순번</th><th style="${tch}">일자</th><th style="${tch}">출장지</th><th style="${tch}">출장목적</th><th style="${tch}">금액</th></tr>`+
      (rr||`<tr><td style="${tci};text-align:center" colspan="5">(내역 없음)</td></tr>`)+
      `<tr><td style="${tch}" colspan="4">합계</td><td style="${tci};text-align:right;font-weight:bold">${_won(total)}</td></tr></tbody></table>`;
    const tlines=rows.map((r,i)=>`  ${i+1}) ${_fmtKDate(r.date)} | ${r.place||'-'} | ${r.content||'-'} | ${_won(_digits(r.amt))}`).join('\n');
    text='[여비(출장비) 지출]\n'+head.map(x=>`· ${x[0]}: ${x[1]}`).join('\n')+
      `${head.length?'\n':''}· 출장내역 (일자 | 출장지 | 목적 | 금액)\n${tlines||'  (내역 없음)'}\n· 합계: 일금 ${_hanAmount(total)}원정 (${_won(total)})`;
  } else {
    const pm=_expState.promo; const pExt=_digits(pm.peopleExt), pInt=_digits(pm.peopleInt), people=pExt+pInt, total=_digits(pm.total);
    const per=people>0?Math.floor(total/people):0; const over=per>EXP_PER_LIMIT;
    const limitEl=document.getElementById('pmLimit');
    if(limitEl){ limitEl.className='exp-limit '+(people&&total?(over?'over':'ok'):'');
      const cntTxt=`외부 ${pExt}명 · 내부 ${pInt}명 · 총 ${people}명`;
      limitEl.textContent=people&&total?`${cntTxt} · 1인당 ${_wonGeum(per)} · 한도 ${_wonGeum(EXP_PER_LIMIT)} ${over?'초과 ⚠':'이내 ✔'}`:`${cntTxt} · 1인당 한도 ${_wonGeum(EXP_PER_LIMIT)}`; }
    // 집행대상: 외부·내부 구분 표기
    const tExt=(pm.targetsExt||'').trim(), tInt=(pm.targetsInt||'').trim();
    const extVal=[tExt, pExt?`(외부 ${pExt}명)`:''].filter(Boolean).join(' ');
    const intVal=[tInt, pInt?`(내부 ${pInt}명)`:''].filter(Boolean).join(' ');
    // 첨부 표 양식: 관련근거 / 집행목적 / 일시·장소 / 집행대상(외부·내부) / 금액·1인당 / 비고
    const rows=[
      ['관련근거', pm.basis||'', null, null],
      ['집행목적', pm.purpose||'', null, null],
      ['일　시', _dotDate(pm.date), '장　소', pm.place||''],
      ['집행대상(외부)', extVal, null, null],
      ['집행대상(내부)', intVal, null, null],
      ['금　액', total?_wonGeum(total):'', '1인당 지출액', (people&&total)?_wonGeum(per):''],
      ['비　고', pm.note||'', null, null],
    ];
    const cell=v=>_ev(v)||'&nbsp;';
    const trs=rows.map(r=> r[2]===null
      ? `<tr><th>${_ev(r[0])}</th><td colspan="3">${cell(r[1])}</td></tr>`
      : `<tr><th>${_ev(r[0])}</th><td>${cell(r[1])}</td><th>${_ev(r[2])}</th><td>${cell(r[3])}</td></tr>`).join('');
    html=`<div class="expd-tag">업무추진비</div><table class="pmt">${trs}</table>`+
      (over?`<div class="expd-warn">1인당 지출액이 한도(${_wonGeum(EXP_PER_LIMIT)})를 초과했습니다. 인원 또는 금액을 확인하세요.</div>`:'');
    // 붙여넣기용(HWP·ERP 리치에디터에 표 유지) — 인라인 스타일
    const ci='border:1px solid #808080;padding:6px 10px;font-size:14px;vertical-align:middle;';
    const ch='background:#efefef;font-weight:bold;text-align:center;white-space:nowrap;'+ci;
    _expRich='<table border="1" cellspacing="0" cellpadding="4" style="border-collapse:collapse;width:100%"><tbody>'+rows.map(r=> r[2]===null
      ? `<tr><th style="${ch}">${_ev(r[0])}</th><td style="${ci}" colspan="3">${_ev(r[1])}</td></tr>`
      : `<tr><th style="${ch}">${_ev(r[0])}</th><td style="${ci}">${_ev(r[1])}</td><th style="${ch}">${_ev(r[2])}</th><td style="${ci}">${_ev(r[3])}</td></tr>`).join('')+'</tbody></table>';
    // 플레인 폴백
    const P=[['관련근거',pm.basis],['집행목적',pm.purpose],
      ['일시',_dotDate(pm.date)+(pm.place?('   장소: '+pm.place):'')],
      ['집행대상(외부)',extVal],['집행대상(내부)',intVal],
      ['금액',total?_wonGeum(total)+((people&&total)?`   (총 ${people}명 · 1인당 ${_wonGeum(per)})`:''):''],['비고',pm.note]];
    text='[업무추진비 지출]\n'+P.filter(x=>x[1]).map(x=>`· ${x[0]}: ${x[1]}`).join('\n');
  }
  return {html, text};
}
function _expLines(list, numbered){
  return `<div class="expd-lines">`+list.filter(x=>x[1]).map((x,i)=>`<div class="expd-line">`+
    (numbered?`<span class="expd-mk">${_GANADA[i]||''}.</span>`:'')+
    `<span class="expd-k">${_ev(x[0])}</span><span class="expd-v">${_ev(x[1])}</span></div>`).join('')+`</div>`;
}
function _expUpdate(){
  const doc=document.getElementById('expDoc'); if(!doc) return;
  const b=_expBuild(); _expPlain=b.text;
  doc.innerHTML=`<div class="expd-title">지출결의서 본문</div>${b.html}`;
}
function _expCopy(btn){
  _expUpdate();                       // 복사 직전 최신 상태로 _expRich·_expPlain 갱신
  if(_expState.type==='general') _expRememberFromState();   // 수기 입력 거래처도 기억
  const text=_expPlain||''; if(!text && !_expRich){ return; }
  const done=(rich)=>{ if(btn){ const o=btn.dataset.label||btn.textContent; btn.dataset.label=o;
      btn.textContent=rich?'✓ 표로 복사됨':'✓ 복사됨'; setTimeout(()=>{btn.textContent=o;},1600); } };
  // 표가 있는 구분(여비·업무추진비): 표를 그대로 유지해 붙여넣기.
  if(_expRich){
    // 1) copy 이벤트에서 text/html·text/plain을 직접 세팅(HWP·워드 등 리치에디터에
    //    표가 가장 안정적으로 붙는다). 선택 영역이 있어야 이벤트가 발생하므로
    //    임시 contenteditable을 포커스·선택한 뒤 실행한다.
    if(_expCopyRich(_expRichDoc(_expRich), text)){ done(true); return; }
    // 2) 비동기 ClipboardItem 폴백
    if(navigator.clipboard && window.ClipboardItem){
      try{
        const item=new ClipboardItem({'text/html':new Blob([_expRichDoc(_expRich)],{type:'text/html'}),
                                      'text/plain':new Blob([text||''],{type:'text/plain'})});
        navigator.clipboard.write([item]).then(()=>done(true)).catch(()=>_expCopyFb(text,()=>done(false)));
        return;
      }catch(e){}
    }
  }
  // 표 없는 구분(일반) 또는 리치 복사 실패 → 텍스트
  if(navigator.clipboard&&navigator.clipboard.writeText){ navigator.clipboard.writeText(text).then(()=>done(false)).catch(()=>_expCopyFb(text,()=>done(false))); }
  else _expCopyFb(text,()=>done(false));
}
// 붙여넣기 호환용 전체 HTML 문서 래퍼(일부 편집기가 문서 구조를 요구)
function _expRichDoc(inner){ return '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'+inner+'</body></html>'; }
// copy 이벤트를 가로채 text/html·text/plain을 강제로 세팅한다. 성공 시 true.
// (임시 contenteditable을 포커스·선택해 execCommand('copy')가 이벤트를 발생시키게 함)
function _expCopyRich(html, text){
  let ok=false;
  const handler=(e)=>{ try{
    (e.clipboardData||window.clipboardData).setData('text/html', html);
    (e.clipboardData||window.clipboardData).setData('text/plain', text||'');
    e.preventDefault(); ok=true;
  }catch(_){} };
  const div=document.createElement('div');
  div.setAttribute('contenteditable','true');
  div.style.cssText='position:fixed;left:0;top:0;width:1px;height:1px;padding:0;border:0;overflow:hidden;opacity:0;';
  div.innerHTML=html;
  document.body.appendChild(div);
  document.addEventListener('copy', handler, true);
  try{
    div.focus();
    const range=document.createRange(); range.selectNodeContents(div);
    const sel=window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const r=document.execCommand('copy'); ok = ok || !!r;
  }catch(_){}
  document.removeEventListener('copy', handler, true);
  try{ window.getSelection().removeAllRanges(); }catch(_){}
  try{ document.body.removeChild(div); }catch(_){}
  return ok;
}
function _expCopyFb(text,done){ try{ const ta=document.createElement('textarea'); ta.value=text; ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done&&done(); }catch(e){ alert('복사 실패 — 본문을 직접 선택해 복사하세요.'); } }
// 현재 구분의 본문을 한글(.hwpx) 표 파일로 생성
function _expHwpxPayload(){
  const t=_expState.type;
  if(t==='promo'){
    const pm=_expState.promo; const pExt=_digits(pm.peopleExt), pInt=_digits(pm.peopleInt), people=pExt+pInt, total=_digits(pm.total);
    const per=people>0?Math.floor(total/people):0; const g=n=>_wonGeum(n);
    const extVal=[(pm.targetsExt||'').trim(), pExt?`(외부 ${pExt}명)`:''].filter(Boolean).join(' ');
    const intVal=[(pm.targetsInt||'').trim(), pInt?`(내부 ${pInt}명)`:''].filter(Boolean).join(' ');
    return {title:'지출결의서 (업무추진비)', filename:'지출결의서_업무추진비', colCnt:4, colWidths:[8000,15814,8000,15814],
      empty: !((pm.basis||'').trim()||(pm.purpose||'').trim()||pm.date||(pm.place||'').trim()||extVal||intVal||total||(pm.note||'').trim()), rows:[
      [{t:'관련근거',hd:1},{t:pm.basis||'',cs:3}],
      [{t:'집행목적',hd:1},{t:pm.purpose||'',cs:3}],
      [{t:'일 시',hd:1},{t:_dotDate(pm.date)},{t:'장 소',hd:1},{t:pm.place||''}],
      [{t:'집행대상(외부)',hd:1},{t:extVal,cs:3}],
      [{t:'집행대상(내부)',hd:1},{t:intVal,cs:3}],
      [{t:'금 액',hd:1},{t:total?g(total):''},{t:'1인당 지출액',hd:1},{t:(people&&total)?g(per):''}],
      [{t:'비 고',hd:1},{t:pm.note||'',cs:3}],
    ]};
  }
  if(t==='general'){
    const g=_expState.general;
    if(g.multi){
      _expNormVendors(g);
      const vs=(g.vendors||[]).filter(v=>v.vendor||v.bno||v.ceo||v.desc||v.amt||v.budget);
      const total=vs.reduce((a,v)=>a+_digits(v.amt),0);
      const rows=[];
      rows.push([{t:'순번',hd:1},{t:'거래처',hd:1},{t:'거래내용',hd:1},{t:'과목',hd:1},{t:'금액',hd:1}]);
      vs.forEach((v,i)=>rows.push([{t:String(i+1)},{t:v.vendor||''},{t:v.desc||''},{t:v.budget||''},{t:_won(_digits(v.amt))}]));
      rows.push([{t:'합계',hd:1,cs:4},{t:_won(total)}]);
      return {title:'지출결의서 (일반·여러 거래처)', filename:'지출결의서_일반_거래처목록', colCnt:5,
        colWidths:[3600,12000,16000,8000,8028], empty: vs.length===0, rows};
    }
    const sup=_digits(g.supply),vat=_digits(g.vat),total=sup+vat;
    const vendor=[g.vendor,g.bno&&('사업자 '+g.bno)].filter(Boolean).join(', ');
    const acct=[g.bank,g.account,g.holder&&('예금주 '+g.holder)].filter(Boolean).join(' ');
    const rows=[g.related&&['관련',g.related],['거래처',vendor],['거래내용',g.desc||''],['지출과목',g.budget||''],
      ['금액','일금 '+_hanAmount(total)+'원정 ('+_won(total)+')'],
      ['결제방식',[g.method,acct&&('('+acct+')')].filter(Boolean).join(' ')],g.attach&&['붙임',g.attach]]
      .filter(Boolean).map(r=>[{t:r[0],hd:1},{t:r[1]}]);
    return {title:'지출결의서 (일반)', filename:'지출결의서_일반', colCnt:2, colWidths:[9000,38628],
      empty: !(vendor||(g.desc||'').trim()||(g.budget||'').trim()||total||(g.related||'').trim()||(g.attach||'').trim()), rows};
  }
  const tv=_expState.travel; const rws=(tv.rows||[]).filter(r=>r.content||r.amt||r.date||r.place);
  const total=rws.reduce((a,r)=>a+_digits(r.amt),0); const rows=[];
  rows.push([{t:'출장자',hd:1},{t:[tv.name,tv.dept&&('('+tv.dept+')')].filter(Boolean).join(' '),cs:4}]);
  rows.push([{t:'순번',hd:1},{t:'일자',hd:1},{t:'출장지',hd:1},{t:'출장목적',hd:1},{t:'금액',hd:1}]);
  rws.forEach((r,i)=>rows.push([{t:String(i+1)},{t:_fmtKDate(r.date)},{t:r.place||''},{t:r.content||''},{t:_won(_digits(r.amt))}]));
  rows.push([{t:'합계',hd:1,cs:4},{t:_won(total)}]);
  return {title:'지출결의서 (여비)', filename:'지출결의서_여비', colCnt:5, colWidths:[4000,9000,9000,17628,8000], empty: rws.length===0, rows};
}
function downloadHwpx(btn){
  const payload=_expHwpxPayload();
  if(payload.empty || !payload.rows.length){ alert('먼저 지출 내역을 입력한 뒤 내려받아 주세요.'); return; }
  if(_expState.type==='general') _expRememberFromState();   // 수기 입력 거래처도 기억
  const orig=btn?btn.textContent:''; if(btn){ btn.disabled=true; btn.textContent='생성 중...'; }
  fetch('/api/expense/hwpx',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    .then(r=>{ if(!r.ok) return r.json().then(j=>{throw new Error(j.error||'생성 실패');}); return r.blob(); })
    .then(blob=>{ const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url;
      a.download=(payload.filename||'지출결의서')+'.hwpx'; document.body.appendChild(a); a.click();
      document.body.removeChild(a); setTimeout(()=>URL.revokeObjectURL(url),2000); })
    .catch(e=>alert('한글(.hwpx) 생성 실패: '+(e.message||e)))
    .finally(()=>{ if(btn){ btn.disabled=false; btn.textContent=orig||'한글(.hwpx)'; } });
}
function _expReset(){
  if(!confirm('입력한 내용을 모두 지울까요?')) return;
  try{ localStorage.removeItem(EXP_KEY); }catch(e){}
  openExpense();
}
function _copyText(text, ok){
  try{
    if(navigator.clipboard && navigator.clipboard.writeText){
      navigator.clipboard.writeText(text).then(()=>ok&&ok()).catch(()=>_expCopyFb(text, ok));
      return;
    }
  }catch(e){}
  _expCopyFb(text, ok);
}
const _SNIP_KEY='koat_snippets';
let _snipTarget=null;   // 마지막으로 포커스한 입력칸(삽입 대상)
document.addEventListener('focusin', e=>{ const t=e.target;
  if(t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && (t.tagName==='TEXTAREA'||t.type==='text'||t.type==='search'||!t.type)
     && t.closest && (t.closest('#expForm'))) _snipTarget=t; });
function getSnippets(){ try{ const a=JSON.parse(localStorage.getItem(_SNIP_KEY)||'[]'); return Array.isArray(a)?a:[]; }catch{ return []; } }
function _setSnippets(a){ _lsSet(_SNIP_KEY, JSON.stringify(a), {critical:true}); }
// 치환 변수 확장: {{오늘}} 등 날짜류는 자동, 그 외({{성명}}·{{금액}})는 삽입 시 입력받아 치환
function _snipExpand(text){
  const d=new Date(), pad=n=>String(n).padStart(2,'0');
  const iso=x=>x.getFullYear()+'-'+pad(x.getMonth()+1)+'-'+pad(x.getDate());
  const wd=['일','월','화','수','목','금','토'][d.getDay()];
  const rel=n=>{ const x=new Date(d); x.setDate(x.getDate()+n); return x; };
  const map={ '오늘':iso(d), '날짜':iso(d), '어제':iso(rel(-1)), '내일':iso(rel(1)),
    '올해':String(d.getFullYear()), '이번달':d.getFullYear()+'-'+pad(d.getMonth()+1), '요일':wd,
    '한글오늘':`${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일`, '한글날짜':`${d.getFullYear()}년 ${d.getMonth()+1}월 ${d.getDate()}일` };
  return String(text||'').replace(/\{\{\s*([^}]+?)\s*\}\}/g,(m,key)=>{
    key=key.trim(); if(map[key]!=null) return map[key];
    const v=prompt(key+' 입력:', ''); return v==null?'':v;
  });
}
function addSnippet(text, title, cat){ text=String(text||'').trim(); if(!text) return; const a=getSnippets();
  a.unshift({id:'s'+Date.now().toString(36), text, title:String(title||'').trim(), cat:String(cat||'').trim()});
  if(a.length>100) a.length=100; _setSnippets(a); _snipRender(); }
function delSnippet(id){ _setSnippets(getSnippets().filter(s=>s.id!==id)); _snipRender(); }
let _snipFilter='';
function _snipSetFilter(v){ _snipFilter=String(v||''); _snipRender(); }
function openSnippets(){ _snipEnsureModal(); const bg=document.getElementById('snipBg'); if(!bg) return; _snipRender(); bg.classList.add('show'); _modalFocusIn('snipBg'); }
function closeSnippets(){ const bg=document.getElementById('snipBg'); if(bg) bg.classList.remove('show'); _modalFocusOut(); }
function _snipAdd(){ const el=document.getElementById('snipNew'), tl=document.getElementById('snipTitle'), ct=document.getElementById('snipCat');
  addSnippet(el&&el.value, tl&&tl.value, ct&&ct.value); if(el){ el.value=''; el.focus(); } if(tl) tl.value=''; }
function _snipRender(){
  const body=document.getElementById('snipBody'); if(!body) return;
  const list=getSnippets();
  const hasTgt=_snipTarget && document.body.contains(_snipTarget);
  const cats=[...new Set(list.map(s=>s.cat).filter(Boolean))].sort();
  const catOpts=cats.map(c=>`<option value="${escAttr(c)}"></option>`).join('');
  const add=`<div class="snip-add">`+
      `<input id="snipTitle" class="memo-input snip-in-t" placeholder="제목(선택)" maxlength="60" onkeydown="if(event.key==='Enter')_snipAdd()">`+
      `<input id="snipCat" class="memo-input snip-in-c" list="snipCatList" placeholder="분류(선택)" maxlength="30">`+
      `<input id="snipNew" class="memo-input snip-in-x" placeholder="문구 입력 후 추가. {{오늘}}·{{성명}} 등 치환변수 사용 가능" maxlength="1000" onkeydown="if(event.key==='Enter')_snipAdd()">`+
      `<button class="memo-addbtn" onclick="_snipAdd()">추가</button>`+
      `<datalist id="snipCatList">${catOpts}</datalist></div>`;
  const filterBox= list.length? `<div class="snip-filter"><input class="memo-input" placeholder="제목·문구·분류 검색" value="${escAttr(_snipFilter)}" oninput="_snipSetFilter(this.value)"></div>`:'';
  const hint=`<div class="snip-hint">${hasTgt?'문구를 클릭하면 방금 입력하던 칸에 삽입됩니다.':'삽입할 입력칸을 먼저 클릭한 뒤 문구를 고르면 자동 입력됩니다(대상이 없으면 복사).'} <b>{{오늘}}·{{날짜}}·{{내일}}·{{이번달}}·{{요일}}</b>은 자동 치환, <b>{{성명}}·{{금액}}</b> 등은 삽입 시 입력받습니다.</div>`;
  const q=_snipFilter.trim().toLowerCase();
  const filtered=list.filter(s=>!q||((s.title||'')+' '+(s.text||'')+' '+(s.cat||'')).toLowerCase().includes(q));
  const rows=filtered.length? filtered.map(s=>`<div class="snip-item"><button class="snip-text" onclick="_snipUse('${s.id}')" title="삽입 또는 복사">`+
      `${s.cat?`<span class="snip-cat">${escHtml(s.cat)}</span>`:''}${s.title?`<b class="snip-tt">${escHtml(s.title)}</b> `:''}${escHtml(s.text)}</button>`+
      `<button class="memo-del" onclick="delSnippet('${s.id}')" title="삭제">✕</button></div>`).join('')
    : (list.length?`<div class="snip-empty">검색 결과가 없습니다.</div>`:`<div class="snip-empty">저장된 문구가 없습니다. 위 칸에 자주 쓰는 문구를 추가하세요.</div>`);
  body.innerHTML=add+filterBox+hint+`<div class="snip-list">${rows}</div>`;
}
function _snipUse(id){
  const s=getSnippets().find(x=>x.id===id); if(!s) return;
  const text=_snipExpand(s.text);
  const t=_snipTarget;
  if(t && document.body.contains(t)){
    const v=t.value, st=(typeof t.selectionStart==='number')?t.selectionStart:v.length, en=(typeof t.selectionEnd==='number')?t.selectionEnd:v.length;
    t.value=v.slice(0,st)+text+v.slice(en);
    const pos=st+text.length; try{ t.selectionStart=t.selectionEnd=pos; }catch(e){}
    t.dispatchEvent(new Event('input',{bubbles:true}));   // 저장 트리거(지출·메모 oninput)
    closeSnippets(); setTimeout(()=>{ try{ t.focus(); }catch(e){} },0);
  } else { _copyText(text, ()=>{}); closeSnippets(); }
}

// 문구 모달은 처음 열 때 만든다
function _snipEnsureModal(){
  if(document.getElementById('snipBg')) return;
  const bg=document.createElement('div'); bg.className='coll-modal-bg'; bg.id='snipBg';
  bg.setAttribute('role','dialog'); bg.setAttribute('aria-modal','true'); bg.setAttribute('aria-label','자주 쓰는 문구');
  bg.addEventListener('click', e=>{ if(e.target===bg) closeSnippets(); });
  bg.innerHTML=`<div class="coll-modal" style="width:min(560px,95vw);"><div class="coll-hd"><span style="font-size:15px;font-weight:700;flex:1;">🗂 자주 쓰는 문구</span>`+
    `<button class="assist-close" aria-label="닫기" onclick="closeSnippets()">✕</button></div><div class="coll-body" id="snipBody"></div>`+
    `<div class="fav-modal-foot">지출결의서 입력칸에 붙여 쓰는 문구를 저장해 재사용합니다. 내 PC에만 저장됩니다.</div></div>`;
  document.body.appendChild(bg);
}
document.addEventListener('keydown', e=>{ if(e.key==='Escape'){ const bg=document.getElementById('snipBg'); if(bg&&bg.classList.contains('show')) closeSnippets(); } });

// ── 공개 ─────────────────────────────────────────────────────────────────
window.Expense={ mount:el=>openExpense(el) };
