'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
// Unit fixture: route generation and the packaged route table are covered separately.
const scope = { LegalPinpointerCanliiCourts: { routes: { ABQB: 'ab/abqb', SCC: 'ca/scc' }, frenchRoutes: {} } };
vm.createContext(scope);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../core.js'), 'utf8'), scope);
const core = scope.LegalPinpointerCore;

test('requested pinpoint wording preserves ranges, singulars and bare mode', () => {
  for (const [kind, values, expected] of [
    ['paragraph', ['12'], 'at para 12'], ['paragraph', ['12','13'], 'at paras 12-13'],
    ['page', ['353'], 'at 353'], ['page', ['553','559'], 'at 553, 559'],
    ['section', ['7(2)'], 's 7(2)'], ['section', ['7(2)','7(3)'], 'ss 7(2)-(3)']
  ]) assert.equal(core.formatPinpoint(kind, values, 'full'), expected);
  assert.equal(core.formatPinpoint('page', ['12','13'], 'bare'), '12-13');
});

test('historic CanLII-only citations, prefixed titles and legislation titles are not dropped or duplicated', () => {
  assert.equal(core.chooseCaseCitation(['MacMillan v. Brownlee', '1934 CanLII 376 (AB QB)'], 'en', ''), '1934 CanLII 376 (AB QB)');
  assert.equal(core.makeCitation('case', '1934 CanLII 376 (AB QB) | MacMillan v. Brownlee', '1934 CanLII 376 (AB QB)').plain,
    'MacMillan v Brownlee, 1934 CanLII 376 (AB QB)');
  assert.equal(core.makeCitation('case', 'Acme, Inc. v. Beta, 2024 SCC 1', '2024 SCC 1').plain, 'Acme, Inc v Beta, 2024 SCC 1');
  assert.equal(core.makeCitation('legislation', 'Criminal Code, RSC 1985, c C-46', 'RSC 1985, c C-46').plain, 'Criminal Code, RSC 1985, c C-46');
  assert.equal(core.makeCitation('case', 'Acme, 2024 Holdings Ltd v. Beta | 2024 SCC 1', '2024 SCC 1').plain, 'Acme, 2024 Holdings Ltd v Beta, 2024 SCC 1');
  assert.equal(core.makeCitation('case', '1934 CanLII 376', '1934 CanLII 376').plain, '1934 CanLII 376');
  assert.equal(core.canliiUrlForCitation('1934 CanLII 376 (AB QB)'), 'https://www.canlii.org/en/ab/abqb/doc/1934/1934canlii376/1934canlii376.html');
  assert.equal(core.canliiUrlForCitation('1934 CanLII 376'), '', 'No invented court route');
  assert.equal(core.chooseCaseCitation(['1934 CanLII 376 (AB QB)', '[1934] 2 WWR 511'], 'en', ''), '[1934] 2 WWR 511', 'Retain reporter preference');
});

test('linear ancestor filtering equals the previous pairwise definition, including duplicates and invalid locators', () => {
  const nodes = [];
  for (let i = 1; i <= 80; i++) for (const suffix of ['', '(1)', '(1)(a)', '(2)', '(2)(i)']) nodes.push({ locator: `${i}${suffix}` });
  nodes.push({ locator: 'bad' }, { locator: '1' }, { locator: '1(1)(a)' }, { locator: ' 02 (x)' }, { locator: '02(x)' }, { locator: '02(x)(y)' });
  const expected = nodes.filter((n, i) => !nodes.some((other, j) => i !== j && core.isProvisionAncestor(n.locator, other.locator)));
  assert.deepEqual(Array.from(core.removeRedundantProvisionAncestors(nodes)), expected);
});
