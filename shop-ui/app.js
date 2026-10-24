// ALKAO — hosted ticket shop (Run 08). A Brand can sell with a plain link:
//   /acheter/<clientId>/<brandId>              published events
//   /acheter/<clientId>/<brandId>/<eventId>    choose a session and tickets, pay
//   /acheter/merci/<clientId>/<brandId>/<holdId>  back from Stripe → the buyer's tickets
// Every price comes from the server; the page only sends what the buyer picked.
// Run 90: a full event page (photo with zoom, sticky purchase panel, date strip, live quote,
// the Brand's other events), the same rules and calls underneath.
import { html, render, useEffect, useLayoutEffect, useRef, useState } from "/shop/vendor/htm-preact.js";
import { localeOf, pickLanguage, switchLanguage } from "/shop/i18n.js";

// Run 16: French by default, English on request (?lang=en, the switch, or the browser).
const LANG = pickLanguage();
document.documentElement.lang = LANG === "en" ? "en-CA" : "fr-CA";
const T = {
  fr: {
    errors: {
      ticketing_unavailable: "La billetterie de cet organisateur est fermée pour le moment.",
      event_not_found: "Cet événement n'est pas en vente.",
      sold_out: "Il ne reste plus assez de places pour cette séance.",
      session_not_available: "Cette séance n'est plus en vente.",
      sales_not_open: "La vente n'est pas encore ouverte.",
      presale_code_invalid: "Ce code de prévente n'est pas valide.",
      hold_not_active: "Votre réservation a expiré. Recommencez votre sélection.",
      hold_not_found: "Votre réservation a expiré. Recommencez votre sélection.",
      rate_limited: "Trop de tentatives. Patientez une minute.",
      payments_unavailable: "Le paiement en ligne n'est pas encore ouvert pour cet organisateur.",
      payment_provider_error: "Le service de paiement ne répond pas. Réessayez.",
      return_url_not_allowed: "Configuration de paiement incomplète chez l'organisateur.",
      invalid_request: "Vérifiez vos informations.",
      promo_code_invalid: "Le code promo n'est plus valide. Changez votre sélection et retirez-le.",
      add_on_sold_out: "Une option choisie vient de s'épuiser pour cette séance. Retirez-la ou changez de séance.",
      ticket_type_sold_out: "Les billets à ce prix viennent de s'épuiser. Choisissez le prix régulier.",
      pass_cart_mixed: "Une passe festival s'achète seule : retirez les billets d'un jour, ou achetez-les dans une autre commande.",
      pass_no_session: "Aucune date de ce festival n'est en vente pour le moment.",
    },
    generic: "Une erreur est survenue. Réessayez dans un instant.",
    promo: {
      label: "Code promo", apply: "Appliquer", remove: "Retirer le code", discount: (c) => `Rabais (${c})`,
      toggle: "J'ai un code promo", applied: (c) => `Code ${c} appliqué`, offer: (p) => `Offre ${p}`,
      unknown: "Ce code n'existe pas pour cet événement.", inactive: "Ce code n'est plus actif.",
      not_started: "Ce code n'est pas encore valide.", ended: "Ce code a expiré.", used_up: "Ce code a atteint sa limite d'utilisations.",
      presale_only: "Ce code ne s'applique pas aux billets en prévente : il vaut pour les billets au prix régulier.",
    },
    // Run 97: presale prices and coupons, always as the organizer set them.
    deal: {
      presale: "Prix prévente", instead: (p) => `au lieu de ${p}`, save: (pct) => `−${pct} %`,
      until: (d) => `Jusqu'au ${d}`, left: (n) => (n <= 25 ? `Plus que ${n} à ce prix` : `${n} restants à ce prix`),
      // Run 101: the last 48 hours of a presale, counted down to its real end.
      endsIn: (d, h, m) => `Se termine dans ${d ? `${d} j ${h} h` : h ? `${h} h ${m} min` : m ? `${m} min` : "moins d'une minute"}`,
      soldOut: "Épuisé à ce prix",
    },
    coupons: {
      title: "Coupons", apply: "Appliquer", applied: "Appliqué", until: (d) => `jusqu'au ${d}`,
      left: (n) => `${n} restant${n > 1 ? "s" : ""}`, off: "de rabais", label: (l, v) => `Coupon ${l} : ${v} de rabais`, generic: "Rabais", notPresale: "hors prix prévente",
    },
    v: {
      above_maximum: (n, l) => `${n} : ${l} au maximum par commande.`,
      below_minimum: (n, l) => `${n} : ${l} au minimum.`,
      max_adults_exceeded: (n, l) => `${n} : ${l} adulte${l > 1 ? "s" : ""} au maximum dans la commande.`,
      add_on_without_admission: (n) => `${n} s'ajoute à une entrée : choisissez d'abord vos billets.`,
      add_on_quantity_mismatch: (n, l, scope) => scope === "up_to_admissions" ? `${n} : ${l} au maximum, un par entrée.` : `${n} : choisissez-en ${l}, un par entrée.`,
      order_too_large: () => "Commande trop grande.",
      other: () => "Sélection invalide.",
    },
    loading: "Chargement…",
    testMode: "Mode test : aucun paiement réel. Utilisez une carte de test Stripe.",
    notFinished: "Paiement non terminé. Vos places sont encore réservées quelques minutes.",
    resume: "Reprendre le paiement",
    release: "Libérer mes places",
    ticketsTitle: "Billets",
    step1: "Choisissez votre séance",
    noSessions: "Aucune séance en vente pour le moment.",
    // Run 98: festival passes.
    pass: {
      modes: "Type de billet", day: "Billet d'un jour", pass: "Passe festival", dates: "Les dates de la passe",
      covers: (n) => `Valide ${n} date${n > 1 ? "s" : ""}`, each: "Une entrée par date, avec le même code QR.",
      left: (n) => (n <= 25 ? `Plus que ${n} passes` : `${n} passes restantes`), full: "Complet pour au moins une date",
      hero: (n) => `Les ${n} dates`, see: "Voir la passe festival",
    },
    doorSale: "Vente à la porte",
    noSessionsToday: "Aucune séance à vendre aujourd'hui.",
    full: "Complet",
    fewLeft: (n) => `Plus que ${n} place${n > 1 ? "s" : ""}`,
    available: "Places disponibles",
    prevDates: "Dates précédentes",
    nextDates: "Dates suivantes",
    step2: "Vos billets",
    pickDateFirst: "Choisissez une date pour voir les billets.",
    optionsTitle: "Ajoutez des options",
    optionsHint: "Repas, activités… Choisissez d'abord vos billets.",
    free: "Gratuit",
    perAdmission: " · option, une par entrée",
    upToAdmissions: " · option, une par personne au plus",
    perOrder: " · option",
    addOnLeft: (n) => (n === 0 ? " · épuisé" : n <= 10 ? ` · plus que ${n}` : ""),
    openDate: " · date modifiable",
    minimum: (n) => ` · minimum ${n}`,
    remove: (n) => `Retirer ${n}`,
    quantity: (n) => `Quantité ${n}`,
    add: (n) => `Ajouter ${n}`,
    gst: "TPS", qst: "TVQ",
    beforeTax: "Avant taxes",
    priceDetail: "Détail du prix, calculé par la billetterie",
    total: "Total",
    taxesNote: "Taxes incluses dans le total. Aucuns frais ajoutés.",
    taxesIn: "taxes incluses",
    tickets: (n) => `${n} billet${n > 1 ? "s" : ""}`,
    pickDate: "Choisissez une date",
    pickTickets: "Choisissez vos billets",
    seeTickets: "Voir les billets",
    next: "Continuer",
    step3: "Vos coordonnées",
    stepsLabel: "Étapes de l'achat",
    stepTickets: "Billets", stepDetails: "Coordonnées", stepPay: "Paiement",
    summaryTitle: "Votre commande",
    heldFor: "Places réservées pendant ",
    email: "Courriel (vos billets y seront envoyés)",
    name: "Nom complet",
    phone: "Téléphone (facultatif)",
    getFree: "Obtenir mes billets",
    pay: (m) => `Payer ${m}`,
    change: "Modifier ma sélection",
    stripe: "Paiement sécurisé par Stripe, directement à l'organisateur.",
    policyTitle: "Politique d'échange et de remboursement",
    // Run 69: what the organizer says about the event.
    factsTitle: "À savoir",
    categories: { concerts: "Concert", festivals: "Festival", sports: "Sport", famille: "Famille", "plein-air": "Plein air", spectacles: "Théâtre et humour", soirees: "Soirée", experiences: "Expérience", gastronomie: "Gastronomie", mode: "Mode", marches: "Marché et salon" },
    age: (n) => (n === 0 ? "Pour tous" : `${n} ans et plus`),
    doors: (d) => `Ouverture des portes ${d} avant le début`,
    languages: { fr: "En français", en: "En anglais", "fr-en": "En français et en anglais", none: "Sans paroles" },
    accessibilityTitle: "Accessibilité",
    policyNone: (brand) => `Les échanges et remboursements suivent la politique de ${brand || "l'organisateur"}. Pour la connaître avant de payer, écrivez-lui :`,
    // Run 90: the event page.
    about: "À propos",
    readMore: "Lire la suite",
    readLess: "Réduire",
    venueTitle: "Lieu",
    directions: "Itinéraire",
    newTab: " (Google Maps, nouvel onglet)",
    organizerTitle: "Organisateur",
    organizedBy: "Organisé par",
    website: "Site web",
    from: "À partir de",
    plusTax: "+ taxes",
    moreDates: (n) => `+ ${n} autre${n > 1 ? "s" : ""} date${n > 1 ? "s" : ""}`,
    share: "Partager",
    linkCopied: "Lien copié",
    copyFailed: "Impossible de copier le lien.",
    zoom: "Agrandir la photo",
    photoOf: (t) => `Photo : ${t}`,
    zoomIn: "Zoom avant", zoomOut: "Zoom arrière", zoomFit: "Ajuster à l'écran", close: "Fermer",
    zoomHint: "Molette, pincement ou double-clic pour zoomer",
    otherEvents: (b) => (b ? `Autres événements de ${b}` : "Autres événements"),
    prevEvents: "Événements précédents",
    nextEvents: "Événements suivants",
    noDate: "Aucune date en vente",
    onSale: (n) => (n === 0 ? "" : `${n} événement${n > 1 ? "s" : ""} à l'affiche`),
    footer: "Billetterie ALKAO",
    shop: "Billetterie",
    noEvents: "Aucun événement en vente pour le moment.",
    opening: "Merci ! Ouverture de vos billets…",
    thanks: "Merci !",
    confirming: "Votre paiement est en cours de confirmation. Vos billets vous seront envoyés par courriel dans quelques minutes.",
    badAddress: "Adresse de billetterie incomplète.",
    // Run 71: the waitlist of a sold-out session.
    // Run 72: before the public sale, and presale codes.
    salesOpen: (d) => `La vente ouvre le ${d}.`,
    salesClosed: "La vente en ligne est terminée pour cet événement.",
    presaleTitle: "Vous avez un code de prévente ?",
    presaleCode: "Code de prévente",
    presaleCheck: "Valider le code",
    presaleOpenNow: "Code de prévente accepté : vous pouvez acheter dès maintenant.",
    presaleLater: (d) => `Code accepté : la prévente ouvre le ${d}.`,
    waitTitle: "Séance complète ? Inscrivez-vous à la liste d'attente",
    waitLead: "Si des places se libèrent, nous vous écrivons une fois. Elles vont ensuite au premier qui achète.",
    waitSession: "Séance",
    waitEmail: "Votre courriel",
    waitSend: "M'avertir",
    waitDone: "C'est noté. Vous recevrez un courriel si des places se libèrent pour cette séance.",
    waitFree: "Des places viennent de se libérer : choisissez la séance ci-dessus.",
    findTitle: "Vous avez déjà acheté ? Retrouvez vos billets",
    findLead: "Nous les renvoyons à l'adresse utilisée pour l'achat.",
    findEmail: "Le courriel utilisé pour l'achat",
    findSend: "Renvoyer mes billets",
    findSent: "Si une commande à venir correspond à cette adresse, vos billets viennent de vous être renvoyés. Vérifiez aussi vos courriels indésirables.",
    other: "English",
    // Run 93: the event page in full.
    sectionsLabel: "Sections de la page",
    tabs: { highlights: "Points forts", gallery: "Galerie", steps: "Le jour J", about: "Description", venue: "Lieu", faq: "FAQ" },
    duration: "Durée", format: "Format", experience: "Expérience", ageReq: "Âge requis", language: "Langue",
    book: "Réserver",
    hlEyebrow: "Points forts", hlTitle: "L'expérience",
    prevItems: "Précédents", nextItems: "Suivants",
    galEyebrow: "Galerie", galTitle: "En photos",
    viewPhoto: (i, n, alt) => `Voir la photo ${i} sur ${n}${alt ? ` : ${alt}` : ""}`,
    prevPhoto: "Photo précédente", nextPhoto: "Photo suivante",
    stepsEyebrow: "Le jour J", stepsTitle: "Comment ça se passe",
    aboutEyebrow: "En bref",
    noticeTitle: "À savoir avant de réserver",
    venueEyebrow: "À propos du lieu",
    showMap: "Afficher la carte",
    mapNote: "Carte fournie par Google Maps. Elle se charge seulement si vous la demandez.",
    mapTitle: (n) => `Carte : ${n}`,
    faqEyebrow: "FAQ", faqTitle: "Questions fréquentes",
    faqMore: (n) => `Voir les ${n} questions`, faqLess: "Voir moins",
    faqAuto: {
      age: ["Quel est l'âge minimum ?", (a) => (a === 0 ? "C'est pour tous les âges." : `${a} ans et plus.`)],
      duration: ["Combien de temps ça dure ?", (d) => `Environ ${d}.`],
      language: ["Dans quelle langue ?", (l) => `${l}.`],
      doors: ["Quand les portes ouvrent-elles ?", (d) => `${d} avant le début de chaque séance.`],
      access: "Le lieu est-il accessible ?",
      refund: "Puis-je échanger ou me faire rembourser ?",
      tickets: ["Comment vais-je recevoir mes billets ?", "Par courriel, juste après le paiement. Ils s'ouvrent aussi sur votre téléphone, même sans réseau, et se présentent à l'entrée."],
      fees: ["Y a-t-il des frais ajoutés ?", "Non. Vous payez le prix affiché, plus les taxes, sans frais ajoutés."],
      pick: ["Où choisir ma date et mon heure ?", "Dans le panneau Billets : choisissez le mois, le jour, puis l'heure."],
    },
    monthsLabel: "Mois",
    weekdays: ["D", "L", "M", "M", "J", "V", "S"],
    weekdaysLong: ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"],
    sessionsCount: (n) => `${n} séance${n > 1 ? "s" : ""}`,
    pickTime: "Choisissez l'heure",
    moreInfo: "Plus d'infos", lessInfo: "Moins d'infos",
    recEyebrow: "Du même organisateur", recTitle: "Vous aimerez aussi",
    continueWith: (m) => `${m} · Continuer`,
  },
  en: {
    errors: {
      ticketing_unavailable: "This organizer's ticketing is closed for now.",
      event_not_found: "This event is not on sale.",
      sold_out: "Not enough seats are left for this session.",
      session_not_available: "This session is no longer on sale.",
      sales_not_open: "Sales are not open yet.",
      presale_code_invalid: "This presale code is not valid.",
      hold_not_active: "Your reservation expired. Please choose again.",
      hold_not_found: "Your reservation expired. Please choose again.",
      rate_limited: "Too many attempts. Please wait a minute.",
      payments_unavailable: "Online payment is not open yet for this organizer.",
      payment_provider_error: "The payment service is not responding. Please try again.",
      return_url_not_allowed: "The organizer's payment setup is incomplete.",
      invalid_request: "Please check your details.",
      promo_code_invalid: "The promo code is no longer valid. Change your selection and remove it.",
      add_on_sold_out: "An option you chose just sold out for this session. Remove it or pick another session.",
      ticket_type_sold_out: "The tickets at this price just sold out. Choose the regular price.",
      pass_cart_mixed: "A festival pass is bought on its own: remove the day tickets, or buy them in another order.",
      pass_no_session: "No date of this festival is on sale right now.",
    },
    generic: "Something went wrong. Please try again in a moment.",
    promo: {
      label: "Promo code", apply: "Apply", remove: "Remove the code", discount: (c) => `Discount (${c})`,
      toggle: "I have a promo code", applied: (c) => `Code ${c} applied`, offer: (p) => `${p} offer`,
      unknown: "This code does not exist for this event.", inactive: "This code is no longer active.",
      not_started: "This code is not valid yet.", ended: "This code has expired.", used_up: "This code has reached its limit.",
      presale_only: "This code does not apply to presale tickets: it is for regular-price tickets.",
    },
    deal: {
      presale: "Presale price", instead: (p) => `instead of ${p}`, save: (pct) => `−${pct}%`,
      until: (d) => `Until ${d}`, left: (n) => (n <= 25 ? `Only ${n} left at this price` : `${n} left at this price`),
      endsIn: (d, h, m) => `Ends in ${d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : m ? `${m} min` : "less than a minute"}`,
      soldOut: "Sold out at this price",
    },
    coupons: {
      title: "Coupons", apply: "Apply", applied: "Applied", until: (d) => `until ${d}`,
      left: (n) => `${n} left`, off: "off", label: (l, v) => `Coupon ${l}: ${v} off`, generic: "Discount", notPresale: "not on presale prices",
    },
    v: {
      above_maximum: (n, l) => `${n}: at most ${l} per order.`,
      below_minimum: (n, l) => `${n}: at least ${l}.`,
      max_adults_exceeded: (n, l) => `${n}: at most ${l} adult${l > 1 ? "s" : ""} in the order.`,
      add_on_without_admission: (n) => `${n} goes with an admission: choose your tickets first.`,
      add_on_quantity_mismatch: (n, l, scope) => scope === "up_to_admissions" ? `${n}: ${l} at most, one per admission.` : `${n}: choose ${l}, one per admission.`,
      order_too_large: () => "Order too large.",
      other: () => "Invalid selection.",
    },
    loading: "Loading…",
    testMode: "Test mode: no real payment. Use a Stripe test card.",
    notFinished: "Payment not completed. Your seats are still held for a few minutes.",
    resume: "Resume payment",
    release: "Release my seats",
    ticketsTitle: "Tickets",
    step1: "Choose your session",
    noSessions: "No session on sale right now.",
    pass: {
      modes: "Ticket type", day: "One-day ticket", pass: "Festival pass", dates: "The pass's dates",
      covers: (n) => `Valid for ${n} date${n > 1 ? "s" : ""}`, each: "One entry per date, with the same QR code.",
      left: (n) => (n <= 25 ? `Only ${n} passes left` : `${n} passes left`), full: "Full for at least one date",
      hero: (n) => `All ${n} dates`, see: "See the festival pass",
    },
    doorSale: "Door sale",
    noSessionsToday: "No session to sell today.",
    full: "Sold out",
    fewLeft: (n) => `Only ${n} seat${n > 1 ? "s" : ""} left`,
    available: "Seats available",
    prevDates: "Earlier dates",
    nextDates: "Later dates",
    step2: "Your tickets",
    pickDateFirst: "Choose a date to see the tickets.",
    optionsTitle: "Add options",
    optionsHint: "Meals, activities… Choose your tickets first.",
    free: "Free",
    perAdmission: " · option, one per admission",
    upToAdmissions: " · option, at most one per person",
    perOrder: " · option",
    addOnLeft: (n) => (n === 0 ? " · sold out" : n <= 10 ? ` · only ${n} left` : ""),
    openDate: " · date can be changed",
    minimum: (n) => ` · minimum ${n}`,
    remove: (n) => `Remove ${n}`,
    quantity: (n) => `Quantity ${n}`,
    add: (n) => `Add ${n}`,
    gst: "GST", qst: "QST",
    beforeTax: "Before taxes",
    priceDetail: "Price details, calculated by the box office",
    total: "Total",
    taxesNote: "Taxes included in the total. No added fees.",
    taxesIn: "taxes included",
    tickets: (n) => `${n} ticket${n > 1 ? "s" : ""}`,
    pickDate: "Choose a date",
    pickTickets: "Choose your tickets",
    seeTickets: "See tickets",
    next: "Continue",
    step3: "Your details",
    stepsLabel: "Purchase steps",
    stepTickets: "Tickets", stepDetails: "Details", stepPay: "Payment",
    summaryTitle: "Your order",
    heldFor: "Seats held for ",
    email: "Email (your tickets will be sent there)",
    name: "Full name",
    phone: "Phone (optional)",
    getFree: "Get my tickets",
    pay: (m) => `Pay ${m}`,
    change: "Change my selection",
    stripe: "Secure payment by Stripe, directly to the organizer.",
    policyTitle: "Exchange and refund policy",
    factsTitle: "Good to know",
    categories: { concerts: "Concert", festivals: "Festival", sports: "Sports", famille: "Family", "plein-air": "Outdoors", spectacles: "Theatre and comedy", soirees: "Nightlife", experiences: "Experience", gastronomie: "Food and drink", mode: "Fashion", marches: "Market and fair" },
    age: (n) => (n === 0 ? "All ages" : `Ages ${n} and over`),
    doors: (d) => `Doors open ${d} before the start`,
    languages: { fr: "In French", en: "In English", "fr-en": "In French and English", none: "No spoken words" },
    accessibilityTitle: "Accessibility",
    policyNone: (brand) => `Exchanges and refunds follow ${brand || "the organizer"}'s policy. To read it before paying, write to them:`,
    about: "About",
    readMore: "Read more",
    readLess: "Show less",
    venueTitle: "Venue",
    directions: "Directions",
    newTab: " (Google Maps, new tab)",
    organizerTitle: "Organizer",
    organizedBy: "Organized by",
    website: "Website",
    from: "From",
    plusTax: "+ taxes",
    moreDates: (n) => `+ ${n} more date${n > 1 ? "s" : ""}`,
    share: "Share",
    linkCopied: "Link copied",
    copyFailed: "The link could not be copied.",
    zoom: "Enlarge the photo",
    photoOf: (t) => `Photo: ${t}`,
    zoomIn: "Zoom in", zoomOut: "Zoom out", zoomFit: "Fit to screen", close: "Close",
    zoomHint: "Scroll, pinch or double-click to zoom",
    otherEvents: (b) => (b ? `More events by ${b}` : "More events"),
    prevEvents: "Previous events",
    nextEvents: "Next events",
    noDate: "No date on sale",
    onSale: (n) => (n === 0 ? "" : `${n} event${n > 1 ? "s" : ""} on sale`),
    footer: "ALKAO Ticketing",
    shop: "Tickets",
    noEvents: "No event on sale right now.",
    opening: "Thank you! Opening your tickets…",
    thanks: "Thank you!",
    confirming: "Your payment is being confirmed. Your tickets will be emailed to you within a few minutes.",
    badAddress: "Incomplete ticketing address.",
    salesOpen: (d) => `Sales open on ${d}.`,
    salesClosed: "Online sales are over for this event.",
    presaleTitle: "Have a presale code?",
    presaleCode: "Presale code",
    presaleCheck: "Check the code",
    presaleOpenNow: "Presale code accepted: you can buy now.",
    presaleLater: (d) => `Code accepted: the presale opens on ${d}.`,
    waitTitle: "Sold out? Join the waitlist",
    waitLead: "If seats open up, we write to you once. They then go to whoever buys first.",
    waitSession: "Session",
    waitEmail: "Your email",
    waitSend: "Notify me",
    waitDone: "Got it. You will receive an email if seats open up for this session.",
    waitFree: "Seats have just opened up: choose the session above.",
    findTitle: "Already bought? Find your tickets",
    findLead: "We send them again to the address used for the purchase.",
    findEmail: "The email used for the purchase",
    findSend: "Send my tickets again",
    findSent: "If an upcoming order matches this address, your tickets have just been sent again. Also check your spam folder.",
    other: "Français",
    sectionsLabel: "Page sections",
    tabs: { highlights: "Highlights", gallery: "Gallery", steps: "On the day", about: "Description", venue: "Venue", faq: "FAQ" },
    duration: "Duration", format: "Format", experience: "Experience", ageReq: "Age", language: "Language",
    book: "Book",
    hlEyebrow: "Highlights", hlTitle: "The experience",
    prevItems: "Previous", nextItems: "Next",
    galEyebrow: "Gallery", galTitle: "In pictures",
    viewPhoto: (i, n, alt) => `View photo ${i} of ${n}${alt ? `: ${alt}` : ""}`,
    prevPhoto: "Previous photo", nextPhoto: "Next photo",
    stepsEyebrow: "On the day", stepsTitle: "How it works",
    aboutEyebrow: "In short",
    noticeTitle: "Good to know before booking",
    venueEyebrow: "About the venue",
    showMap: "Show the map",
    mapNote: "Map by Google Maps. It loads only if you ask for it.",
    mapTitle: (n) => `Map: ${n}`,
    faqEyebrow: "FAQ", faqTitle: "Frequently asked questions",
    faqMore: (n) => `See all ${n} questions`, faqLess: "See less",
    faqAuto: {
      age: ["What is the minimum age?", (a) => (a === 0 ? "It is for all ages." : `Ages ${a} and over.`)],
      duration: ["How long does it last?", (d) => `About ${d}.`],
      language: ["In which language?", (l) => `${l}.`],
      doors: ["When do the doors open?", (d) => `${d} before each session starts.`],
      access: "Is the venue accessible?",
      refund: "Can I exchange or get a refund?",
      tickets: ["How will I get my tickets?", "By email, right after payment. They also open on your phone, even without a network, and are shown at the entrance."],
      fees: ["Are there added fees?", "No. You pay the price shown, plus taxes, with no added fees."],
      pick: ["Where do I choose my date and time?", "In the Tickets panel: choose the month, the day, then the time."],
    },
    monthsLabel: "Months",
    weekdays: ["S", "M", "T", "W", "T", "F", "S"],
    weekdaysLong: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
    sessionsCount: (n) => `${n} session${n > 1 ? "s" : ""}`,
    pickTime: "Choose the time",
    moreInfo: "More info", lessInfo: "Less info",
    recEyebrow: "From the same organizer", recTitle: "You may also like",
    continueWith: (m) => `${m} · Continue`,
  },
}[LANG];

// ── Icons (24 px strokes, decorative: the text next to them says it) ────────
const PATHS = {
  calendar: "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z",
  pin: "M12 21.5s7-6.1 7-11.5a7 7 0 1 0-14 0c0 5.4 7 11.5 7 11.5zM12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3 2",
  share: "M4 13v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6M16 7l-4-4-4 4M12 3v13",
  expand: "M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7",
  zoomIn: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M11 8v6M8 11h6",
  zoomOut: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4M8 11h6",
  fit: "M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4",
  close: "M18 6 6 18M6 6l12 12",
  left: "M15 18l-6-6 6-6",
  right: "M9 18l6-6-6-6",
  arrow: "M5 12h14M13 6l6 6-6 6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  lock: "M7 11V8a5 5 0 0 1 10 0v3M6 11h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1z",
  check: "M20 6 9 17l-5-5",
  tag: "M20.6 13.4l-7.2 7.2a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8zM7.5 7.5h.01",
  mail: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM21 7l-9 6-9-6",
  phone: "M21 16.5v3a2 2 0 0 1-2.2 2 19.5 19.5 0 0 1-8.5-3 19.2 19.2 0 0 1-6-6 19.5 19.5 0 0 1-3-8.6A2 2 0 0 1 3.3 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.4 2.1L7.3 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.5 1.6z",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3a14 14 0 0 1 3.6 9A14 14 0 0 1 12 21a14 14 0 0 1-3.6-9A14 14 0 0 1 12 3z",
  external: "M18 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h5M15 3h6v6M10 14 21 3",
  route: "M3 11 21 3l-8 18-2-8-8-2z",
  users: "M16 20v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 18.5V20M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 20v-1.5a3.5 3.5 0 0 0-2.5-3.4M15.5 4.2a3.5 3.5 0 0 1 0 6.6",
  door: "M5 21V4a1 1 0 0 1 1-1h9l4 2v16M3 21h18M14 12h.01",
  speech: "M20 15a2 2 0 0 1-2 2H8l-4 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2z",
  access: "M12 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM9 9h6M12 9v5l4 5M12 14l-4 5",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16v-5M12 8h.01",
  ticket: "M3 8a2 2 0 0 0 2-2h14a2 2 0 0 0 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 0-2 2H5a2 2 0 0 0-2-2v-2a2 2 0 0 0 0-4zM14 6v12",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  spark: "M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.8 2.8M14.9 14.9l2.8 2.8M6.3 17.7l2.8-2.8M14.9 9.1l2.8-2.8",
  down: "M6 9l6 6 6-6",
  alert: "M12 3 2 20h20L12 3zM12 10v4M12 17h.01",
  map: "M9 4 3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14",
};
const Icon = ({ n, cls = "i" }) => html`<svg class=${cls} viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d=${PATHS[n]} /></svg>`;
const stepNo = (n) => html`<span class="step-n" aria-hidden="true">${n}</span><span class="sr-only">${n}. </span>`;
const reduced = () => { try { return matchMedia("(prefers-reduced-motion: reduce)").matches; } catch { return false; } };

const switcher = html`<p class="lang"><button class="lang-btn" lang=${LANG === "en" ? "fr" : "en"} onClick=${() => switchLanguage(LANG === "en" ? "fr" : "en")}><${Icon} n="globe" />${T.other}</button></p>`;

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// Run 35: door sales. The same shop and the same Stripe payment (so the same commission),
// on the staff member's phone or tablet, showing only today's sessions. Card only.
const DOOR = new URLSearchParams(location.search).get("porte") === "1";
const dayIn = (date, tz) => new Intl.DateTimeFormat("en-CA", { timeZone: tz || "America/Toronto", dateStyle: "short" }).format(date);

const route = (() => {
  const p = location.pathname;
  let m = new RegExp(`^/acheter/merci/(${UUID})/(${UUID})/(${UUID})$`).exec(p);
  if (m) return { page: "merci", c: m[1], b: m[2], holdId: m[3] };
  m = new RegExp(`^/acheter/(${UUID})/(${UUID})/(${UUID})$`).exec(p);
  if (m) return { page: "event", c: m[1], b: m[2], eventId: m[3] };
  m = new RegExp(`^/acheter/(${UUID})/(${UUID})$`).exec(p);
  if (m) return { page: "events", c: m[1], b: m[2] };
  return null;
})();
const base = route && `/v1/public/clients/${route.c}/brands/${route.b}`;

// Run 50: the Brand's colour, logo and the event's photo (checked again here before use).
const https = (u) => (typeof u === "string" && /^https:\/\/[^\s"'<>\\]+$/.test(u) ? u : null);
function applyLook(brand) {
  const hex = /^#[0-9a-f]{6}$/i;
  if (hex.test(brand?.accentColor ?? "") && hex.test(brand?.onAccentColor ?? "")) {
    const s = document.documentElement.style;
    s.setProperty("--accent", brand.accentColor);
    s.setProperty("--accent-ink", brand.onAccentColor);
    // The top bar wears the Brand's colour too, in light and dark.
    s.setProperty("--top", brand.accentColor);
    s.setProperty("--top-ink", brand.onAccentColor);
  }
}
// Run 90: without the organizer's photo, the category's photo (Run 69), else a neutral one.
const CATEGORY_PHOTO = { concerts: "cat-concerts", festivals: "cat-festivals", sports: "cat-sports", famille: "cat-family", "plein-air": "cat-camping", spectacles: "cat-shows", soirees: "cat-nightlife", experiences: "cat-live", gastronomie: "cat-food", mode: "cat-fashion", marches: "cat-markets" };
const fallbackPhoto = (category) => `/assets/home/img/${CATEGORY_PHOTO[category] ?? "event-fallback"}.webp`;

/** The logo, or the Brand's name when the image cannot be shown. */
function Logo({ src, name }) {
  const [failed, setFailed] = useState(false);
  return failed ? html`<span class="brand-name">${name}</span>` : html`<img class="logo" src=${src} alt=${name} height="36" onError=${() => setFailed(true)} />`;
}
const hideBroken = (e) => { e.currentTarget.hidden = true; };
/** The Brand's band: its colour, its logo (or name), the language switch. */
const Top = ({ brand, extra }) => {
  const logo = https(brand?.logoUrl);
  return html`<header class="top"><div class="wrap top-row">
    <p class="brand">${logo ? html`<${Logo} src=${logo} name=${brand.name} />` : html`<span class="brand-name">${brand?.name ?? ""}</span>`}${extra ?? ""}</p>
    ${switcher}
  </div></header>`;
};
const Footer = () => html`<footer class="foot"><div class="wrap foot-row"><p>${T.footer}</p><p class="foot-secure"><${Icon} n="lock" />${T.stripe}</p></div></footer>`;
const STORE = (holdId) => `alkao.checkout.${holdId}`;
const SCOPE_TEXT = (t) => (t.addOnScope === "per_order" ? T.perOrder : t.addOnScope === "up_to_admissions" ? T.upToAdmissions : T.perAdmission);

// Run 49: the ad's UTM tags on the shop's link go with the order, for the campaign report.
const ATTRIBUTION = (() => {
  const q = new URLSearchParams(location.search);
  const a = {};
  for (const key of ["source", "medium", "campaign", "content", "term"]) {
    const v = q.get(`utm_${key}`)?.trim();
    if (v && v.length <= 100 && !/[<>\u0000-\u001f]/.test(v)) a[key] = v;
  }
  if (Object.keys(a).length === 0) return null;
  a.landing = location.pathname.slice(0, 200);
  return a;
})();
const saved = (holdId) => { try { return JSON.parse(sessionStorage.getItem(STORE(holdId)) ?? "null"); } catch { return null; } };
const save = (holdId, value) => { try { sessionStorage.setItem(STORE(holdId), JSON.stringify(value)); } catch {} };

const money = (cents) => (Number(cents ?? 0) / 100).toLocaleString(localeOf(LANG), { style: "currency", currency: "CAD" });
const whenFr = (iso, tz) => new Intl.DateTimeFormat(localeOf(LANG), { dateStyle: "full", timeStyle: "short", timeZone: tz || "America/Toronto" }).format(new Date(iso));
const fmt = (iso, tz, o) => new Intl.DateTimeFormat(localeOf(LANG), { timeZone: tz || "America/Toronto", ...o }).format(new Date(iso));
/** The pieces of a date card: weekday, day, month, (year when not this one), time. */
function dateParts(iso, tz) {
  const year = fmt(iso, tz, { year: "numeric" });
  return {
    wd: fmt(iso, tz, { weekday: "short" }),
    day: fmt(iso, tz, { day: "numeric" }),
    mon: fmt(iso, tz, { month: "short" }),
    year: year === fmt(Date.now(), tz, { year: "numeric" }) ? null : year,
    time: fmt(iso, tz, { hour: "numeric", minute: "2-digit" }),
  };
}
const shortDate = (iso, tz) => fmt(iso, tz, { weekday: "short", day: "numeric", month: "short" });
/** "From": the lowest paid admission before taxes (as the platform home shows it), or free. */
function priceFrom(types) {
  // Run 97: a presale with no ticket left is no longer a price anyone pays.
  const admissions = (types ?? []).filter((t) => t.kind === "admission" && t.remaining !== 0);
  if (admissions.length === 0) return null;
  const paid = admissions.map((t) => t.priceCents).filter((c) => c > 0);
  return paid.length ? { cents: Math.min(...paid) } : { free: true };
}

/**
 * Run 97: the cheapest presale ticket still on sale, against the regular ticket it undercuts
 * (both as the organizer priced them), or null.
 */
function presaleFrom(types) {
  const list = types ?? [];
  const deals = list.filter((t) => t.kind === "admission" && t.presaleOf && t.remaining !== 0)
    .map((t) => ({ t, regular: list.find((r) => r.id === t.presaleOf) }))
    .filter((d) => d.regular && d.t.priceCents < d.regular.priceCents)
    .sort((a, b) => a.t.priceCents - b.t.priceCents);
  const d = deals[0];
  return d ? { cents: d.t.priceCents, regularCents: d.regular.priceCents, endsAt: d.t.salesEndAt ?? null, remaining: d.t.remaining ?? null } : null;
}
/** Run 98: the dates a festival pass covers (every date on sale), and what is left. */
function PassDates({ sessions, tz, left }) {
  return html`<div class="pass-dates">
    <ul class="pass-list">${sessions.map((s) => html`<li><${Icon} n="calendar" /><span>${fmt(s.startsAt, tz, { weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" })}</span></li>`)}</ul>
    <p class="pass-note">${T.pass.each} ${left === 0 ? html`<strong>${T.pass.full}</strong>` : html`<strong>${T.pass.left(left)}</strong>`}</p>
  </div>`;
}

/** Run 97: presale tickets right before the regular ticket each undercuts, the rest in order. */
function presalesFirst(list) {
  const ids = new Set(list.map((t) => t.id));
  const out = [];
  for (const t of list) {
    if (t.presaleOf && ids.has(t.presaleOf)) continue;
    out.push(...list.filter((p) => p.presaleOf === t.id), t);
  }
  return out;
}
/** Run 97: what a saving is, in whole percent (rounded down: never more than the truth). */
const savePct = (cents, regularCents) => Math.floor(((regularCents - cents) / regularCents) * 100);
/** Run 97: a coupon's value, as the organizer set it. */
const couponValue = (c) => (c.kind === "percent" ? (LANG === "en" ? `${c.percent}%` : `${c.percent} %`) : money(c.amountCents));
/** Run 97: a coupon shared as /acheter/…?coupon=CODE is applied on arrival. */
const URL_COUPON = (() => {
  const v = new URLSearchParams(location.search).get("coupon");
  return v && /^[A-Za-z0-9-]{3,32}$/.test(v) ? v.toUpperCase() : null;
})();

class ApiError extends Error {
  constructor(status, code, details) { super(code); this.status = status; this.code = code; this.details = details; }
}
async function call(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...headers, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error?.code ?? "error", data?.error?.details);
  return data;
}

const errText = (e) => T.errors[e?.code] ?? T.generic;

function violationText(v, types) {
  const type = types.find((t) => t.id === v.ticketTypeId);
  const name = type?.name ?? "";
  if (v.code === "add_on_quantity_mismatch") return T.v.add_on_quantity_mismatch(name, v.limit, type?.addOnScope);
  switch (v.code) {
    case "above_maximum":
    case "below_minimum":
    case "max_adults_exceeded":
    case "add_on_without_admission":
    case "add_on_quantity_mismatch":
    case "order_too_large":
      return T.v[v.code](name, v.limit);
    default: return T.v.other();
  }
}

// Run 90: what another event of the Brand shows on a card: its next date and its "from" price,
// read from the same public event the shop sells. Once per event and page.
const summaries = new Map();
function summary(id) {
  if (!summaries.has(id)) {
    summaries.set(id, call(`/events/${id}`).then((d) => {
      const next = d.sessions.find((s) => s.available > 0) ?? d.sessions[0] ?? null;
      return { next: next?.startsAt ?? null, last: d.sessions[d.sessions.length - 1]?.startsAt ?? null, count: d.sessions.length, tz: d.event.venue?.timezone, from: priceFrom(d.ticketTypes) };
    }, () => null));
  }
  return summaries.get(id);
}
function useSummaries(ids) {
  const [map, setMap] = useState(null);
  useEffect(() => {
    let live = true;
    Promise.all(ids.map((id) => summary(id).then((s) => [id, s]))).then((pairs) => { if (live) setMap(Object.fromEntries(pairs)); });
    return () => { live = false; };
  }, [ids.join(",")]);
  return map;
}
/** Soonest first; events without a date on sale last. */
const byNextDate = (events, sums) => [...events].sort((a, b) => {
  const x = sums?.[a.id]?.next, y = sums?.[b.id]?.next;
  return x && y ? Date.parse(x) - Date.parse(y) : x ? -1 : y ? 1 : 0;
});

/** A short message at the bottom of the screen ("Lien copié"), read by screen readers. */
function useToast() {
  const [msg, setMsg] = useState(null);
  const timer = useRef(0);
  const show = (m) => { setMsg(m); clearTimeout(timer.current); timer.current = setTimeout(() => setMsg(null), 2600); };
  return [msg, show];
}
const Toast = ({ msg }) => html`<div class="toast-zone" role="status">${msg && html`<p class="toast"><${Icon} n="check" />${msg}</p>`}</div>`;

/** A number that slides up or down when it changes (stepper). */
function Num({ value }) {
  const prev = useRef(value);
  const dir = value > prev.current ? "up" : value < prev.current ? "down" : "";
  useEffect(() => { prev.current = value; }, [value]);
  return html`<span key=${value} class=${`qty-num ${dir}`}>${value}</span>`;
}

/** An amount that counts to its new value (the total); screen readers get the final value. */
function Money({ cents }) {
  const [shown, setShown] = useState(cents);
  const cur = useRef(cents);
  useEffect(() => {
    const from = cur.current;
    if (from === cents || reduced()) { cur.current = cents; setShown(cents); return; }
    const t0 = performance.now();
    let raf = 0;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 360);
      cur.current = Math.round(from + (cents - from) * (1 - Math.pow(1 - k, 3)));
      setShown(cur.current);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [cents]);
  return html`<span aria-hidden="true">${money(shown)}</span><span class="sr-only">${money(cents)}</span>`;
}

/** Run 90: the hold's real expiry, as a clock and a bar that empties. */
function HoldTimer({ until, start, onExpire }) {
  const [left, setLeft] = useState(Math.max(0, until - Date.now()));
  useEffect(() => {
    const t = setInterval(() => { const l = Math.max(0, until - Date.now()); setLeft(l); if (l === 0) { clearInterval(t); onExpire(); } }, 1000);
    return () => clearInterval(t);
  }, [until]);
  const s = Math.ceil(left / 1000);
  const share = Math.max(0, Math.min(1, left / Math.max(1, until - start)));
  return html`<div class=${`hold${s <= 120 ? " low" : ""}`}>
    <${Icon} n="clock" />
    <p>${T.heldFor}<span class="timer" role="timer">${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}</span>.</p>
    <span class="hold-bar" aria-hidden="true"><span style=${{ transform: `scaleX(${share})` }}></span></span>
  </div>`;
}

// ── Zoomable photo (Run 90): wheel, pinch, double-click, drag; Escape or the button closes ──
const MAX_ZOOM = 5;
function Lightbox({ photos, start = 0, onClose }) {
  // Run 93: one photo, or the gallery with previous and next.
  const [at, setAt] = useState(start);
  const { src, alt } = photos[at];
  const many = photos.length > 1;
  const dialog = useRef(null);
  const stage = useRef(null);
  const img = useRef(null);
  const view = useRef({ s: 1, x: 0, y: 0 });
  const pointers = useRef(new Map());
  const pinch = useRef(null);
  const [scale, setScale] = useState(1);

  const paint = (animate) => {
    const el = img.current;
    if (!el) return;
    const { s, x, y } = view.current;
    el.classList.toggle("anim", !!animate && !reduced());
    el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${s})`;
    setScale(s);
  };
  const clamp = () => {
    const el = img.current, box = stage.current;
    const v = view.current;
    const mx = Math.max(0, (el.offsetWidth * v.s - box.clientWidth) / 2);
    const my = Math.max(0, (el.offsetHeight * v.s - box.clientHeight) / 2);
    v.x = Math.min(mx, Math.max(-mx, v.x));
    v.y = Math.min(my, Math.max(-my, v.y));
  };
  // A point of the screen, from the photo's centre (as laid out, before zoom).
  const fromCentre = (clientX, clientY) => {
    const r = stage.current.getBoundingClientRect(), el = img.current;
    return [clientX - r.left - el.offsetLeft - el.offsetWidth / 2, clientY - r.top - el.offsetTop - el.offsetHeight / 2];
  };
  const zoomTo = (next, cx = 0, cy = 0, animate = false) => {
    const v = view.current;
    const s = Math.min(MAX_ZOOM, Math.max(1, next));
    const k = s / v.s;
    view.current = s === 1 ? { s, x: 0, y: 0 } : { s, x: cx - k * (cx - v.x), y: cy - k * (cy - v.y) };
    clamp();
    paint(animate);
  };

  useEffect(() => {
    const d = dialog.current;
    document.documentElement.classList.add("lb-open");
    d.showModal();
    const wheel = (e) => { e.preventDefault(); const [cx, cy] = fromCentre(e.clientX, e.clientY); zoomTo(view.current.s * Math.exp(-e.deltaY * 0.0018), cx, cy); };
    const box = stage.current;
    box.addEventListener("wheel", wheel, { passive: false });
    return () => { box.removeEventListener("wheel", wheel); document.documentElement.classList.remove("lb-open"); };
  }, []);

  const down = (e) => {
    stage.current.setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    }
  };
  const move = (e) => {
    const p = pointers.current.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const [cx, cy] = fromCentre(mx, my);
      view.current.x += mx - pinch.current.mx;
      view.current.y += my - pinch.current.my;
      zoomTo(view.current.s * (d / Math.max(1, pinch.current.d)), cx, cy);
      pinch.current = { d, mx, my };
    } else if (view.current.s > 1) {
      view.current.x += dx;
      view.current.y += dy;
      clamp();
      paint(false);
    }
  };
  const up = (e) => { pointers.current.delete(e.pointerId); if (pointers.current.size < 2) pinch.current = null; };
  const go = (d) => {
    if (!many) return;
    view.current = { s: 1, x: 0, y: 0 };
    paint(false);
    setAt((n) => (n + d + photos.length) % photos.length);
  };
  const dbl = (e) => { const [cx, cy] = fromCentre(e.clientX, e.clientY); zoomTo(view.current.s > 1.05 ? 1 : 2.5, cx, cy, true); };
  const key = (e) => {
    const v = view.current;
    if (e.key === "+" || e.key === "=") zoomTo(v.s * 1.4, 0, 0, true);
    else if (e.key === "-" || e.key === "_") zoomTo(v.s / 1.4, 0, 0, true);
    else if (e.key === "0") zoomTo(1, 0, 0, true);
    else if (many && v.s <= 1 && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); go(e.key === "ArrowLeft" ? -1 : 1); }
    else if (v.s > 1 && e.key.startsWith("Arrow")) {
      const step = 60;
      if (e.key === "ArrowLeft") v.x += step; else if (e.key === "ArrowRight") v.x -= step;
      else if (e.key === "ArrowUp") v.y += step; else v.y -= step;
      e.preventDefault(); clamp(); paint(true);
    } else return;
  };
  return html`<dialog class="lightbox" ref=${dialog} aria-label=${T.photoOf(alt)} onClose=${onClose} onKeyDown=${key}>
    <div class="lb-bar">
      ${many ? html`<p class="lb-count" aria-live="polite">${at + 1} / ${photos.length}</p>` : html`<p class="lb-hint">${T.zoomHint}</p>`}
      <div class="lb-tools">
        <button type="button" class="lb-btn" aria-label=${T.zoomOut} disabled=${scale <= 1} onClick=${() => zoomTo(view.current.s / 1.5, 0, 0, true)}><${Icon} n="zoomOut" /></button>
        <span class="lb-pct" aria-hidden="true">${Math.round(scale * 100)} %</span>
        <button type="button" class="lb-btn" aria-label=${T.zoomIn} disabled=${scale >= MAX_ZOOM} onClick=${() => zoomTo(view.current.s * 1.5, 0, 0, true)}><${Icon} n="zoomIn" /></button>
        <button type="button" class="lb-btn" aria-label=${T.zoomFit} disabled=${scale <= 1} onClick=${() => zoomTo(1, 0, 0, true)}><${Icon} n="fit" /></button>
        <button type="button" class="lb-btn lb-close" aria-label=${T.close} autofocus onClick=${() => dialog.current.close()}><${Icon} n="close" /></button>
      </div>
    </div>
    <div class=${`lb-stage${scale > 1 ? " zoomed" : ""}`} ref=${stage} onPointerDown=${down} onPointerMove=${move} onPointerUp=${up} onPointerCancel=${up} onDblClick=${dbl}>
      <img ref=${img} src=${src} alt=${alt} draggable="false" />
    </div>
    ${many && html`<button type="button" class="lb-btn lb-side prev" aria-label=${T.prevPhoto} onClick=${() => go(-1)}><${Icon} n="left" /></button>
      <button type="button" class="lb-btn lb-side next" aria-label=${T.nextPhoto} onClick=${() => go(1)}><${Icon} n="right" /></button>`}
  </dialog>`;
}

// ── Horizontal rails: dates in the panel, events below (scroll-snap, arrows, swipe) ──
function useEdges(ref, deps) {
  const [edges, setEdges] = useState({ start: false, end: false, index: 1, count: 0 });
  const update = () => {
    const el = ref.current;
    if (!el) return;
    const first = el.firstElementChild;
    const step = first ? first.getBoundingClientRect().width + parseFloat(getComputedStyle(el).columnGap || "0") : 1;
    const count = el.children.length;
    const visible = Math.max(1, Math.round(el.clientWidth / Math.max(1, step)));
    const index = Math.min(count, Math.round(el.scrollLeft / Math.max(1, step)) + 1);
    setEdges({ start: el.scrollLeft > 4, end: el.scrollLeft + el.clientWidth < el.scrollWidth - 4, index, count, last: Math.min(count, index + visible - 1) });
  };
  useEffect(() => {
    update();
    if (!ref.current || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, deps);
  const by = (dir) => ref.current?.scrollBy({ left: dir * ref.current.clientWidth * 0.85, behavior: reduced() ? "auto" : "smooth" });
  return [edges, update, by];
}

/** An event of the Brand as a card: photo, date badge, title, place, "from". */
function EventCard({ e, sum, level = 3 }) {
  const own = https(e.imageUrl);
  const [src, setSrc] = useState(own ?? fallbackPhoto(e.category));
  const tz = sum?.tz ?? e.venueTimezone;
  const p = sum?.next ? dateParts(sum.next, tz) : null;
  const place = [e.venueName, e.venueCity].filter(Boolean).join(" · ");
  const broken = (ev) => { if (own && src === own) setSrc(fallbackPhoto(e.category)); else hideBroken(ev); };
  // Run 93: several dates read as a range, as on the event page.
  const range = sum?.next && sum.count > 1 && sum.last && dayIn(new Date(sum.next), tz) !== dayIn(new Date(sum.last), tz)
    ? `${dayMonth(sum.next, tz)} – ${dayMonth(sum.last, tz)}` : null;
  return html`<a class="ev-card" href=${`/acheter/${route.c}/${route.b}/${e.id}`}>
    <span class="ev-media">
      <img src=${src} alt="" width="640" height="400" loading="lazy" decoding="async" onError=${broken} />
      ${p && html`<span class="date-badge" aria-hidden="true"><b>${p.day}</b>${p.mon}</span>`}
      ${e.venueName && html`<span class="ev-chip"><${Icon} n="pin" />${e.venueName}</span>`}
    </span>
    <span class="ev-body">
      ${level === 2 ? html`<h2 class="ev-title">${e.title}</h2>` : html`<h3 class="ev-title">${e.title}</h3>`}
      <span class="ev-when">${range ?? (p ? `${shortDate(sum.next, tz)} · ${p.time}${sum.count > 1 ? ` · ${T.moreDates(sum.count - 1)}` : ""}` : sum ? T.noDate : "")}</span>
      ${place && html`<span class="ev-place">${place}</span>`}
      <span class="ev-from">${sum?.from ? (sum.from.free ? T.free : html`${T.from} <strong>${money(sum.from.cents)}</strong>`) : ""}</span>
    </span>
  </a>`;
}

/** Run 90: "Autres événements de <Brand>": the Brand's other events with a date on sale. */
function OtherEvents({ brandName, events }) {
  const list = events.slice(0, 12);
  const sums = useSummaries(list.map((e) => e.id));
  const ref = useRef(null);
  const shown = sums ? byNextDate(list.filter((e) => sums[e.id]?.next), sums) : [];
  const [edges, update, by] = useEdges(ref, [shown.length]);
  if (!sums || shown.length === 0) return null;
  return html`<section class="rail-sec" aria-labelledby="rail-title">
    <div class="rail-head">
      <div><p class="sec-eyebrow">${brandName ? T.otherEvents(brandName) : T.recEyebrow}</p><h2 id="rail-title">${T.recTitle}</h2></div>
      ${(edges.start || edges.end) && html`<div class="rail-nav">
        <span class="rail-count" aria-hidden="true">${edges.index}–${edges.last} / ${edges.count}</span>
        <button type="button" class="round" aria-label=${T.prevEvents} disabled=${!edges.start} onClick=${() => by(-1)}><${Icon} n="left" /></button>
        <button type="button" class="round" aria-label=${T.nextEvents} disabled=${!edges.end} onClick=${() => by(1)}><${Icon} n="right" /></button>
      </div>`}
    </div>
    <ul class="rail" ref=${ref} onScroll=${update}>${shown.map((e) => html`<li><${EventCard} e=${e} sum=${sums[e.id]} /></li>`)}</ul>
  </section>`;
}

// ── Event page blocks ───────────────────────────────────────────────────────
const span = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${String(m % 60).padStart(2, "0")}` : ""}`);
const dayMonth = (iso, tz) => fmt(iso, tz, { day: "numeric", month: "short" });
// Run 97: when a presale or a coupon ends ("1 novembre, 23 h 59").
/** Run 101: "Se termine dans 5 h 12 min" in a presale's last 48 hours, else null (the date is shown instead). */
const SOON_MS = 48 * 3_600_000;
function endsIn(iso, now) {
  const ms = Date.parse(iso) - now;
  if (!(ms > 0) || ms > SOON_MS) return null;
  const mins = Math.floor(ms / 60_000);
  return T.deal.endsIn(Math.floor(mins / 1440), Math.floor((mins % 1440) / 60), mins % 60);
}
const presaleEnd = (iso, tz, now) => endsIn(iso, now) ?? T.deal.until(dayLong(iso, tz));

const dayLong = (iso, tz) => {
  const text = fmt(iso, tz, { day: "numeric", month: "long", hour: "numeric", minute: "2-digit" });
  return LANG === "en" ? text : text.replace(/^1 /, "1er ");
};
/** "18 oct. – 31 janv.", or the one date and its time. */
function dateRange(sessions, tz) {
  if (!sessions.length) return null;
  const first = sessions[0].startsAt, last = sessions[sessions.length - 1].startsAt;
  if (sessions.length === 1 || dayIn(new Date(first), tz) === dayIn(new Date(last), tz)) return `${shortDate(first, tz)} · ${dateParts(first, tz).time}`;
  return `${dayMonth(first, tz)} – ${dayMonth(last, tz)}`;
}

/** Run 93: the hero as the organizer describes the outing, with the price and a way to the tickets. */
function Hero({ ev, src, own, onBroken, sessions, address, from, presale, pass, compact, zoomRef, onZoom, onBook, onPass, now = Date.now() }) {
  const tz = ev.venue?.timezone;
  const when = dateRange(sessions, tz);
  const place = [address || ev.venue?.name, ev.venue?.city].filter(Boolean).join(", ");
  const facts = [
    Number.isInteger(ev.durationMinutes) && ["clock", T.duration, span(ev.durationMinutes)],
    ev.format && ["grid", T.format, ev.format],
    ev.page?.summary && ["spark", T.experience, ev.page.summary],
    Number.isInteger(ev.minAge) && ["users", T.ageReq, T.age(ev.minAge)],
    T.languages[ev.language] && ["speech", T.language, T.languages[ev.language]],
  ].filter(Boolean);
  return html`<section class=${`hero${compact ? " compact" : ""}`} aria-labelledby="event-title">
    <div class="hero-media" onClick=${onZoom}>
      <img class=${own ? "hero-img photo" : "hero-img"} src=${src} alt="" width="1600" height="900" fetchpriority="high" decoding="async" onError=${onBroken} />
    </div>
    <div class="hero-shade" aria-hidden="true"></div>
    <button type="button" class="hero-zoom" ref=${zoomRef} aria-label=${T.zoom} onClick=${onZoom}><${Icon} n="expand" /></button>
    <div class="wrap hero-inner">
      <div class="hero-text">
        ${T.categories[ev.category] && html`<p class="eyebrow">${T.categories[ev.category]}</p>`}
        <h1 id="event-title">${ev.title}</h1>
        ${(when || place) && html`<div class="hero-where">
          ${when && html`<p><${Icon} n="calendar" /><span>${when}${sessions.length > 1 ? html` <span class="more">· ${T.sessionsCount(sessions.length)}</span>` : ""}</span></p>`}
          ${place && html`<p><${Icon} n="pin" /><span>${place}</span></p>`}
        </div>`}
        ${facts.length > 0 && !compact && html`<ul class="hero-facts">${facts.map(([icon, label, value]) => html`<li>
          <${Icon} n=${icon} /><span><span class="hf-label">${label}</span><span class="hf-value">${value}</span></span></li>`)}</ul>`}
      </div>
      ${from && !compact && html`<div class=${`hero-book${presale || pass ? " has-deal" : ""}`}>
        <p class="hb-from"><span class="hb-label">${from.free ? T.ticketsTitle : T.from}</span>
          <span class="hb-price">${from.free ? T.free : money(from.cents)}</span>${!from.free && html`<span class="hb-tax">${T.plusTax}</span>`}</p>
        <button type="button" class="hb-btn" onClick=${onBook}>${T.book}</button>
        ${presale && html`<p class="hb-deal"><span class="deal-badge">${T.deal.presale}</span>
          <span class="hb-deal-price">${money(presale.cents)}</span>
          <span class="hb-deal-was"><span class="sr-only">${T.deal.instead("")}</span><s>${money(presale.regularCents)}</s></span>
          <span class="save">${T.deal.save(savePct(presale.cents, presale.regularCents))}</span>
          ${presale.endsAt && html`<span class="hb-deal-until">${endsIn(presale.endsAt, now) ?? T.coupons.until(dayLong(presale.endsAt, ev.venue?.timezone))}</span>`}</p>`}
        ${pass && html`<button type="button" class="hb-deal hb-pass" aria-label=${`${T.pass.see} — ${T.pass.hero(pass.dates)}, ${money(pass.cents)}`} onClick=${onPass}>
          <span class="deal-badge">${T.pass.pass}</span><span class="hb-deal-price">${money(pass.cents)}</span>
          <span class="hb-deal-until">${T.pass.hero(pass.dates)}</span><${Icon} n="arrow" /></button>`}
      </div>`}
    </div>
  </section>`;
}

/** Run 93: the page's sections as tabs that stay in view and follow the reading. */
function SectionTabs({ items, onShare }) {
  const [active, setActive] = useState(items[0]?.[0] ?? null);
  const ids = items.map(([id]) => id).join(",");
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const els = items.map(([id]) => document.getElementById(id)).filter(Boolean);
    const io = new IntersectionObserver((entries) => {
      const seen = entries.filter((e) => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (seen) setActive(seen.target.id);
    }, { rootMargin: "-96px 0px -55% 0px" });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [ids]);
  if (items.length < 2) return null;
  return html`<nav class="tabs" aria-label=${T.sectionsLabel}>
    <ul class="tabs-list">${items.map(([id, label]) => html`<li><a href=${`#${id}`} aria-current=${active === id ? "true" : undefined} onClick=${() => setActive(id)}>${label}</a></li>`)}</ul>
    ${onShare && html`<button type="button" class="tabs-share" aria-label=${T.share} onClick=${onShare}><${Icon} n="share" /></button>`}
  </nav>`;
}

const SecHead = ({ eyebrow, id, title, children }) => html`<div class="sec-head">
  <div><p class="sec-eyebrow">${eyebrow}</p><h2 id=${id}>${title}</h2></div>${children ?? ""}
</div>`;

/** Points forts: a rail of photo cards with a title and a few words. */
function Highlights({ items }) {
  const ref = useRef(null);
  const [edges, update, by] = useEdges(ref, [items.length]);
  if (!items.length) return null;
  return html`<section class="block hl" id="points-forts" aria-labelledby="hl-title">
    <${SecHead} eyebrow=${T.hlEyebrow} id="hl-title" title=${T.hlTitle}>
      ${(edges.start || edges.end) && html`<div class="rail-nav">
        <button type="button" class="round" aria-label=${T.prevItems} disabled=${!edges.start} onClick=${() => by(-1)}><${Icon} n="left" /></button>
        <button type="button" class="round" aria-label=${T.nextItems} disabled=${!edges.end} onClick=${() => by(1)}><${Icon} n="right" /></button>
      </div>`}
    <//>
    <ul class="hl-rail" ref=${ref} onScroll=${update}>${items.map((h, i) => {
      const img = https(h.imageUrl);
      return html`<li class=${`hl-card${img ? "" : " no-img"}`}>
        ${img ? html`<img src=${img} alt="" width="600" height="450" loading="lazy" decoding="async" onError=${hideBroken} />`
          : html`<span class="hl-num" aria-hidden="true">${String(i + 1).padStart(2, "0")}</span>`}
        <div class="hl-text"><h3>${h.title}</h3>${h.text && html`<p>${h.text}</p>`}</div>
      </li>`;
    })}</ul>
  </section>`;
}

/** Galerie: a mosaic; each photo opens the viewer with previous and next. */
function Gallery({ photos, onOpen }) {
  if (!photos.length) return null;
  const shown = photos.slice(0, 5);
  return html`<section class="block gallery" id="galerie" aria-labelledby="gal-title">
    <${SecHead} eyebrow=${T.galEyebrow} id="gal-title" title=${T.galTitle} />
    <ul class=${`mosaic n${shown.length}`}>${shown.map((p, i) => html`<li>
      <button type="button" class="mosaic-btn" aria-label=${T.viewPhoto(i + 1, photos.length, p.alt)} onClick=${(e) => onOpen(i, e.currentTarget)}>
        <img src=${p.url} alt="" loading="lazy" decoding="async" onError=${hideBroken} />
        ${i === shown.length - 1 && photos.length > shown.length && html`<span class="mosaic-more" aria-hidden="true">+${photos.length - shown.length}</span>`}
      </button></li>`)}</ul>
  </section>`;
}

/** Le jour J: how the visit goes, step by step. */
function Steps({ steps }) {
  if (!steps.length) return null;
  return html`<section class="block steps" id="le-jour-j" aria-labelledby="steps-title">
    <${SecHead} eyebrow=${T.stepsEyebrow} id="steps-title" title=${T.stepsTitle} />
    <ol class="timeline">${steps.map((st, i) => {
      const img = https(st.imageUrl);
      return html`<li>
        <span class="tl-media" aria-hidden="true">${img ? html`<img src=${img} alt="" width="96" height="96" loading="lazy" decoding="async" onError=${hideBroken} />` : html`<span class="tl-num">${i + 1}</span>`}</span>
        <div class="tl-text"><h3>${st.title}</h3>${st.text && html`<p>${st.text}</p>`}</div>
      </li>`;
    })}</ol>
  </section>`;
}

/** The organizer's description, clamped with "Lire la suite", and the notice before booking. */
function About({ text, notice }) {
  const ref = useRef(null);
  const [long, setLong] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => { const el = ref.current; if (el) setLong(el.scrollHeight > el.clientHeight + 4); }, [text]);
  if (!text?.trim() && !notice) return null;
  return html`<section class="block about" id="description" aria-labelledby="about-title">
    <${SecHead} eyebrow=${T.aboutEyebrow} id="about-title" title=${T.tabs.about} />
    ${text?.trim() && html`<div id="about-text" ref=${ref} class=${`about-text${open ? "" : " clamped"}`}>${text.trim()}</div>
      ${(long || open) && html`<button type="button" class="link-btn more-btn" aria-expanded=${open ? "true" : "false"} aria-controls="about-text" onClick=${() => setOpen(!open)}>${open ? T.readLess : T.readMore}<${Icon} n="down" cls=${`i chev${open ? " up" : ""}`} /></button>`}`}
    ${notice && html`<div class="notice"><${Icon} n="alert" /><div><h3>${T.noticeTitle}</h3><p>${notice}</p></div></div>`}
  </section>`;
}

// ── Run 69: category, age, doors, language and accessibility, as the organizer set them ──
function Facts({ ev }) {
  const items = [
    T.categories[ev.category] && ["tag", T.categories[ev.category]],
    Number.isInteger(ev.minAge) && ["users", T.age(ev.minAge)],
    Number.isInteger(ev.doorsOpenMinutes) && ev.doorsOpenMinutes > 0 && ["door", T.doors(span(ev.doorsOpenMinutes))],
    T.languages[ev.language] && ["speech", T.languages[ev.language]],
  ].filter(Boolean);
  const access = String(ev.accessibility ?? "").trim();
  if (!items.length && !access) return null;
  return html`<section class="block facts" aria-labelledby="facts-title">
    <h2 id="facts-title">${T.factsTitle}</h2>
    ${items.length > 0 && html`<ul class="chips">${items.map(([icon, text]) => html`<li><${Icon} n=${icon} /><span>${text}</span></li>`)}</ul>`}
    ${access && html`<div class="access"><${Icon} n="access" /><div><h3>${T.accessibilityTitle}</h3><p>${access}</p></div></div>`}
  </section>`;
}

/** Run 93: where it is: the address, directions, and the map once the buyer asks for it. */
function Venue({ venue, address }) {
  const [map, setMap] = useState(false);
  if (!venue?.name) return null;
  const line = [address, venue.city].filter(Boolean).join(", ");
  const query = [venue.name, address, venue.city].filter(Boolean).join(", ");
  const href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(query)}`;
  return html`<section class="block venue" id="lieu" aria-labelledby="venue-title">
    <${SecHead} eyebrow=${T.venueEyebrow} id="venue-title" title=${venue.name} />
    <div class="card venue-card">
      <div class="venue-row">
        <span class="tile" aria-hidden="true"><${Icon} n="pin" /></span>
        <div class="venue-text"><p class="venue-name">${venue.name}</p>${line && html`<p class="muted">${line}</p>`}</div>
        <a class="btn-ghost" href=${href} target="_blank" rel="noopener"><${Icon} n="route" />${T.directions}<span class="sr-only">${T.newTab}</span></a>
      </div>
      <div class="map">${map
        ? html`<iframe title=${T.mapTitle(venue.name)} src=${`https://www.google.com/maps?q=${encodeURIComponent(query)}&output=embed`} loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>`
        : html`<button type="button" class="map-load" onClick=${() => setMap(true)}><${Icon} n="map" /><span>${T.showMap}</span></button><p class="map-note">${T.mapNote}</p>`}</div>
    </div>
  </section>`;
}

/** Run 93: the organizer's questions, then the ones the page can answer from its own facts. */
function Faq({ ev }) {
  const [open, setOpen] = useState(false);
  const A = T.faqAuto;
  const own = (ev.page?.faq ?? []).map((f) => [f.question, f.answer]);
  const policy = String(ev.brand?.refundPolicy ?? "").trim();
  const access = String(ev.accessibility ?? "").trim();
  const derived = [
    Number.isInteger(ev.minAge) && [A.age[0], A.age[1](ev.minAge)],
    Number.isInteger(ev.durationMinutes) && [A.duration[0], A.duration[1](span(ev.durationMinutes))],
    T.languages[ev.language] && [A.language[0], A.language[1](T.languages[ev.language])],
    Number.isInteger(ev.doorsOpenMinutes) && ev.doorsOpenMinutes > 0 && [A.doors[0], A.doors[1](span(ev.doorsOpenMinutes))],
    access && [A.access, access],
    policy && [A.refund, policy],
    A.tickets, A.fees, !DOOR && A.pick,
  ].filter(Boolean);
  const all = [...own, ...derived];
  const shown = open ? all : all.slice(0, 5);
  return html`<section class="block faq" id="faq" aria-labelledby="faq-title">
    <${SecHead} eyebrow=${T.faqEyebrow} id="faq-title" title=${T.faqTitle} />
    <div class="faq-list">${shown.map(([q, a]) => html`<details class="faq-item">
      <summary><span>${q}</span><${Icon} n="down" cls="i chev" /></summary>
      <p>${a}</p>
    </details>`)}</div>
    ${all.length > 5 && html`<button type="button" class="link-btn" aria-expanded=${open ? "true" : "false"} onClick=${() => setOpen(!open)}>${open ? T.faqLess : T.faqMore(all.length)}</button>`}
  </section>`;
}

/**
 * Run 93: the dates as a calendar: the months with a session, the days with one, then the
 * hours of the chosen day. A day with one session chooses it at once.
 */
function SessionCalendar({ sessions, tz, value, onPick }) {
  const days = new Map();
  for (const x of sessions) {
    const d = dayIn(new Date(x.startsAt), tz);
    if (!days.has(d)) days.set(d, []);
    days.get(d).push(x);
  }
  const months = [...new Set([...days.keys()].map((d) => d.slice(0, 7)))].sort();
  const chosen = sessions.find((x) => x.id === value);
  const firstOpen = sessions.find((x) => x.available > 0) ?? sessions[0];
  const [month, setMonth] = useState(() => dayIn(new Date((chosen ?? firstOpen).startsAt), tz).slice(0, 7));
  const [day, setDay] = useState(() => (chosen ? dayIn(new Date(chosen.startsAt), tz) : null));
  const [y, m] = month.split("-").map(Number);
  const lead = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = dayIn(new Date(), tz);
  const avail = (x) => (x.available === 0 ? T.full : x.available <= 20 ? T.fewLeft(x.available) : T.available);
  const monthName = (ym, style) => new Intl.DateTimeFormat(localeOf(LANG), { month: style, year: "numeric", timeZone: "UTC" }).format(new Date(`${ym}-15T12:00:00Z`));
  const pickDay = (key, list) => {
    setDay(key);
    if (list.length === 1) onPick(list[0].id);
    else if (!list.some((x) => x.id === value)) onPick(null);
  };
  const slots = day ? days.get(day) ?? [] : [];
  return html`<div class="cal">
    ${months.length > 1 && html`<div class="cal-months" role="group" aria-label=${T.monthsLabel}>${months.map((ym) => html`<button type="button" class="cal-month"
      aria-pressed=${ym === month ? "true" : "false"} aria-label=${monthName(ym, "long")} onClick=${() => setMonth(ym)}>${monthName(ym, "short")}</button>`)}</div>`}
    ${months.length === 1 && html`<p class="cal-title">${monthName(month, "long")}</p>`}
    <div class="cal-grid">
      ${T.weekdays.map((w, i) => html`<span class="cal-wd" aria-hidden="true" title=${T.weekdaysLong[i]}>${w}</span>`)}
      ${Array.from({ length: lead }, (_, i) => html`<span class="cal-blank" key=${`b${i}`} aria-hidden="true"></span>`)}
      ${Array.from({ length: count }, (_, i) => {
        const key = `${month}-${String(i + 1).padStart(2, "0")}`;
        const list = days.get(key);
        if (!list) return html`<span class=${`cal-day off${key === today ? " today" : ""}`} key=${key} aria-hidden="true">${i + 1}</span>`;
        const open = list.some((x) => x.available > 0);
        const name = list.length === 1 ? `${whenFr(list[0].startsAt, tz)}, ${avail(list[0])}` : `${fmt(list[0].startsAt, tz, { dateStyle: "full" })}, ${T.sessionsCount(list.length)}`;
        const few = open && list.every((x) => x.available === 0 || x.available <= 20);
        return html`<button type="button" key=${key} class=${`cal-day on${few ? " few" : ""}${key === today ? " today" : ""}`} aria-pressed=${key === day ? "true" : "false"}
          aria-label=${name} disabled=${!open} onClick=${() => pickDay(key, list)}>${i + 1}</button>`;
      })}
    </div>
    ${slots.length > 0 && html`<div class="slots" role="group" aria-label=${T.pickTime}>
      <p class="slots-title">${fmt(slots[0].startsAt, tz, { weekday: "long", day: "numeric", month: "long" })}</p>
      <div class="slots-row">${slots.map((x) => html`<button type="button" class=${`slot${x.available > 0 && x.available <= 20 ? " few" : ""}`} aria-pressed=${x.id === value ? "true" : "false"}
        disabled=${x.available === 0} aria-label=${slots.length > 1 ? `${whenFr(x.startsAt, tz)}, ${avail(x)}` : `${dateParts(x.startsAt, tz).time}, ${avail(x)}`} onClick=${() => onPick(x.id)}>
        <span class="slot-time">${dateParts(x.startsAt, tz).time}</span><span class="slot-avail">${avail(x)}</span></button>`)}</div>
    </div>`}
  </div>`;
}

/** Door sales: today's sessions only, as hours. */
function TimeSlots({ sessions, tz, value, onPick }) {
  const avail = (x) => (x.available === 0 ? T.full : x.available <= 20 ? T.fewLeft(x.available) : T.available);
  return html`<div class="slots"><div class="slots-row">${sessions.map((x) => html`<button type="button" class=${`slot${x.available > 0 && x.available <= 20 ? " few" : ""}`}
    aria-pressed=${x.id === value ? "true" : "false"} disabled=${x.available === 0} aria-label=${`${whenFr(x.startsAt, tz)}, ${avail(x)}`} onClick=${() => onPick(x.id)}>
    <span class="slot-time">${dateParts(x.startsAt, tz).time}</span><span class="slot-avail">${avail(x)}</span></button>`)}</div></div>`;
}

// ── Run 65: the organizer's exchange and refund policy, before payment (OPC) ──
function Policy({ brand, id = "policy-title", level = 3 }) {
  const text = String(brand?.refundPolicy ?? "").trim();
  const contact = [brand?.supportEmail, brand?.supportPhone].filter(Boolean).join(" · ");
  const title = level === 2 ? html`<h2 id=${id}>${T.policyTitle}</h2>` : html`<h3 id=${id}>${T.policyTitle}</h3>`;
  return html`<section class=${`policy${level === 2 ? " block" : ""}`} aria-labelledby=${id}>
    ${title}
    <div class="policy-body">
      ${text ? html`<p>${text}</p>` : html`<p>${T.policyNone(brand?.name ?? "")}${contact ? html` <strong>${contact}</strong>` : ""}</p>`}
    </div>
  </section>`;
}

/** Run 90: who organizes it and how to reach them. */
function Organizer({ brand }) {
  if (!brand?.name) return null;
  const site = https(brand.websiteUrl);
  const initials = brand.name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  const links = [
    site && html`<li><a href=${site} target="_blank" rel="noopener"><${Icon} n="external" />${T.website}</a></li>`,
    brand.supportEmail && html`<li><a href=${`mailto:${brand.supportEmail}`}><${Icon} n="mail" />${brand.supportEmail}</a></li>`,
    brand.supportPhone && html`<li><a href=${`tel:${brand.supportPhone.replace(/[^\d+]/g, "")}`}><${Icon} n="phone" />${brand.supportPhone}</a></li>`,
  ].filter(Boolean);
  return html`<section class="block organizer" aria-labelledby="org-title">
    <h2 id="org-title">${T.organizerTitle}</h2>
    <div class="card org-card">
      <span class="org-avatar" aria-hidden="true">${initials || "•"}</span>
      <div class="org-text">
        <p class="org-name"><span class="org-label">${T.organizedBy}</span> ${brand.name}</p>
        ${brand.addressLine && html`<p class="muted">${brand.addressLine}</p>`}
        ${links.length > 0 && html`<ul class="org-links">${links}</ul>`}
      </div>
    </div>
  </section>`;
}

const EventSkeleton = () => html`<main class="event-main" aria-busy="true">
  <p class="boot sr-only" role="status">${T.loading}</p>
  <div class="hero sk-hero" aria-hidden="true"></div>
  <div class="wrap layout" aria-hidden="true">
    <div class="side"><div class="panel sk-panel"><span class="sk w40"></span><span class="sk tall"></span><span class="sk"></span><span class="sk w60"></span></div></div>
    <div class="content"><div class="sk-block"><span class="sk w40"></span><span class="sk"></span><span class="sk"></span><span class="sk w60"></span></div></div>
  </div>
</main>`;

// ── Event: choose, quote, hold, buyer, pay ──────────────────────────────────
function EventShop({ config }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [sessionId, setSessionId] = useState(null);
  const [qty, setQty] = useState({});
  const [quote, setQuote] = useState(null);
  const [violations, setViolations] = useState([]);
  const [hold, setHold] = useState(null);
  const [buyer, setBuyer] = useState({ email: "", fullName: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  // Run 36: the code as typed, the code applied (checked by the server), and why it was refused.
  const [promoInput, setPromoInput] = useState(URL_COUPON ?? "");
  const [promo, setPromo] = useState(URL_COUPON);
  // Run 103: the partner company whose code this is ("Offre Caisse Desjardins").
  const [offer, setOffer] = useState(null);
  const [promoError, setPromoError] = useState(null);
  const [promoOpen, setPromoOpen] = useState(Boolean(URL_COUPON));
  // Run 72: a presale code that opens the sale before the public opening ({ code, opensAt }).
  const [presale, setPresale] = useState(null);
  // Run 98: "day" (one session) or "pass" (a festival pass, valid at every date on sale).
  const [mode, setMode] = useState(null);
  // Run 90: the Brand's list (other events, this one's address), the photo, the zoom.
  const [listing, setListing] = useState(null);
  const [photoBroken, setPhotoBroken] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [toast, showToast] = useToast();
  const zoomButton = useRef(null);
  const promoField = useRef(null);
  const seq = useRef(0);

  const load = () => call(`/events/${route.eventId}`).then(setData, setError);
  useEffect(() => {
    load();
    if (!DOOR) call(`/events`).then(setListing, () => setListing(null));
    // Back from Stripe without paying: offer to resume, or free the seats.
    const cancelled = /^#annule=([0-9a-f-]{36})$/.exec(location.hash)?.[1];
    const s = cancelled && saved(cancelled);
    if (s) setNotice({ holdId: cancelled, ...s });
    if (cancelled) history.replaceState(null, "", location.pathname);
  }, []);

  // Run 101: a presale in its last 48 hours counts down each minute; once it ends, the page
  // reloads the event so the presale row goes away and the regular price takes over.
  const [clock, setClock] = useState(() => Date.now());
  const presaleEnds = (data?.ticketTypes ?? []).filter((t) => t.presaleOf && t.salesEndAt).map((t) => Date.parse(t.salesEndAt));
  const soonEnd = presaleEnds.filter((at) => at > clock && at - clock <= SOON_MS).sort((a, b) => a - b)[0];
  useEffect(() => {
    if (!soonEnd) return;
    const id = setInterval(() => {
      const at = Date.now();
      setClock(at);
      if (at >= soonEnd) load();
    }, Math.min(60_000, Math.max(1_000, soonEnd - Date.now() + 500)));
    return () => clearInterval(id);
  }, [soonEnd]);

  // With a single date on sale, it is already chosen. Run 98: an event selling only passes
  // starts in pass mode, its cart on the first date.
  useEffect(() => {
    if (!data || sessionId) return;
    if (!DOOR && data.ticketTypes.some((t) => t.kind === "admission" && t.pass) && !data.ticketTypes.some((t) => t.kind === "admission" && !t.pass)) {
      if (data.sessions[0]) setSessionId(data.sessions[0].id);
      return;
    }
    const tz = data.event.venue?.timezone;
    const today = dayIn(new Date(), tz);
    const list = DOOR ? data.sessions.filter((s) => dayIn(new Date(s.startsAt), tz) === today) : data.sessions;
    if (list.length === 1 && list[0].available > 0) setSessionId(list[0].id);
  }, [data]);
  useEffect(() => { if (promoOpen) promoField.current?.focus(); }, [promoOpen]);

  const items = (data?.ticketTypes ?? []).filter((t) => (qty[t.id] ?? 0) > 0).map((t) => ({ ticketTypeId: t.id, quantity: qty[t.id] }));
  useEffect(() => {
    if (!data || items.length === 0) { setQuote(null); setViolations([]); return; }
    const n = ++seq.current;
    const t = setTimeout(() => call(`/events/${route.eventId}/quote`, { method: "POST", body: { items, ...(promo ? { promoCode: promo } : {}) } }).then(
      (r) => { if (n === seq.current) { setQuote(r.quote); setOffer(r.offer ?? null); setViolations([]); } },
      (e) => {
        if (n !== seq.current) return;
        if (e.code === "promo_code_invalid") { setPromoError(e.details?.reason ?? "unknown"); setPromo(null); return; }
        setQuote(null); setViolations(e.code === "cart_invalid" ? e.details ?? [] : []); if (e.code !== "cart_invalid") setError(e);
      },
    ), 200);
    return () => clearTimeout(t);
  }, [JSON.stringify(items), promo]);

  if (error && !data) return html`<main class="wrap narrow state-page"><div class="card state"><span class="state-ico bad" aria-hidden="true"><${Icon} n="info" /></span><div class="alert bad" role="alert">${errText(error)}</div></div></main>`;
  if (!data) return html`<${EventSkeleton} />`;
  const ev = data.event;
  applyLook(ev.brand);
  const tz = ev.venue?.timezone;
  // Run 97: a presale ticket comes right before the regular ticket it undercuts.
  // Run 98: a festival pass is sold on its own, for every date on sale (never at the door).
  const passTypes = DOOR ? [] : data.ticketTypes.filter((t) => t.kind === "admission" && t.pass);
  const dayTypes = data.ticketTypes.filter((t) => t.kind === "admission" && !t.pass);
  const passMode = passTypes.length > 0 && (dayTypes.length === 0 || mode === "pass");
  const admissions = presalesFirst(passMode ? passTypes : dayTypes);
  const addOns = data.ticketTypes.filter((t) => t.kind === "add_on");
  const wanted = items.reduce((n, i) => n + (data.ticketTypes.find((t) => t.id === i.ticketTypeId)?.kind === "admission" ? i.quantity : 0), 0);
  const today = dayIn(new Date(), tz);
  const sessions = DOOR ? data.sessions.filter((s) => dayIn(new Date(s.startsAt), tz) === today) : data.sessions;
  const session = sessions.find((s) => s.id === sessionId);
  // Run 98: a pass takes a seat on every date: what is left is the fullest date's.
  const passLeft = sessions.length ? Math.min(...sessions.map((s) => s.available)) : 0;
  // Run 98: the hero offers the pass when one-day tickets are sold too.
  const passOffer = passTypes.length > 0 && dayTypes.length > 0 && sessions.length > 1
    ? { cents: Math.min(...passTypes.map((t) => t.priceCents)), dates: sessions.length } : null;
  const pickMode = (m) => { setMode(m); setQty({}); setSessionId(m === "pass" ? sessions[0]?.id ?? null : sessions.length === 1 && sessions[0].available > 0 ? sessions[0].id : null); };
  // Run 72: the sale window; a valid presale code opens it from its own time.
  const nowMs = Date.now();
  const closed = !DOOR && ev.salesCloseAt && nowMs >= Date.parse(ev.salesCloseAt);
  const early = !DOOR && ev.salesOpenAt && nowMs < Date.parse(ev.salesOpenAt) && !(presale && nowMs >= Date.parse(presale.opensAt));
  const canBuy = !closed && !early;
  const set = (id, n) => setQty((q) => ({ ...q, [id]: Math.max(0, n) }));
  // Run 49: what is left of an add-on with a stock, for the chosen session (null: no limit).
  const left = (t) => (t.kind === "add_on" && session?.addOnsAvailable && t.id in session.addOnsAvailable ? session.addOnsAvailable[t.id] : null);
  const tooMany = passMode ? wanted > passLeft : !!session && wanted > session.available;
  const from = priceFrom(data.ticketTypes);
  const presaleDeal = DOOR ? null : presaleFrom(data.ticketTypes);
  const coupons = DOOR ? [] : data.coupons ?? [];
  const own = https(ev.imageUrl);
  const photo = own && !photoBroken ? own : fallbackPhoto(ev.category);
  const others = (listing?.events ?? []).filter((e) => e.id !== route.eventId);
  const address = listing?.events?.find((e) => e.id === route.eventId)?.venueAddress ?? null;
  const doorBadge = DOOR ? html` <span class="badge">${T.doorSale}</span>` : "";

  // Run 60: one row per ticket type; options (add-ons) in their own card, once tickets are chosen.
  const typeRow = (t) => {
    const q = qty[t.id] ?? 0;
    const about = String(t.description ?? "").trim();
    // Run 97: a presale shows the regular price it undercuts, when it ends and what is left.
    const regular = t.presaleOf ? data.ticketTypes.find((r) => r.id === t.presaleOf) : null;
    const deal = regular && t.priceCents < regular.priceCents ? regular : null;
    const limited = Number.isInteger(t.remaining) ? t.remaining : null;
    const gone = limited === 0;
    const meta = `${t.kind === "add_on" ? SCOPE_TEXT(t) : ""}${t.openDate ? T.openDate : ""}${t.pass ? ` · ${T.pass.covers(sessions.length)}` : ""}${t.minQuantity > 1 ? T.minimum(t.minQuantity) : ""}${left(t) !== null ? T.addOnLeft(left(t)) : ""}`.replace(/^ · /, "");
    const dealMeta = deal ? [t.salesEndAt && presaleEnd(t.salesEndAt, tz, clock), limited !== null && !gone && T.deal.left(limited)].filter(Boolean) : [];
    return html`<div class=${`type${q > 0 ? " is-on" : ""}${deal ? " is-deal" : ""}${gone ? " is-gone" : ""}`}>
      <div class="type-info">
        ${deal && html`<p class="type-deal"><span class="deal-badge">${T.deal.presale}</span><span class="save">${T.deal.save(savePct(t.priceCents, deal.priceCents))}</span></p>`}
        <div class="name">${t.name}</div>
        <div class="type-price"><span class="price">${t.priceCents === 0 ? T.free : money(t.priceCents)}</span>${deal && html` <span class="was"><span class="sr-only">${T.deal.instead("")}</span><s>${money(deal.priceCents)}</s></span>`}${meta && html`<span class="meta"> · ${meta}</span>`}</div>
        ${(dealMeta.length > 0 || gone) && html`<p class="deal-meta">${gone ? T.deal.soldOut : dealMeta.map((m) => html`<span>${m}</span>`)}</p>`}
        ${about && html`<details class="type-more"><summary>${T.moreInfo}</summary><p>${about}</p></details>`}</div>
      <div class="stepper">
        <button type="button" class="step-btn" aria-label=${T.remove(t.name)} disabled=${!(q > 0)} onClick=${() => set(t.id, q - 1)}><${Icon} n="minus" /></button>
        <output aria-label=${T.quantity(t.name)}><${Num} value=${q} /></output>
        <button type="button" class="step-btn plus" aria-label=${T.add(t.name)} disabled=${(t.kind === "add_on" && wanted === 0) || q >= Math.min(t.maxQuantity, left(t) ?? Infinity, limited ?? Infinity, t.pass ? passLeft - (wanted - q) : Infinity)} onClick=${() => set(t.id, q + 1)}><${Icon} n="plus" /></button>
      </div></div>`;
  };
  // Run 97: a coupon goes into the promo code, checked by the server like a typed one.
  const applyCoupon = (code) => { setPromoError(null); setPromoInput(code); setPromo(code); setPromoOpen(true); };
  const couponsBlock = coupons.length > 0 && html`<section class="coupons" aria-labelledby="coupons-title">
    <h3 id="coupons-title" class="coupons-title"><${Icon} n="tag" />${T.coupons.title}</h3>
    <ul class="coupon-list">${coupons.map((c) => {
      const on = promo === c.code;
      // Run 99: a coupon kept off presale prices says so while a presale is on.
      const meta = [c.endsAt && T.coupons.until(dayLong(c.endsAt, tz)), Number.isInteger(c.remaining) && T.coupons.left(c.remaining),
        c.excludesPresales && presaleDeal && T.coupons.notPresale].filter(Boolean).join(" · ");
      return html`<li class=${`coupon${on ? " is-on" : ""}`}>
        <p class="coupon-value"><strong>−${couponValue(c)}</strong><span>${T.coupons.off}</span></p>
        <div class="coupon-body" id=${`coupon-${c.code}`}>
          <p class="coupon-label">${c.label ?? T.coupons.generic}</p>
          ${meta && html`<p class="coupon-meta">${meta}</p>`}
          <p class="coupon-code"><code>${c.code}</code></p>
        </div>
        <button type="button" class=${`coupon-btn${on ? " is-on" : ""}`} aria-pressed=${on ? "true" : "false"} aria-describedby=${`coupon-${c.code}`} onClick=${() => applyCoupon(c.code)}>
          ${on ? html`<${Icon} n="check" />${T.coupons.applied}` : T.coupons.apply}</button>
      </li>`;
    })}</ul>
  </section>`;

  const reserve = async () => {
    setBusy(true); setError(null);
    try {
      const r = await call(`/holds`, { method: "POST", body: { sessionId, items, ...(promo ? { promoCode: promo } : {}), ...(presale ? { presaleCode: presale.code } : {}) } });
      setHold({ ...r.hold, expiresAtMs: Date.parse(r.hold.expiresAt), startedAtMs: Date.now() });
      scrollTo({ top: 0, behavior: reduced() ? "auto" : "smooth" });
    } catch (e) {
      if (e.code === "promo_code_invalid") { setPromoError(e.details?.reason ?? "unknown"); setPromo(null); }
      else setError(e);
      if (e.code === "sold_out" || e.code === "add_on_sold_out" || e.code === "ticket_type_sold_out" || e.code === "session_not_available") load();
    }
    finally { setBusy(false); }
  };
  const applyPromo = (e) => { e.preventDefault(); setPromoError(null); setPromo(promoInput.trim() ? promoInput.trim().toUpperCase() : null); };
  const release = async (h) => {
    try { await call(`/holds/${h.id}`, { method: "DELETE", headers: { "x-alkao-hold-token": h.token } }); } catch {}
  };
  const checkout = async (h, who) => {
    const shop = config.publicUrl ?? location.origin;
    const r = await call(`/holds/${h.id}/checkout`, {
      method: "POST",
      headers: { "x-alkao-hold-token": h.token },
      body: {
        buyer: { email: who.email.trim(), fullName: who.fullName.trim() || null, phone: who.phone.trim() || null, language: LANG },
        successUrl: `${shop}/acheter/merci/${route.c}/${route.b}/${h.id}`,
        cancelUrl: `${shop}/acheter/${route.c}/${route.b}/${route.eventId}${DOOR ? "?porte=1" : ""}#annule=${h.id}`,
        ...(ATTRIBUTION ? { attribution: ATTRIBUTION } : {}),
      },
    });
    save(h.id, { orderId: r.order.id, token: r.order.token, holdToken: h.token, buyer: who, door: DOOR });
    if (r.checkoutUrl) location.assign(r.checkoutUrl);
    else location.assign(`/billets#${new URLSearchParams({ c: route.c, b: route.b, o: r.order.id, k: r.order.token, ...(DOOR ? { porte: "1" } : {}) })}`);
  };
  const pay = async (e) => {
    e.preventDefault(); setBusy(true); setError(null);
    try { await checkout(hold, buyer); } catch (err) { setError(err); setBusy(false); }
  };
  // Run 90: share the page (never the door-sale or campaign address).
  const share = async () => {
    const url = `${config.publicUrl ?? location.origin}${location.pathname}`;
    if (navigator.share) {
      try { await navigator.share({ title: ev.title, url }); return; } catch (e) { if (e?.name === "AbortError") return; }
    }
    try { await navigator.clipboard.writeText(url); showToast(T.linkCopied); } catch { showToast(T.copyFailed); }
  };
  const closeZoom = () => { const back = zoom?.back ?? zoomButton.current; setZoom(false); requestAnimationFrame(() => back?.focus()); };
  // Run 93: the hero's photo alone, or the gallery from the photo chosen.
  const gallery = (ev.page?.gallery ?? []).filter((g) => https(g.url)).map((g) => ({ url: g.url, alt: g.alt ?? "" }));
  const openGallery = (i, el) => setZoom({ photos: gallery.map((g) => ({ src: g.url, alt: g.alt || ev.title })), start: i, back: el });
  const book = () => {
    document.getElementById("billets")?.scrollIntoView({ behavior: reduced() ? "auto" : "smooth", block: "start" });
    document.getElementById("panel-title")?.focus({ preventScroll: true });
  };

  if (notice) {
    const resume = async () => { setBusy(true); try { await checkout({ id: notice.holdId, token: notice.holdToken }, notice.buyer); } catch (e) { setError(e); setNotice(null); setBusy(false); } };
    const drop = async () => { setBusy(true); await release({ id: notice.holdId, token: notice.holdToken }); sessionStorage.removeItem(STORE(notice.holdId)); setNotice(null); setBusy(false); load(); };
    return html`<${Top} brand=${ev.brand} /><main class="wrap narrow state-page">
      <div class="card state">
        <span class="state-ico" aria-hidden="true"><${Icon} n="clock" /></span>
        <h1>${ev.title}</h1>
        <div class="alert" role="status">${T.notFinished}</div>
        ${error && html`<div class="alert bad" role="alert">${errText(error)}</div>`}
        <div class="actions"><button type="button" class="cta" disabled=${busy} onClick=${resume}>${T.resume}</button>
          <button type="button" class="btn-ghost" disabled=${busy} onClick=${drop}>${T.release}</button></div>
      </div>
    </main><${Footer} />`;
  }

  // Checkout: the buyer's details next to the order, with the hold's real countdown.
  if (hold) {
    const q = hold.quote;
    return html`<${Top} brand=${ev.brand} extra=${doorBadge} />
    <main class="wrap checkout">
      <div class="co-head">
        <ol class="progress" aria-label=${T.stepsLabel}>
          <li class="done"><${Icon} n="check" />${T.stepTickets}</li>
          <li aria-current="step"><span class="dot" aria-hidden="true"></span>${T.stepDetails}</li>
          <li><span class="dot" aria-hidden="true"></span>${T.stepPay}</li>
        </ol>
        <h1 class="co-title">${ev.title}</h1>
      </div>
      <div class="co-grid">
        <section class="card co-form" aria-labelledby="step3-title">
          <h2 id="step3-title" class="step-title">${stepNo(3)}${T.step3}</h2>
          <${HoldTimer} until=${hold.expiresAtMs} start=${hold.startedAtMs} onExpire=${() => { setHold(null); setError(new ApiError(409, "hold_not_active")); load(); }} />
          ${error && html`<div class="alert bad" role="alert">${errText(error)}</div>`}
          <form class="buyer-form" onSubmit=${pay}>
            <label>${T.email}<input type="email" required autocomplete="email" value=${buyer.email} onInput=${(e) => setBuyer({ ...buyer, email: e.target.value })} /></label>
            <div class="two">
              <label>${T.name}<input required autocomplete="name" value=${buyer.fullName} onInput=${(e) => setBuyer({ ...buyer, fullName: e.target.value })} /></label>
              <label>${T.phone}<input type="tel" autocomplete="tel" value=${buyer.phone} onInput=${(e) => setBuyer({ ...buyer, phone: e.target.value })} /></label>
            </div>
            <${Policy} brand=${ev.brand} id="policy-title" />
            <button type="submit" class="cta wide" disabled=${busy}>${busy && html`<span class="spin" aria-hidden="true"></span>`}${q.totalCents === 0 ? T.getFree : T.pay(money(q.totalCents))}</button>
            ${q.totalCents > 0 && html`<p class="secure"><${Icon} n="lock" />${T.stripe}</p>`}
            <button type="button" class="link-btn change" disabled=${busy} onClick=${async () => { await release(hold); setHold(null); load(); }}><${Icon} n="left" />${T.change}</button>
          </form>
        </section>
        <aside class="card co-sum" aria-labelledby="sum-title">
          <h2 id="sum-title">${T.summaryTitle}</h2>
          <div class="sum-ev">
            <img class="sum-thumb" src=${photo} alt="" width="88" height="66" onError=${hideBroken} />
            <div>
              <p class="sum-name">${ev.title}</p>
              <p class="sum-line"><${Icon} n="calendar" />${whenFr(session?.startsAt ?? hold.quote?.startsAt ?? Date.now(), tz)}</p>
              ${ev.venue?.name && html`<p class="sum-line"><${Icon} n="pin" />${[ev.venue.name, ev.venue.city].filter(Boolean).join(", ")}</p>`}
            </div>
          </div>
          <table class="quote"><caption class="sr-only">${T.priceDetail}</caption><tbody>
            ${q.lines.map((l) => html`<tr><td>${l.quantity} × ${l.name}</td><td class="num">${money(l.lineTotalCents)}</td></tr>`)}
            ${q.discountCents > 0 && html`<tr class="discount"><td>${T.promo.discount(q.promoCode)}</td><td class="num">−${money(q.discountCents)}</td></tr>`}
            ${(q.taxes ?? []).map((t) => html`<tr class="tax"><td>${t.code === "GST" ? T.gst : t.code === "QST" ? T.qst : t.labelFr}</td><td class="num">${money(t.amountCents)}</td></tr>`)}
            <tr class="total"><td>${T.total}</td><td class="num">${money(q.totalCents)}</td></tr></tbody></table>
          <p class="fine">${T.taxesNote}</p>
        </aside>
      </div>
    </main><${Footer} />`;
  }

  const promoBlock = html`<div class="promo">
    ${!(promoOpen || promo || promoError) ? html`<button type="button" class="link-btn" aria-expanded="false" onClick=${() => setPromoOpen(true)}><${Icon} n="tag" />${T.promo.toggle}</button>` : html`
      <form class="promo-form" onSubmit=${applyPromo}>
        <label for="promo-code">${T.promo.label}</label>
        <div class="promo-row">
          <input id="promo-code" ref=${promoField} value=${promoInput} autocomplete="off" autocapitalize="characters" spellcheck="false" onInput=${(e) => setPromoInput(e.target.value)} />
          <button type="submit" class="btn-ghost">${T.promo.apply}</button>
        </div>
        ${promo && html`<p class="promo-ok"><${Icon} n="check" /><span>${T.promo.applied(promo)}${offer ? html` · <strong>${T.promo.offer(offer)}</strong>` : ""}</span>
          <button type="button" class="link-btn" onClick=${() => { setPromo(null); setPromoInput(""); setPromoError(null); }}>${T.promo.remove}</button></p>`}
        ${promoError && html`<div class="alert" role="alert">${T.promo[promoError] ?? T.promo.unknown}</div>`}
      </form>`}
  </div>`;

  const quoteBox = html`<div class="quote-box" aria-live="polite">${quote && html`
    <table class="quote"><caption class="sr-only">${T.priceDetail}</caption><tbody>
      ${quote.lines.map((l) => html`<tr><td>${l.quantity} × ${l.name}</td><td class="num">${money(l.lineTotalCents)}</td></tr>`)}
      ${quote.discountCents > 0 && html`<tr class="discount"><td>${T.promo.discount(quote.promoCode)}</td><td class="num">−${money(quote.discountCents)}</td></tr>`}
      ${quote.taxes.length > 0 && html`<tr class="sub"><td>${T.beforeTax}</td><td class="num">${money(quote.subtotalCents - quote.discountCents)}</td></tr>`}
      ${quote.taxes.map((t) => html`<tr class="tax"><td>${t.code === "GST" ? T.gst : t.code === "QST" ? T.qst : t.labelFr}</td><td class="num">${money(t.amountCents)}</td></tr>`)}
      <tr class="total"><td>${T.total}</td><td class="num">${money(quote.totalCents)}</td></tr>
    </tbody></table>
    <p class="fine">${T.taxesNote}</p>`}</div>`;

  const ready = !busy && !!quote && violations.length === 0 && !tooMany;
  const buybar = html`<div class="buybar">
    <div class="bar-sum">
      ${quote ? html`<span class="bar-label">${T.total}</span><span class="bar-amt"><${Money} cents=${quote.totalCents} /></span><span class="bar-note">${T.tickets(wanted)} · ${T.taxesIn}</span>`
        : html`<span class="bar-label">${from ? T.from : T.ticketsTitle}</span><span class="bar-amt">${from ? (from.free ? T.free : money(from.cents)) : ""}</span><span class="bar-note">${sessionId ? T.pickTickets : T.pickDate}</span>`}
    </div>
    ${!sessionId && html`<a class="cta only-narrow" href="#billets">${T.seeTickets}</a>`}
    <button type="button" class=${`cta${sessionId ? "" : " only-wide"}`} disabled=${!ready} onClick=${reserve}>${busy && html`<span class="spin" aria-hidden="true"></span>`}${quote ? T.continueWith(money(quote.totalCents)) : T.next}<${Icon} n="arrow" /></button>
  </div>`;

  const panel = html`<div class="panel">
    <div class="panel-head">
      <h2 id="panel-title" tabindex="-1">${T.ticketsTitle}</h2>
      ${from && html`<p class="panel-from">${from.free ? T.free : html`${T.from} <strong>${money(from.cents)}</strong>`}</p>`}
    </div>
    <div class="panel-body">
      ${error && html`<div class="alert bad" role="alert">${errText(error)}</div>`}
      ${(closed || early) && html`<${SaleWindow} closed=${closed} opensAt=${ev.salesOpenAt} tz=${tz} eventId=${route.eventId} presale=${presale} onPresale=${setPresale} />`}
      ${canBuy && presale && html`<div class="alert ok" role="status">${T.presaleOpenNow}</div>`}
      ${canBuy && couponsBlock}
      ${canBuy && passTypes.length > 0 && dayTypes.length > 0 && sessions.length > 0 && html`<div class="mode-switch" role="group" aria-label=${T.pass.modes}>
        <button type="button" aria-pressed=${passMode ? "false" : "true"} onClick=${() => pickMode("day")}>${T.pass.day}</button>
        <button type="button" aria-pressed=${passMode ? "true" : "false"} onClick=${() => pickMode("pass")}>${T.pass.pass}</button>
      </div>`}
      ${canBuy && html`
        <div class="step">
          <h3 class="step-title">${stepNo(1)}${passMode ? T.pass.dates : T.step1}</h3>
          ${sessions.length === 0 ? html`<p class="step-hint">${DOOR ? T.noSessionsToday : T.noSessions}</p>`
            : passMode ? html`<${PassDates} sessions=${sessions} tz=${tz} left=${passLeft} />`
            : DOOR ? html`<${TimeSlots} sessions=${sessions} tz=${tz} value=${sessionId} onPick=${setSessionId} />`
            : html`<${SessionCalendar} sessions=${sessions} tz=${tz} value=${sessionId} onPick=${setSessionId} />`}
          ${!DOOR && !passMode && sessions.some((s) => s.available === 0) && html`<${Waitlist} sessions=${sessions.filter((s) => s.available === 0)} tz=${tz} onFree=${load} />`}
        </div>
        ${sessions.length > 0 && html`<div class=${`step${sessionId ? "" : " is-idle"}`}>
          <h3 class="step-title">${stepNo(2)}${T.step2}</h3>
          ${!sessionId ? html`<p class="step-hint">${T.pickDateFirst}</p>` : html`<div class="step-in" key=${sessionId}>
            <div class="types">${admissions.map(typeRow)}</div>
            ${addOns.length > 0 && !passMode && html`<section class="options" aria-labelledby="options-title">
              <h4 id="options-title">${T.optionsTitle}</h4>
              ${wanted === 0 && html`<p class="muted">${T.optionsHint}</p>`}
              <div class="types">${addOns.map(typeRow)}</div>
            </section>`}
            ${violations.length > 0 && html`<div class="alert" role="alert"><ul class="violations">${violations.map((v) => html`<li>${violationText(v, data.ticketTypes)}</li>`)}</ul></div>`}
            ${tooMany && html`<div class="alert" role="alert">${T.errors.sold_out}</div>`}
            ${promoBlock}
            ${quoteBox}
          </div>`}
        </div>`}`}
    </div>
    ${canBuy && sessions.length > 0 && buybar}
  </div>`;

  // Run 93: a tab for each section the page has.
  const tabs = [
    (ev.page?.highlights ?? []).length > 0 && ["points-forts", T.tabs.highlights],
    gallery.length > 0 && ["galerie", T.tabs.gallery],
    (ev.page?.steps ?? []).length > 0 && ["le-jour-j", T.tabs.steps],
    (ev.description?.trim() || ev.page?.notice) && ["description", T.tabs.about],
    ev.venue?.name && ["lieu", T.tabs.venue],
    ["faq", T.tabs.faq],
  ].filter(Boolean);
  return html`<${Top} brand=${ev.brand} extra=${doorBadge} />
  <main class=${`event-main${canBuy && sessions.length > 0 ? " with-bar" : ""}`}>
    <${Hero} ev=${ev} src=${photo} own=${photo === own} onBroken=${(e) => (photo === own ? setPhotoBroken(true) : hideBroken(e))}
      sessions=${sessions} address=${address} from=${from} presale=${presaleDeal} compact=${DOOR}
      pass=${passOffer} onPass=${() => { if (!passMode) pickMode("pass"); book(); }} now=${clock}
      zoomRef=${zoomButton} onZoom=${() => setZoom({ photos: [{ src: photo, alt: ev.title }], start: 0 })} onBook=${book} />
    <div class="wrap layout">
      <section class="side" id="billets" aria-labelledby="panel-title">${panel}</section>
      <div class="content">
        ${!DOOR && html`<${SectionTabs} items=${tabs} onShare=${share} />`}
        ${!DOOR && html`<${Highlights} items=${ev.page?.highlights ?? []} />`}
        ${!DOOR && html`<${Gallery} photos=${gallery} onOpen=${openGallery} />`}
        ${!DOOR && html`<${Steps} steps=${ev.page?.steps ?? []} />`}
        <${About} text=${ev.description} notice=${ev.page?.notice} />
        <${Facts} ev=${ev} />
        <${Venue} venue=${ev.venue} address=${address} />
        ${!DOOR && html`<${Faq} ev=${ev} />`}
        <${Policy} brand=${ev.brand} id="policy-event" level=${2} />
        <${Organizer} brand=${ev.brand} />
      </div>
    </div>
    ${!DOOR && others.length > 0 && html`<div class="wrap"><${OtherEvents} brandName=${listing?.brand?.name ?? ev.brand?.name} events=${others} /></div>`}
    ${!DOOR && html`<div class="wrap"><${FindTickets} /></div>`}
  </main>
  <${Footer} />
  ${zoom && html`<${Lightbox} photos=${zoom.photos} start=${zoom.start} onClose=${closeZoom} />`}
  <${Toast} msg=${toast} />`;
}

// ── Run 72: before the public sale: when it opens, and a presale code ──
function SaleWindow({ closed, opensAt, tz, eventId, presale, onPresale }) {
  const [code, setCode] = useState("");
  const [state, setState] = useState(null);
  const check = async (e) => {
    e.preventDefault();
    setState("busy");
    try {
      const r = await call(`/events/${eventId}/presale`, { method: "POST", body: { code: code.trim() } });
      setState(null);
      onPresale({ code: code.trim(), opensAt: r.presale.opensAt });
    } catch (err) { setState({ error: err }); }
  };
  if (closed) return html`<div class="notice-box" role="status"><span class="tile" aria-hidden="true"><${Icon} n="info" /></span><p>${T.salesClosed}</p></div>`;
  return html`<section class="sale-window" aria-labelledby="sale-title">
    <div class="notice-box"><span class="tile" aria-hidden="true"><${Icon} n="calendar" /></span><h3 id="sale-title">${T.salesOpen(whenFr(opensAt, tz))}</h3></div>
    ${presale ? html`<div class="alert ok" role="status">${T.presaleLater(whenFr(presale.opensAt, tz))}</div>` : html`
      <form class="presale" onSubmit=${check}>
        <h4>${T.presaleTitle}</h4>
        <label>${T.presaleCode}<input required maxlength="40" autocomplete="off" autocapitalize="characters" value=${code} onInput=${(e) => setCode(e.target.value)} /></label>
        <button type="submit" class="btn-ghost" disabled=${state === "busy"}>${T.presaleCheck}</button>
      </form>`}
    ${state?.error && html`<div class="alert bad" role="alert">${errText(state.error)}</div>`}
  </section>`;
}

// ── Run 71: a sold-out session's waitlist: one e-mail when seats come back ──
function Waitlist({ sessions, tz, onFree }) {
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  const [email, setEmail] = useState("");
  const [state, setState] = useState(null);
  const [open, setOpen] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setState("busy");
    try {
      await call(`/sessions/${sessionId}/waitlist`, { method: "POST", body: { email: email.trim(), language: LANG === "en" ? "en" : "fr" } });
      setState("sent");
    } catch (err) {
      if (err.code === "session_not_full") { setState("free"); onFree(); } else setState({ error: err });
    }
  };
  // Run 90: folded under its title until the buyer asks for it.
  return html`<section class=${`waitlist${open ? " open" : ""}`} aria-labelledby="wait-title">
    <h4 id="wait-title"><button type="button" class="wait-toggle" aria-expanded=${open ? "true" : "false"} aria-controls="wait-body" onClick=${() => setOpen(!open)}>${T.waitTitle}<${Icon} n="right" cls="i chev" /></button></h4>
    <div id="wait-body" class="wait-body" hidden=${!open}>
    ${state === "sent" ? html`<div class="alert ok" role="status">${T.waitDone}</div>` : html`
      <p class="muted">${T.waitLead}</p>
      <form onSubmit=${submit}>
        ${sessions.length > 1 && html`<label>${T.waitSession}<select value=${sessionId} onChange=${(e) => setSessionId(e.target.value)}>
          ${sessions.map((s) => html`<option value=${s.id}>${whenFr(s.startsAt, tz)}</option>`)}</select></label>`}
        <label>${T.waitEmail}<input type="email" required autocomplete="email" value=${email} onInput=${(e) => setEmail(e.target.value)} /></label>
        <button type="submit" class="btn-ghost" disabled=${state === "busy"}>${T.waitSend}</button>
      </form>`}
    </div>
    ${state === "free" && html`<div class="alert" role="status">${T.waitFree}</div>`}
    ${state?.error && html`<div class="alert bad" role="alert">${errText(state.error)}</div>`}
  </section>`;
}

// ── Run 27: lost the email? The tickets are sent again to the same address ──
function FindTickets() {
  const [email, setEmail] = useState("");
  const [state, setState] = useState(null);
  const submit = async (e) => {
    e.preventDefault();
    setState("busy");
    try { await call(`/tickets/resend`, { method: "POST", body: { email: email.trim() } }); setState("sent"); }
    catch (err) { setState({ error: err }); }
  };
  return html`<section class="find" aria-labelledby="find-title">
    <span class="tile" aria-hidden="true"><${Icon} n="ticket" /></span>
    <div class="find-text"><h2 id="find-title">${T.findTitle}</h2><p class="muted">${T.findLead}</p></div>
    ${state === "sent" ? html`<div class="alert ok" role="status">${T.findSent}</div>` : html`
      <form class="find-form" onSubmit=${submit}>
        <label>${T.findEmail}<input type="email" required autocomplete="email" value=${email} onInput=${(e) => setEmail(e.target.value)} /></label>
        <button type="submit" class="btn-ghost" disabled=${state === "busy"}>${T.findSend}</button>
      </form>`}
    ${state?.error && html`<div class="alert bad" role="alert">${errText(state.error)}</div>`}
  </section>`;
}

// ── Brand: published events ─────────────────────────────────────────────────
function EventList() {
  const [state, setState] = useState(null);
  useEffect(() => {
    call(`/events`).then(async (d) => {
      applyLook(d.brand);
      const ids = d.events.slice(0, 48).map((e) => e.id);
      const sums = Object.fromEntries(await Promise.all(ids.map((id) => summary(id).then((s) => [id, s]))));
      setState({ events: byNextDate(d.events, sums), brand: d.brand, sums });
    }, (e) => setState({ error: e }));
  }, []);
  if (!state) return html`<main class="wrap list-main" aria-busy="true"><p class="boot sr-only" role="status">${T.loading}</p>
    <ul class="grid" aria-hidden="true">${[0, 1, 2].map(() => html`<li><span class="ev-card sk-card"><span class="ev-media sk"></span><span class="ev-body"><span class="sk w60"></span><span class="sk w40"></span></span></span></li>`)}</ul></main>`;
  if (state.error) return html`<main class="wrap narrow state-page"><div class="card state"><div class="alert bad" role="alert">${errText(state.error)}</div></div></main>`;
  const n = state.events.length;
  return html`<${Top} brand=${state.brand} /><main class="wrap list-main">
    <header class="list-head">
      <p class="eyebrow">${T.shop}</p>
      <h1>${state.brand?.name ?? T.shop}</h1>
      ${n > 0 && html`<p class="muted">${T.onSale(n)}</p>`}
    </header>
    ${n === 0 ? html`<div class="card state"><span class="state-ico" aria-hidden="true"><${Icon} n="calendar" /></span><p>${T.noEvents}</p></div>`
      : html`<ul class="grid">${state.events.map((e) => html`<li><${EventCard} e=${e} sum=${state.sums[e.id]} level=${2} /></li>`)}</ul>`}
    <${FindTickets} />
  </main><${Footer} />`;
}

// ── Back from Stripe ────────────────────────────────────────────────────────
function Thanks() {
  const s = saved(route.holdId);
  useEffect(() => {
    if (s) location.replace(`/billets#${new URLSearchParams({ c: route.c, b: route.b, o: s.orderId, k: s.token, ...(s.door ? { porte: "1" } : {}) })}`);
  }, []);
  if (s) return html`<main class="wrap narrow state-page"><div class="card state"><span class="spin big" aria-hidden="true"></span><p class="boot">${T.opening}</p></div></main>`;
  return html`<main class="wrap narrow state-page"><div class="card state">
    <span class="state-ico ok" aria-hidden="true"><${Icon} n="check" /></span>
    <h1>${T.thanks}</h1>
    <div class="alert ok" role="status">${T.confirming}</div>
  </div></main>`;
}

function App() {
  const [config, setConfig] = useState(null);
  useEffect(() => { fetch("/shop/config.json").then((r) => r.json()).then(setConfig, () => setConfig({})); }, []);
  if (!route) return html`<main class="wrap narrow state-page"><div class="card state"><div class="alert bad" role="alert">${T.badAddress}</div></div></main>`;
  if (!config) return html`<main><p class="boot">${T.loading}</p></main>`;
  // Run 32: with Stripe test keys, buyers are told that nothing will be charged.
  const testMode = config.paymentsMode === "test" && html`<header class="testmode"><p role="status">${T.testMode}</p></header>`;
  const page = route.page === "merci" ? html`<${Thanks} />` : route.page === "events" ? html`<${EventList} />` : html`<${EventShop} config=${config} />`;
  return html`${testMode}${page}`;
}

// The page's static "Chargement…" goes: pages render a band and a main side by side.
const root = document.getElementById("app");
root.replaceChildren();
render(html`<${App} />`, root);
