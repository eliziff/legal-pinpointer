'use strict';

// Checks the extension's model of Chrome's text-fragment search against the installed Chrome, case
// by case, like MikeOSS Fork's experiments/text-fragment-fidelity/quirk-check.mjs. Each case is a
// small page opened at #:~:<directive> by a fresh navigation. Chrome's verdict is read from what it
// does: the match's common ancestor element becomes :target, and a match below a tall spacer
// scrolls the page. The model's verdict is findDirective on the same page. Any disagreement fails.
// Usage: node tools/fragment-quirks.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const projectRoot = path.resolve(__dirname, '..');
const chromePath = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SPACER = '<div style="height:3000px">spacer</div>';

// [name, body html, directive]. Every candidate passage sits in an element with an id.
const CASES = [
  ['plain', '<p id="a">The appeal is allowed.</p>', 'text=appeal%20is'],
  ['case and accents fold', '<p id="a">Cour d’APPEL du Québec</p>', 'text=cour%20d%27appel%20du%20quebec'],
  ['ligature and eszett fold', '<p id="a">ﬁnal Straße Cæsar</p>', 'text=final%20strasse%20caesar'],
  ['soft hyphen ignored', '<p id="a">exam\u00ADple text</p>', 'text=example%20text'],
  ['zero-width space ignored', '<p id="a">fo\u200Bo bar</p>', 'text=foo%20bar'],
  ['nbsp and space are two spaces', '<p id="a">allowed.&nbsp; The order</p>', 'text=allowed.%20%20The'],
  ['nbsp and space not one space', '<p id="a">allowed.&nbsp; The order</p>', 'text=allowed.%20The'],
  ['em dash is not hyphen', '<p id="a">a—b c</p>', 'text=a%2Db%20c'],
  ['whole word start', '<p id="a">reappeal granted</p>', 'text=appeal%20granted'],
  ['whole word end', '<p id="a">appeals granted</p>', 'text=appeal'],
  ['apostrophe inside word', '<p id="a">don\'t stop</p>', 'text=t%20stop'],
  ['br splits terms', '<p id="a">Costs follow<br>the event</p>', 'text=follow%20the'],
  ['br range ends', '<p id="a">Costs follow<br>the event</p>', 'text=costs,event'],
  ['pre newline splits terms', '<pre id="a">first line\nsecond line</pre>', 'text=line%20second'],
  ['pre tab is not space', '<pre id="a">left\tright</pre>', 'text=left%20right'],
  ['pre tab matches tab', '<pre id="a">left\tright</pre>', 'text=left%09right'],
  ['block splits terms', '<div id="a"><p>one two</p><p>three four</p></div>', 'text=two%20three'],
  ['inline-block splits terms', '<p id="a">Alpha <span style="display:inline-block">beta</span> gamma</p>', 'text=alpha%20beta'],
  ['float splits terms', '<p id="a">Alpha <span style="float:left">beta</span> gamma</p>', 'text=alpha%20beta'],
  ['absolute splits terms', '<p id="a" style="position:relative">Alpha <span style="position:absolute;left:300px">beta</span> gamma</p>', 'text=alpha%20beta'],
  ['inline element joins', '<p id="a">Alpha <b>beta</b> gamma</p>', 'text=alpha%20beta%20gamma'],
  ['img between letters joins', '<p id="a">York<img src="data:," alt="x">Inline flag</p>', 'text=yorkinline'],
  ['img between words', '<p id="a">York <img src="data:," alt="x"> Inline flag</p>', 'text=york%20inline'],
  ['hidden text skipped', '<p id="a">gamma <span style="visibility:hidden">delta</span> epsilon</p>', 'text=gamma%20epsilon'],
  ['display none skipped', '<p id="a">one <span style="display:none">two</span> three</p>', 'text=one%20three'],
  ['aria-hidden searched', `${SPACER}<p id="a" aria-hidden="true">needle aria words</p>`, 'text=needle%20aria%20words'],
  ['offscreen text searched', `${SPACER}<p id="a" style="position:absolute;left:-9999px">needle offscreen words</p>`, 'text=needle%20offscreen%20words'],
  ['until-found searched', `${SPACER}<div id="a" hidden="until-found">needle found words</div>`, 'text=needle%20found%20words'],
  ['closed details searched', `${SPACER}<details id="d"><summary>More</summary><p id="a">needle detail words</p></details>`, 'text=needle%20detail%20words'],
  ['content-visibility hidden skipped', `${SPACER}<div id="a" style="content-visibility:hidden">needle locked words</div>`, 'text=needle%20locked%20words'],
  ['input value searched', `${SPACER}<input id="a" value="needle input words">`, 'text=needle%20input%20words'],
  ['textarea value searched', `${SPACER}<textarea id="a">needle textarea words</textarea>`, 'text=needle%20textarea%20words'],
  ['select skipped', `${SPACER}<select id="a"><option>needle option words</option></select>`, 'text=needle%20option%20words'],
  ['svg title skipped', `${SPACER}<svg id="a" width="10" height="10"><title>needle svg words</title></svg>`, 'text=needle%20svg%20words'],
  ['img alt skipped', `${SPACER}<img id="a" src="data:," alt="needle alt words">`, 'text=needle%20alt%20words'],
  ['button text searched', `${SPACER}<button id="a">needle button words</button>`, 'text=needle%20button%20words'],
  ['prefix across blocks', '<p>foo bar</p><p id="a">baz qux</p>', 'text=bar-,baz%20qux'],
  ['suffix across blocks', '<p id="a">baz qux</p><p>foo bar</p>', 'text=baz%20qux,-foo'],
  ['prefix must be adjacent', '<p id="b">bar and baz qux</p><p id="a">bar baz qux</p>', 'text=bar-,baz%20qux'],
  ['suffix completes a word', '<p id="a">the appeal fails</p>', 'text=app,-eal'],
  ['first end after start', '<div id="c"><p id="a">start one end</p><p id="b">middle end</p></div>', 'text=start,end'],
  ['range end with suffix skips', '<div id="c"><p id="a">start one end</p><p id="b">middle end tail</p></div>', 'text=start,end,-tail'],
  ['exact restarts after failed suffix', '<p id="b">same words here</p><p id="a">same words there</p>', 'text=same%20words,-there'],
  ['unicode case fold', '<p id="a">ΟΔΟΣ ΚΑΛΟΣ</p>', 'text=%CE%BF%CE%B4%CE%BF%CF%82'],
  ['full-width folds', '<p id="a">ＡＢＣ１２３ ok</p>', 'text=abc123%20ok'],
  ['superscript folds', '<p id="a">note¹ here</p>', 'text=note1%20here'],
  ['prime is not apostrophe', '<p id="a">5′ long</p>', 'text=5%27%20long'],
  ['low quote is not quote', '<p id="a">„quoted“ word</p>', 'text=%22quoted%22%20word'],
  ['noscript skipped', `${SPACER}<noscript><p id="a">needle noscript words</p></noscript>`, 'text=needle%20noscript%20words'],
  ['table cells split', '<table id="a"><tr><td>left cell</td><td>right cell</td></tr></table>', 'text=cell%20right'],
  ['list items split', '<ul id="a"><li>item one</li><li>item two</li></ul>', 'text=one%20item'],
  ['flex items split', '<div id="a" style="display:flex"><span>flex one</span><span>flex two</span></div>', 'text=one%20flex'],
  ['wbr joins', '<p id="a">super<wbr>calif words</p>', 'text=supercalif%20words'],
  ['inline-flex splits', '<p id="a">Alpha <span style="display:inline-flex">beta</span> gamma</p>', 'text=alpha%20beta'],
  ['comment joins', '<p id="a">York<!-- note -->Inline flag</p>', 'text=yorkinline'],
  ['script between letters', '<p id="a">York<script>/* x */</script>Inline flag</p>', 'text=yorkinline'],
  ['style between letters', '<p id="a">York<style>b{}</style>Inline flag</p>', 'text=yorkinline'],
  ['hidden img between letters', '<p id="a">York<img src="data:," style="display:none">Inline flag</p>', 'text=yorkinline'],
  ['meta between letters', '<p id="a">York<meta name="x" content="y">Inline flag</p>', 'text=yorkinline'],
  ['prefix across img', '<p id="a">York <img src="data:," alt="x"> Inline flag</p>', 'text=york-,inline%20flag'],
  ['hidden span without spaces', '<p id="a">gamma<span style="visibility:hidden">delta</span>epsilon</p>', 'text=gammaepsilon'],
  ['hidden span two spaces', '<p id="a">gamma <span style="visibility:hidden">delta</span> epsilon</p>', 'text=gamma%20%20epsilon'],
  ['hidden trailing space', '<p id="a">gamma <span style="visibility:hidden">delta </span>epsilon</p>', 'text=gamma%20epsilon'],
  ['single low quote', '<p id="a">‚quoted‘ word</p>', 'text=%27quoted%27%20word'],
  ['reversed quote', '<p id="a">‛quoted‛ word</p>', 'text=%27quoted%27%20word'],
  ['reversed double quote', '<p id="a">‟quoted‟ word</p>', 'text=%22quoted%22%20word'],
  ['double prime', '<p id="a">5″ long</p>', 'text=5%22%20long'],
  ['guillemets', '<p id="a">«quoted» word</p>', 'text=%22quoted%22%20word'],
  ['full-width quote', '<p id="a">＂quoted＂ word</p>', 'text=%22quoted%22%20word'],
  ['dotless i', '<p id="a">Dırectory</p>', 'text=directory'],
  ['en dash is not hyphen', '<p id="a">1–2 pages</p>', 'text=1%2D2%20pages'],
  ['non-breaking hyphen', '<p id="a">1‑2 pages</p>', 'text=1%2D2%20pages'],
  ['ellipsis folds to dots', '<p id="a">and so on… more</p>', 'text=on...%20more'],
  ['westlaw flag then link', '<p id="a">and <a href="#x"><img src="data:," alt="x"><span>Inline KeyCite Flag</span></a><span><a href="#y"><em>R. v. Wong</em></a></span>[1990] 3</p>', 'text=flagr.'],
  ['flag link without img', '<p id="a">and <a href="#x"><span>Inline KeyCite Flag</span></a><span><a href="#y"><em>R. v. Wong</em></a></span>[1990] 3</p>', 'text=flagr.'],
  ['img earlier in inline', '<p id="a">and <b><img src="data:," alt="x">Inline Flag</b>R. v. Wong</p>', 'text=flagr.'],
  ['img earlier in text', '<p id="a">and <img src="data:," alt="x">Inline Flag<b>R.</b> v. Wong</p>', 'text=flagr.'],
  ['img earlier plain', '<p id="a">and <img src="data:," alt="x"> Inline FlagR. v. Wong</p>', 'text=flagr.'],
  ['img mid inline end', '<p id="a">and <b>Inline <img src="data:," alt="x"> Flag</b>R. v. Wong</p>', 'text=flagr.'],
  ['nested img parent end', '<p id="a">and <b><i><img src="data:," alt="x">xx </i>yy</b> zz end</p>', 'text=xx%20yy'],
  ['nested img outer end', '<p id="a">and <b><i><img src="data:," alt="x">xx </i>yy</b> zz end</p>', 'text=yy%20zz'],
  ['img parent end bounds word', '<p id="a">and <b><img src="data:," alt="x">Xx</b>Yy end</p>', 'text=yy%20end'],
  ['plain inline end joins word', '<p id="a">and <b>Xx</b>Yy end</p>', 'text=yy%20end'],
  ['hidden img parent end', '<p id="a">and <b><img src="data:," alt="x" style="display:none">Xx</b>Yy end</p>', 'text=yy%20end'],
  ['img parent end then sibling', '<p id="a">and <b><img src="data:," alt="x">Xx</b><i> Yy</i> zz</p>', 'text=yy%20zz']
];

function page(body) {
  return '<!doctype html><html><head><meta charset="utf-8"><style>::target-text{background:rgb(0,255,0)}</style></head>'
    + `<body>${body}</body></html>`;
}

const MODEL = `(directive) => {
  const F = window.LegalPinpointerTextFragments;
  const index = F.buildTextIndex(document.body);
  const parsed = F.parseDirective(directive);
  const found = parsed && F.findDirective(index, parsed);
  if (!found) return { matched: false };
  let first = null;
  let last = null;
  for (const run of index.runs) {
    if (!first && run.at + run.length > found.start) first = run;
    if (run.at < found.end) last = run;
  }
  if (!first || !last) return { matched: true, target: '(control)' };
  const range = document.createRange();
  range.setStart(first.node, Math.max(0, found.start - first.at) + first.offset);
  range.setEnd(last.node, Math.min(last.length, found.end - last.at) + last.offset);
  let node = range.commonAncestorContainer;
  if (node.nodeType !== 1) node = node.parentElement;
  return { matched: true, target: node.id || node.tagName, unique: found.unique };
}`;

async function main() {
  const server = http.createServer((request, response) => {
    const at = Number(new URL(request.url, 'http://x').pathname.split('/')[2]);
    const body = Buffer.from(page(CASES[at] ? CASES[at][1] : ''), 'utf8');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:" });
    response.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'legal-pinpointer-quirks-'));
  const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
    '--no-first-run', '--window-size=1000,700', 'about:blank'], { stdio: 'ignore' });
  let port = 0;
  for (let attempt = 0; attempt < 200 && !port; attempt += 1) {
    try { port = Number(fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]); } catch (_) { await delay(50); }
  }
  const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
  const socket = new WebSocket(list.find((target) => target.type === 'page').webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  let onLoad = null;
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    } else if (message.method === 'Page.loadEventFired' && onLoad) onLoad();
  });
  await new Promise((resolve) => socket.addEventListener('open', resolve, { once: true }));
  const send = (method, params = {}) => new Promise((resolve) => {
    id += 1;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.result.value;
  await send('Page.enable');
  const scripts = ['canlii-courts.js', 'core.js', 'text-fragments.js'].map((name) => fs.readFileSync(path.join(projectRoot, name), 'utf8'));
  const failures = [];
  try {
    for (const [at, [name, , directive]] of CASES.entries()) {
      const loaded = new Promise((resolve) => { onLoad = resolve; });
      await send('Page.navigate', { url: `${origin}/case/${at}?n=${Date.now()}#:~:${directive}` });
      await Promise.race([loaded, delay(5000)]);
      let chromeSaw = null;
      for (let wait = 0; wait < 1500; wait += 100) {
        chromeSaw = await evaluate('({ target: (document.querySelector(":target") || {}).id || null, scrollY })');
        if (chromeSaw.target || chromeSaw.scrollY > 0) break;
        await delay(100);
      }
      await delay(100);
      chromeSaw = await evaluate('({ target: (document.querySelector(":target") || {}).id || null, scrollY })');
      for (const source of scripts) await evaluate(source);
      const model = await evaluate(`(${MODEL})(${JSON.stringify(directive)})`);
      const chromeMatched = Boolean(chromeSaw.target) || chromeSaw.scrollY > 0;
      const agree = chromeMatched === model.matched && (!chromeSaw.target || !model.target || model.target === '(control)' || chromeSaw.target === model.target);
      const line = `${agree ? 'ok  ' : 'FAIL'} ${name.padEnd(36)} chrome=${chromeMatched ? chromeSaw.target || `scroll ${chromeSaw.scrollY}` : 'none'} model=${model.matched ? model.target : 'none'}`;
      process.stdout.write(`${line}\n`);
      if (!agree) failures.push(name);
    }
  } finally {
    process.stdout.write(`${CASES.length - failures.length}/${CASES.length} agree${failures.length ? `; disagree: ${failures.join(', ')}` : ''}\n`);
    socket.close();
    chrome.kill();
    server.close();
    await delay(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
