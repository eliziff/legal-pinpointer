'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

global.LegalPinpointerCanliiCourts = require('../canlii-courts.js');
const core = require('../core.js');
global.LegalPinpointerTextFragments = {};
const providers = require('../providers.js');

test('collapses paragraph and provision runs using legal citation notation', () => {
  assert.equal(core.formatPinpoint('paragraph', ['12', '13', '14', '15', '17', '18'], 'bare'), '12-15, 17-18');
  assert.equal(core.formatPinpoint('paragraph', ['12'], 'full'), 'para 12');
  assert.equal(core.formatPinpoint('paragraph', ['12', '13'], 'full'), 'paras 12-13');
  assert.equal(core.formatPinpoint('section', ['7(2)', '7(3)', '7(4)'], 'bare'), '7(2)-(4)');
  assert.equal(core.formatPinpoint('section', ['7(2)', '7(3)', '7(4)'], 'full'), 'ss 7(2)-(4)');
  assert.equal(core.formatPinpoint('page', ['353'], 'full'), 'at p. 353');
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
  assert.equal(citation.plain, 'ADULT GUARDIANSHIP (ABUSE AND NEGLECT) REGULATION, B.C. Reg. 13/2000');
  assert.equal(citation.html, '<i>ADULT GUARDIANSHIP (ABUSE AND NEGLECT) REGULATION</i>, B.C. Reg. 13/2000');
  assert.equal(
    core.outputCitationLink(citation, 'https://www.canlii.org/en/bc/laws/regu/bc-reg-13-2000/latest/bc-reg-13-2000.html').html,
    '<i>ADULT GUARDIANSHIP (ABUSE AND NEGLECT) REGULATION</i>, <a href="https://www.canlii.org/en/bc/laws/regu/bc-reg-13-2000/latest/bc-reg-13-2000.html">B.C. Reg. 13/2000</a>'
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
