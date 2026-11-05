(function (w, d) {
  const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';
  const stack = [];
  const $ = (s) => (typeof s === "string" ? d.querySelector(s) : s);

  function emit(el, name, detail) {
    return el.dispatchEvent(new CustomEvent("modal:" + name, { detail, cancelable: true }));
  }

  function open(target) {
    const el = $(target);
    if (!el || el.classList.contains("is-open")) return;
    if (!emit(el, "beforeopen")) return;
    el._returnFocus = d.activeElement;
    el.setAttribute("aria-hidden", "false");
    stack.push(el);
    d.documentElement.style.overflow = "hidden";
    requestAnimationFrame(() => {
      el.classList.add("is-open");
      const f = el.querySelector("[autofocus]") || el.querySelector(FOCUSABLE);
      setTimeout(() => f && f.focus({ preventScroll: true }), 60);
      emit(el, "open");
    });
  }

  function close(target, result) {
    const el = target ? $(target) : stack[stack.length - 1];
    if (!el || !el.classList.contains("is-open")) return;
    if (!emit(el, "beforeclose", result)) return;
    el.classList.remove("is-open");
    el.setAttribute("aria-hidden", "true");
    stack.splice(stack.indexOf(el), 1);
    if (!stack.length) d.documentElement.style.overflow = "";
    el._returnFocus && el._returnFocus.focus && el._returnFocus.focus({ preventScroll: true });
    emit(el, "close", result);
  }

  function nudge(el) {
    const dlg = el.querySelector(".vm-dialog");
    dlg.classList.remove("vm-shake"); void dlg.offsetWidth; dlg.classList.add("vm-shake");
  }

  function confirm({ title = "Are you sure?", body = "", confirmText = "Confirm", cancelText = "Cancel", icon = "✦" } = {}) {
    return new Promise((resolve) => {
      const el = d.createElement("div");
      el.className = "vm-backdrop";
      el.setAttribute("role", "dialog"); el.setAttribute("aria-modal", "true");
      el.innerHTML = `<div class="vm-dialog">
        <div class="vm-header"><div class="vm-icon">${icon}</div><h2 class="vm-title"></h2></div>
        <div class="vm-content"><p class="vm-body"></p>
        <div class="vm-actions vm-row"><button class="vm-btn vm-btn--ghost" data-modal-close="false"></button>
        <button class="vm-btn vm-btn--primary" data-modal-close="true" autofocus></button></div></div></div>`;
      el.querySelector(".vm-title").textContent = title;
      el.querySelector(".vm-body").textContent = body;
      el.querySelector(".vm-btn--ghost").textContent = cancelText;
      el.querySelector(".vm-btn--primary").textContent = confirmText;
      d.body.appendChild(el);
      el.addEventListener("modal:close", (e) => {
        resolve(e.detail === "true");
        setTimeout(() => el.remove(), 600);
      }, { once: true });
      open(el);
    });
  }

  d.addEventListener("click", (e) => {
    const opener = e.target.closest("[data-modal-open]");
    if (opener) { e.preventDefault(); return open(opener.getAttribute("data-modal-open")); }
    const closer = e.target.closest("[data-modal-close]");
    if (closer) return close(closer.closest(".vm-backdrop"), closer.getAttribute("data-modal-close") || undefined);
    const top = stack[stack.length - 1];
    if (top && e.target === top) top.hasAttribute("data-static") ? nudge(top) : close(top);
  });

  d.addEventListener("keydown", (e) => {
    const top = stack[stack.length - 1];
    if (!top) return;
    if (e.key === "Escape") return top.hasAttribute("data-static") ? nudge(top) : close(top);
    if (e.key === "Tab") {
      const f = [...top.querySelectorAll(FOCUSABLE)];
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && d.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && d.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });

  w.Modal = { open, close, confirm };
})(window, document);
