// Classic content-script module. Never clicks the model-family selector.
(() => {
  const values = ["none", "medium", "high", "max", "pro"];
  const fail = code => Object.assign(new Error(code), { code });
  const visible = e => e && e.getBoundingClientRect().width > 0 &&
    !e.closest('[inert], [aria-hidden="true"]');
  function create({ root, assert = () => {}, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now }) {
    let guard = null, phase = "initial";
    function button() {
      assert();
      const candidates = Array.from(root().querySelectorAll('button[data-composer-navigation-target="reasoning"][data-selected-reasoning-effort]')).filter(visible);
      if (candidates.length !== 1) throw fail("effort_dom_unsupported");
      return candidates[0];
    }
    function menu(b) {
      const candidates = Array.from(document.querySelectorAll('[role="menu"][data-state="open"]'))
        .filter(m => visible(m) && m.getAttribute("aria-labelledby") === b.id);
      if (candidates.length !== 1) return null;
      return candidates[0];
    }
    function read() {
      const b = button(), m = menu(b);
      if (!m) return null;
      const familyNodes = m.querySelectorAll('[data-model-selected="true"]');
      const modelFamily = familyNodes.length === 1 ? familyNodes[0].textContent.trim() : null;
      if (!["GPT-6", "GPT-5.6 Sol"].includes(modelFamily)) throw fail("effort_model_unsupported");
      const slider = m.querySelector('[data-reasoning-slider] [role="slider"]');
      const proNode = m.querySelector('[data-maximum]');
      const index = Number(slider?.getAttribute("aria-valuenow"));
      const min = Number(slider?.getAttribute("aria-valuemin")), max = Number(slider?.getAttribute("aria-valuemax"));
      if (!slider || !proNode || min !== 0 || !Number.isInteger(max) || max < 1 || max > 4 ||
          !Number.isInteger(index) || index < min || index > max) throw fail("effort_dom_unsupported");
      const proUnavailable = !!m.querySelector('[data-ultra-warning-visible="true"]');
      const pro = proNode.getAttribute("data-maximum") === "true";
      const raw = b.getAttribute("data-selected-reasoning-effort");
      if (pro ? raw !== "medium" || index !== max : values[index] !== raw || index > 3)
        throw fail("effort_dom_unsupported");
      return { b, m, index, max, modelFamily, proUnavailable, effectiveEffort: pro ? "pro" : raw };
    }
    async function wait(check, deadline) {
      for (;;) {
        assert();
        const result = check();
        if (result) return result;
        if (now() >= deadline) {
          const error = fail("effort_timeout"); error.message += ": " + phase; throw error;
        }
        if (typeof MutationObserver !== "function") { await sleep(80); continue; }
        // React updates should wake us even when background timers are throttled.
        // Always inspect state after waking, including a timer delayed past its deadline.
        await new Promise(resolve => {
          const observer = new MutationObserver(finish);
          const timer = setTimeout(finish, Math.min(80, Math.max(1, deadline - now())));
          function finish() { observer.disconnect(); clearTimeout(timer); resolve(); }
          observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
        });
      }
    }
    function close() {
      const b = button(), m = menu(b);
      m?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    }
    async function open(deadline) {
      phase = "open";
      let b = button();
      if (!menu(b)) b.click();
      return wait(read, deadline);
    }
    async function step(state, direction, deadline, family) {
      const control = state.m.querySelector('[data-reasoning-slider]');
      if (!control) throw fail("effort_dom_unsupported");
      control.dispatchEvent(new KeyboardEvent("keydown", { key: direction, code: direction, bubbles: true, cancelable: true }));
      phase = "step";
      return wait(() => {
        const next = read();
        if (next && next.modelFamily !== family) throw fail("effort_model_changed");
        return next && (next.index !== state.index || next.proUnavailable) ? next : null;
      }, deadline);
    }
    function remember(selection) {
      guard = { selection, b: button(), text: button().textContent };
      return selection;
    }
    async function set(policy) {
      if (!values.includes(policy?.effort) || !["error", "lower", "max"].includes(policy?.effortFallback ?? "error") ||
          policy?.effortFallback === "max" && policy?.effort !== "pro")
        throw fail("invalid_effort_policy");
      guard = null;
      const deadline = now() + 12000;
      let original;
      try { original = await open(deadline); }
      catch (error) { try { close(); } catch {} throw error; }
      let state = original, success = false;
      try {
        const proFallback = policy.effort === "pro" && policy.effortFallback === "max";
        let target = policy.effort === "pro" ? state.max : values.indexOf(policy.effort);
        if (policy.effort === "pro" && state.proUnavailable) {
          if (!proFallback) throw fail("effort_unavailable");
          target = 3;
        }
        if (target > state.max) {
          if (policy.effortFallback !== "lower" || policy.effort === "pro") throw fail("effort_unavailable");
          target = state.max;
        }
        for (let n = 0; n < 5 && state.index !== target; n++) {
          state = await step(state, state.index < target ? "ArrowRight" : "ArrowLeft", deadline, original.modelFamily);
          if (policy.effort === "pro" && state.proUnavailable) break;
        }
        if (policy.effort === "pro" && (state.effectiveEffort !== "pro" || state.proUnavailable)) {
          if (!proFallback || state.max < 3) throw fail("effort_unavailable");
          for (let n = 0; n < 5 && state.index !== 3; n++)
            state = await step(state, state.index < 3 ? "ArrowRight" : "ArrowLeft", deadline, original.modelFamily);
          if (state.effectiveEffort !== "max") throw fail("effort_unavailable");
        } else if (state.effectiveEffort !== policy.effort) {
          if (policy.effortFallback !== "lower" || policy.effort === "pro") throw fail("effort_unavailable");
          if (state.effectiveEffort === "pro") state = await step(state, "ArrowLeft", deadline, original.modelFamily);
          if (values.indexOf(state.effectiveEffort) >= values.indexOf(policy.effort)) throw fail("effort_unavailable");
        }
        const selection = { requestedEffort: policy.effort, effectiveEffort: state.effectiveEffort,
          fallbackApplied: state.effectiveEffort !== policy.effort, modelFamily: state.modelFamily };
        phase = "close";
        close();
        await wait(() => button().getAttribute("aria-expanded") === "false", deadline);
        // Let closing animations settle before taking a change-detection stamp.
        await sleep(200);
        success = true;
        return remember(selection);
      } finally {
        if (!success) {
          try {
            state = read();
            for (let n = 0; state && n < 5 && state.index !== original.index && now() < deadline; n++) {
              if (state.modelFamily !== original.modelFamily) break;
              state = await step(state, state.index > original.index ? "ArrowLeft" : "ArrowRight", deadline, original.modelFamily);
            }
            close();
          } catch { /* Do not touch a replaced composer or another model. */ }
        }
      }
    }
    async function recheck() {
      if (!guard) throw fail("effort_verification_failed");
      const expected = guard.selection, deadline = now() + 4000;
      try {
        const state = await open(deadline);
        if (state.modelFamily !== expected.modelFamily || state.effectiveEffort !== expected.effectiveEffort ||
            expected.effectiveEffort === "pro" && state.proUnavailable)
          throw fail("effort_changed");
      } finally { close(); }
      phase = "recheck-close";
      await wait(() => button().getAttribute("aria-expanded") === "false", deadline);
      await sleep(200);
      remember(expected);
    }
    function assertUnchanged() {
      if (!guard) return;
      const b = button();
      const raw = guard.selection.effectiveEffort === "pro" ? "medium" : guard.selection.effectiveEffort;
      if (b !== guard.b || b.getAttribute("data-selected-reasoning-effort") !== raw ||
          b.textContent !== guard.text || b.getAttribute("aria-expanded") !== "false") throw fail("effort_changed");
    }
    return { set, recheck, assertUnchanged };
  }
  globalThis.GptRelayEffort = { create };
})();
