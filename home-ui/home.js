// Run 64: the ALKAO platform home's motion and helpers, on top of a page that works without
// it (src/api/home-view.ts). No network call, no tracking, no framework: carousel, reveal on
// scroll, rails, favourites (this browser only), quick view, search palette, the assistant
// (answers from the page's own help topics and events) and a language suggestion.
// Organizers' text is only ever set with textContent.
(() => {
  "use strict";
  const doc = document;
  const root = doc.documentElement;
  const dataEl = doc.getElementById("alkao-data");
  const data = dataEl ? JSON.parse(dataEl.textContent || "{}") : {};
  const t = data.t || {};
  const events = Array.isArray(data.events) ? data.events : [];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const canDialog = typeof HTMLDialogElement === "function";
  const $ = (s, el = doc) => el.querySelector(s);
  const $$ = (s, el = doc) => Array.from(el.querySelectorAll(s));
  const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const store = {
    get(k) { try { return window.localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { window.localStorage.setItem(k, v); } catch { /* private mode */ } },
  };
  const h = (tag, props, ...kids) => {
    const el = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "text") el.textContent = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : String(v));
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : doc.createTextNode(String(kid)));
    return el;
  };
  const PATHS = {
    search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5",
    pin: "M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12zM12 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z",
    help: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM9.5 9.5a2.5 2.5 0 0 1 4.9.6c0 1.6-2.4 2-2.4 3.4M12 17h.01",
    grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
    heart: "M12 20s-7.5-4.6-9.2-9.4C1.6 7.2 3.9 4 7.2 4c2 0 3.6 1.1 4.8 2.8C13.2 5.1 14.8 4 16.8 4c3.3 0 5.6 3.2 4.4 6.6C19.5 15.4 12 20 12 20z",
  };
  const svg = (name) => {
    const s = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("class", "i");
    s.setAttribute("aria-hidden", "true");
    s.setAttribute("fill", "none");
    s.setAttribute("stroke", "currentColor");
    s.setAttribute("stroke-width", "1.9");
    s.setAttribute("stroke-linecap", "round");
    s.setAttribute("stroke-linejoin", "round");
    const p = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", PATHS[name] || "");
    s.append(p);
    return s;
  };
  const byId = new Map(events.map((e) => [e.id, e]));

  // ── Reveal on scroll: what is already on screen shows at once, the rest as it comes ──
  const reveals = $$(".reveal");
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.top < window.innerHeight && r.bottom > 0; };
  if (reduce || !("IntersectionObserver" in window)) reveals.forEach((el) => el.classList.add("is-visible"));
  else {
    reveals.forEach((el) => { if (inView(el)) el.classList.add("is-visible"); });
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add("is-visible"); io.unobserve(entry.target); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
    reveals.forEach((el) => { if (!el.classList.contains("is-visible")) io.observe(el); });
  }
  root.classList.add("js");

  // ── Header and back-to-top ──
  const head = $("[data-head]");
  const toTop = $("[data-to-top]");
  const onScroll = () => {
    const y = window.scrollY;
    head?.classList.toggle("is-scrolled", y > 24);
    if (toTop) toTop.hidden = y < 900;
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  $$(".mobile-panel a").forEach((a) => a.addEventListener("click", () => a.closest("details")?.removeAttribute("open")));

  // ── Hero carousel ──
  const slides = $$("[data-slide]");
  const captions = $$("[data-caption]");
  const controls = $(".slide-controls");
  const dotsBox = $(".dots");
  const dots = $$("[data-dot]");
  const toggle = $("[data-slide-toggle]");
  const card = $(".slide-card");
  const MS = 7000;
  let index = 0;
  let timer = 0;
  let paused = reduce;
  let holding = false;
  const schedule = () => {
    window.clearTimeout(timer);
    const running = !paused && !holding && !doc.hidden && slides.length > 1;
    if (dotsBox) {
      dotsBox.classList.remove("is-running");
      if (running) { void dotsBox.offsetWidth; dotsBox.classList.add("is-running"); }
    }
    if (running) timer = window.setTimeout(() => show(index + 1), MS);
  };
  const show = (n) => {
    index = (n + slides.length) % slides.length;
    slides.forEach((s, k) => {
      s.classList.toggle("is-active", k === index);
      if (k === index) s.removeAttribute("aria-hidden"); else s.setAttribute("aria-hidden", "true");
    });
    const next = slides[(index + 1) % slides.length]?.querySelector("img");
    if (next) next.loading = "eager";
    captions.forEach((c, k) => { c.hidden = k !== index; c.classList.toggle("is-active", k === index); });
    dots.forEach((d, k) => { if (k === index) d.setAttribute("aria-current", "true"); else d.removeAttribute("aria-current"); });
    schedule();
  };
  const setPaused = (value) => {
    paused = value;
    controls?.classList.toggle("is-paused", paused);
    toggle?.setAttribute("aria-label", paused ? t.play : t.pause);
    schedule();
  };
  if (slides.length > 1 && controls) {
    controls.hidden = false;
    $("[data-slide-prev]")?.addEventListener("click", () => show(index - 1));
    $("[data-slide-next]")?.addEventListener("click", () => show(index + 1));
    toggle?.addEventListener("click", () => setPaused(!paused));
    dots.forEach((d) => d.addEventListener("click", () => show(Number(d.dataset.dot))));
    card?.addEventListener("pointerenter", () => { holding = true; schedule(); });
    card?.addEventListener("pointerleave", () => { holding = false; schedule(); });
    card?.addEventListener("focusin", () => { holding = true; schedule(); });
    card?.addEventListener("focusout", () => { holding = false; schedule(); });
    card?.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft") show(index - 1);
      if (e.key === "ArrowRight") show(index + 1);
    });
    let startX = null;
    card?.addEventListener("touchstart", (e) => { startX = e.touches[0]?.clientX ?? null; }, { passive: true });
    card?.addEventListener("touchend", (e) => {
      const end = e.changedTouches[0]?.clientX;
      if (startX != null && end != null && Math.abs(end - startX) > 50) show(index + (end < startX ? 1 : -1));
      startX = null;
    });
    doc.addEventListener("visibilitychange", schedule);
    setPaused(paused);
  }

  // ── Horizontal rails ──
  $$(".rail-block").forEach((block) => {
    const rail = $(".rail", block);
    const nav = $(".rail-nav", block);
    if (!rail || !nav) return;
    const fit = () => { nav.hidden = rail.scrollWidth <= rail.clientWidth + 4; };
    $("[data-rail-prev]", block)?.addEventListener("click", () => rail.scrollBy({ left: -rail.clientWidth * 0.85, behavior: reduce ? "auto" : "smooth" }));
    $("[data-rail-next]", block)?.addEventListener("click", () => rail.scrollBy({ left: rail.clientWidth * 0.85, behavior: reduce ? "auto" : "smooth" }));
    window.addEventListener("resize", fit);
    fit();
  });

  // ── Favourites (kept in this browser only) ──
  const favs = new Set((() => { try { return JSON.parse(store.get("alkao.favs") || "[]"); } catch { return []; } })().filter((id) => byId.has(id)));
  const saveFavs = () => store.set("alkao.favs", JSON.stringify([...favs]));
  const paintFav = (btn, id) => {
    const on = favs.has(id);
    btn.setAttribute("aria-pressed", String(on));
    const title = byId.get(id)?.title || "";
    if (btn.dataset.fav) btn.setAttribute("aria-label", `${on ? t.unfavorite : t.favorite} : ${title}`);
    const label = btn.querySelector("span");
    if (label) label.textContent = on ? t.unfavorite : t.favorite;
  };
  const toggleFav = (id) => {
    if (favs.has(id)) favs.delete(id); else favs.add(id);
    saveFavs();
    $$(`[data-fav="${CSS.escape(id)}"]`).forEach((b) => paintFav(b, id));
  };
  $$("[data-fav]").forEach((btn) => {
    btn.hidden = false;
    paintFav(btn, btn.dataset.fav);
    btn.addEventListener("click", () => toggleFav(btn.dataset.fav));
  });

  // ── Dialogs ──
  let opener = null;
  const open = (dialog) => {
    if (!dialog || !canDialog) return false;
    opener = doc.activeElement;
    dialog.showModal();
    return true;
  };
  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
    $$("[data-close]", dialog).forEach((b) => b.addEventListener("click", () => dialog.close()));
    dialog.addEventListener("close", () => { if (opener && typeof opener.focus === "function") opener.focus(); opener = null; });
  });

  const tickets = doc.getElementById("dlg-tickets");
  $$("[data-open-tickets]").forEach((a) => a.addEventListener("click", (e) => { if (open(tickets)) e.preventDefault(); }));

  // Quick view
  const preview = doc.getElementById("dlg-preview");
  let previewId = null;
  const fillPreview = (ev) => {
    previewId = ev.id;
    const img = $("[data-p-image]", preview);
    img.src = ev.image;
    $("[data-p-brand]", preview).textContent = ev.brand;
    $("[data-p-title]", preview).textContent = ev.title;
    $("[data-p-place]", preview).textContent = ev.place || ev.city || "";
    const price = $("[data-p-price]", preview);
    price.textContent = ev.price || "";
    price.hidden = !ev.price;
    const text = $("[data-p-text]", preview);
    text.textContent = ev.description || "";
    text.hidden = !ev.description;
    const list = $("[data-p-dates]", preview);
    list.replaceChildren(...(ev.dates || []).map((d) => h("li", { text: d })));
    if (ev.count > (ev.dates || []).length) list.append(h("li", { text: (t.dates || "{n}").replace("{n}", String(ev.count)) }));
    $("[data-p-shop]", preview).href = ev.shop;
    paintFav($("[data-p-fav]", preview), ev.id);
  };
  if (preview && canDialog) {
    $$("[data-preview]").forEach((btn) => {
      btn.hidden = false;
      btn.addEventListener("click", () => { const ev = byId.get(btn.dataset.preview); if (ev) { fillPreview(ev); open(preview); } });
    });
    $("[data-p-fav]", preview)?.addEventListener("click", () => {
      if (!previewId) return;
      toggleFav(previewId);
      paintFav($("[data-p-fav]", preview), previewId);
    });
    const share = $("[data-p-share]", preview);
    share?.addEventListener("click", async () => {
      const ev = byId.get(previewId);
      if (!ev) return;
      try {
        if (navigator.share) await navigator.share({ title: ev.title, url: ev.url });
        else {
          await navigator.clipboard.writeText(ev.url);
          const label = share.lastChild;
          const before = label.textContent;
          label.textContent = t.copied;
          window.setTimeout(() => { label.textContent = before; }, 2000);
        }
      } catch { /* cancelled */ }
    });
    // Slides of real events open their quick view too.
    $$("[data-caption] .caption-link").forEach((a, k) => {
      const ev = events.find((e) => e.shop === a.getAttribute("href"));
      if (!ev || k > 2) return;
      a.addEventListener("click", (e) => { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); fillPreview(ev); open(preview); });
    });
  }

  // ── Search palette (Ctrl/Cmd + K, or "/") ──
  const palette = doc.getElementById("dlg-search");
  const input = palette ? $("[data-palette-input]", palette) : null;
  const results = palette ? $("[data-palette-results]", palette) : null;
  const cats = Array.isArray(data.categories) ? data.categories : [];
  const topics = Array.isArray(data.help) ? data.help : [];
  const s = t.search || {};
  const item = (href, icon, title, sub, image, onClick) => {
    const a = h("a", { class: "palette-item", href }, image ? h("img", { src: image, alt: "" }) : svg(icon), h("span", {}, h("strong", { text: title }), sub ? h("small", { text: sub }) : null));
    if (onClick) a.addEventListener("click", onClick);
    return a;
  };
  const openTopic = (id) => () => {
    palette.close();
    const d = doc.getElementById(`faq-${id}`);
    if (d) d.open = true;
  };
  const renderPalette = () => {
    const q = fold(input.value).trim();
    const words = q.split(/\s+/).filter(Boolean);
    const evs = (q ? events.filter((e) => words.every((w) => e.text.includes(w))) : events.filter((e) => favs.has(e.id))).slice(0, 6);
    const cs = q ? cats.filter((c) => fold(c.label).includes(q) || c.words.some((w) => w.trim() && q.includes(w.trim()))) : cats.slice(0, 4);
    const hs = (q ? topics.filter((x) => fold(x.q).includes(q) || x.keys.some((k) => q.includes(k))) : topics.slice(0, 3)).slice(0, 4);
    const groups = [];
    if (evs.length) groups.push(h("p", { class: "palette-group", text: q ? s.events : t.favorites }), ...evs.map((e) => item(e.shop, "search", e.title, [e.next, e.city].filter(Boolean).join(" · "), e.image)));
    if (cs.length) groups.push(h("p", { class: "palette-group", text: s.categories }), ...cs.map((c) => item(c.url, "grid", c.label, "", null)));
    if (hs.length) groups.push(h("p", { class: "palette-group", text: s.help }), ...hs.map((x) => item(`#faq-${x.id}`, "help", x.q, "", null, openTopic(x.id))));
    if (!groups.length) groups.push(h("p", { class: "palette-empty", text: s.none }));
    if (q) groups.push(item(`/?${data.lang === "en" ? "lang=en&" : ""}q=${encodeURIComponent(input.value.trim())}#evenements`, "search", s.all, "", null));
    results.replaceChildren(...groups);
  };
  const openPalette = () => {
    if (!palette || !open(palette)) return false;
    input.value = "";
    renderPalette();
    input.focus();
    return true;
  };
  if (palette && canDialog) {
    $$("[data-open-search]").forEach((a) => a.addEventListener("click", (e) => { if (openPalette()) e.preventDefault(); }));
    input.addEventListener("input", renderPalette);
    palette.addEventListener("keydown", (e) => {
      // A search field eats the first Escape (it clears itself): close at once instead.
      if (e.key === "Escape") { e.preventDefault(); palette.close(); return; }
      const items = $$(".palette-item", palette);
      const at = items.indexOf(doc.activeElement);
      if (e.key === "ArrowDown") { e.preventDefault(); items[Math.min(at + 1, items.length - 1)]?.focus(); }
      if (e.key === "ArrowUp") { e.preventDefault(); if (at <= 0) input.focus(); else items[at - 1]?.focus(); }
    });
    doc.addEventListener("keydown", (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(doc.activeElement?.tagName || "") || doc.activeElement?.isContentEditable;
      if ((e.key === "k" && (e.metaKey || e.ctrlKey)) || (e.key === "/" && !typing && !doc.querySelector("dialog[open]"))) {
        e.preventDefault();
        openPalette();
      }
    });
  }
  const openHash = () => {
    if (!location.hash.startsWith("#faq-")) return;
    const d = doc.getElementById(location.hash.slice(1));
    if (d && d.tagName === "DETAILS") d.open = true;
  };
  window.addEventListener("hashchange", openHash);
  openHash();

  // ── Assistant: answers from this page's help topics and events, nothing sent anywhere ──
  const a = t.assistant || {};
  const panel = doc.getElementById("assistant");
  const fab = $(".assistant-fab");
  const log = panel ? $("[data-log]", panel) : null;
  const chipsBox = panel ? $("[data-chips]", panel) : null;
  const form = panel ? $("[data-ask]", panel) : null;
  const ask = panel ? $("input", form) : null;
  const STOP = new Set("le la les des de du un une pour avec sur dans et ou au aux en je j ai est sont mon ma mes ce cet cette ces quel quelle quels quoi qui que quand ou comment est-ce il y a the a an for with in on and or to of my is are what when where how can i me show find trouver cherche evenement evenements event events billet billets ticket tickets un une svp please".split(" "));
  const EVENT_WORDS = ["trouver", "cherche", "find", "looking", "evenement", "event", "spectacle", "sortie", "outing", "ce soir", "tonight", "fin de semaine", "weekend", "quoi faire", "what to do"];
  let greeted = false;
  const scrollLog = () => { log.scrollTop = log.scrollHeight; };
  const say = (who, ...content) => {
    const m = h("div", { class: `msg msg-${who}` }, ...content);
    log.append(m);
    scrollLog();
    return m;
  };
  const eventLinks = (list) => h("div", { class: "msg-events" }, ...list.map((e) => h("a", { class: "msg-event", href: e.shop }, h("img", { src: e.image, alt: "" }), h("span", {}, h("strong", { text: e.title }), h("small", { text: [e.next, e.city, e.price].filter(Boolean).join(" · ") })))));
  const findEvents = (q) => {
    const words = q.split(/[^a-z0-9-]+/).filter((w) => w.length > 2 && !STOP.has(w));
    const catIds = cats.filter((c) => c.words.some((w) => w.trim().length > 2 && q.includes(w.trim())) || q.includes(fold(c.label))).map((c) => c.id);
    return events
      .map((e) => ({ e, score: words.filter((w) => e.text.includes(w)).length * 2 + e.categories.filter((c) => catIds.includes(c)).length }))
      .filter((x) => x.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, 3)
      .map((x) => x.e);
  };
  const answer = (raw) => {
    const q = ` ${fold(raw).trim()} `;
    if (/\b(merci|thanks|thank you|thx)\b/.test(q)) return [a.thanks];
    if (fold(raw).trim() === fold(a.chips?.[0])) return events.length ? [a.askEvent, eventLinks(events.slice(0, 3))] : [a.askEvent];
    const found = findEvents(q);
    const wantsEvent = EVENT_WORDS.some((w) => q.includes(w)) || cats.some((c) => q.includes(fold(c.label)));
    const scored = topics
      .map((x) => ({ x, score: x.keys.filter((k) => q.includes(k)).length }))
      .filter((x) => x.score > 0)
      .sort((p, r) => r.score - p.score);
    if (found.length && (wantsEvent || !scored.length)) return [a.found, eventLinks(found)];
    if (scored.length) {
      const top = scored[0].x;
      return [h("span", { text: top.a }), " ", h("a", { href: `#faq-${top.id}`, text: top.q, onclick: () => { const d = doc.getElementById(`faq-${top.id}`); if (d) d.open = true; } })];
    }
    if (wantsEvent) return events.length ? [a.noEvents, eventLinks(events.slice(0, 3))] : [a.noEvents];
    if (/\b(bonjour|salut|allo|hello|hi|hey)\b/.test(q)) return [a.hello];
    return [a.fallback];
  };
  const reply = (text) => {
    const typing = say("bot", h("span", { class: "typing", "aria-label": "…" }, h("i"), h("i"), h("i")));
    window.setTimeout(() => {
      typing.remove();
      say("bot", ...answer(text));
    }, reduce ? 0 : 520);
  };
  const send = (text) => {
    const value = String(text || "").trim().slice(0, 200);
    if (!value) return;
    say("user", h("span", { text: value }));
    reply(value);
  };
  const setOpen = (on) => {
    panel.hidden = !on;
    fab?.setAttribute("aria-expanded", String(on));
    if (on) {
      if (!greeted) { greeted = true; say("bot", a.hello); }
      window.setTimeout(() => ask.focus(), 50);
    } else fab?.focus();
  };
  if (panel && fab && log && form && ask) {
    fab.hidden = false;
    $$("[data-open-assistant]").forEach((b) => { b.hidden = false; b.addEventListener("click", () => setOpen(panel.hidden)); });
    $("[data-close-assistant]", panel)?.addEventListener("click", () => setOpen(false));
    panel.addEventListener("keydown", (e) => { if (e.key === "Escape") setOpen(false); });
    chipsBox.replaceChildren(...(a.chips || []).map((c) => h("button", { type: "button", text: c, onclick: () => send(c) })));
    form.addEventListener("submit", (e) => { e.preventDefault(); send(ask.value); ask.value = ""; });
  }

  // ── Language suggestion, once, for a browser set to the other language ──
  const toast = $("[data-lang-toast]");
  const pref = fold((navigator.languages && navigator.languages[0]) || navigator.language || "").slice(0, 2);
  if (toast && !store.get("alkao.langToast") && (pref === "en" || pref === "fr") && pref !== data.lang) {
    window.setTimeout(() => { toast.hidden = false; }, 2500);
    const done = () => { store.set("alkao.langToast", "1"); toast.hidden = true; };
    $("[data-toast-close]", toast)?.addEventListener("click", done);
    $("a", toast)?.addEventListener("click", () => store.set("alkao.langToast", "1"));
  }
})();
