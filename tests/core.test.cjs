'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

global.LegalPinpointerCanliiCourts = require('../canlii-courts.js');
const core = require('../core.js');
global.LegalPinpointerTextFragments = {};
const providers = require('../providers.js');

test('collapses paragraph and provision runs using legal citation notation', () => {
  assert.equal(core.formatPinpoint('paragraph', ['12', '13', '14', '15', '17', '18'], 'bare'), '12-15, 17-18');
  assert.equal(core.formatPinpoint('paragraph', ['12'], 'full'), 'at para 12');
  assert.equal(core.formatPinpoint('paragraph', ['12', '13'], 'full'), 'at paras 12-13');
  assert.equal(core.formatPinpoint('section', ['7(2)', '7(3)', '7(4)'], 'bare'), '7(2)-(4)');
  assert.equal(core.formatPinpoint('section', ['7(2)', '7(3)', '7(4)'], 'full'), 'ss 7(2)-(4)');
  assert.equal(core.formatPinpoint('page', ['353'], 'full'), 'at 353');
  assert.equal(core.formatPinpoint('page', ['553', '559'], 'full'), 'at 553, 559');
  assert.equal(core.formatPinpoint('page', ['553', '554', '555'], 'full'), 'at 553-555');
  assert.equal(core.formatPinpoint('pilcrow', ['12'], 'bare'), '\u00b6 12');
  assert.equal(core.formatPinpoint('silcrow', ['12.02'], 'full'), '\u00a7 12.02');
});

test('prefers a bounded neutral citation and cleans provider title additions', () => {
  assert.equal(
    core.chooseCaseCitation(['[2019] A.J. No. 144 | 2019 ABCA 49 | 2019 CarswellAlta 203'], 'en', ''),
    '2019 ABCA 49'
  );
  assert.equal(core.cleanPlatformTitle('Quebec (Attorney General) v Denis | Westlaw Advantage Canada'), 'Quebec (Attorney General) v Denis');
  const citation = core.makeCitation('case', 'R. v. Grant (S.C.C.)', '2009 SCC 32');
  assert.equal(citation.plain, 'R v Grant, 2009 SCC 32');
  assert.deepEqual(
    core.outputCitationLink(citation, 'https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html'),
    {
      plain: 'R v Grant, 2009 SCC 32',
      html: '<i>R v Grant</i>, <a href="https://www.canlii.org/en/ca/scc/doc/2009/2009scc32/2009scc32.html">2009 SCC 32</a>'
    }
  );
});

test('italicizes only the legislation title when a provider combines its heading and citation', () => {
  const citation = core.makeCitation(
    'legislation',
    'ADULT GUARDIANSHIP (ABUSE AND NEGLECT) REGULATION, B.C. Reg. 13/2000, s. 1',
    ''
  );
  assert.equal(citation.plain, 'ADULT GUARDIANSHIP (ABUSE AND NEGLECT) REGULATION, BC Reg 13/2000');
  assert.equal(citation.html, '<i>ADULT GUARDIANSHIP (ABUSE AND NEGLECT) REGULATION</i>, BC Reg 13/2000');
  assert.equal(
    core.outputCitationLink(citation, 'https://www.canlii.org/en/bc/laws/regu/bc-reg-13-2000/latest/bc-reg-13-2000.html').html,
    '<i>ADULT GUARDIANSHIP (ABUSE AND NEGLECT) REGULATION</i>, <a href="https://www.canlii.org/en/bc/laws/regu/bc-reg-13-2000/latest/bc-reg-13-2000.html">BC Reg 13/2000</a>'
  );
});

test('a provider alias remains detectable even when surrounding text is concatenated', () => {
  assert.equal(core.chooseCaseCitation(['[2009] 2 SCR 353 | 2009 SCC 32', 'R v Grant'], 'en', '[2009] 2 SCR 353'), '2009 SCC 32');
  assert.deepEqual(core.neutralCitations('2009 SCC 32Donnohue Grant'), []);
});

test('uses the exact CanLII court table and abstains for an unknown court', () => {
  assert.equal(
    core.canliiUrlForCitation('Weir-Jones Technical Services Inc v Purolator Courier Ltd, 2019 ABCA 49', 'en'),
    'https://www.canlii.org/en/ab/abca/doc/2019/2019abca49/2019abca49.html'
  );
  assert.equal(
    core.canliiUrlForCitation('Reference re Greenhouse Gas Pollution Pricing Act, 2021 SCC 11', 'fr'),
    'https://www.canlii.org/fr/ca/csc/doc/2021/2021csc11/2021csc11.html'
  );
  assert.equal(core.canliiUrlForCitation('Example v Example, 2024 XYZZY 1', 'en'), '');
});

test('cleans provider URLs without inventing a durable identifier', () => {
  assert.equal(
    core.cleanProviderUrl('westlaw', 'https://nextcanada.westlaw.com/Document/I123?transitionType=Default&contextData=x#co_anchor'),
    'https://nextcanada.westlaw.com/Document/I123'
  );
  assert.equal(
    core.cleanProviderUrl('lexis', 'https://advance.lexis.com/document/?pdmfid=1516831&crid=discard&pddocfullpath=%2Fshared%2Fdocument%2Fcases-ca%2Furn%3AcontentItem%3A1&pdcontentcomponentid=280675'),
    'https://advance.lexis.com/document/?pdmfid=1516831&pddocfullpath=%2Fshared%2Fdocument%2Fcases-ca%2Furn%3AcontentItem%3A1&pdcontentcomponentid=280675'
  );
  assert.equal(
    core.cleanProviderUrl('lexis', 'https://advance.lexis.com/document/?pdmfid=1505209&crid=discard&pddocfullpath=%2Fshared%2Fdocument%2Fanalytical-materials-ca%2Furn%3AcontentItem%3A1&pdtocnodeidentifier=AAKAADAAC'),
    'https://advance.lexis.com/document/?pdmfid=1505209&pddocfullpath=%2Fshared%2Fdocument%2Fanalytical-materials-ca%2Furn%3AcontentItem%3A1&pdtocnodeidentifier=AAKAADAAC'
  );
});

test('builds provider pinpoint URLs from exact native anchors', () => {
  assert.equal(
    core.withFragment('https://nextcanada.westlaw.com/Document/I123', '#crsw_paragraph_num_13'),
    'https://nextcanada.westlaw.com/Document/I123#crsw_paragraph_num_13'
  );
  assert.equal(
    core.withFragment(
      'https://advance.lexis.com/document/?pdmfid=1505209&pddocfullpath=%2Fshared%2Fdocument%2Fcases-ca%2Furn%3AcontentItem%3A1&pdcontentcomponentid=281027',
      '#PARA_13_650000'
    ),
    'https://advance.lexis.com/document/?pdmfid=1505209&pddocfullpath=%2Fshared%2Fdocument%2Fcases-ca%2Furn%3AcontentItem%3A1&pdcontentcomponentid=281027#PARA_13_650000'
  );
  assert.equal(core.canliiAnchorForLocator('section', '1(u)'), '#sec1subsecu');
  assert.equal(core.canliiAnchorForLocator('section', '1(u)(iii)'), '', 'CanLII exposes no documented named anchor below subsection level.');
});

test('keeps provider anchors attached to detected secondary-source symbols', () => {
  const westlawAnchor = { id: 'co_anchor_1_2_1', textContent: '', previousElementSibling: null };
  const westlawMarker = {
    id: '', textContent: '¶ 12 Text', previousElementSibling: westlawAnchor,
    querySelector: () => null, closest: () => null
  };
  assert.equal(providers.providerAnchorId(westlawMarker), 'co_anchor_1_2_1');

  const lexisMarker = {
    id: '', textContent: '§ 7 Text', previousElementSibling: null,
    querySelector: () => ({ id: 'PARA_7_650000' }), closest: () => null
  };
  assert.equal(providers.providerAnchorId(lexisMarker), 'PARA_7_650000');
});


test('legislation titles are split even when citation metadata is present', () => {
  assert.equal(core.makeCitation('legislation', 'Example Act, RSA 2000, c E-1', 'RSA 2000, c E-1').plain,
    'Example Act, RSA 2000, c E-1');
});


test('case citations follow McGill: neutral, printed reporter, CanLII, then the provider database', () => {
  const reporters = '175 NR 1 | [1994] 1 SCR 100';
  const carswell = '1994 CarswellNat 99';
  const lexis = '[1994] S.C.J. No. 12';
  const canlii = '1994 CanLII 17 (SCC)';
  assert.equal(core.chooseCaseCitation([reporters, carswell, lexis, canlii, '1994 SCC 7'], 'en', '', 'westlaw'), '1994 SCC 7');
  assert.equal(core.chooseCaseCitation([reporters, carswell, lexis, canlii], 'en', '', 'westlaw'), '[1994] 1 SCR 100');
  assert.equal(core.chooseCaseCitation(['[1964] S.C.R. 642, [1965] 2 C.C.C. 129, 50 D.L.R. (2d) 80'], 'en', '', 'westlaw'), '[1964] SCR 642');
  assert.equal(core.chooseCaseCitation(['12 Alta. L.R. (3d) 45 | 1994 CarswellAlta 9'], 'en', '', 'westlaw'), '12 Alta LR (3d) 45');
  assert.equal(core.chooseCaseCitation([carswell, lexis, canlii], 'en', '', 'westlaw'), canlii);
  assert.equal(core.chooseCaseCitation([lexis, carswell], 'en', '', 'westlaw'), '1994 CarswellNat 99 (WL Can)');
  assert.equal(core.chooseCaseCitation([carswell, lexis], 'en', '', 'lexis'), '[1994] SCJ No 12 (QL)');
  assert.equal(core.chooseCaseCitation(['86 ACWS (3d) 1109 | J.E. 99-703'], 'en', carswell, 'westlaw'), '1994 CarswellNat 99 (WL Can)');
  assert.equal(core.chooseCaseCitation(['2019 CARSWELLALTA 203 | 2019 CanLII 111 (AB CA)'], 'en', ''), '2019 CanLII 111 (AB CA)');
  assert.deepEqual(core.neutralCitations('1994 NR 100 | 2019 CARSWELLALTA 203 | 2019 CANLII 111'), []);
  assert.equal(core.canliiUrlForCitation(canlii, 'en'), 'https://www.canlii.org/en/ca/scc/doc/1994/1994canlii17/1994canlii17.html');
  assert.equal(core.canliiUrlForCitation(carswell, 'en'), '');
  assert.equal(core.canliiUrlForCitation(lexis, 'en'), '');
  assert.equal(core.chooseCaseCitation(['2019 ABCA 49', '2009 SCC 32'], 'en', ''), '2019 ABCA 49');
  assert.equal(core.chooseCaseCitation(['2009 SCC 32 | 2009 CSC 32'], 'fr', ''), '2009 CSC 32');
});

test('case names follow McGill party conventions', () => {
  const name = (value) => core.makeCitation('case', value, '').title;
  assert.equal(name('Sikyea v. R.'), 'Sikyea v R');
  assert.equal(name('The King v. Central Railway Signal Co.'), 'R v Central Railway Signal Co');
  assert.equal(name('Her Majesty the Queen v. N.P.D.'), 'R v NPD');
  assert.equal(name('Canada (Attorney General) v. Bedford Holdings Ltd.'), 'Canada (AG) v Bedford Holdings Ltd');
  assert.equal(name('Québec (Procureur général) c. Ward Inc.'), 'Québec (PG) c Ward Inc');
  assert.equal(name('A-M. A. v College of Registered Psychotherapists'), 'A-M A v College of Registered Psychotherapists');
  assert.equal(name('669779 Ontario Ltd. (c.o.b. CSA Transportation) (Re)'), 'Re 669779 Ontario Ltd (cob CSA Transportation)');
  assert.equal(name('TC, Local 31 and 669779 Ontario Ltd., Re'), 'Re TC, Local 31 and 669779 Ontario Ltd');
  assert.equal(name('Paron Construction v. Town Drywall et al.'), 'Paron Construction v Town Drywall');
  assert.equal(name('EGALE Canada Inc. v. Canada (Attorney General of)'), 'EGALE Canada Inc v Canada (AG)');
  assert.equal(core.articleCitation({ authors: ['Adam M Dodek'], title: 'Regulating Law Firms in Canada', year: '2012', volume: '90', issue: '2', journal: 'Canadian Bar Review', firstPage: '381' }).plain, 'Adam M Dodek, “Regulating Law Firms in Canada” (2012) 90:2 Canadian Bar Review 381');
});

test('provision pinpoints state a shared section number once', () => {
  assert.equal(core.formatPinpoint('section', ['20(a)', '20(b)(i)'], 'full'), 'ss 20(a), (b)(i)');
  assert.equal(core.formatPinpoint('section', ['20(c)', '21(a)'], 'full'), 'ss 20(c), 21(a)');
  assert.equal(core.formatPinpoint('section', ['7(2)', '7(3)', '7(4)'], 'full'), 'ss 7(2)-(4)');
  assert.equal(core.formatPinpoint('paragraph', ['32', '33', '35'], 'full'), 'at paras 32-33, 35');
});

test('Quebec statutes on CanLII link to LegisQuebec section ids', () => {
  const quebec = 'https://www.canlii.org/en/qc/laws/stat/cqlr-c-r-6.01/latest/cqlr-c-r-6.01.html';
  assert.equal(core.canliiAnchorForLocator('section', '18.1(2)', quebec), '#se:18_1');
  assert.equal(core.canliiAnchorForLocator('section', '18', quebec), '#se:18');
  assert.equal(core.canliiAnchorForLocator('section', '18(2)'), '#sec18subsec2');
});
