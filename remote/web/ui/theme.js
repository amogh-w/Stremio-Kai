/* theme.js: load synchronously in <head> so the theme is set before first paint. Local only, no network. */
var FLAVORS=["latte","frappe","macchiato","mocha"],ACCENTS=["rosewater","flamingo","pink","mauve","red","peach","yellow","green","teal","sky","blue","lavender"];
var RADII={tight:.55,apple:1,soft:1.5};
var store={get:function(k){try{return localStorage.getItem(k)}catch(e){return null}},set:function(k,v){try{localStorage.setItem(k,v)}catch(e){}}};
var mq=matchMedia("(prefers-color-scheme: dark)");
function applyTheme(){
  var f=store.get("ui-flavor")||"auto",a=store.get("ui-accent")||"mauve",r=store.get("ui-radius")||"apple",h=document.documentElement;
  if(f!=="auto"&&FLAVORS.indexOf(f)<0)f="auto"; if(ACCENTS.indexOf(a)<0)a="mauve"; if(!RADII[r])r="apple";
  var fl=f==="auto"?(mq.matches?"mocha":"latte"):f;
  FLAVORS.forEach(function(x){h.classList.toggle(x,x===fl)});
  h.style.setProperty("--accent","var(--ctp-"+a+")"); h.style.setProperty("--r-scale",RADII[r]);
  document.querySelectorAll("[data-flavor]").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.flavor===f)});
  document.querySelectorAll("[data-accent]").forEach(function(b){b.classList.toggle("ring-2",b.dataset.accent===a)});
  document.querySelectorAll("[data-radius]").forEach(function(b){b.setAttribute("aria-pressed",b.dataset.radius===r)});
  document.querySelectorAll(".seg").forEach(function(s){s.dispatchEvent(new Event("sync"))});
}
applyTheme(); mq.addEventListener&&mq.addEventListener("change",applyTheme);
