// 서무비서 확장 — ERP·그룹웨어 화면(모든 프레임)에서 동작
//  1) 지금 화면이 어떤 업무인지 화면 문구로 감지 → 패널에 "이 업무 안내 보기" 제안
//  2) 마지막으로 누른 입력란을 기억 → 패널의 초안을 그 칸에 넣기
//  3) 맨 위 프레임에만 오른쪽 아래 🗂 버튼
// 화면 내용은 기기 밖으로 보내지 않는다. 감지한 업무 이름만 확장 안에서 패널로 전달한다.
(() => {
  if (window.__secLoaded) return; window.__secLoaded = true;
  const TOP = window === window.top;
  let lastEditable = null;

  // ── 입력란 기억 ────────────────────────────────────────────
  const editable = (el) => {
    if (!el || el.nodeType !== 1) return null;
    if (el.tagName === "TEXTAREA") return el;
    if (el.tagName === "INPUT" && /^(text|search|)$/i.test(el.type || "")) return el;
    const ce = el.closest && el.closest('[contenteditable=""],[contenteditable="true"]');
    if (ce) return ce;
    if (el.ownerDocument && el.ownerDocument.designMode === "on") return el.ownerDocument.body;
    return null;
  };
  document.addEventListener("focusin", (e) => {
    const el = editable(e.target);
    if (el) { lastEditable = el; chrome.runtime.sendMessage({ type: "focus" }).catch(() => {}); }
  }, true);
  // 웹 편집기(본문이 iframe designMode)는 focusin 이 문서 단위로 온다
  if (document.designMode === "on") document.addEventListener("click", () => { lastEditable = document.body; chrome.runtime.sendMessage({ type: "focus" }).catch(() => {}); }, true);

  function insertText(text) {
    const el = lastEditable && lastEditable.isConnected ? lastEditable : editable(document.activeElement);
    if (!el) return { ok: false };
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      // 한 줄 칸(제목 등)에는 초안의 첫 줄(제목)만 넣는다
      const v = el.tagName === "INPUT" ? (text.split("\n").map((x) => x.trim()).find(Boolean) || "") : text;
      const start = el.selectionStart ?? el.value.length, end = el.selectionEnd ?? el.value.length;
      // 프레임워크(React 등)가 값 변경을 알아채도록 기본 setter + input 이벤트
      const proto = el.tagName === "INPUT" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, el.value.slice(0, start) + v + el.value.slice(end));
      el.selectionStart = el.selectionEnd = start + v.length;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, where: el.name || el.id || el.tagName.toLowerCase() };
    }
    // contenteditable·웹 편집기: 줄바꿈을 살려 넣는다
    const doc = el.ownerDocument;
    let ok = false;
    // 줄마다 <br> — insertText 는 편집기에 따라 줄바꿈을 문단으로 바꿔 빈 줄이 두 배가 된다
    const esc = (t) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const html = text.split("\n").map((ln) => esc(ln).replace(/^ +/, (sp) => "&nbsp;".repeat(sp.length))).join("<br>");
    try { ok = doc.execCommand("insertHTML", false, html); } catch (e) {}
    if (!ok) { try { ok = doc.execCommand("insertText", false, text); } catch (e) {} }
    if (!ok) {
      const sel = doc.getSelection();
      const frag = doc.createDocumentFragment();
      text.split("\n").forEach((ln, i) => { if (i) frag.appendChild(doc.createElement("br")); frag.appendChild(doc.createTextNode(ln)); });
      if (sel && sel.rangeCount && el.contains(sel.anchorNode)) { const r = sel.getRangeAt(0); r.deleteContents(); r.insertNode(frag); }
      else el.appendChild(frag);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      ok = true;
    }
    return { ok, where: "editor" };
  }

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m.type === "insert") { reply(insertText(String(m.text || ""))); }
    else if (m.type === "chip" && TOP) { setChip(m.q || "", m.title || ""); }
  });

  // ── 화면 감지 ──────────────────────────────────────────────
  // 화면 제목 후보: 문서 제목, 제목 요소, 활성 탭·메뉴, 양식 제목 칸. 본문 전체를 훑지 않는다.
  const SEL = 'h1,h2,h3,legend,caption,.title,.tit,[class*="title"],[class*="Title"],[class*="tit_"],.on,.active,[aria-selected="true"],[aria-current]';
  function candidates() {
    const out = [document.title || ""];
    const els = document.querySelectorAll(SEL);
    for (let i = 0; i < els.length && out.length < 60; i++) {
      const el = els[i];
      if (!el.offsetParent && el.tagName !== "TITLE") continue;      // 보이지 않는 요소 제외
      const t = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
      if (t && t.length <= 40) out.push(t);
    }
    return out;
  }
  let lastSent = "";
  function detect() {
    const texts = candidates();
    for (const [rx, q] of globalThis.SEC_RULES || []) {
      const hit = texts.find((t) => rx.test(t));
      if (hit) {
        const key = q + "|" + hit;
        // 어느 프레임에서 찾았든 서비스 워커가 맨 위 프레임의 🗂 버튼에 다시 알려 준다
        if (key !== lastSent) { lastSent = key; chrome.runtime.sendMessage({ type: "context", context: { q, title: hit.slice(0, 40) } }).catch(() => {}); }
        return;
      }
    }
  }
  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(detect, 600); };
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true, characterData: false });
  window.addEventListener("hashchange", schedule);
  schedule();
  if (TOP) setTimeout(() => setChip("", ""), 0);   // 감지 전에도 🗂 버튼은 보이게

  // ── 🗂 버튼(맨 위 프레임) ───────────────────────────────────
  let host = null, chipQ = "";
  function ui() {
    if (host || !TOP || !document.body) return host;
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
    if (!TOP) return;
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
