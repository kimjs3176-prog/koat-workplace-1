// 서무비서 확장 — ERP·그룹웨어 화면(모든 프레임)에서 동작
//  1) 화면 감지: 기관·내가 만든 'ERP 화면 규칙'(프로필) → 기본 문구 규칙 순으로 지금 업무를 알아본다
//  2) 초안 넣기: 화면 규칙의 '칸 매핑'으로 여러 칸을 한 번에 채우거나, 마지막으로 누른 칸에 넣는다
//  3) 구조 분석·요소 고르기·강조: 'ERP 맞춤' 도구가 이 화면의 입력란·라벨·편집기·제목을 파악한다
//  4) 맨 위 프레임에만 오른쪽 아래 🗂 버튼
// 화면 내용은 기기 밖으로 보내지 않는다. 구조 분석 결과(칸 이름·위치)는 관리자가 저장할 때만 서버에 간다.
(() => {
  if (window.__secLoaded) return; window.__secLoaded = true;
  const TOP = window === window.top;
  // 🗂 버튼을 그릴 프레임: 보통은 맨 위. 맨 위가 <frameset>(온나라 등 옛 구조)이면 그 안의 가장 큰 프레임
  function uiFrame() {
    if (TOP) return !(document.body && document.body.tagName === "FRAMESET");
    try {
      if (window.parent !== window.top || window.top.document.body.tagName !== "FRAMESET") return false;
      let best = null, area = -1;
      for (let i = 0; i < window.top.frames.length; i++) {
        const f = window.top.frames[i]; const a = (f.innerWidth || 0) * (f.innerHeight || 0);
        if (a > area) { area = a; best = f; }
      }
      return best === window;
    } catch (e) { return false; }
  }
  let lastEditable = null;

  // ── 프레임 위치(경로) — 프레임 구조가 같은 ERP 화면이면 늘 같은 값 ─────────────
  function framePath() {
    const segs = [];
    let w = window;
    for (let i = 0; i < 12 && w !== w.top; i++) {
      let fe = null;
      try { fe = w.frameElement; } catch (e) { fe = null; }
      if (!fe) {                              // 다른 출처의 프레임: 주소로 구분
        let loc = ""; try { loc = w.location.host + w.location.pathname; } catch (e) { loc = "?"; }
        segs.unshift("@" + loc);
        break;
      }
      const sibs = [...fe.ownerDocument.querySelectorAll("iframe,frame")];
      segs.unshift(fe.id ? "#" + fe.id : fe.name ? "~" + fe.name : "%" + sibs.indexOf(fe));
      w = w.parent;
    }
    return segs.join(">");
  }
  const MYPATH = framePath();
  // 진단 기록: 서비스 워커로 보낸다(값은 보내지 않고 구조·결과만). 기록이 꺼져 있으면 서비스 워커가 버린다.
  const dlog = (ev, data) => { try { chrome.runtime.sendMessage({ type: "log", src: TOP ? "content" : "content(frame)", ev, data: Object.assign({ frame: MYPATH }, data || {}) }).catch(() => {}); } catch (e) {} };
  dlog("load", { url: location.pathname, title: document.title.slice(0, 60), designMode: document.designMode === "on", top: TOP });
  // 이 프레임이 새 화면을 열었다 — 이 프레임이 알려 둔 업무가 있으면 서비스 워커가 지운다(메뉴만 바뀌는 그룹웨어 대비)
  try { chrome.runtime.sendMessage({ type: "frameNav" }).catch(() => {}); } catch (e) {}

  // ── 입력란 ────────────────────────────────────────────────
  const isTextInput = (el) => el.tagName === "INPUT" && /^(text|search|email|tel|number|date|)$/i.test(el.type || "");
  const editable = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === "TEXTAREA" || isTextInput(el)) return el;
    const ce = el.closest && el.closest('[contenteditable=""],[contenteditable="true"]');
    if (ce) return ce;
    if (el.ownerDocument && el.ownerDocument.designMode === "on") return el.ownerDocument.body;
    return null;
  };
  const kindOf = (el) => el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "INPUT" ? "input"
    : el.tagName === "SELECT" ? "select" : "editor";
  const visible = (el) => {
    if (el === document.body) return true;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2 && getComputedStyle(el).visibility !== "hidden";
  };
  const clean = (t, n = 40) => String(t || "").replace(/\s+/g, " ").replace(/[*:：]\s*$/, "").trim().slice(0, n);

  // 칸 이름 찾기: label[for] · 감싼 label · aria · 표의 왼쪽/위 머리칸 · 앞 글자 · placeholder
  function labelOf(el) {
    try {
      if (el.id) { const l = el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l && clean(l.innerText)) return clean(l.innerText); }
      const wrap = el.closest && el.closest("label"); if (wrap && clean(wrap.innerText)) return clean(wrap.innerText);
      if (el.getAttribute("aria-label")) return clean(el.getAttribute("aria-label"));
      const lb = el.getAttribute("aria-labelledby");
      if (lb) { const t = lb.split(/\s+/).map((i) => (el.ownerDocument.getElementById(i) || {}).innerText || "").join(" "); if (clean(t)) return clean(t); }
      const cell = el.closest && el.closest("td,th");
      if (cell) {
        let p = cell.previousElementSibling;
        while (p && !clean(p.innerText)) p = p.previousElementSibling;
        if (p && clean(p.innerText)) return clean(p.innerText);
        const row = cell.parentElement, tbl = cell.closest("table");
        if (row && tbl) {                                   // 위쪽 머리 행의 같은 열
          const idx = [...row.children].indexOf(cell);
          const prev = row.previousElementSibling;
          if (prev && prev.children[idx] && clean(prev.children[idx].innerText)) return clean(prev.children[idx].innerText);
        }
      }
      let s = el.previousElementSibling;
      for (let i = 0; i < 3 && s; i++, s = s.previousElementSibling) if (clean(s.innerText)) return clean(s.innerText);
      // 부모 안의 바로 앞 글자("내용<div contenteditable>")
      let t = el.previousSibling, txt = "";
      for (let i = 0; i < 4 && t && !txt; i++, t = t.previousSibling) if (t.nodeType === 3) txt = clean(t.textContent);
      if (txt) return txt;
      if (el.placeholder) return clean(el.placeholder);
      if (el.title) return clean(el.title);
      if (el.name) return clean(el.name);
    } catch (e) {}
    return el === el.ownerDocument.body ? "본문 편집기" : "";
  }
  // 다시 찾기 쉬운 선택자: 안정적인 id → name → 경로
  function cssPath(el) {
    if (el === el.ownerDocument.body) return "body";
    if (el.id && !/\d{5,}|[a-f0-9]{8,}|^(ext|gen|ui-id|react|ember|mui)/i.test(el.id)) return "#" + CSS.escape(el.id);
    if (el.name) {
      const s = `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
      if (el.ownerDocument.querySelectorAll(s).length === 1) return s;
    }
    const parts = [];
    let n = el;
    for (let d = 0; n && n.nodeType === 1 && n !== el.ownerDocument.body && d < 8; d++) {
      if (n.id && !/\d{5,}/.test(n.id)) { parts.unshift("#" + CSS.escape(n.id)); break; }
      const tag = n.tagName.toLowerCase();
      const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
      n = n.parentElement;
    }
    return parts.join(">");
  }
  function describe(el) {
    const f = { sel: cssPath(el), label: labelOf(el), kind: kindOf(el), frame: MYPATH };
    if (el.name) f.name = String(el.name).slice(0, 120);
    if (el.id) f.fid = String(el.id).slice(0, 120);
    if (el.tagName === "INPUT") f.type = el.type || "text";
    f.empty = !((el.value !== undefined ? el.value : el.innerText) || "").trim();
    return f;
  }
  // ── 값 넣기 ────────────────────────────────────────────────
  function setValue(el, text, mode) {
    text = String(text ?? "");
    el.focus && el.focus();
    if (el.tagName === "SELECT") {
      const opt = [...el.options].find((o) => o.text.trim() === text.trim() || o.value === text);
      if (!opt) return false;
      el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); return true;
    }
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      // 한 줄 칸에는 첫 줄만
      const v = el.tagName === "INPUT" ? (text.split("\n").map((x) => x.trim()).find(Boolean) || "") : text;
      const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      if (mode === "insert") {
        const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
        setter.call(el, el.value.slice(0, start) + v + el.value.slice(end));
        try { el.selectionStart = el.selectionEnd = start + v.length; } catch (e) {}
      } else setter.call(el, v);                       // 매핑 채우기는 칸을 통째로 바꾼다
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
    // contenteditable·웹 편집기: 줄마다 <br> (insertText 는 편집기에 따라 빈 줄이 두 배가 된다)
    const doc = el.ownerDocument;
    if (mode !== "insert") {
      try { const r = doc.createRange(); r.selectNodeContents(el); const s = doc.getSelection(); s.removeAllRanges(); s.addRange(r); } catch (e) {}
    }
    const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const html = text.split("\n").map((ln) => esc(ln).replace(/^ +/, (sp) => "&nbsp;".repeat(sp.length))).join("<br>");
    let ok = false;
    try { ok = doc.execCommand("insertHTML", false, html); } catch (e) {}
    if (!ok) { try { ok = doc.execCommand("insertText", false, text); } catch (e) {} }
    if (!ok) {
      if (mode !== "insert") el.textContent = "";
      text.split("\n").forEach((ln, i) => { if (i) el.appendChild(doc.createElement("br")); el.appendChild(doc.createTextNode(ln)); });
      ok = true;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return ok;
  }

  document.addEventListener("focusin", (e) => {
    const el = editable(e.target);
    if (el) {
      if (el !== lastEditable) dlog("focus", { kind: kindOf(el), label: labelOf(el), sel: cssPath(el) });
      lastEditable = el; chrome.runtime.sendMessage({ type: "focus" }).catch(() => {});
    }
  }, true);
  if (document.designMode === "on") document.addEventListener("click", () => { lastEditable = document.body; chrome.runtime.sendMessage({ type: "focus" }).catch(() => {}); }, true);

  function insertText(text) {
    const el = lastEditable && lastEditable.isConnected ? lastEditable : editable(document.activeElement);
    if (!el) { dlog("insert", { ok: false, why: "누른 입력란 없음", active: document.activeElement && document.activeElement.tagName }); return { ok: false }; }
    let ok = false, err = "";
    try { ok = setValue(el, text, "insert"); } catch (e) { err = e.message; }
    dlog("insert", { ok, kind: kindOf(el), label: labelOf(el), err, len: String(text).length });
    return { ok, where: el.name || el.id || el.tagName.toLowerCase() };
  }

  // ── 구조 분석(ERP 맞춤 도구가 부름) ─────────────────────────────
  globalThis.__secAnalyze = () => {
    const fields = [];
    const seen = new Set();
    const add = (el) => { if (seen.has(el) || !visible(el)) return; seen.add(el); fields.push(describe(el)); };
    document.querySelectorAll("input,textarea,select").forEach((el) => {
      if (el.tagName === "INPUT" && !isTextInput(el)) return;
      if (el.disabled || el.readOnly) return;
      add(el);
    });
    document.querySelectorAll('[contenteditable="true"],[contenteditable=""]').forEach((el) => { if (!el.parentElement || !el.parentElement.closest('[contenteditable="true"],[contenteditable=""]')) add(el); });
    if (document.designMode === "on" || (document.body && document.body.isContentEditable && !TOP)) add(document.body);
    return { path: MYPATH, top: TOP, url: location.href.slice(0, 300), title: document.title.slice(0, 120),
      headings: candidates().slice(0, 30), fields: fields.slice(0, 80) };
  };
  // ── 진단 스냅샷: 화면 구조 + 버튼 이름 + 편집기·라이브러리 단서(값은 담지 않는다) ──────────
  globalThis.__secSnapshot = () => {
    const a = globalThis.__secAnalyze();
    const btns = [];
    document.querySelectorAll('button,a,input[type="button"],input[type="submit"],[role="button"],[onclick]').forEach((el) => {
      if (btns.length >= 80 || (el.offsetParent === null && el !== document.body)) return;
      const t = String(el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").replace(/\s+/g, " ").trim();
      if (t && t.length <= 20 && !btns.some((b) => b.t === t)) btns.push({ t, tag: el.tagName.toLowerCase(), id: el.id || "", cls: String(el.className || "").slice(0, 40) });
    });
    const frames = [...document.querySelectorAll("iframe,frame")].slice(0, 30).map((f) => {
      let same = false, dm = "", ce = false;
      try { same = !!f.contentDocument; dm = f.contentDocument.designMode; ce = !!(f.contentDocument.body && f.contentDocument.body.isContentEditable); } catch (e) {}
      let src = f.getAttribute("src") || ""; try { if (src && !src.startsWith("about:")) { const u = new URL(src, location.href); src = u.pathname; } } catch (e) {}
      return { id: f.id || "", name: f.name || "", src: src.slice(0, 120), sameOrigin: same, designMode: dm, editable: ce, w: f.clientWidth, h: f.clientHeight };
    });
    const scripts = [...document.scripts].map((x) => (x.src || "").split("?")[0].split("/").pop()).filter(Boolean);
    const hints = scripts.filter((n) => /ckeditor|tinymce|dext|namo|smarteditor|se2|husky|quill|editor|jquery|ext-all|sencha|kendo|devextreme|nexacro|websquare|xplatform|miplatform/i.test(n)).slice(0, 20);
    try { const u = new URL(location.href); a.url = u.origin + u.pathname + (u.search ? "?" + [...u.searchParams.keys()].join("&") : ""); } catch (e) {}
    return Object.assign(a, { buttons: btns, iframes: frames, scriptHints: hints, scripts: scripts.length, contentEditable: document.querySelectorAll("[contenteditable]").length, forms: document.forms.length });
  };
  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m.type === "insert") { reply(insertText(String(m.text || ""))); }
    else if (m.type === "chip" && uiFrame()) { setChip(m.q || "", m.title || ""); }
  });

  // ── 화면 감지 ──────────────────────────────────────────────
  const SEL = 'h1,h2,h3,legend,caption,.title,.tit,[class*="title"],[class*="Title"],[class*="tit_"],.on,.active,[aria-selected="true"],[aria-current]';
  // 첨부파일 이름(예: 출장증빙서식_2026-09-22.xlsx)은 화면 제목이 아니다
  const FILE_RX = /\.(xlsx?|hwpx?|hwp|pdf|docx?|pptx?|zip|jpe?g|png|gif|txt|csv)\)?$/i;
  function candidates() {
    const out = [document.title || ""];
    const els = document.querySelectorAll(SEL);
    for (let i = 0; i < els.length && out.length < 60; i++) {
      const el = els[i];
      if (!el.offsetParent) continue;
      const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      if (t && t.length <= 40 && !FILE_RX.test(t) && !out.includes(t)) out.push(t);
    }
    return out.filter(Boolean);
  }
  let lastSent = "", noneLogged = "";
  // 이 프레임이 알려 둔 업무가 더는 화면에 없으면 지우게 한다
  function forget() { if (lastSent) { lastSent = ""; chrome.runtime.sendMessage({ type: "frameNav" }).catch(() => {}); } }
  function detect() {
    if (globalThis.SEC_SKIP_URL && globalThis.SEC_SKIP_URL.test(location.pathname)) { forget(); return; }
    const texts = candidates();
    let ctx = null;
    // rank: 규칙 순서 — 여러 프레임이 서로 다른 업무를 알아보면 더 구체적인(앞쪽) 규칙을 쓴다
    {                                                   // 기관 ERP 의 주소가 정확한 화면(신청서 팝업 등)은 주소가 먼저
      const base = (globalThis.SEC_RULES || []).length;
      for (const [i, [rx, q, proc]] of (globalThis.SEC_URL_RULES || []).entries()) {
        if (rx.test(location.pathname)) { ctx = { q, title: q, proc: proc || "", rank: base + i, byUrl: true }; break; }
      }
    }
    if (!ctx) for (const [i, [rx, q, proc]] of (globalThis.SEC_RULES || []).entries()) {
      const hit = texts.find((t) => rx.test(t));
      // '잔여연차 : 9.29' 처럼 숫자 섞인 긴 문구는 화면 이름으로 쓰지 않는다(개인 정보·매번 바뀜)
      if (hit) { ctx = { q, title: (/\d/.test(hit) && hit.length > 10 ? q : hit).slice(0, 40), proc: proc || "", rank: i }; break; }
    }
    if (!ctx) {
      // 업무를 알아보지 못한 화면 — 어떤 제목 문구가 있었는지 남겨 규칙을 보강한다(주소마다 한 번)
      if (texts.length && noneLogged !== location.pathname) { noneLogged = location.pathname; dlog("detect.none", { url: location.pathname, texts: texts.slice(0, 25) }); }
      forget();
      return;
    }
    const key = JSON.stringify(ctx);
    // 어느 프레임에서 찾았든 서비스 워커가 맨 위 프레임의 🗂 버튼에 다시 알려 준다
    if (key !== lastSent) { lastSent = key; dlog("detect", { ctx, by: ctx.byUrl ? "주소 규칙" : "기본 규칙", hit: ctx.byUrl ? location.pathname : (texts.find((t) => (globalThis.SEC_RULES || [])[ctx.rank] && globalThis.SEC_RULES[ctx.rank][0].test(t)) || "") }); chrome.runtime.sendMessage({ type: "context", context: ctx }).catch(() => {}); }
  }
  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(detect, 600); };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener("hashchange", schedule);
  chrome.runtime.sendMessage({ type: "hello" }).catch(() => {});   // 이 탭에 확장이 붙었음을 알림(IE 모드 등 판별용)
  schedule();
  setTimeout(() => { if (uiFrame()) setChip("", ""); }, TOP ? 0 : 800);   // 감지 전에도 🗂 버튼은 보이게(frameset 은 프레임이 다 뜬 뒤 판단)

  // ── 🗂 버튼(맨 위 프레임) ───────────────────────────────────
  let host = null, chipQ = "";
  function ui() {
    if (host || !uiFrame() || !document.body) return host;
    host = document.createElement("div");
    host.id = "koat-sec-ext";
    const sh = host.attachShadow({ mode: "closed" });
    sh.innerHTML = `<style>
      :host{all:initial}
      .w{position:fixed;right:18px;bottom:18px;z-index:2147483646;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font-family:"Pretendard","Malgun Gothic",system-ui,sans-serif}
      .b{width:48px;height:48px;border-radius:50%;border:0;background:#256ef4;color:#fff;font-size:22px;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}
      .b:focus-visible,.c:focus-visible{outline:3px solid #111;outline-offset:2px}
      .c{display:none;max-width:280px;border:1px solid #c9d6f2;background:#fff;color:#1a1a1a;border-radius:12px;padding:8px 12px;font-size:13px;line-height:1.45;text-align:left;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.15)}
      .c b{color:#256ef4}
      .x{margin-left:6px;color:#888;font-size:12px}
    </style><div class="w"><button class="c" type="button"></button><button class="b" type="button" title="서무비서 열기 (Alt+Shift+S)" aria-label="서무비서 열기">🗂</button></div>`;
    const chip = sh.querySelector(".c");
    sh.querySelector(".b").addEventListener("click", () => chrome.runtime.sendMessage({ type: "open", q: chipQ }).catch(() => {}));
    chip.addEventListener("click", (e) => {
      if (e.target.classList && e.target.classList.contains("x")) { chip.style.display = "none"; chip.dataset.closed = "1"; return; }
      chrome.runtime.sendMessage({ type: "open", q: chipQ }).catch(() => {});
    });
    host._chip = chip;
    document.body.appendChild(host);
    return host;
  }
  function setChip(q, title) {
    if (!uiFrame()) return;
    chrome.runtime.sendMessage({ type: "settings" }).then((s) => {
      if (!s || s.floating === false) { if (host) host.remove(), host = null; return; }
      const h = ui(); if (!h) return;
      const chip = h._chip;
      if (q !== chipQ) chip.dataset.closed = "";
      chipQ = q;
      if (!q || chip.dataset.closed) { chip.style.display = "none"; return; }
      chip.innerHTML = "";
      const b = document.createElement("b"); b.textContent = "🗂 " + title;
      const x = document.createElement("span"); x.className = "x"; x.textContent = "✕"; x.setAttribute("aria-label", "닫기");
      chip.append(b, document.createElement("br"), document.createTextNode("이 업무의 절차·기한·반려 점검 보기"), x);
      chip.style.display = "block";
    }).catch(() => {});
  }
})();
