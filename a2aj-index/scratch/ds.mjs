import {chromium} from 'playwright';
const b = await chromium.launch({headless: true}); const p = await b.newPage();
await p.goto('about:blank');
console.log(await p.evaluate(() => ['gzip','deflate','deflate-raw','brotli','zstd'].map(f => { try { new DecompressionStream(f); return f + ':yes'; } catch (e) { return f + ':no'; } }).join(' ') + ' ' + navigator.userAgent));
await b.close();
