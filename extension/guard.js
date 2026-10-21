// 서무비서 확장 — 결재 전 점검
// ERP 에서 '상신·결재요청·제출' 버튼을 누르면, 지금 화면 업무의 반려 점검 항목을 먼저 보여 준다.
// 점검했다고 누르면 원래 버튼을 그대로 다시 눌러 준다(ERP 동작은 바꾸지 않는다). 설정에서 끌 수 있다.
(() => {
  if (window.__secGuard) return; window.__secGuard = true;
  let guard = null;                  // {proc, title, pitfalls:[{t,basis}], enabled}
  let bypass = false;
  // 이름 전체가 맞아야 한다 — '결재요청함'·'결재상신함'(메뉴)·'결재 요청 취소'는 상신이 아니다
  const SUBMIT = /^(결재\s*)?상신(하기)?$|^결재\s*(요청|올리기|올림|상신)(하기)?$|^기안\s*완료$|^(제출|신청|승인\s*요청)(하기)?$|^결재\s*하기$/;
  // 진단 기록(2026-10-16)의 KOAT ERP 제출 버튼 — 업무 화면에서만(메뉴의 같은 이름 링크는 아래 MENU 로 거른다)
  const SUBMIT_ERP = /^(출장|여비\s*정산|근태|휴가|시간외(근무)?)\s*신청$|^서무\s*확정\s*요청$|^(정산|확정)\s*요청$/;
  // 왼쪽 메뉴·상단 메뉴·트리·탭 안의 같은 이름은 화면을 여는 링크라 점검하지 않는다
  const inMenu = (el) => !!el.closest('nav,[role="menu"],[role="menubar"],[role="tree"],[role="tablist"],[class*="menu" i],[id*="menu" i],[class*="lnb" i],[class*="gnb" i],[class*="snb" i],[class*="tree" i]');   // (class 'tab' 은 table 과 겹쳐 쓰지 않는다)
  // 메뉴 안 링크·메뉴 항목은 화면을 여는 것 — 'menu' 가 이름에 든 도구 막대의 진짜 버튼은 그대로 점검한다
  const menuLink = (el) => inMenu(el) && (el.tagName === "A" || /^(menuitem|treeitem|tab|link)$/.test(el.getAttribute("role") || ""));
  const isSubmitLabel = (el, t) => !!t && t.length <= 14 && ((SUBMIT.test(t) && !menuLink(el)) || (SUBMIT_ERP.test(t) && el.tagName !== "A" && !inMenu(el)));
  const ackKey = () => "secGuardAck:" + (guard && guard.proc);
  const acked = () => { try { return Date.now() - Number(sessionStorage.getItem(ackKey()) || 0) < 10 * 60 * 1000; } catch (e) { return false; } };

  chrome.runtime.onMessage.addListener((m) => { if (m.type === "guard") guard = m.guard; });
  chrome.runtime.sendMessage({ type: "getGuard" }).then((g) => { if (g && g.guard) guard = g.guard; }).catch(() => {});

  const dlog = (ev, data) => { try { chrome.runtime.sendMessage({ type: "log", src: "guard", ev, data }).catch(() => {}); } catch (e) {} };
  // 상신일 수도 있는 버튼(이름에 이런 말이 들어간 것) — 가로채지 않았을 때도 이름을 남겨 규칙을 보강한다
  const MAYBE = /상신|결재|제출|기안|신청|승인|요청|보내기|발송|완료/;
  // 그림 버튼(<a><img alt="상신"></a>, <input type=image alt="상신">)도 이름을 읽는다
  function labelOf(el) {
    const img = el.querySelector && el.querySelector("img[alt]");
    return String(el.innerText || (el.type !== "image" && el.value) || el.getAttribute("aria-label") || el.title || el.alt || (img && img.alt) || "").replace(/\s+/g, " ").trim();
  }
  document.addEventListener("click", (e) => {
    if (bypass) return;
    const el = e.target.closest && e.target.closest('button,a,input[type="button"],input[type="submit"],input[type="image"],[role="button"],[onclick]');
    if (!el) return;
    const t = labelOf(el);
    const isSubmit = isSubmitLabel(el, t);
    if (t && t.length <= 20 && (isSubmit || MAYBE.test(t))) {
      dlog("button", { label: t, submit: isSubmit, tag: el.tagName.toLowerCase(), id: el.id || "", menu: inMenu(el), path: location.pathname.slice(0, 80),
        guard: guard ? { proc: guard.proc, n: (guard.pitfalls || []).length, enabled: guard.enabled } : null, acked: acked() });
    }
    if (!guard || !guard.enabled || !(guard.pitfalls || []).length || acked()) return;
    if (!isSubmit) return;
    e.preventDefault(); e.stopImmediatePropagation();
    dlog("guard.show", { label: t, proc: guard.proc, n: guard.pitfalls.length });
    show(el, t);
  }, true);

  // 입력란에서 Enter 로 양식을 보내는 경우(버튼 클릭 없이) — 보내는 버튼 이름이 상신이면 같은 점검
  document.addEventListener("submit", (e) => {
    if (bypass || !guard || !guard.enabled || !(guard.pitfalls || []).length || acked()) return;
    const el = e.submitter; const t = el ? labelOf(el) : "";
    if (!isSubmitLabel(el, t)) return;
    e.preventDefault(); e.stopImmediatePropagation();
    dlog("guard.show", { label: t, proc: guard.proc, n: guard.pitfalls.length, via: "submit" });
    show(el, t);
  }, true);

  // ── 화면 입력값 읽기(결재 전 입력값 점검용) — 값은 판정에만 쓰고 기록·전송하지 않는다 ──
  function fieldLabel(el) {
    const own = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("aria-label") || el.title || el.placeholder || "";
    if (own.trim()) return own.trim().slice(0, 40);
    const cell = el.closest("td,dd,li,div"); let row = el.closest("tr");
    // 표: 같은 줄의 앞 칸(th·td) 글 / 정의 목록: 앞 dt / 그 밖: 바로 앞 형제 글
    let prev = cell && cell.previousElementSibling;
    while (prev && !(prev.innerText || "").trim()) prev = prev.previousElementSibling;
    const t = (prev && prev.innerText) || (row && row.querySelector("th") && row.querySelector("th").innerText) || el.name || el.id || "";
    return String(t).replace(/\s+/g, " ").trim().slice(0, 40);
  }
  function screenOf(doc) {
    const docs = [doc];
    try { for (const f of (window.top.document || doc).querySelectorAll("iframe,frame")) { try { if (f.contentDocument && !docs.includes(f.contentDocument)) docs.push(f.contentDocument); } catch (e) {} } } catch (e) {}
    const fields = [], files = []; let text = "", row = 0;
    for (const d of docs) {
      const rows = new Map();
      for (const el of d.querySelectorAll('input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio]),select,textarea')) {
        if (el.type === "file") { files.push(el); continue; }
        const v = el.tagName === "SELECT" ? (el.selectedOptions[0] && el.selectedOptions[0].text) || "" : el.value;
        if (!v) continue;
        const r = el.closest("tr,dd,li,.row,p") || el.parentElement; if (!rows.has(r)) rows.set(r, row++);
        fields.push({ label: fieldLabel(el), value: String(v).slice(0, 40), row: rows.get(r) });
      }
      try { text += " " + (d.body ? d.body.innerText : "").slice(0, 20000); } catch (e) {}
    }
    return { fields, attach: globalThis.SEC_CHECK ? SEC_CHECK.countAttach(text, files) : undefined };
  }

  function show(btn, label) {
    // 같은 출처면 맨 위 창에 띄운다(안쪽 프레임이 작아도 카드가 잘리지 않게)
    let doc = document;
    try { if (window.top !== window && window.top.document.body) doc = window.top.document; } catch (e) { doc = document; }
    const host = doc.createElement("div");
    host.id = "koat-sec-guard";
    const sh = host.attachShadow({ mode: "open" });
    const ps = guard.pitfalls.slice(0, 12);
    // 화면 값으로 판정할 수 있는 항목은 결과를 붙이고, 걸린 항목을 맨 위로
    let ev = [];
    try { if (globalThis.SEC_CHECK && ps.some((p) => p.check)) ev = SEC_CHECK.evaluate(ps, screenOf(btn.ownerDocument || document), new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10)); } catch (e) { ev = []; }
    const order = ps.map((p, i) => i).sort((a, b) => ((ev[a] && !ev[a].ok) ? 0 : 1) - ((ev[b] && !ev[b].ok) ? 0 : 1));
    const nFail = ev.filter((x) => x && !x.ok).length + (ev.extra ? 1 : 0), nOk = ev.filter((x) => x && x.ok).length;
    if (nFail || nOk) dlog("guard.values", { fail: nFail, ok: nOk, total: ps.length });     // 값은 남기지 않고 개수만
    sh.innerHTML = `<style>
      :host{all:initial}
      .dim{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:"Pretendard","Malgun Gothic",system-ui,sans-serif}
      .card{background:#fff;color:#1a1a1a;border-radius:14px;max-width:520px;width:calc(100% - 32px);max-height:calc(100% - 40px);overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.3);padding:18px 18px 14px}
      h2{margin:0 0 4px;font-size:17px}
      .sub{color:#5f6b7a;font-size:12.5px;margin:0 0 12px;line-height:1.5}
      label{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid #e3e7ee;border-radius:9px;margin-bottom:6px;font-size:13.5px;line-height:1.5;cursor:pointer}
      label.on{background:#ecfdf5;border-color:#10b981}
      label.fail{border-color:#dc2626;background:#fef2f2}
      .v{display:block;font-size:12px;margin-top:2px;font-weight:600}.v.ok{color:#047857}.v.no{color:#b91c1c}
      .extra{border:1px solid #dc2626;background:#fef2f2;color:#b91c1c;border-radius:9px;padding:8px 10px;font-size:13px;margin-bottom:6px;font-weight:600}
      input{margin-top:3px;width:16px;height:16px;flex-shrink:0}
      .b{display:block;color:#6b7280;font-size:11.5px}
      .row{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end;margin-top:12px}
      button{border:0;border-radius:9px;padding:9px 14px;font-size:13.5px;font-weight:700;cursor:pointer;font-family:inherit}
      .go{background:#256ef4;color:#fff}.go.part{background:#b45309}
      .ghost{background:#f1f5f9;color:#1a1a1a}
      button:focus-visible,input:focus-visible{outline:3px solid #111;outline-offset:2px}
    </style><div class="dim" role="dialog" aria-modal="true" aria-label="결재 전 점검"><div class="card">
      <h2>🚫 결재 올리기 전 점검</h2>
      <p class="sub">${esc(guard.title || "")} — '${esc(label)}' 전에 자주 반려되는 항목입니다. 확인한 항목에 체크하세요.</p>
      ${nFail || nOk ? `<p class="sub">🔎 화면에 입력된 값으로 ${nOk + nFail}개 항목을 확인했습니다${nFail ? ` — <b style="color:#b91c1c">${nFail}개 확인 필요</b>` : ""}. 값은 저장하지 않습니다.</p>` : ""}
      ${ev.extra ? `<div class="extra">⚠ ${esc(ev.extra.note)}</div>` : ""}
      <div class="list">${order.map((i) => { const p = ps[i], v = ev[i];
        return `<label class="${v && !v.ok ? "fail" : ""}"><input type="checkbox" data-i="${i}"><span>${esc(p.t)}${v ? `<span class="v ${v.ok ? "ok" : "no"}">${v.ok ? "✓" : "⚠"} ${esc(v.note)}</span>` : ""}${(p.basis || []).length ? `<span class="b">근거: ${p.basis.map((b) => esc(b.reg + (b.art ? ` 제${b.art}조` : ""))).join(", ")}</span>` : ""}</span></label>`; }).join("")}</div>
      <div class="row"><button class="ghost" data-a="more" type="button">서무비서에서 자세히</button><button class="ghost" data-a="no" type="button">취소</button><button class="go part" data-a="go" type="button">${ps.length}개 남음 — 그래도 계속</button></div>
    </div></div>`;
    const go = sh.querySelector('[data-a="go"]');
    const sync = () => {
      const left = [...sh.querySelectorAll("input")].filter((x) => !x.checked).length;
      sh.querySelectorAll("label").forEach((l) => l.classList.toggle("on", l.querySelector("input").checked));
      go.textContent = left ? `${left}개 남음 — 그래도 계속` : `모두 확인 — '${label}' 계속`;
      go.classList.toggle("part", !!left);
    };
    sh.addEventListener("change", sync);
    const close = () => { host.remove(); doc.removeEventListener("keydown", key, true); };
    const key = (e) => { if (e.key === "Escape") close(); };
    doc.addEventListener("keydown", key, true);
    sh.querySelector('[data-a="no"]').addEventListener("click", () => { dlog("guard.cancel", { label }); close(); });
    sh.querySelector('[data-a="more"]').addEventListener("click", () => { chrome.runtime.sendMessage({ type: "open", q: guard.q || guard.title }).catch(() => {}); });
    go.addEventListener("click", () => {
      dlog("guard.continue", { label, checked: [...sh.querySelectorAll("input")].filter((x) => x.checked).length, total: ps.length });
      try { sessionStorage.setItem(ackKey(), String(Date.now())); } catch (e) {}
      close();
      bypass = true; try { btn.click(); } finally { setTimeout(() => { bypass = false; }, 0); }
    });
    (doc.body || doc.documentElement).appendChild(host);
    setTimeout(() => { const f = sh.querySelector("input"); f && f.focus(); }, 0);
  }
  function esc(s) { return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])); }
})();
