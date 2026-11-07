// 計算と入力ルールのテスト（ブラウザ不要）。実行：npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const Calc = require("../docs/calc.js");

const calc = s => Calc.fmt(Calc.evaluate(s));

test("四則演算と括弧の順番", () => {
  assert.equal(calc("2+3×4"), "14");
  assert.equal(calc("(2+3)×4"), "20");
  assert.equal(calc("2×(3+4)×5"), "70");
  assert.equal(calc("((1+2)×(3+4))"), "21");
  assert.equal(calc("10−2−3"), "5");
  assert.equal(calc("100÷10÷5"), "2");
  assert.equal(calc("−(2+3)"), "−5");
  assert.equal(calc("(−3)×(−2)"), "6");
  assert.equal(calc("2(3)"), "6");          // 数字と括弧が並んだら掛け算
  assert.equal(calc("(2)(3)"), "6");
});

test("小数の誤差が出ない", () => {
  assert.equal(calc("0.1+0.2"), "0.3");
  assert.equal(calc("0.1+0.2−0.3"), "0");
  assert.equal(calc("1−0.9"), "0.1");
  assert.equal(calc("1.0000001−1"), "0.0000001");
  assert.equal(calc("1.1×1.1"), "1.21");
  assert.equal(calc("7÷0.1"), "70");
  assert.equal(calc("0.3÷0.1"), "3");
});

test("割り算の桁と大きな数", () => {
  assert.equal(calc("1÷3"), "0.333333333333333");
  assert.equal(calc("2÷3"), "0.666666666666667");
  assert.equal(calc("999999999999×999"), "998,999,999,999,001");
  assert.equal(calc("123456789×1000"), "123,456,789,000");
  assert.equal(Calc.fmt(12345678901234567), "1.234568e16");
  // 1÷3 を丸めずに持つので、×3 で 1 に戻る
  assert.equal(Calc.fmt(Calc.evaluate("1÷3") * 3), "1");
});

test("% は「200+10% = 220」方式", () => {
  assert.equal(calc("200+10%"), "220");
  assert.equal(calc("200−10%"), "180");
  assert.equal(calc("200×10%"), "20");
  assert.equal(calc("200÷10%"), "2,000");
  assert.equal(calc("10%"), "0.1");
  assert.equal(calc("1000+8%"), "1,080");
  assert.equal(calc("1100÷110%"), "1,000");
  assert.equal(calc("200+10%×2"), "240");
  assert.equal(calc("(200+10%)×2"), "440");
});

test("計算できない式はメッセージを throw する", () => {
  assert.throws(() => Calc.evaluate("1÷0"), e => e === Calc.DIV0);
  assert.throws(() => Calc.evaluate("8÷(3−3)"), e => e === Calc.DIV0);
  assert.throws(() => Calc.evaluate("3+"), e => e === "式が途中です。");
  assert.throws(() => Calc.evaluate("(1+2"), e => e === "式が途中です。");
});

test("参照 [行ID] は渡した関数で値を引く", () => {
  const refs = { 1: 3600, 2: -15 };
  const ref = id => { if (!(id in refs)) throw "参照先がありません。"; return refs[id]; };
  assert.equal(Calc.fmt(Calc.evaluate("[1]+400", ref)), "4,000");
  assert.equal(Calc.fmt(Calc.evaluate("[2]×2", ref)), "−30");
  assert.throws(() => Calc.evaluate("[9]", ref), e => e === "参照先がありません。");
});

test("途中の式を計算できる形にする", () => {
  assert.equal(Calc.complete("2×(3+4"), "2×(3+4)");
  assert.equal(Calc.complete("3+"), "3");
  assert.equal(Calc.complete("2×("), "2");
  assert.equal(Calc.complete("5."), "5");
  assert.equal(Calc.complete(""), "");
});

test("表示とコピー用の数字", () => {
  assert.equal(Calc.fmt(-15), "−15");
  assert.equal(Calc.fmt(NaN), "エラー");
  assert.equal(Calc.plain(3600000), "3600000");
  assert.equal(Calc.plain(-15), "15");          // 符号なし
  assert.equal(Calc.numLit(-15), "(−15)");
  assert.equal(Calc.numLit(12.5), "12.5");
});

// 文字列 keys を順に打ったときの式（カーソルは常に末尾）
const typeKeys = keys => keys.reduce((b, k) => Calc.applyKey(b, "", k) ?? b, "");

test("入力ルール", () => {
  assert.equal(typeKeys([..."007"]), "7");           // 先頭の0は置き換え
  assert.equal(typeKeys([..."1.2."]), "1.2");        // 小数点は1つだけ
  assert.equal(typeKeys(["."]), "0.");
  assert.equal(typeKeys([..."5+×"]), "5×");          // 演算子は置き換え
  assert.equal(typeKeys(["×"]), "");                 // 先頭はマイナスだけ
  assert.equal(typeKeys(["−", "5"]), "−5");
  assert.equal(typeKeys([..."(−×"]), "(−");          // 「(−」の−は置き換えない
  assert.equal(typeKeys([..."2("]), "2×(");          // 数字の後の括弧は×を補う
  assert.equal(typeKeys([..."(2)3"]), "(2)×3");
  assert.equal(typeKeys([")"]), "");                 // 開いていない括弧は閉じない
  assert.equal(typeKeys([..."10%%"]), "10%");
  assert.equal(typeKeys([..."12", "⌫"]), "1");
  assert.equal(Calc.applyKey("[3]", "", "⌫"), "");   // 参照は1つの単位で消える
  assert.equal(Calc.joinRight("(2)", "5"), "×");
  assert.equal(Calc.joinRight("5", "(1)"), "×");
  assert.equal(Calc.joinRight("5", "+1"), "");
});

test("式をまとまりに分ける", () => {
  assert.deepEqual(Calc.exprTokens("12+[3]").map(t => t.k), ["num", "sym", "ref"]);
  assert.deepEqual(Calc.exprTokens("12+[3]").map(t => [t.a, t.b]), [[0, 2], [2, 3], [3, 6]]);
});

test("貼り付ける文字を整える", () => {
  assert.equal(Calc.cleanPaste("¥1,200円"), "1200");
  assert.equal(Calc.cleanPaste("１２００"), "1200");
  assert.equal(Calc.cleanPaste("12*3-4/2"), "12×3−4÷2");
  assert.equal(Calc.cleanPaste("1200×3=3600"), "3600");     // 「式=答え」は答えだけ
  assert.equal(Calc.cleanPaste("-15"), "−15");
  assert.equal(Calc.cleanPaste("+5"), "5");
  assert.equal(Calc.cleanPaste("1÷0"), "1÷0");              // 0で割る式は入れられる
  assert.equal(Calc.cleanPaste("合計 1,200円です"), null);
  assert.equal(Calc.cleanPaste("(1+2"), null);
  assert.equal(Calc.cleanPaste("1.2.3"), null);
  assert.equal(Calc.cleanPaste(""), null);
});
