/*! ALKAO — "Acheter des billets" button for a Brand's website (Run 12).
 *
 *   <script src="https://<alkao>/widget.js" data-client="<clientId>" data-brand="<brandId>"
 *           data-event="<eventId, optional>" data-label="Acheter des billets" data-lang="fr|en" async></script>
 *
 * It only inserts a link to the ALKAO shop next to this tag: no iframe, no cookie, no data.
 */
(function () {
  var script = document.currentScript;
  if (!script) return;
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  var d = script.dataset;
  var ids = [d.client, d.brand].concat(d.event ? [d.event] : []);
  if (!ids.every(function (id) { return UUID.test(id || ""); })) {
    if (window.console) console.warn("ALKAO widget: data-client and data-brand (and data-event) must be UUIDs.");
    return;
  }
  var origin = new URL(script.src).origin;
  var link = document.createElement("a");
  var lang = d.lang === "en" ? "en" : d.lang === "fr" ? "fr" : null;
  link.href = origin + "/acheter/" + ids.join("/") + (lang ? "?lang=" + lang : "");
  link.textContent = (d.label || (lang === "en" ? "Buy tickets" : "Acheter des billets")).slice(0, 60);
  link.className = "alkao-buy";
  if (d.target === "_blank") { link.target = "_blank"; link.rel = "noopener"; }
  if (d.style !== "none") {
    var s = link.style;
    s.display = "inline-block"; s.padding = "12px 20px"; s.borderRadius = "10px"; s.fontWeight = "600";
    s.fontFamily = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"; s.textDecoration = "none";
    s.background = d.color && /^#[0-9a-fA-F]{3,8}$/.test(d.color) ? d.color : "#1c1917"; s.color = "#ffffff";
  }
  // Placed in <head> by mistake: show the button at the top of the page instead.
  if (script.parentNode && script.parentNode.nodeName !== "HEAD") {
    script.parentNode.insertBefore(link, script.nextSibling);
  } else {
    var place = function () { document.body.insertBefore(link, document.body.firstChild); };
    if (document.body) place(); else document.addEventListener("DOMContentLoaded", place);
  }
})();
