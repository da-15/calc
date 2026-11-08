/* 式が見える電卓：計算と入力ルール
   画面には触らない関数だけを置く。ブラウザでは Calc として、Node.js では require("./calc.js") で使える（テスト用）。

   式は次の文字だけでできた文字列として扱う。
     数字と小数点 0-9 .  ／ 演算子 + − × ÷  ／ ( )  ／ %  ／ 履歴の答えの参照 [行ID]
   マイナスは画面と同じ「−」（U+2212）を使う。 */
const Calc = (() => {
  const OPS = ["+","−","×","÷"];
  const DIV0 = "0では割れません。";
  const INCOMPLETE = "式が途中です。";

  const isDigit = c => c>="0" && c<="9";
  // c で終わっていたら、そのあとに数字や括弧が来るとき×を補う（数字・閉じ括弧・参照・小数点・%）
  const endsOperand = c => isDigit(c) || c===")" || c==="]" || c==="." || c==="%";
  // 閉じていない括弧の数
  const opens = s => { let n=0; for(const c of s){ if(c==="(") n++; else if(c===")") n--; } return n; };

  /* ---- 計算（evalは使わず、自前で式を解析） ---- */
  // refValue(id)：参照 [id] の値を返す関数。参照先がなければ、メッセージの文字列を throw する
  const noRefs = () => { throw INCOMPLETE; };
  function tokenize(s, refValue=noRefs){
    const t=[]; let i=0;
    while(i<s.length){
      const c=s[i];
      if(isDigit(c)||c==="."){ let j=i; while(j<s.length&&(isDigit(s[j])||s[j]===".")) j++;
        const n=s.slice(i,j); if(n===".") throw INCOMPLETE; t.push(parseFloat(n)); i=j; }
      else if(c==="["){ const j=s.indexOf("]",i); t.push(refValue(+s.slice(i+1,j))); i=j+1; }
      else { t.push(c); i++; }
    }
    return t;
  }
  // 式を計算する。計算できなければ、メッセージの文字列を throw する
  function evaluate(s, refValue){
    const t=tokenize(s, refValue); let p=0;
    const expect=()=>{ if(p>=t.length) throw INCOMPLETE; };
    // 足し算・引き算の右側が「10%」だけなら、左側の10%を足し引きする（200+10% = 220）
    function sum(){ let v=term().v;
      while(t[p]==="+"||t[p]==="−"){ const o=t[p++]; const r=term();
        const d = r.pct ? v*r.v : r.v;
        v = addRound(v, o==="+" ? d : -d); }
      return v; }
    // 10%×2 のように%が1つだけの項は「20%」として扱う
    function term(){ const f=factor(); let v=f.v, pcts=f.pct?1:0;
      while(true){
        let o=t[p];
        if(o==="×"||o==="÷") p++;
        else if(typeof o==="number"||o==="(") o="×";   // 2(3) や (2)(3) は掛け算とみなす
        else break;
        const r=factor(); if(r.pct) pcts++;
        if(o==="÷"&&r.v===0) throw DIV0;
        v = o==="×" ? v*r.v : v/r.v;
      }
      return {v, pct:pcts===1}; }
    function factor(){ const v=unary(); if(t[p]==="%"){ p++; return {v:v/100, pct:true}; } return {v, pct:false}; }
    function unary(){ expect(); if(t[p]==="−"){ p++; return -unary(); } return atom(); }
    function atom(){ expect(); const x=t[p++];
      if(typeof x==="number") return x;
      if(x==="("){ const v=sum(); if(t[p]!==")") throw INCOMPLETE; p++; return v; }
      throw INCOMPLETE; }
    const v=sum();
    if(p!==t.length) throw t[p]===")" ? "( が足りません。" : INCOMPLETE;   // 「1+2)×3」のように閉じ括弧が余っている
    return v;
  }
  // 2進数の誤差を消すため、足し算・引き算の答えを元の数の桁で丸める（有効15桁）
  function addRound(a,b){
    const v=a+b, m=Math.max(Math.abs(a),Math.abs(b));
    if(!isFinite(v)||m===0) return v;
    const d=14-Math.floor(Math.log10(m));
    return d<0||d>100 ? v : Number(v.toFixed(d));
  }
  // 途中の式から、計算できる形を作る：末尾の演算子などを外し、閉じ括弧を補う
  function complete(s){
    while(/[+−×÷(.]$/.test(s)) s=s.slice(0,-1);
    return s ? s+")".repeat(Math.max(0,opens(s))) : "";
  }

  /* ---- 数字の表示 ---- */
  const clean = v => parseFloat(v.toPrecision(15));
  // 画面に出す形（カンマ区切り。とても大きい・小さい数は 1.234568e16 の形）
  function fmt(v){
    if(!isFinite(v)) return "エラー";
    const c=clean(v), sign = c<0 ? "−" : "", a=Math.abs(c);
    if(a>=1e16||(a!==0&&a<1e-9)) return sign+a.toExponential(6).replace("e+","e").replace(/\.?0+e/,"e");
    return sign+a.toLocaleString("en-US",{maximumSignificantDigits:15});
  }
  // カンマなし・省略なしの数字（有効15桁、符号なし）
  const plain = v => Math.abs(clean(v)).toLocaleString("en-US",{useGrouping:false,maximumSignificantDigits:15});
  // 式に書ける形の数字（マイナスは括弧付き）
  const numLit = v => v<0 ? "(−"+plain(v)+")" : plain(v);

  // 式を、数字・参照・記号のまとまりに分ける（a〜b は式の中の位置）
  function exprTokens(s){
    const t=[]; let i=0;
    while(i<s.length){ const c=s[i];
      if(isDigit(c)||c==="."){ let j=i; while(j<s.length&&(isDigit(s[j])||s[j]===".")) j++; t.push({k:"num",a:i,b:j}); i=j; }
      else if(c==="["){ const j=s.indexOf("]",i)+1; t.push({k:"ref",a:i,b:j}); i=j; }
      else { t.push({k:"sym",a:i,b:i+1}); i++; }
    }
    return t;
  }

  /* ---- 入力ルール ---- */
  // カーソルより前の部分 b に、キー k を打ったときの新しい b を返す（何もしないなら null）。a はカーソルより後ろの部分
  function applyKey(b,a,k){
    const L=b.slice(-1);
    const curNum=()=>b.match(/[0-9.]*$/)[0];
    if(isDigit(k)||k==="."){
      if(L===")"||L==="]"||L==="%") b+="×";
      if(k==="."){
        if((curNum()+a.match(/^[0-9.]*/)[0]).includes(".")) return null;
        return b+(curNum()===""?"0.":".");
      }
      if(curNum()==="0") b=b.slice(0,-1);   // 先頭の0を置き換え
      return b+k;
    }
    if(OPS.includes(k)){
      if(b===""||L==="(") return k==="−" ? b+"−" : null;  // 先頭・括弧の直後はマイナスだけ
      if(L===".") b=b.slice(0,-1);
      if(OPS.includes(b.slice(-1))){
        if(b.length===1||b.slice(-2,-1)==="(") return null;   // 「(−」の−は置き換えない
        b=b.slice(0,-1);
      }
      return b+k;
    }
    if(k==="%"){
      if(b===""||L==="("||L==="%"||OPS.includes(L)) return null;
      return (L==="." ? b.slice(0,-1) : b)+"%";
    }
    if(k==="("){
      if(endsOperand(L)) b=(L==="." ? b.slice(0,-1) : b)+"×";
      return b+"(";
    }
    if(k===")"){
      // 「(」が足りなくても打てる（＝を押したときに「( が足りません。」と知らせる）。中身のない「()」や「1+)」にはしない
      if(L==="("||OPS.includes(L)) return null;
      return (L==="." ? b.slice(0,-1) : b)+")";
    }
    if(k==="⌫") return L==="]" ? b.replace(/\[\d+\]$/,"") : b.slice(0,-1);
    return null;
  }
  // カーソルの右側との間に、必要なら×を補う
  function joinRight(b,a){
    const L=b.slice(-1), R=a.charAt(0);
    if((L===")"||L==="]"||L==="%") && (isDigit(R)||R==="."||R==="("||R==="[")) return "×";
    if((isDigit(L)||L===".") && (R==="("||R==="[")) return "×";
    return "";
  }

  /* ---- 符号の切り替え（±） ---- */
  // 「ひとまとまり」は、数字・参照・括弧で囲まれた部分のどれか。
  // 位置 i から始まるひとまとまりの終わりの位置を返す。i からまとまりが始まらなければ -1
  function operandEnd(s,i){
    const c=s[i];
    if(isDigit(c)||c==="."){ while(i<s.length&&(isDigit(s[i])||s[i]===".")) i++; return i; }
    if(c==="[") return s.indexOf("]",i)+1;
    if(c==="("){ let d=0; for(;i<s.length;i++){ if(s[i]==="(") d++; else if(s[i]===")" && --d===0) return i+1; } }
    return -1;
  }
  // カーソル q の直前のひとまとまり（数字なら q を含むもの）を {a,b} で返す。直後の%は飛ばす。なければ null
  function operandBefore(s,q){
    if(s[q-1]==="%") q--;
    const t=exprTokens(s).find(t=>(t.k==="num"||t.k==="ref") && t.a<q && q<=t.b);
    if(t) return {a:t.a, b:t.b};
    if(s[q-1]===")"){ let d=0; for(let i=q-1;i>=0;i--){ if(s[i]===")") d++; else if(s[i]==="(" && --d===0) return {a:i, b:q}; } }
    return null;
  }
  // 式 s の、選んだまとまり sel（なければカーソル pos の直前のまとまり）の符号を切り替える。
  // 戻り値 {s, pos, sel}。まとまりがなければ、マイナスの数を打ち始める形にする
  function toggleSign(s,pos,sel=null){
    const R = sel || operandBefore(s,pos);
    if(!R){
      const b=s.slice(0,pos), a=s.slice(pos), L=b.slice(-1);
      if(b===""||L==="(") return {s:b+"−"+a, pos:b.length+1, sel:null};
      if(OPS.includes(L)) return {s:b+"(−"+a, pos:b.length+2, sel:null};
      return {s, pos, sel};
    }
    const X=s.slice(R.a,R.b), pre=s.slice(0,R.a), post=s.slice(R.b);
    const inner=X.slice(2,-1), e=operandEnd(inner,0);
    const single = e===inner.length || (e>0 && inner[e]==="%" && e+1===inner.length);   // 中身がひとまとまりだけか
    // 式の [ra,rb) を N に置き換える。xAt は、N の中で X が始まる位置
    let ra=R.a, rb=R.b, N=X, xAt=0;
    if(X.startsWith("(−") && X.endsWith(")") && single) N=inner;                         // 「(−5)」「(−(3+5))」→ 外す
    else if(pre.endsWith("(−") && post.startsWith(")")){ ra-=2; rb+=1; }                 // 「(−5)」の5 → 外す
    else if(pre.endsWith("−") && (pre.length===1 || pre.slice(-2,-1)==="(")) ra-=1;       // 「−5」→ 外す
    else if(pre===""||pre.endsWith("(")){ N="−"+X; xAt=1; }                               // 先頭や「(」の直後 →「−5」
    else { N="(−"+X+")"; xAt=2; }                                                         // 式の途中 →「(−5)」
    const out=s.slice(0,ra)+N+s.slice(rb);
    if(sel) return {s:out, pos:ra+xAt+X.length, sel:{a:ra+xAt, b:ra+xAt+X.length}};
    // カーソルは、置き換えた部分より後ろならずらす。中なら同じまとまりの中の位置を保つ
    return {s:out, pos: pos>=rb ? pos+out.length-s.length : ra+xAt+(pos-R.a), sel:null};
  }

  // 貼り付ける文字を、この電卓の式の形に整える。式として読めなければ null
  function cleanPaste(text){
    let t=text.normalize("NFKC").replace(/[\s,¥円]/g,"");
    if(t.includes("=")) t=t.slice(t.lastIndexOf("=")+1);   // 「式=答え」なら答えだけ
    t=t.replace(/[*xX✕]/g,"×").replace(/\//g,"÷").replace(/[-‐‑–—―]/g,"−").replace(/^\+/,"");
    if(!t || !/^[0-9.+−×÷()%]+$/.test(t)) return null;
    if((t.match(/[0-9.]+/g)||[]).some(n=>n==="."||n.split(".").length>2)) return null;
    let depth=0; for(const c of t){ depth += c==="(" ? 1 : c===")" ? -1 : 0; if(depth<0) return null; }
    if(depth!==0) return null;
    try{ evaluate(t); }catch(e){ if(e!==DIV0) return null; }
    return t;
  }

  return { OPS, DIV0, isDigit, opens, evaluate, complete, fmt, plain, numLit, exprTokens, applyKey, joinRight, operandEnd, operandBefore, toggleSign, cleanPaste };
})();
if(typeof module==="object" && module.exports) module.exports = Calc;
