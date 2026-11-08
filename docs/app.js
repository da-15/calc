/* 式が見える電卓：画面の操作
   計算の仕組みと入力ルールは calc.js（Calc）にある。ここは状態の管理・表示・タップやキーの操作を受け持つ。
   式の中で過去の答えは「[行ID]」という参照として持ち、行を編集すると、その答えを参照している行を上から順に計算し直す。 */

/* ---- 調整用の数値 ---- */
const CONFIG = {
  LIMIT: 200,               // 履歴を残す件数
  HOLD_MS: 500,             // 長押しとみなすまでの時間（ミリ秒）
  HOLD_MOVE: 10,            // 長押し中にこれ以上指が動いたら取り消す（px）
  FS_DEFAULT: 20,           // 履歴と入力欄の文字の大きさ（px）
  FS_MIN: 14, FS_MAX: 32,   // ピンチで変えられる範囲（px）
  DRAG_START: 10,           // テンキーのドラッグを始めるまでの縦の移動（px）
  DRAG_CANCEL: 14,          // ドラッグを始める前にこれ以上横や逆向きに動いたら、ドラッグにしない（px）
  DRAG_TOGGLE: 0.35,        // テンキーの高さのこの割合以上動かして離したら、出す・隠すを切り替える
  DRAG_FLICK: 0.5,          // これより速く払ったら（px/ミリ秒）、動かした量にかかわらず切り替える
  DRAG_ANIM_MS: 200,        // 指を離したあとの、テンキーが動き切るまでの時間
  BLOCK_AFTER_DRAG: 350,    // テンキーのドラッグ直後、タップを無視する時間
  BLOCK_AFTER_PINCH: 400,   // ピンチ直後、タップを無視する時間
};
// 端末に保存するときの名前
const STORE = "calc-history-v2", FS_KEY = "calc-font-size";

const { OPS, isDigit, endsOperand, opens, complete, clean, fmt, plain, numLit, exprTokens, applyKey, joinRight, cleanPaste } = Calc;
let expr = "";          // 入力中の式
let pos = 0;            // カーソル位置
let sel = null;         // 選択中の数字 {a,b}
let done = false;       // ＝を押した直後か
let lastId = null;      // 直前に確定した行
let history = [];       // {id, e:式, v:答え}
let nextId = 1;
let editing = null;     // 編集中の行のID
let copying = null;     // 長押しでコピーのボタンを出している行のID
let pasting = false;    // 長押しで貼り付けのボタンを出しているか
let note = "";          // 式の段に出しているエラーのメッセージ
let historyDirty = true;   // 履歴の表示を描き直す必要があるか
let scrollToEnd = true;    // 新しい行が増えたときだけ、履歴をいちばん下まで送る
const flash = new Set();   // 再計算で答えが変わった行

const $ = id => document.getElementById(id);
const el = { history:$("history"), expr:$("expr"), exprText:$("exprText"), result:$("result"), label:$("exprLabel"),
  parenInfo:$("parenInfo"), editBar:$("editBar"), copyBar:$("copyBar"), pasteBar:$("pasteBar"), modal:$("modal"), keyarea:$("keyarea"), keysWrap:$("keysWrap"), grip:$("grip") };
const byId = id => history.find(h=>h.id===id);
const idxOf = id => history.findIndex(h=>h.id===id);

/* ---- 保存（この端末のブラウザ内） ---- */
function save(){ try{ localStorage.setItem(STORE, JSON.stringify({nextId, history})); }catch(e){} }
function load(){
  try{
    const d=JSON.parse(localStorage.getItem(STORE)||"null");
    if(d && Array.isArray(d.history)){
      history=d.history.filter(x=>x&&typeof x.e==="string"&&Number.isInteger(x.id));
      nextId=Math.max(d.nextId|0, 1, ...history.map(h=>h.id+1));
    }
  }catch(e){}
  recalc(false);
  // 上限を超えていたら古い行から消す（参照している式は数字に置き換える）
  if(history.length>CONFIG.LIMIT){ while(history.length>CONFIG.LIMIT) removeRow(history[0].id); save(); }
}

/* ---- 計算：参照 [行ID] を履歴の答えに置き換えて計算する ---- */
function refValue(id){
  const h=byId(id);
  if(!h) throw "参照先がありません。";
  if(!isFinite(h.v)) throw "参照先がエラーです。";
  return h.v;
}
const evaluate = s => Calc.evaluate(s, refValue);

/* ---- 履歴の再計算・追加・削除 ---- */
function recalc(mark){
  for(const h of history){
    const old=h.v; let v;
    try{ v=evaluate(h.e); }catch(e){ v=NaN; }
    h.v = isFinite(v) ? v : NaN;
    if(mark && !Object.is(old,h.v)) flash.add(h.id);
  }
  historyDirty=true;
}
// 消える行を参照している式は、その時点の数字に置き換える
function freeze(id){
  const h=byId(id); if(!h||!isFinite(h.v)) return;
  const lit=numLit(h.v), tag="["+id+"]";
  for(const x of history) if(x.id!==id) x.e=x.e.split(tag).join(lit);
  if(expr.includes(tag)) setExpr(expr.split(tag).join(lit));
}
function removeRow(id){ freeze(id); const i=idxOf(id); if(i>=0) history.splice(i,1); historyDirty=true; }
function pushRow(e,v){
  const id=nextId++;
  history.push({id,e,v});
  while(history.length>CONFIG.LIMIT) removeRow(history[0].id);
  historyDirty=true; scrollToEnd=true;
  return id;
}

/* ---- 入力ルール（カーソル位置 pos、選択中の数字 sel） ---- */
function setExpr(v){ expr=v; pos=v.length; sel=null; }
// 選んでいるのが記号（演算子・括弧・%）か。数字と参照のときは false
const selIsSym = () => sel!==null && !/[0-9.[]/.test(expr[sel.a]);
// 位置 i の「−」が、引き算ではなく符号か（式の先頭や「(」の直後）
const isSignAt = i => expr[i]==="−" && (i===0 || expr[i-1]==="(");
function press(k){
  closeMenu();
  if(!el.modal.hidden) return;
  // 入力欄が空のときのACは、履歴をすべて消す確認を出す（行の編集中は除く）
  if(k==="C" && expr==="" && editing===null && history.length){ openModal(); return; }
  if(k==="=") return equals();
  if(k==="C"){ setExpr(""); done=false; return render(); }
  if(done){
    // ＝の直後に演算子・%・±を押すと、直前の答えを参照して続ける
    if((OPS.includes(k)||k==="%"||k==="±") && expr==="" && byId(lastId)) setExpr("["+lastId+"]");
    done=false;
  }
  if(k==="±"){
    if(selIsSym()){
      if(isSignAt(sel.a)) return render();   // 符号の−を選んでいるときは何もしない
      // ほかの記号を選んでいるときは、直後のまとまりの符号を切り替える（12×5 の×なら 12×(−5)）
      const e=Calc.operandEnd(expr, sel.b);
      pos = e>0 ? e : sel.b; sel=null;
    }
    toggleSign(); return render();
  }
  let b, a;
  if(sel){
    // 選んだものは⌫で丸ごと消える。数字は数字キーで、演算子は演算子キーで置き換わる。
    // それ以外のキーは、選んだものの直後に入る。符号としての−（先頭や「(」の直後）は演算子に置き換えない
    const c=expr[sel.a], sym=selIsSym();
    const replace = k==="⌫" || (sym ? OPS.includes(c) && OPS.includes(k) && !isSignAt(sel.a) : isDigit(k)||k===".");
    b=expr.slice(0, replace ? sel.a : sel.b); a=expr.slice(sel.b); sel=null;
    if(k==="⌫"){ expr=b+a; pos=b.length; return render(); }
  } else { b=expr.slice(0,pos); a=expr.slice(pos); }
  // 00・000 は 0 を続けて打ったのと同じ
  const nb = k==="00"||k==="000" ? [...k].reduce((acc,c)=> acc===null ? null : applyKey(acc,a,c), b) : applyKey(b,a,k);
  if(nb!==null){ expr=nb+(k==="⌫"?"":joinRight(nb,a))+a; pos=nb.length; }
  render();
}
// ± ：選んでいる数字（なければカーソルの直前のまとまり）の符号を切り替える
function toggleSign(){ ({s:expr, pos, sel}=Calc.toggleSign(expr, pos, sel)); }
function equals(){
  sel=null;
  const s=complete(expr);
  if(!s) return;
  // 計算できなければ、理由を式の段に出す（次のタップかキーで消える）
  let v; try{ v=evaluate(s); }catch(e){ showNote(e); return; }
  if(!isFinite(v)){ showNote("桁が大きすぎます。"); return; }
  let id;
  if(editing!==null){
    const h=byId(editing); h.e=s; id=h.id; editing=null;
    recalc(true); flash.add(id);
  } else {
    id=pushRow(s,v);
  }
  save();
  setExpr(""); lastId=id; done=true;
  render();
}

/* ---- 行の編集 ---- */
function startEdit(id){ closeMenu(); editing=id; setExpr(byId(id).e); done=false; historyDirty=true; render(); }
function cancelEdit(){ editing=null; setExpr(""); done=false; historyDirty=true; render(); }
function deleteEditing(){
  const id=editing; editing=null; removeRow(id); recalc(true); save();
  setExpr(""); done=false; render();
}
// 過去の答えを参照として式に入れる（編集中は、その行より上の答えだけ）
function insertRef(id){
  closeMenu();
  done=false;
  let b,a;
  if(sel){ b=expr.slice(0, selIsSym() ? sel.b : sel.a); a=expr.slice(sel.b); sel=null; } else { b=expr.slice(0,pos); a=expr.slice(pos); }
  // 前後に記号がなければ「+」でつなぐ（答えを足していく使い方が多いため）
  const L=b.slice(-1);
  if(endsOperand(L)) b=(L==="." ? b.slice(0,-1) : b)+"+";
  b+="["+id+"]"; expr=b+(joinRight(b,a)?"+":"")+a; pos=b.length; render();
}

/* ---- 表示 ---- */
const esc = s => s.replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
function refHtml(id){ const h=byId(id); return `<span class="ref">${h&&isFinite(h.v)?fmt(h.v):"?"}</span>`; }
const pretty = s => esc(s).replace(/\[(\d+)\]/g,(m,id)=>refHtml(+id));
function liveExprHtml(){
  const cur='<span class="cur"></span>';
  let html = (!sel && pos===0) ? cur : "";
  for(const tk of exprTokens(expr)){
    const txt=expr.slice(tk.a,tk.b);
    const inner = tk.k==="ref" ? refHtml(+txt.slice(1,-1))
      : (!sel && pos>tk.a && pos<tk.b) ? esc(txt.slice(0,pos-tk.a))+cur+esc(txt.slice(pos-tk.a))
      : esc(txt);
    const on = sel && sel.a===tk.a && sel.b===tk.b;
    html+=`<span class="tok k-${tk.k}${on?" sel":""}" data-a="${tk.a}" data-b="${tk.b}">${inner}</span>`;
    if(!sel && pos===tk.b && pos>0) html+=cur;
  }
  return html;
}
// 履歴は、内容や編集状態が変わったときだけ描き直す
function renderHistory(){
  const editIdx = editing===null ? history.length : idxOf(editing);
  el.history.innerHTML=history.map((x,i)=>{
    const ans = !isFinite(x.v) ? `<span class="ans bad">エラー</span>`
      : i<editIdx ? `<button class="ans" data-id="${x.id}" aria-label="${fmt(x.v)} を式に入れる">${fmt(x.v)}</button>`
      : `<span class="ans off" data-id="${x.id}">${fmt(x.v)}</span>`;
    const cls = "row"+(x.id===editing?" editing":"")+(x.id===copying?" picked":"")+(flash.has(x.id)?" changed":"");
    return `<div class="${cls}" data-id="${x.id}"><button class="ex" aria-label="この行を編集">${pretty(x.e)}</button><span class="tail">=${ans}</span></div>`;
  }).join("");
  flash.clear();
  if(scrollToEnd){ el.history.scrollTop=el.history.scrollHeight; scrollToEnd=false; }
  el.label.textContent = editing===null ? "式" : "行を編集";
  el.label.parentNode.classList.toggle("editing", editing!==null);
  historyDirty=false;
}
// 式の段の右側：コピー・貼り付けのボタンを出している間は、ほかの表示を隠す。
// エラーのメッセージを出している間は、編集のボタンを隠してメッセージを優先する
function updateBars(){
  const menu = copying!==null || pasting;
  el.copyBar.hidden = copying===null;
  el.pasteBar.hidden = !pasting;
  el.editBar.hidden = editing===null || menu || note!=="";
  el.parenInfo.hidden = menu;
}
function updateInfo(){
  const full = editing===null && expr!=="" && history.length>=CONFIG.LIMIT;
  el.parenInfo.textContent = note || (full ? `上限${CONFIG.LIMIT}件です。確定すると最古の行が消えます。` : "");
  el.parenInfo.classList.toggle("warn", note!=="" || full);
  updateBars();
}
function render(){
  if(historyDirty) renderHistory();
  if(pos>expr.length||pos<0) pos=expr.length;
  const open=opens(expr);
  el.exprText.innerHTML = liveExprHtml() + `<span class="ghost">${")".repeat(Math.max(0,open))}</span>`;
  if(pos===expr.length) el.expr.scrollTop = el.expr.scrollHeight;
  updateInfo();
  // 途中の式でも答えを先に見せる
  const s=complete(expr);
  let v=null; if(s){ try{ v=evaluate(s); }catch(e){ v=e; } }
  // 計算できない式（途中・0で割るなど）なら空にする。理由は＝を押したときに出す
  el.result.textContent = typeof v==="number" && isFinite(v) ? "="+fmt(v) : "";
}

/* ---- 全消去の確認 ---- */
function openModal(){
  $("m-body").textContent=`${history.length}件の計算履歴が消えます。元には戻せません。`;
  el.modal.hidden=false; $("m-cancel").focus();
}
const closeModal = () => { el.modal.hidden=true; };
$("m-cancel").addEventListener("click",closeModal);
$("m-ok").addEventListener("click",()=>{ copying=null; pasting=false; history=[]; editing=null; historyDirty=true; save(); setExpr(""); done=false; closeModal(); render(); });
el.modal.addEventListener("click",e=>{ if(e.target===el.modal) closeModal(); });

/* ---- 操作 ---- */
el.history.addEventListener("click",e=>{
  const a=e.target.closest("button.ans"); if(a){ insertRef(+a.dataset.id); return; }
  const x=e.target.closest(".row"); if(x) startEdit(+x.dataset.id);
});
// 式をタップ：数字・参照・記号は選択、余白は先頭か末尾へ
el.expr.addEventListener("click",e=>{
  if(!el.modal.hidden) return;
  closeMenu();
  if(keysHidden) setKeys(false);    // 隠れているときに式をタップしたらテンキーを戻す
  done=false;
  const t=e.target.closest(".tok");
  if(t){
    const a=+t.dataset.a, b=+t.dataset.b;
    if(sel && sel.a===a && sel.b===b){ sel=null; pos=b; }   // 選んでいるものをもう一度タップしたら、その直後にカーソル
    else { sel={a,b}; pos=b; }
  } else {
    const r=el.exprText.querySelector(".tok")?.getBoundingClientRect();
    pos = (r && e.clientX<r.left && e.clientY<r.bottom) ? 0 : expr.length;
    sel=null;
  }
  render();
});
/* ---- 長押しでコピー・貼り付け ---- */
// iPhoneはタップの中でしかクリップボードを使えないので、長押しではボタンを出し、ボタンのタップでコピー・貼り付けする。
// 履歴の行の長押し：「式をコピー」「答えをコピー」、入力欄の長押し：「貼り付け」
let hold=null, skipClick=false;
function closeMenu(){
  if(copying===null && !pasting) return;
  copying=null; pasting=false;
  el.history.querySelector(".row.picked")?.classList.remove("picked");
  updateBars();
}
// エラーのメッセージ。次にどこかをタップするか、キーを押すと消える（タップした操作はそのまま行う）。
// 指が触れた瞬間に画面を変えると、iPhoneはそのタップを取り消してしまうので、タップが確定した時点で消す
function showNote(msg){ note=msg; updateInfo(); }
function clearNote(){ if(note){ note=""; updateInfo(); } }
document.addEventListener("click",clearNote,true);
document.addEventListener("keydown",clearNote,true);
// 式の参照は数字に置き換え、カンマなしで
const exprForCopy = e => e.replace(/\[(\d+)\]/g,(m,id)=>{ const h=byId(+id); return h&&isFinite(h.v) ? numLit(h.v) : "?"; });
function copyText(text){
  const failed=()=>showNote("コピーできませんでした。");
  const fallback=()=>{
    const ta=document.createElement("textarea");
    ta.value=text; ta.readOnly=true; ta.style.cssText="position:fixed;top:0;left:0;opacity:0;-webkit-user-select:text;user-select:text";
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0,text.length);
    let ok=false; try{ ok=document.execCommand("copy"); }catch(e){}
    ta.remove(); return ok;
  };
  if(navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(()=>{ if(!fallback()) failed(); });
  else if(!fallback()) failed();
}
function copyRow(kind){
  const h=byId(copying); closeMenu();
  if(!h) return;
  if(kind==="ans"){ if(isFinite(h.v)) copyText((h.v<0?"-":"")+plain(h.v)); }
  else copyText(exprForCopy(h.e));
}
function pasteText(text){
  const x=cleanPaste(text);
  if(x===null){ showNote("貼り付けできない内容です。"); return; }
  done=false;
  let b,a;
  if(sel){ b=expr.slice(0, selIsSym() ? sel.b : sel.a); a=expr.slice(sel.b); sel=null; } else { b=expr.slice(0,pos); a=expr.slice(pos); }
  // 式を途中に貼るときは、まとまりが崩れないよう括弧で囲む（数字1つや「10%」なら囲まない）
  const ins = /^[0-9.]+%?$/.test(x) || (b==="" && a==="") ? x : "("+x+")";
  const L=b.slice(-1), F=ins.charAt(0);
  if(((L===")"||L==="]"||L==="%") && (isDigit(F)||F==="."||F==="(")) || ((isDigit(L)||L===".") && F==="(")) b+="×";
  b+=ins; expr=b+joinRight(b,a)+a; pos=b.length;
  render();
}
// パソコンでは Ctrl+C（Macは⌘+C）で、入力欄で選んでいる数字、なければ入力中の式と答えをコピーする（入力欄が空なら何もしない）
document.addEventListener("copy",e=>{
  if(!el.modal.hidden) return;
  let t="";
  // 数字（参照）を選んでいるとき、または入力欄が数字1つだけのときは、その数字だけ。記号を選んでいるときは式全体
  const one = sel && !selIsSym() ? expr.slice(sel.a,sel.b) : /^−?([0-9.]+|\[\d+\])$/.test(expr) ? expr : null;
  if(one){
    let v=NaN; try{ v=evaluate(one); }catch(err){}
    if(isFinite(v)) t=(v<0?"-":"")+plain(v);
  } else if(expr){
    // 計算できる式なら「式=答え」でコピーする（閉じていない括弧は補う。末尾が演算子などなら式だけ）
    const full=expr+")".repeat(Math.max(0,opens(expr)));
    let v=NaN; try{ v=evaluate(full); }catch(err){}
    t = isFinite(v) ? exprForCopy(full)+"="+(v<0?"−":"")+plain(v) : exprForCopy(expr);
  }
  if(!t) return;
  e.clipboardData.setData("text/plain",t); e.preventDefault();
});
// パソコンでは Ctrl+V（Macは⌘+V）でも貼り付けられる。キーボードでの貼り付けは確認なしで読める
document.addEventListener("paste",e=>{
  if(!el.modal.hidden) return;
  const t=e.clipboardData?.getData("text/plain"); if(t==null) return;
  e.preventDefault(); closeMenu(); pasteText(t);
});
$("p-paste").addEventListener("click",()=>{
  closeMenu();
  if(!navigator.clipboard?.readText){ showNote("貼り付けできませんでした。"); return; }
  navigator.clipboard.readText().then(pasteText,()=>showNote("貼り付けできませんでした。"));
});
// ボタンが出ている間は、ボタン以外のどこをタップしても閉じるだけにする（タップした場所の操作はしない）
document.addEventListener("pointerdown",()=>{ skipClick=false; },true);
document.addEventListener("click",e=>{
  if(performance.now()<noClickUntil){ e.stopPropagation(); e.preventDefault(); return; }   // ドラッグやピンチの直後のクリックは無視する
  if(skipClick){ skipClick=false; e.stopPropagation(); e.preventDefault(); return; }   // 長押しした直後のクリックは無視する
  if((copying!==null||pasting) && !el.copyBar.contains(e.target) && !el.pasteBar.contains(e.target)){ closeMenu(); e.stopPropagation(); e.preventDefault(); }
},true);
$("c-expr").addEventListener("click",()=>copyRow("expr"));
$("c-ans").addEventListener("click",()=>copyRow("ans"));
const cancelHold = () => { if(hold){ clearTimeout(hold.timer); hold=null; } };
// 指を動かさずに押し続けたら（CONFIG.HOLD_MS）、onHold が返した関数を呼ぶ
function watchHold(target, onHold){
  target.addEventListener("pointerdown",e=>{
    cancelHold();
    const fire=onHold(e); if(!fire) return;
    hold={x:e.clientX, y:e.clientY, timer:setTimeout(()=>{ hold=null; closeMenu(); fire(); skipClick=true; updateBars(); },CONFIG.HOLD_MS)};
  });
  target.addEventListener("pointermove",e=>{ if(hold && Math.hypot(e.clientX-hold.x,e.clientY-hold.y)>CONFIG.HOLD_MOVE) cancelHold(); });
  for(const ev of ["pointerup","pointercancel"]) target.addEventListener(ev,cancelHold);
  target.addEventListener("scroll",cancelHold,{passive:true});
  target.addEventListener("touchend",e=>{ if(skipClick) e.preventDefault(); });   // 長押しのあとはタップ扱いにしない
  target.addEventListener("contextmenu",e=>e.preventDefault());   // Androidで長押ししたときのメニューを出さない
}
watchHold(el.history, e=>{
  const row=e.target.closest(".row"); if(!row) return null;
  const id=+row.dataset.id;
  return ()=>{ copying=id; el.history.querySelector(`.row[data-id="${id}"]`)?.classList.add("picked"); $("c-ans").disabled=!isFinite(byId(id)?.v); };
});
watchHold(el.expr, ()=>()=>{ pasting=true; });
// クリックやタップでボタンにフォーカスを移さない。
// フォーカスが残ると、キーボードを使ったときに枠線が出たり、スペースキーでそのボタンがもう一度押されたりするため。
// Tabキーで移動したときの枠線はそのまま出す
document.addEventListener("mousedown",e=>{ if(e.target.closest("button,[tabindex]")) e.preventDefault(); });
$("e-cancel").addEventListener("click",cancelEdit);
$("e-del").addEventListener("click",deleteEditing);
$("keys").addEventListener("click",e=>{ const b=e.target.closest("button"); if(b) press(b.dataset.k); });
document.addEventListener("keydown",e=>{
  if(!el.modal.hidden){ if(e.key==="Escape") closeModal(); return; }
  if(e.ctrlKey||e.metaKey||e.altKey) return;   // ブラウザのショートカット（拡大・再読み込み・コピーなど）はそのまま
  if((e.key==="Enter"||e.key===" ") && e.target.closest?.("button,[tabindex]")) return;   // Tabで選んだボタンは、そのボタンを押す
  const map={"+":"+","-":"−","*":"×","/":"÷","%":"%","Enter":"=","=":"=","Backspace":"⌫","Escape":"C","(":"(",")":")",".":"."};
  const k = e.key.length===1&&isDigit(e.key) ? e.key : map[e.key];
  if(k){ e.preventDefault(); press(k); }
});

/* ---- テンキーを隠す・戻す ---- */
let keysHidden=false, drag=null, keysH=0, noClickUntil=0;
function setKeys(hide){
  if(hide && el.keysWrap.offsetHeight>0) keysH=el.keysWrap.offsetHeight;   // 出すときに使う高さを覚えておく
  keysHidden=hide;
  el.keysWrap.classList.toggle("hidden",hide);
  document.body.classList.toggle("keys-hidden",hide);
  el.grip.setAttribute("aria-label", hide ? "テンキーを出す" : "テンキーを隠す");
}
const blockClicks = ms => { noClickUntil=performance.now()+ms; };
// テンキーを指に合わせて動かす。出ているときは下へ、隠れているときは上へ。
// 離した位置と速さで、切り替えるか元に戻すかを決める
function startDrag(e){
  const show=keysHidden;
  drag={x:e.clientX, y:e.clientY, py:e.clientY, pt:performance.now(), vy:0, show, active:false,
    H: show ? (keysH || $("keys").scrollHeight+4) : el.keysWrap.offsetHeight};
}
el.keyarea.addEventListener("pointerdown",startDrag);
// 隠れているときは、式の欄とラベルからも引き上げられる
for(const t of [el.expr, document.querySelector(".label")]) t.addEventListener("pointerdown",e=>{ if(keysHidden) startDrag(e); });
addEventListener("pointermove",e=>{
  if(!drag) return;
  if(pinch && !drag.active){ drag=null; return; }
  const dir=drag.show?-1:1, along=(e.clientY-drag.y)*dir, dx=e.clientX-drag.x, w=el.keysWrap;
  if(!drag.active){
    if(along>CONFIG.DRAG_START && along>Math.abs(dx)*1.5){
      drag.active=true; w.style.transition="none";
      if(drag.show){ w.style.height="0px"; w.classList.remove("hidden"); }
    }
    else if(Math.abs(dx)>CONFIG.DRAG_CANCEL||along<-CONFIG.DRAG_CANCEL) drag=null;
    if(!drag||!drag.active) return;
  }
  const now=performance.now();
  drag.vy=(e.clientY-drag.py)*dir/Math.max(1,now-drag.pt); drag.py=e.clientY; drag.pt=now;
  const moved=Math.min(drag.H, Math.max(0,along));
  w.style.height=(drag.show ? moved : drag.H-moved)+"px";
});
function endDrag(e, cancel){
  const d=drag; drag=null;
  if(!d||!d.active) return;
  blockClicks(CONFIG.BLOCK_AFTER_DRAG);
  const along=(e.clientY-d.y)*(d.show?-1:1);
  const toggle=!cancel && (along>d.H*CONFIG.DRAG_TOGGLE || d.vy>CONFIG.DRAG_FLICK);
  const hide = d.show ? !toggle : toggle;
  const w=el.keysWrap;
  w.style.transition=`height ${CONFIG.DRAG_ANIM_MS}ms ease-out`;
  void w.offsetHeight;
  w.style.height = hide ? "0px" : d.H+"px";
  let finished=false;
  const finish=()=>{
    if(finished) return; finished=true;
    w.style.transition="none";
    setKeys(hide);
    w.style.height="";
    void w.offsetHeight;
    w.style.transition="";
  };
  w.addEventListener("transitionend",finish,{once:true});
  setTimeout(finish,CONFIG.DRAG_ANIM_MS+60);
}
addEventListener("pointerup",e=>endDrag(e,false));
addEventListener("pointercancel",e=>endDrag(e,true));
el.grip.addEventListener("click",()=>setKeys(!keysHidden));
el.grip.addEventListener("keydown",e=>{ if(e.key==="Enter"||e.key===" "){ e.preventDefault(); setKeys(!keysHidden); } });

/* ---- ピンチで文字の大きさを変える ---- */
let fs=CONFIG.FS_DEFAULT, pinch=null;
try{ const v=parseFloat(localStorage.getItem(FS_KEY)); if(v>=CONFIG.FS_MIN&&v<=CONFIG.FS_MAX) fs=v; }catch(e){}
document.documentElement.style.setProperty("--fs", fs+"px");
const saveFs = () => { try{ localStorage.setItem(FS_KEY, String(fs)); }catch(e){} };
// 大きさを変える。履歴がいちばん下ならそのまま下に、途中なら指の間にある行が動かないようにする
function setFs(v, focalY){
  v=Math.round(Math.min(CONFIG.FS_MAX, Math.max(CONFIG.FS_MIN, v))*2)/2;
  if(v===fs) return;
  const h=el.history, atBottom = h.scrollHeight-h.scrollTop-h.clientHeight<4;
  let anchor=null;
  if(!atBottom) for(const r of h.children){ const b=r.getBoundingClientRect(); if(b.bottom>=focalY){ anchor={r, top:b.top}; break; } }
  fs=v; document.documentElement.style.setProperty("--fs", fs+"px");
  if(atBottom) h.scrollTop=h.scrollHeight;
  else if(anchor) h.scrollTop += anchor.r.getBoundingClientRect().top - anchor.top;
  if(pos===expr.length) el.expr.scrollTop=el.expr.scrollHeight;
}
const screenEl=document.querySelector(".screen");
const dist = t => Math.hypot(t[0].clientX-t[1].clientX, t[0].clientY-t[1].clientY);
screenEl.addEventListener("touchstart",e=>{
  if(e.touches.length!==2) return;
  cancelHold();   // 2本目の指が触れたら、長押しやタップはやめてピンチだけを扱う
  pinch={d:dist(e.touches), fs};
},{passive:true});
screenEl.addEventListener("touchmove",e=>{
  if(!pinch || e.touches.length<2) return;
  e.preventDefault();   // 画面全体の拡大やスクロールをさせない
  setFs(pinch.fs*dist(e.touches)/pinch.d, (e.touches[0].clientY+e.touches[1].clientY)/2);
},{passive:false});
for(const ev of ["touchend","touchcancel"]) screenEl.addEventListener(ev,e=>{
  if(!pinch || e.touches.length>=2) return;
  pinch=null; saveFs(); blockClicks(CONFIG.BLOCK_AFTER_PINCH);
});
// iPhoneのSafari独自のピンチ（画面全体の拡大）を止める
for(const ev of ["gesturestart","gesturechange"]) document.addEventListener(ev,e=>e.preventDefault());
// パソコンでは、トラックパッドのピンチや Ctrl+マウスホイールでも変えられる
screenEl.addEventListener("wheel",e=>{
  if(!e.ctrlKey) return;
  e.preventDefault();
  setFs(fs*Math.exp(-e.deltaY*0.01), e.clientY); saveFs();
},{passive:false});

load();
render();

// オフラインでも起動できるように、ファイルを端末に保存する仕組みを登録する
if("serviceWorker" in navigator) addEventListener("load",()=>{ navigator.serviceWorker.register("sw.js").catch(()=>{}); });
