const {test} = require('node:test');
const assert = require('node:assert/strict');
require('../canlii-courts.js');
const core = require('../core.js');

test('Quebec neutral, CanLII and alias links use French', () => {
  for (const court of ['QCCA', 'QCCS', 'QCCQ', 'QCCM', 'QCTAT']) {
    const route = court.toLowerCase();
    assert.equal(core.canliiUrlForCitation(`2024 ${court} 7`),
      `https://www.canlii.org/fr/qc/${route}/doc/2024/2024${route}7/2024${route}7.html`);
    assert.equal(core.canliiUrlForCitation(`1999 CanLII 7 (${court})`),
      `https://www.canlii.org/fr/qc/${route}/doc/1999/1999canlii7/1999canlii7.html`);
    assert.equal(core.canliiUrlForAliasTarget(`qc/${route}/1999canlii7`),
      `https://www.canlii.org/fr/qc/${route}/doc/1999/1999canlii7/1999canlii7.html`);
  }
  assert.match(core.canliiUrlForCitation('2009 SCC 32'), /\/en\/ca\/scc\//);
  assert.match(core.canliiUrlForCitation('2009 SCC 32', 'fr'), /\/fr\/ca\/csc\//);
  assert.equal(core.canliiUrlForCitation('2024 UNKNOWN 7'), '');
});
