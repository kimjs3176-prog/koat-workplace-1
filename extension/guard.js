// 서무비서 확장 — 결재 전 점검
// ERP 에서 '상신·결재요청·제출' 버튼을 누르면, 지금 화면 업무의 반려 점검 항목을 먼저 보여 준다.
// 점검했다고 누르면 원래 버튼을 그대로 다시 눌러 준다(ERP 동작은 바꾸지 않는다). 설정에서 끌 수 있다.
(() => {
  if (window.__secGuard) return; window.__secGuard = true;
  let guard = null;                  // {proc, title, pitfalls:[{t,basis}], enabled}
  let bypass = false;
  const SUBMIT = /^(결재\s*)?상신(하기)?$|결재\s*(요청|올리기|올림|상신)|^기안\s*완료$|^(제출|신청|승인\s*요청)(하기)?$|^결재\s*하기$/;
  const ackKey = () => "secGuardAck:" + (guard && guard.proc);
  const acked = () => { try { return Date.now() - Number(sessionStorage.getItem(ackKey()) || 0) < 10 * 60 * 1000; } catch (e) { return false; } };

  chrome.runtime.onMessage.addListener((m) => { if (m.type === "guard") guard = m.guard; });
  chrome.runtime.sendMessage({ type: "getGuard" }).then((g) => { if (g && g.guard) guard = g.guard; }).catch(() => {});

  const dlog = (ev, data) => { try { chrome.runtime.sendMessage({ type: "log", src: "guard", ev, data }).catch(() => {}); } catch (e) {} };
  // 상신일 수도 있는 버튼(이름에 이런 말이 들어간 것) — 가로채지 않았을 때도 이름을 남겨 규칙을 보강한다
  const MAYBE = /상신|결재|제출|기안|신청|승인|요청|보내기|발송|완료/;
  function labelOf(el) { return String(el.innerText || el.value || el.getAttribute("aria-label") || el.title || "").replace(/\s+/g, " ").trim(); }
  document.addEventListener("click", (e) => {
    if (bypass) return;
    const el = e.target.closest && e.target.closest('button,a,input[type="button"],input[type="submit"],[role="button"],[onclick]');
    if (!el) return;
    const t = labelOf(el);
    const isSubmit = !!t && t.length <= 14 && SUBMIT.test(t);
    if (t && t.length <= 20 && (isSubmit || MAYBE.test(t))) {
      dlog("button", { label: t, submit: isSubmit, tag: el.tagName.toLowerCase(), id: el.id || "",
        guard: guard ? { proc: guard.proc, n: (guard.pitfalls || []).length, enabled: guard.enabled } : null, acked: acked() });
    }
    if (!guard || !guard.enabled || !(guard.pitfalls || []).length || acked()) return;
    if (!isSubmit) return;
    e.preventDefault(); e.stopImmediatePropagation();
    dlog("guard.show", { label: t, proc: guard.proc, n: guard.pitfalls.length });
    show(el, t);
  }, true);

  function show(btn, label) {
    // 같은 출처면 맨 위 창에 띄운다(안쪽 프레임이 작아도 카드가 잘리지 않게)
    let doc = document;
    try { if (window.top !== window && window.top.document.body) doc = window.top.document; } catch (e) { doc = document; }
    const host = doc.createElement("div");
    host.id = "koat-sec-guard";
    const sh = host.attachShadow({ mode: "open" });
    const ps = guard.pitfalls.slice(0, 12);
    sh.innerHTML = `<style>
      :host{all:initial}
      .dim{position:fixed;inset:0;background:rgba(15,23,42,.45);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:"Pretendard","Malgun Gothic",system-ui,sans-serif}
      .card{background:#fff;color:#1a1a1a;border-radius:14px;max-width:520px;width:calc(100% - 32px);max-height:calc(100% - 40px);overflow:auto;box-shadow:0 12px 40px rgba(0,0,0,.3);padding:18px 18px 14px}
      h2{margin:0 0 4px;font-size:17px}
      .sub{color:#5f6b7a;font-size:12.5px;margin:0 0 12px;line-height:1.5}
      label{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;border:1px solid #e3e7ee;border-radius:9px;margin-bottom:6px;font-size:13.5px;line-height:1.5;cursor:pointer}
      label.on{background:#ecfdf5;border-color:#10b981}
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
      <div class="list">${ps.map((p, i) => `<label><input type="checkbox" data-i="${i}"><span>${esc(p.t)}${(p.basis || []).length ? `<span class="b">근거: ${p.basis.map((b) => esc(b.reg + (b.art ? ` 제${b.art}조` : ""))).join(", ")}</span>` : ""}</span></label>`).join("")}</div>
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
