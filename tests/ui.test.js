// 画面の操作のテスト（Chromium で docs/ を開いて、タップやキー入力を再現する）。実行：npm test
// 初回だけ準備が必要：npm install && npx playwright install chromium
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const ROOT = path.join(__dirname, "..", "docs");
const TYPES = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".webmanifest":"application/manifest+json", ".png":"image/png" };
let server, base, browser;

test.before(async () => {
  // docs/ をそのまま配る小さなサーバー
  server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p.endsWith("/")) p += "index.html";
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}/`;
  browser = await chromium.launch();
});
test.after(async () => { await browser?.close(); server?.close(); });

// スマホに近い画面を開く。履歴などは空の状態から始まる
async function open({ width = 390, height = 760 } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, hasTouch: true });
  await ctx.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base.slice(0, -1) });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(base);
  const cdp = await ctx.newCDPSession(page);
  const touchAt = async (x, y, ms, moveY = 0) => {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    await page.waitForTimeout(ms);
    if (moveY) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + moveY }] });
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(250);
  };
  const center = async loc => { const b = await loc.boundingBox(); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const t = {
    page, errors,
    key: k => page.locator(`#keys [data-k="${k}"]`).tap(),
    // テンキーで打つ（"00" "000" は1つのキーとして扱わないので、1文字ずつ）
    type: async s => { for (const k of s) await t.key(k); },
    calc: async s => { await t.type(s); await t.key("="); },
    expr: () => page.evaluate("expr"),
    result: () => page.locator("#result").innerText(),
    info: () => page.locator("#parenInfo").innerText(),
    shown: id => page.evaluate(id => !document.getElementById(id).hidden, id),
    row: i => page.locator("#history .row").nth(i),
    rows: () => page.locator("#history .row").count(),
    answers: () => page.evaluate("history.map(h=>fmt(h.v))"),
    clip: () => page.evaluate("navigator.clipboard.readText()"),
    setClip: s => page.evaluate(s => navigator.clipboard.writeText(s), s),
    hold: async (loc, ms = 650) => { const [x, y] = await center(loc); await touchAt(x, y, ms); },
    tap: async loc => { const [x, y] = await center(loc); await touchAt(x, y, 80); },
    pinch: async (cx, cy, d0, d1) => {
      const pts = d => [{ x: cx, y: cy - d / 2, id: 1 }, { x: cx, y: cy + d / 2, id: 2 }];
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: pts(d0) });
      for (let i = 1; i <= 8; i++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: pts(d0 + (d1 - d0) * i / 8) });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
      await page.waitForTimeout(300);
    },
    close: () => ctx.close(),
  };
  return t;
}

test("計算して履歴に残る", async () => {
  const t = await open();
  await t.calc("1200×3");
  await t.calc("2×(3+4");             // 閉じていない括弧は補う
  await t.calc("200+10%");
  assert.deepEqual(await t.answers(), ["3,600", "14", "220"]);
  assert.equal(await t.expr(), "");   // ＝のあと入力欄は空になる
  await t.type("8÷0");
  assert.equal(await t.result(), "0では割れません。");
  assert.deepEqual(t.errors, []);
  await t.close();
});

test("途中の答え・000・±・＝の直後の続き", async () => {
  const t = await open();
  await t.key("5"); await t.key("000");
  assert.equal(await t.expr(), "5000");
  assert.equal(await t.result(), "=5,000");
  await t.key("C"); await t.type("200×5"); await t.key("±");
  assert.equal(await t.expr(), "200×(−5)");
  await t.key("±");
  assert.equal(await t.expr(), "200×5");
  await t.key("C"); await t.calc("12+3"); await t.type("+1");
  assert.equal(await t.result(), "=16");   // 直前の答え 15 に続ける
  await t.close();
});

test("答えの参照と、行の編集による再計算", async () => {
  const t = await open();
  await t.calc("100");
  await t.row(0).locator("button.ans").tap(); await t.type("×2"); await t.key("=");
  await t.row(1).locator("button.ans").tap(); await t.type("+1"); await t.key("=");
  assert.deepEqual(await t.answers(), ["100", "200", "201"]);
  // 1行目を 50 に直すと、参照している行も計算し直す
  await t.row(0).locator(".ex").tap();
  assert.equal(await t.page.locator("#exprLabel").innerText(), "行を編集");
  for (let i = 0; i < 3; i++) await t.key("⌫");
  await t.calc("50");
  assert.deepEqual(await t.answers(), ["50", "100", "101"]);
  // 参照されている行を消すと、参照していた式は数字に置き換わる
  await t.row(0).locator(".ex").tap(); await t.page.locator("#e-del").tap();
  assert.equal(await t.page.evaluate("history[0].e"), "50×2");
  // 記号がなければ + でつなぐ
  await t.key("5"); await t.row(0).locator("button.ans").tap();
  assert.equal(await t.result(), "=105");
  await t.close();
});

test("入力欄の数字をタップして置き換える", async () => {
  const t = await open();
  await t.type("888−12");
  await t.page.locator("#exprText .tok.k-num").first().tap();
  await t.type("900");
  assert.equal(await t.expr(), "900−12");
  await t.close();
});

test("ACの確認と、履歴の保存", async () => {
  const t = await open();
  await t.calc("1+1");
  await t.key("C");                                  // 入力欄が空なら確認を出す
  assert.equal(await t.shown("modal"), true);
  await t.page.locator("#m-cancel").tap();
  assert.equal(await t.rows(), 1);
  await t.page.reload();
  assert.equal(await t.rows(), 1);                   // 開き直しても残る
  await t.close();
});

test("入力欄の記号をタップして選ぶ", async () => {
  const t = await open();
  const sym = ch => t.page.locator("#exprText .tok.k-sym", { hasText: ch }).first();
  const start = s => t.page.evaluate(s => { setExpr(s); render(); }, s);
  await start("12×5");
  await sym("×").tap(); await t.key("÷");
  assert.equal(await t.expr(), "12÷5");              // 演算子は演算子キーで置き換わる
  await sym("÷").tap(); await t.key("3");
  assert.equal(await t.expr(), "12÷35");             // それ以外のキーは直後に入る
  await sym("÷").tap(); await t.key("⌫");
  assert.equal(await t.expr(), "1235");              // ⌫で消すと数字はくっつく
  await start("1+2×3");
  await sym("+").tap(); await t.key("(");
  assert.equal(await t.expr(), "1+(2×3");
  await t.page.locator("#exprText .tok.k-num").last().tap(); await t.page.locator("#exprText .tok.k-num").last().tap();
  await t.key(")");
  assert.equal(await t.expr(), "1+(2×3)");          // 数字を2回タップすると、その直後にカーソル
  await sym(")").tap(); await t.key("⌫");
  assert.equal(await t.expr(), "1+(2×3");            // 括弧は選んだものだけ消える
  await start("(−5)×2");
  await sym("−").tap(); await t.key("+");
  assert.equal(await t.expr(), "(−5)×2");            // 符号の−は演算子に置き換えない
  await sym("−").tap(); await t.key("±");
  assert.equal(await t.expr(), "(−5)×2");            // 符号の−を選んで±を押しても何もしない
  await start("1+2");
  await sym("+").tap(); await t.key("±");
  assert.equal(await t.expr(), "1+(−2");             // ほかの記号なら、その直後で符号を扱う
  await start("(−5)×2");
  await sym("×").tap(); await sym("×").tap();
  assert.equal(await t.page.evaluate("sel===null && pos===5"), true);   // もう一度タップでその直後にカーソル
  await t.close();
});

test("長押しでコピー、ボタン以外のタップは閉じるだけ", async () => {
  const t = await open();
  await t.calc("5−20");
  await t.row(0).locator("button.ans").tap(); await t.type("×2+1000"); await t.key("=");
  await t.hold(t.row(1));
  assert.equal(await t.shown("copyBar"), true);
  await t.page.locator("#c-expr").tap();
  assert.equal(await t.clip(), "(−15)×2+1000");
  await t.hold(t.row(0));
  await t.page.locator("#c-ans").tap();
  assert.equal(await t.clip(), "-15");
  // ボタンが出ている間は、どこをタップしても閉じるだけ
  await t.type("7");
  for (const target of [t.row(0).locator(".ex"), t.page.locator('#keys [data-k="5"]'), t.page.locator("#expr")]) {
    await t.hold(t.row(1)); await t.tap(target);
    assert.equal(await t.shown("copyBar"), false);
    assert.equal(await t.expr(), "7");
    assert.equal(await t.page.evaluate("editing"), null);
  }
  await t.close();
});

test("長押しで貼り付け", async () => {
  const t = await open();
  const paste = async (clip, start) => {
    await t.setClip(clip);
    await t.page.evaluate(s => { setExpr(s); render(); }, start);
    await t.hold(t.page.locator("#expr"));
    await t.page.locator("#p-paste").tap();
    await t.page.waitForTimeout(150);
    return t.expr();
  };
  assert.equal(await paste("¥1,200円", ""), "1200");
  assert.equal(await paste("3+4", "2×"), "2×(3+4)");     // 式の途中なら括弧で囲む
  assert.equal(await paste("10%", "200+"), "200+10%");   // 「10%」は囲まない
  assert.equal(await paste("-15", "2×"), "2×(−15)");
  assert.equal(await paste("合計 1,200円です", "9"), "9");
  assert.equal(await t.info(), "貼り付けできない内容です。");
  // メッセージは次のタップで消え、そのタップの操作も行われる
  await t.page.locator("#exprText .tok.k-num").first().tap();
  assert.equal(await t.info(), "");
  assert.equal(await t.page.evaluate("sel!==null"), true);
  await t.close();
});

test("Ctrl+C・Ctrl+V・キーボード", async () => {
  const t = await open();
  const { page } = t;
  await page.keyboard.type("5-20");
  assert.equal(await t.expr(), "5−20");
  await page.keyboard.press("Control+C");
  assert.equal(await t.clip(), "5−20=−15");
  await page.keyboard.press("Enter");
  assert.deepEqual(await t.answers(), ["−15"]);
  await t.setClip("3*4");
  await page.keyboard.press("Control+V");
  assert.equal(await t.expr(), "3×4");
  await page.keyboard.press("Control+Equal");          // ブラウザのショートカットは横取りしない
  assert.equal(await t.expr(), "3×4");
  // クリックしたボタンにフォーカスを残さない
  await page.locator('#keys [data-k="7"]').click();
  assert.equal(await page.evaluate("document.activeElement===document.body"), true);
  // Tab で選んだボタンは Enter でそのボタンを押す（＝にはならない）
  await page.locator('#keys [data-k="C"]').focus();
  await page.keyboard.press("Enter");
  assert.equal(await t.expr(), "");
  await t.close();
});

test("テンキーを指で隠す・戻す", async () => {
  const t = await open();
  const drag = async (loc, dy) => {
    const b = await loc.boundingBox(); const x = b.x + b.width / 2, y = b.y + 10;
    await t.page.mouse.move(x, y); await t.page.mouse.down();
    await t.page.mouse.move(x, y + dy, { steps: 10 }); await t.page.mouse.up();
    await t.page.waitForTimeout(400);
  };
  await drag(t.page.locator('#keys [data-k="5"]'), 200);
  assert.equal(await t.page.evaluate("keysHidden"), true);
  await drag(t.page.locator("#expr"), -40);            // 少しだけなら戻らない
  assert.equal(await t.page.evaluate("keysHidden"), true);
  await drag(t.page.locator("#expr"), -220);
  assert.equal(await t.page.evaluate("keysHidden"), false);
  await t.key("7");
  assert.equal(await t.expr(), "7");
  await t.close();
});

test("ピンチで文字の大きさを変える", async () => {
  const t = await open();
  for (let i = 1; i <= 15; i++) await t.page.evaluate(i => { setExpr(String(i * 111)); equals(); }, i);
  await t.pinch(195, 300, 80, 160);
  assert.equal(await t.page.evaluate("fs"), 32);       // 上限で止まる
  assert.equal(await t.page.evaluate("visualViewport.scale"), 1);   // 画面全体は拡大しない
  await t.pinch(195, 300, 200, 40);
  assert.equal(await t.page.evaluate("fs"), 14);       // 下限で止まる
  await t.page.reload();
  assert.equal(await t.page.evaluate("fs"), 14);       // 開き直しても残る
  await t.close();
});

test("数字を選んでも改行位置が変わらず、枠が切れない", async () => {
  for (const width of [330, 360, 390, 420]) {
    const t = await open({ width });
    await t.page.evaluate(() => { for (const k of "1000000000") press(k); press("="); insertRef(history[0].id); for (const k of "×3") press(k); });
    const tops = () => t.page.evaluate(() => [...document.querySelectorAll("#exprText .tok,#result")].map(e => Math.round(e.getClientRects()[0].top)));
    const before = await tops();
    await t.page.locator("#exprText .tok.k-ref").tap();
    assert.deepEqual(await tops(), before, `幅 ${width}px`);
    const [right, clip] = await t.page.evaluate(() => [document.querySelector("#exprText .sel .ref").getBoundingClientRect().right + 1, document.getElementById("expr").getBoundingClientRect().right]);
    assert.ok(right <= clip, `幅 ${width}px で枠が切れている`);
    await t.close();
  }
});

test("オフラインでも起動する", async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(base);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await ctx.setOffline(true);
  await page.reload();
  assert.equal(await page.title(), "式が見える電卓");
  assert.equal(await page.evaluate("typeof Calc.evaluate"), "function");
  await ctx.close();
});
