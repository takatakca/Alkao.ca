// Run 64: the ALKAO platform home's motion and helpers, on top of a page that works without
// it (src/api/home-view.ts). No network call, no tracking, no framework: carousel, reveal on
// scroll, rails, favourites (this browser only), quick view, search palette, the assistant
// (answers from the page's own help topics and events) and a language suggestion.
// Run 66: recently viewed (this browser only), "add to calendar" (.ics made here), directions
// and the install prompt. Run 67: "Suivre", the organizer's newsletter sign-up (confirmed by
// e-mail), sent to this site's own public API.
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
    calendar: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3 10h18M8 3v4M16 3v4",
    clock: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
    left: "m15 18-6-6 6-6",
    right: "m9 18 6-6-6-6",
    close: "M6 6l12 12M18 6 6 18",
    zoom: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5M11 8v6M8 11h6",
    unzoom: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-3.5-3.5M8 11h6",
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

  // ── Recently viewed (this browser only): copies of the page's own cards ──
  const readList = (key) => { try { const v = JSON.parse(store.get(key) || "[]"); return Array.isArray(v) ? v.filter((id) => byId.has(id)) : []; } catch { return []; } };
  const recent = readList("alkao.recent");
  const viewed = (id) => {
    if (!byId.has(id)) return;
    const next = [id, ...recent.filter((x) => x !== id)].slice(0, 8);
    recent.splice(0, recent.length, ...next);
    store.set("alkao.recent", JSON.stringify(next));
  };
  const recentBlock = $("[data-recent]");
  const recentRail = recentBlock ? $(".rail", recentBlock) : null;
  if (recentBlock && recentRail && recent.length) {
    const copies = recent.map((id) => $(`.grid article.card[data-id="${CSS.escape(id)}"]`)).filter(Boolean).map((source) => {
      const copy = source.cloneNode(true);
      copy.classList.add("is-visible");
      return h("div", { role: "listitem", class: "rail-item" }, copy);
    });
    if (copies.length) { recentRail.replaceChildren(...copies); recentBlock.hidden = false; }
    $("[data-recent-clear]", recentBlock)?.addEventListener("click", () => {
      recent.splice(0, recent.length);
      store.set("alkao.recent", "[]");
      recentBlock.hidden = true;
      // The button is gone: keep the keyboard on the list of events.
      $(".grid .card-title a")?.focus();
    });
  }
  doc.addEventListener("click", (e) => {
    const a = e.target instanceof Element ? e.target.closest("a[href]") : null;
    const ev = a && events.find((x) => x.shop === a.getAttribute("href"));
    if (ev) viewed(ev.id);
  }, true);

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
  // One opener per open dialog: the follow form can open over the quick view.
  const openers = [];
  const open = (dialog) => {
    if (!dialog || !canDialog) return false;
    openers.push(doc.activeElement);
    dialog.showModal();
    return true;
  };
  $$("dialog").forEach((dialog) => {
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
    $$("[data-close]", dialog).forEach((b) => b.addEventListener("click", () => dialog.close()));
    dialog.addEventListener("close", () => { const back = openers.pop(); if (back && typeof back.focus === "function") back.focus(); });
  });

  const tickets = doc.getElementById("dlg-tickets");
  $$("[data-open-tickets]").forEach((a) => a.addEventListener("click", (e) => { if (open(tickets)) e.preventDefault(); }));

  // ── "Add to calendar": an iCalendar file (RFC 5545) made here, as on the tickets page ──
  const stamp = (date) => date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const icsText = (v) => String(v).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  const icsFold = (line) => {
    const enc = new TextEncoder();
    const parts = [];
    let cur = "";
    let size = 0;
    for (const ch of line) {
      const n = enc.encode(ch).length;
      if (size + n > (parts.length ? 74 : 75)) { parts.push(cur); cur = ""; size = 0; }
      cur += ch;
      size += n;
    }
    parts.push(cur);
    return parts.join("\r\n ");
  };
  const calendarFile = (ev, i) => {
    const start = new Date(ev.starts[i]);
    const end = ev.ends && ev.ends[i] ? new Date(ev.ends[i]) : null;
    const lines = [
      "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//ALKAO//Billetterie//FR", "CALSCALE:GREGORIAN", "METHOD:PUBLISH",
      "BEGIN:VEVENT",
      // Adding the same date again updates it instead of doubling it.
      `UID:${ev.id}-${stamp(start)}@alkao`,
      `DTSTAMP:${stamp(new Date())}`,
      `DTSTART:${stamp(start)}`,
      ...(end ? [`DTEND:${stamp(end)}`] : []),
      `SUMMARY:${icsText(ev.title)}`,
      ...(ev.address ? [`LOCATION:${icsText(ev.address)}`] : []),
      `DESCRIPTION:${icsText(`${ev.brand}\n${ev.url}`)}`,
      `URL:${ev.url}`,
      "END:VEVENT", "END:VCALENDAR",
    ];
    return `${lines.map(icsFold).join("\r\n")}\r\n`;
  };
  const addToCalendar = (ev, i) => {
    if (!ev || !ev.starts || !ev.starts[i]) return;
    const url = URL.createObjectURL(new Blob([calendarFile(ev, i)], { type: "text/calendar;charset=utf-8" }));
    const slug = fold(ev.title).replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "evenement";
    const a = h("a", { href: url, download: `alkao-${slug}.ics`, hidden: true });
    doc.body.append(a);
    a.click();
    a.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  // ── Follow an organizer: its newsletter, confirmed by e-mail (nothing is saved before) ──
  const followDialog = doc.getElementById("dlg-follow");
  const followForm = followDialog ? $("[data-follow-form]", followDialog) : null;
  const organizers = new Map((Array.isArray(data.organizers) ? data.organizers : []).map((o) => [o.id, o]));
  const fill = (text, name) => String(text || "").replace("{b}", name);
  let following = null;
  const openFollow = (id) => {
    const o = organizers.get(id);
    if (!o || !followForm) return;
    following = o;
    $("[data-f-title]", followDialog).textContent = fill(t.follow, o.name);
    $("[data-f-lead]", followDialog).textContent = fill(t.followLead, o.name);
    $("[data-f-note]", followDialog).textContent = fill(t.followNote, o.name);
    $("[data-f-error]", followDialog).hidden = true;
    $("[data-f-done]", followDialog).hidden = true;
    followForm.hidden = false;
    open(followDialog);
    window.setTimeout(() => $("input[name=email]", followForm)?.focus(), 30);
  };
  if (followDialog && followForm && canDialog && typeof fetch === "function") {
    $$("[data-follow]").forEach((b) => { b.hidden = !organizers.has(b.dataset.follow); b.addEventListener("click", () => openFollow(b.dataset.follow)); });
    const submit = $("button[type=submit]", followForm);
    const error = $("[data-f-error]", followDialog);
    const done = $("[data-f-done]", followDialog);
    followForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (!following) return;
      const form = new FormData(followForm);
      const fail = (text) => { error.textContent = text; error.hidden = false; };
      error.hidden = true;
      submit.disabled = true;
      try {
        const res = await fetch(following.follow, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: String(form.get("email") || "").trim(),
            firstName: String(form.get("firstName") || "").trim() || null,
            language: data.lang === "en" ? "en" : "fr",
            source: "alkao",
          }),
        });
        if (res.status === 202) {
          followForm.hidden = true;
          followForm.reset();
          done.textContent = fill(t.followDone, following.name);
          done.hidden = false;
          done.focus();
        } else fail(res.status === 429 ? t.followBusy : res.status === 400 ? t.followInvalid : t.followError);
      } catch {
        fail(t.followError);
      } finally {
        submit.disabled = false;
      }
    });
  }

  // Quick view
  const preview = doc.getElementById("dlg-preview");
  let previewId = null;
  const fillPreview = (ev) => {
    previewId = ev.id;
    const img = $("[data-p-image]", preview);
    img.src = ev.image;
    // Run 90: the organizer's own photo opens the viewer (ALKAO's stand-in does not).
    img.parentElement.classList.toggle("is-photo", Boolean(ev.photo));
    const zoomBtn = $("[data-p-zoom]", preview);
    if (zoomBtn) zoomBtn.hidden = !ev.photo || !canDialog;
    $("[data-p-brand]", preview).textContent = ev.brand;
    $("[data-p-title]", preview).textContent = ev.title;
    $("[data-p-place]", preview).textContent = ev.place || ev.city || "";
    const price = $("[data-p-price]", preview);
    price.textContent = ev.price || "";
    price.hidden = !ev.price;
    const text = $("[data-p-text]", preview);
    text.textContent = ev.description || "";
    text.hidden = !ev.description;
    // Run 69: what the organizer says (category, age, doors, language) and the accessibility notes.
    const facts = $("[data-p-facts]", preview);
    if (facts) {
      facts.replaceChildren(...(ev.facts || []).map((f) => h("li", { text: f })));
      facts.hidden = !(ev.facts || []).length;
    }
    const access = $("[data-p-access]", preview);
    if (access) {
      $("[data-p-access-text]", access).textContent = ev.accessibility || "";
      access.hidden = !ev.accessibility;
    }
    const list = $("[data-p-dates]", preview);
    list.replaceChildren(...(ev.dates || []).map((d, i) => h("li", {},
      h("span", { text: d }),
      ev.starts && ev.starts[i] ? h("button", { type: "button", class: "round round-sm", "aria-label": (t.addDate || "{d}").replace("{d}", d), title: (t.addDate || "{d}").replace("{d}", d), onclick: () => addToCalendar(ev, i) }, svg("calendar")) : null)));
    if (ev.count > (ev.dates || []).length) list.append(h("li", { text: (t.dates || "{n}").replace("{n}", String(ev.count)) }));
    $("[data-p-shop]", preview).href = ev.shop;
    paintFav($("[data-p-fav]", preview), ev.id);
    const ics = $("[data-p-ics]", preview);
    if (ics) ics.hidden = !(ev.starts && ev.starts.length);
    const map = $("[data-p-map]", preview);
    if (map) {
      map.hidden = !ev.map;
      if (ev.map) { map.href = ev.map; map.setAttribute("aria-label", (t.directionsTo || "{p}").replace("{p}", ev.address)); }
    }
    const followBtn = $("[data-p-follow]", preview);
    if (followBtn) {
      const o = organizers.get(ev.brandId);
      followBtn.hidden = !o || !followForm || typeof fetch !== "function";
      if (o) { followBtn.dataset.org = o.id; $("span", followBtn).textContent = fill(t.follow, o.name); }
    }
    viewed(ev.id);
  };
  if (preview && canDialog) {
    $$("[data-preview]").forEach((btn) => {
      btn.hidden = false;
      btn.addEventListener("click", () => { const ev = byId.get(btn.dataset.preview); if (ev) { fillPreview(ev); open(preview); } });
    });
    $("[data-p-ics]", preview)?.addEventListener("click", () => addToCalendar(byId.get(previewId), 0));
    $("[data-p-follow]", preview)?.addEventListener("click", (e) => openFollow(e.currentTarget.dataset.org));
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

  // ── Run 90: the photo viewer. Full screen; zoom with a click, the wheel, a pinch or + and -; pan while
  // zoomed; arrows or a swipe for the next photo. Escape or the close button exits and focus goes back.
  const z = t.zoom || {};
  const MAX = 4;
  let viewer = null;
  let shots = [];
  let at = 0;
  let scale = 1;
  let x = 0;
  let y = 0;
  const buildViewer = () => {
    const img = h("img", { alt: "", draggable: "false" });
    const stage = h("div", { class: "zoom-stage" }, img);
    const title = h("p", { class: "zoom-title", id: "zoom-title" });
    const count = h("span", { class: "zoom-count", "aria-live": "polite" });
    const button = (cls, label, name, onclick) => h("button", { class: `round ${cls}`.trim(), type: "button", "aria-label": label, title: label, onclick }, svg(name));
    const dialog = h("dialog", { class: "zoom", "aria-labelledby": "zoom-title" },
      h("div", { class: "zoom-top" }, h("div", { class: "zoom-head" }, title, count), button("", t.close, "close", () => dialog.close())),
      stage,
      h("div", { class: "zoom-bar" },
        button("", z.zoomOut, "unzoom", () => zoomBy(1 / 1.6)),
        button("", z.zoomIn, "zoom", () => zoomBy(1.6)),
        h("p", { class: "zoom-hint", text: z.hint })),
      button("zoom-side prev", z.prev, "left", () => go(-1)),
      button("zoom-side next", z.next, "right", () => go(1)));
    doc.body.append(dialog);
    const box = () => {
      const r = stage.getBoundingClientRect();
      return { left: r.left + img.offsetLeft, top: r.top + img.offsetTop, w: img.offsetWidth, h: img.offsetHeight };
    };
    const paint = () => {
      const b = box();
      // Never pan past the photo's edges.
      x = Math.min(0, Math.max(b.w * (1 - scale), x));
      y = Math.min(0, Math.max(b.h * (1 - scale), y));
      if (scale === 1) { x = 0; y = 0; }
      img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
      stage.classList.toggle("is-zoomed", scale > 1);
    };
    const zoomAt = (next, cx, cy) => {
      const b = box();
      const s2 = Math.min(MAX, Math.max(1, next));
      const ix = (cx - b.left - x) / scale;
      const iy = (cy - b.top - y) / scale;
      x = cx - b.left - ix * s2;
      y = cy - b.top - iy * s2;
      scale = s2;
      paint();
    };
    const zoomBy = (k) => { const b = box(); zoomAt(scale * k, b.left + b.w / 2, b.top + b.h / 2); };
    const reset = () => { scale = 1; paint(); };
    const show = (i) => {
      at = (i + shots.length) % shots.length;
      const shot = shots[at];
      reset();
      img.classList.add("is-loading");
      img.onload = () => img.classList.remove("is-loading");
      img.src = shot.src;
      img.alt = shot.alt || "";
      title.textContent = shot.alt || z.title || "";
      const many = shots.length > 1;
      count.textContent = many ? (z.of || "{i} / {n}").replace("{i}", String(at + 1)).replace("{n}", String(shots.length)) : "";
      $$(".zoom-side", dialog).forEach((b) => { b.hidden = !many; });
      // The next and previous photos load ahead.
      if (many) [1, -1].forEach((d) => { new Image().src = shots[(at + d + shots.length) % shots.length].src; });
    };
    const go = (d) => { if (shots.length > 1) show(at + d); };
    stage.addEventListener("wheel", (e) => { e.preventDefault(); zoomAt(scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
    // One finger or the mouse pans (or swipes to the next photo); two fingers pinch.
    const pointers = new Map();
    let moved = false;
    let start = null;
    let pinch = 0;
    stage.addEventListener("pointerdown", (e) => {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      stage.setPointerCapture(e.pointerId);
      moved = false;
      start = { x: e.clientX, y: e.clientY };
      pinch = 0;
    });
    stage.addEventListener("pointermove", (e) => {
      const last = pointers.get(e.pointerId);
      if (!last) return;
      const now = { x: e.clientX, y: e.clientY };
      if (pointers.size === 2) {
        const [a, b] = [...pointers.entries()].map(([id, p]) => (id === e.pointerId ? now : p));
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch) zoomAt(scale * (dist / pinch), (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch = dist;
        stage.classList.add("is-pinching");
        moved = true;
      } else if (scale > 1) {
        x += now.x - last.x;
        y += now.y - last.y;
        stage.classList.add("is-dragging");
        paint();
      }
      if (start && Math.hypot(now.x - start.x, now.y - start.y) > 6) moved = true;
      pointers.set(e.pointerId, now);
    });
    const up = (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (!pointers.size) {
        stage.classList.remove("is-dragging", "is-pinching");
        const dx = start ? e.clientX - start.x : 0;
        if (scale === 1 && !pinch && Math.abs(dx) > 60) go(dx < 0 ? 1 : -1);
      }
      pinch = 0;
    };
    stage.addEventListener("pointerup", up);
    stage.addEventListener("pointercancel", up);
    stage.addEventListener("click", (e) => {
      if (moved) return;
      if (scale > 1) reset();
      else zoomAt(2.5, e.clientX, e.clientY);
    });
    dialog.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); go(1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); go(-1); }
      else if (e.key === "+" || e.key === "=") { e.preventDefault(); zoomBy(1.6); }
      else if (e.key === "-") { e.preventDefault(); zoomBy(1 / 1.6); }
      else if (e.key === "0") { e.preventDefault(); reset(); }
    });
    dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.close(); });
    dialog.addEventListener("close", () => { img.removeAttribute("src"); const back = openers.pop(); if (back && typeof back.focus === "function") back.focus(); });
    window.addEventListener("resize", () => { if (dialog.open) paint(); });
    return { dialog, show };
  };
  const openViewer = (list, i) => {
    if (!canDialog || !list.length) return false;
    viewer = viewer || buildViewer();
    shots = list;
    viewer.show(Math.max(0, i));
    return open(viewer.dialog);
  };
  $$("[data-zoom]").forEach((el) => {
    el.hidden = false;
    el.addEventListener("click", (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      const group = el.dataset.zoomGroup;
      const list = group ? $$(`[data-zoom-group="${CSS.escape(group)}"]`) : [el];
      if (openViewer(list.map((x) => ({ src: x.dataset.zoom, alt: x.dataset.zoomAlt || "" })), list.indexOf(el))) e.preventDefault();
    });
  });
  if (preview && canDialog) {
    const zoomPreview = () => { const ev = byId.get(previewId); if (ev && ev.photo) openViewer([{ src: ev.image, alt: ev.title }], 0); };
    $("[data-p-zoom]", preview)?.addEventListener("click", zoomPreview);
    $("[data-p-image]", preview)?.addEventListener("click", zoomPreview);
  }

  // ── Run 90: the filter menus: one open at a time, closed by a click elsewhere or Escape ──
  const menus = $$(".dd");
  menus.forEach((d) => d.addEventListener("toggle", () => { if (d.open) menus.forEach((o) => { if (o !== d) o.open = false; }); }));
  doc.addEventListener("click", (e) => menus.forEach((d) => { if (d.open && !d.contains(e.target)) d.open = false; }));
  doc.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const d = menus.find((m) => m.open);
    if (d) { d.open = false; $("summary", d)?.focus(); }
  });

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
    const evs = (q ? events.filter((e) => words.every((w) => e.text.includes(w))) : events.filter((e) => favs.has(e.id) && !recent.includes(e.id))).slice(0, 6);
    const seen = q ? [] : recent.map((id) => byId.get(id)).filter(Boolean).slice(0, 4);
    const cs = q ? cats.filter((c) => fold(c.label).includes(q) || c.words.some((w) => w.trim() && q.includes(w.trim()))) : cats.slice(0, 4);
    const hs = (q ? topics.filter((x) => fold(x.q).includes(q) || x.keys.some((k) => q.includes(k))) : topics.slice(0, 3)).slice(0, 4);
    const groups = [];
    if (seen.length) groups.push(h("p", { class: "palette-group", text: t.recent }), ...seen.map((e) => item(e.shop, "clock", e.title, [e.next, e.city].filter(Boolean).join(" · "), e.image)));
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

  // ── Install (where the browser offers it) ──
  let installEvent = null;
  const installButtons = $$("[data-install]");
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installEvent = e;
    installButtons.forEach((b) => { b.hidden = false; });
  });
  installButtons.forEach((b) => b.addEventListener("click", async () => {
    if (!installEvent) return;
    installEvent.prompt();
    try { await installEvent.userChoice; } catch { /* dismissed */ }
    installEvent = null;
    installButtons.forEach((x) => { x.hidden = true; });
  }));
  window.addEventListener("appinstalled", () => installButtons.forEach((x) => { x.hidden = true; }));

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
