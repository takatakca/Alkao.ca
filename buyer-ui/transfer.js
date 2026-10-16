import qrcode from "/billets/vendor/qrcode.mjs";

// The recipient's one-use proof and later access token never appear in requests
// for static files, browser history queries, server query strings or logs.
const els = Object.fromEntries(["language","title","intro","message","accept","result","ticket-title",
"ticket-tip","qr","copy","copy-status","warning","offline"].map(id=>[id,document.getElementById(id)]));
const params = new URLSearchParams(location.hash.slice(1));
const validUuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value||"");
const proof = value => /^[A-Za-z0-9_-]{43}$/.test(value||"");
const scope = {c:params.get("c"),b:params.get("b"),r:params.get("r")};
let claim= params.get("k");
let access= params.get("a");
let busy=false;
let lang=(navigator.language||"fr").toLowerCase().startsWith("en")?"en":"fr";
const labels={
 fr:{title:"Recevoir mon billet",intro:"Vous avez reçu une invitation personnelle à recevoir un billet. Confirmez-la pour générer votre nouveau code QR.",
 checking:"Vérification du lien…",ready:"L'invitation est prête à être confirmée.",accept:"Confirmer et recevoir mon billet",
 working:"Confirmation sécurisée en cours…",failed:"Cette invitation n'est plus disponible. Vérifiez votre courriel ou communiquez avec l'organisateur.",
 offline:"Une connexion Internet est requise pour confirmer le transfert.",showing:"Votre code QR est prêt.",ticketTitle:"Votre billet",ticketTip:"Présentez ce code QR à l'entrée. Il est personnel.",
 warning:"Le lien d'invitation fonctionne une seule fois. Conservez le lien de votre billet après confirmation. Ne transmettez pas ce code à d'autres personnes.",
 copy:"Copier mon lien personnel",copied:"Lien personnel copié.",copyFail:"Copiez l'adresse de cette page pour conserver votre billet.",qrAlt:"Code QR de votre billet",switch:"English"},
 en:{title:"Receive my ticket",intro:"You received a personal invitation to receive a ticket. Confirm it to create your new QR code.",
 checking:"Checking the link…",ready:"The invitation is ready for confirmation.",accept:"Confirm and receive my ticket",
 working:"Confirming securely…",failed:"This invitation is no longer available. Check your email or contact the organizer.",
 offline:"An internet connection is required to confirm the transfer.",showing:"Your QR code is ready.",ticketTitle:"Your ticket",ticketTip:"Present this QR code at entry. It is personal.",
 warning:"The invitation link works only once. Keep your ticket link after confirmation. Do not share this code with anyone.",
 copy:"Copy my personal link",copied:"Personal link copied.",copyFail:"Copy this page's address to keep your ticket.",qrAlt:"Your ticket QR code",switch:"Français"}
};
const apiBase=`/v1/public/clients/${scope.c}/brands/${scope.b}/transfers/${scope.r}`;
function msg(key,failed=false){els.message.textContent=labels[lang][key];els.message.dataset.error=String(failed);}
function translate(){
 const l=labels[lang];document.documentElement.lang=lang==="fr"?"fr-CA":"en-CA";
 els.title.textContent=l.title;els.intro.textContent=l.intro;els.accept.textContent=l.accept;
 els["ticket-title"].textContent=l.ticketTitle;els["ticket-tip"].textContent=l.ticketTip;
 els.qr.alt=l.qrAlt;els.copy.textContent=l.copy;els.warning.textContent=l.warning;
 els.offline.textContent=l.offline;els.language.textContent=l.switch;els.language.setAttribute("aria-label",l.switch);
}
async function fetchTicket(){
 const response=await fetch(apiBase+"/ticket",{headers:{"x-alkao-transfer-token":access},cache:"no-store"});
 if(!response.ok)throw Error("not_available");
 const obj=await response.json();
 if(!obj.ticket||typeof obj.ticket.credential!=="string"||!obj.ticket.credential.startsWith("ALK1."))throw Error("invalid_ticket");
 const qr=qrcode(0,"M");qr.addData(obj.ticket.credential);qr.make();
 els.qr.src=qr.createDataURL(6,4);
 els.result.hidden=false;els.accept.hidden=true;msg("showing");
}
async function accept(){
 if(busy||!claim)return;
 busy=true;els.accept.disabled=true;msg("working");
 try{
  const response=await fetch(apiBase+"/claim",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({secret:claim}),cache:"no-store"});
  if(!response.ok)throw Error("not_available");
  const body=await response.json();const token=body?.transfer?.accessToken;
  if(!proof(token))throw Error("invalid_token");
  access=token;claim=null;
  // Swap single-use invitation proof for recipient-only ticket access after acceptance.
  history.replaceState(null,"",`#${new URLSearchParams({...scope,a:token}).toString()}`);
  await fetchTicket();
 }catch{msg("failed",true);els.accept.hidden=true;}
 finally{busy=false;els.accept.disabled=false;}
}
els.language.addEventListener("click",()=>{
 lang=lang==="fr"?"en":"fr";translate();
 if(els.result.hidden&&els.accept.hidden===false)msg("ready");
 else if(!els.result.hidden)msg("showing");
});
els.accept.addEventListener("click",()=>void accept());
els.copy.addEventListener("click",async()=>{
 try {await navigator.clipboard.writeText(location.href);els["copy-status"].textContent=labels[lang].copied;}
 catch {els["copy-status"].textContent=labels[lang].copyFail;}
});
translate();
if(!validUuid(scope.c)||!validUuid(scope.b)||!validUuid(scope.r)){
 msg("failed",true);
}else if(proof(access)){
 msg("checking");
 void fetchTicket().catch(()=>msg("failed",true));
}else if(proof(claim)){
 els.accept.hidden=false;msg("ready");
}else{
 msg("failed",true);
}
