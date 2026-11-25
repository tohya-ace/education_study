/* 背景イラストの上に直接のっている文字に class="ks-onbg" を付ける（白い文字にするため） */
(function(){
  function alphaOf(c){
    if(!c||c==='transparent') return 0;
    var m=/\/\s*([\d.]+%?)\s*\)$/.exec(c);              // color(srgb r g b / a) など
    if(m) return m[1].slice(-1)==='%'?parseFloat(m[1])/100:parseFloat(m[1]);
    m=/^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(c);  // rgba(r, g, b, a)
    if(m) return parseFloat(m[1]);
    return 1;
  }
  function opaqueBg(el){
    var cs=getComputedStyle(el);
    if(cs.backgroundImage&&cs.backgroundImage!=='none') return true;
    return alphaOf(cs.backgroundColor)>0.05;
  }
  function onBackground(el){
    // 表の見出し（caption）は表の外側に描かれるので、表の背景は見ない
    if(el.closest&&el.closest('caption')){ var t=el.closest('table'); el=t&&t.parentElement||el; }
    for(var e=el;e&&e!==document.body&&e!==document.documentElement;e=e.parentElement){
      if(e.tagName==='DIALOG') return false;
      if(opaqueBg(e)) return false;
    }
    return true;
  }
  function hasOwnText(el){
    for(var n=el.firstChild;n;n=n.nextSibling){ if(n.nodeType===3&&n.nodeValue.trim()) return true; }
    return false;
  }
  var pending=false;
  function scan(){
    pending=false;
    var all=document.body?document.body.getElementsByTagName('*'):[];
    for(var i=0;i<all.length;i++){
      var el=all[i];
      if(/^(SCRIPT|STYLE|SVG|PATH|RT|RP)$/i.test(el.tagName)) continue;
      if(hasOwnText(el)){
        if(onBackground(el)) el.classList.add('ks-onbg'); else el.classList.remove('ks-onbg');
      }
    }
  }
  function queue(){ if(!pending){ pending=true; requestAnimationFrame(scan); } }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',queue); else queue();
  window.addEventListener('load',queue);
  document.addEventListener('transitionend',queue,true);
  new MutationObserver(queue).observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','open']});
})();
