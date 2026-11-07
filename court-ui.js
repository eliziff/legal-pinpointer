'use strict';

// Court decision pages on Lexum/Decisia sites (decisions.scc-csc.ca, the Federal Courts', the
// Ontario Court of Appeal's and the other courts' sites): the decision's frame gets what CanLII,
// Westlaw and Lexis pages have. Beside the title, the CanLII button (lit once the decision's CanLII
// version is identified from the page's own metadata) and Copy link. Along the top of the frame,
// once the title has scrolled away, a bar with the full name and citation and the same buttons.
//
// Nothing moves the page: the title's buttons are out of flow at its end, and the bar is fixed, in
// its own shadow root, click-through outside the bar. The copy needs no engine: the name and
// neutral citation are the page's own, linked to the CanLII version (else this page).
(function startCourtUi() {
  if (globalThis.LegalPinpointerCourtUi) return;
  globalThis.LegalPinpointerCourtUi = true;
  const PAGE = /^https:\/\/[^/]+\/[^/]+\/[^/]+\/(?:en|fr)\/item\/\d+\/index\.do/;
  if (!PAGE.test(location.href)) return;

  const CANLII_LOGO = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="2640.1 4.7 685.6 685.6"><g transform="matrix(1.33,0,0,-1.33,-51.85,911.22)"><g><g><g transform="translate(1366.69,215.90)"></g><g transform="translate(1822.88,431.36)"></g><g transform="translate(908.24,339.35)"></g><g transform="translate(1697.10,238.79)"></g><g transform="translate(504.64,273.00)"></g><g transform="translate(237.02,626.65)"></g><g transform="translate(506.37,271.47)"></g><g transform="translate(1974.78,669.64)"></g><g transform="translate(500.98,275.13)"></g><g transform="translate(502.71,273.59)"></g><g transform="translate(2488.91,367.05)"><path d="m 0,0 49.26,65.91 -79.71,2.34 0.29,52.55 -83.35,-34.54 71.16,113.27 -61.84,10.96 -9.15,102.98 -83.89,-74.10 -49.20,43.22 -20.25,-145.77 -40.78,99.91 -39.88,-41.18 -54.08,49.81 -7.68,-88.29 -55.23,-4.56 91.47,-139.03 5.77,-9.82 -31.36,-46.42 110.42,-20.47 -57.34,-109.91 62.40,-27.90 41.29,120.43 99.02,-63.83 -1.18,67.44 172.52,37.22 z" style="fill:#bb2119;fill-rule:nonzero"></path></g><g transform="translate(2489.93,368.69)"><path d="m 0,0 48.95,66.14 -79.72,1.96 0.04,52.55 -83.18,-34.93 70.62,113.61 -61.89,10.66 -9.64,102.94 -83.54,-74.49 -49.40,42.99 -19.57,-145.87 -41.25,99.72 -39.68,-41.37 -54.32,49.55 -7.27,-88.32 -55.21,-4.82 92.12,-138.60 5.82,-9.79 -31.14,-46.56 110.51,-19.95 -56.82,-110.18 62.53,-27.60 40.72,120.63 99.32,-63.36 -1.50,67.43 172.34,38.03 z" style="fill:#bb2119;fill-rule:nonzero"></path></g><g transform="translate(2195.26,379.91)"></g><g transform="translate(2363.50,463.28)"></g></g></g></g></svg>';
  const CANLII_ICON = `url("data:image/svg+xml,${encodeURIComponent(CANLII_LOGO)}")`;
  const LINK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
  const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const escapeHtml = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const settings = { providerHeader: true, canliiButton: true };
  const state = { name: '', canliiUrl: '', pageUrl: location.href.split(/[?#]/)[0] };

  const CSS = `
    :host { all: initial; }
    .tools { display: inline-flex; gap: 2px; margin-left: 8px; vertical-align: middle; }
    .bar { position: fixed; top: 0; left: 0; right: 0; display: flex; align-items: center; gap: 8px; box-sizing: border-box; min-height: 38px;
      padding: 5px 8px; border-bottom: 1px solid #e5e7eb; background: #fff; color: #111827;
      box-shadow: 0 1px 3px rgb(0 0 0 / 6%), 0 6px 16px -10px rgb(0 0 0 / 18%);
      font: 600 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif;
      opacity: 0; transform: translateY(-100%); pointer-events: none; transition: opacity 120ms, transform 140ms ease-out; }
    .bar.ready { opacity: 1; transform: none; pointer-events: auto; }
    .name { flex: 1; min-width: 0; overflow-wrap: break-word; user-select: text; cursor: text; }
    a { display: grid; flex: none; place-items: center; box-sizing: border-box; width: 26px; height: 26px; border: 1px solid #e5e7eb;
      border-radius: 6px; background: #fff; cursor: pointer; transition: border-color 80ms, box-shadow 80ms, opacity 120ms; }
    a::before { content: ""; width: 16px; height: 16px; background: ${CANLII_ICON} center / contain no-repeat; }
    a.live:hover { border-color: #f3b4ae; box-shadow: 0 1px 4px rgb(213 43 30 / 18%); }
    a:not(.live) { opacity: .3; filter: grayscale(1); cursor: default; }
    a[hidden] { display: none; }
    button { all: unset; display: inline-flex; flex: none; align-items: center; gap: 6px; box-sizing: border-box; height: 26px; padding: 0 7px;
      border-radius: 6px; color: #374151; font: 500 12px/1 system-ui, -apple-system, "Segoe UI", sans-serif; cursor: pointer; transition: background-color 80ms, color 80ms; }
    button:hover { background: #fff1f0; color: #b72016; }
    button:focus-visible, a:focus-visible { outline: 2px solid #d52b1e; outline-offset: 1px; }
    button svg { width: 15px; height: 15px; }
    button.done { color: #111827; background: #f3f4f6; }
    button.done span::after { content: "Copied"; }
    button:not(.done) span::after { content: "Copy link"; }
    .tools button span { display: none; }
    @media print { .bar, .tools { display: none; } }
  `;

  function shadowHost(style) {
    const host = document.createElement('span');
    host.setAttribute('data-lp-ui', '');
    host.style.cssText = style;
    const shadow = host.attachShadow({ mode: 'open' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];
    return { host, shadow };
  }
  const buttons = () => '<a class="canlii" aria-label="CanLII" title="Looking for the CanLII version"></a>'
    + `<button type="button" class="copy" aria-label="Copy the linked name and citation" title="Copy the linked name and citation">${LINK_ICON}<span></span></button>`;

  let title = null, tools = null, bar = null, observer = null, titleVisible = true;

  function paint() {
    for (const root of [tools, bar].filter(Boolean)) {
      const link = root.querySelector('a.canlii');
      link.hidden = !settings.canliiButton;
      link.classList.toggle('live', Boolean(state.canliiUrl));
      if (state.canliiUrl) Object.assign(link, { href: state.canliiUrl, target: '_blank', rel: 'noopener', title: 'Open on CanLII' });
    }
    if (bar) bar.querySelector('.name').textContent = state.name;
  }

  function showBar() {
    bar?.classList.toggle('ready', settings.providerHeader && !titleVisible);
  }

  function mount() {
    title = document.querySelector('h3.title');
    if (!title || tools) return Boolean(title);
    const meta = new Map(Array.from(document.querySelectorAll('.metadata tr'), (row) => [clean(row.cells[0]?.textContent).toLowerCase(), clean(row.cells[1]?.textContent)]));
    const own = clean(title.textContent), citation = meta.get('neutral citation') || meta.get('report') || '';
    state.name = citation && !own.includes(citation) ? `${own}, ${citation}` : own;
    // Beside the title, out of flow.
    const inline = shadowHost('all:initial;display:inline;');
    inline.shadow.innerHTML = `<span class="tools">${buttons()}</span>`;
    title.appendChild(inline.host);
    tools = inline.shadow.querySelector('.tools');
    // Along the top of the frame.
    const fixed = shadowHost('all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483645;');
    fixed.shadow.innerHTML = `<div class="bar" role="toolbar" aria-label="Citation">${buttons().replace('<button', '<span class="name"></span><button')}</div>`;
    document.documentElement.appendChild(fixed.host);
    bar = fixed.shadow.querySelector('.bar');
    for (const root of [tools, bar]) root.addEventListener('click', onClick);
    observer = new IntersectionObserver(([entry]) => { titleVisible = entry.isIntersecting || !title.getClientRects().length; showBar(); });
    observer.observe(title);
    paint();
    identify(Array.from(meta.values()).filter(Boolean).join(' | ').slice(0, 4000));
    return true;
  }

  function identify(text) {
    if (!text) return;
    chrome.runtime.sendMessage({ type: 'LEGAL_PINPOINTER_CASE_IDENTITY', text }).then((response) => {
      if (response?.ok && /^https:\/\/(?:www\.)?canlii\.org\//.test(response.canliiUrl || '')) state.canliiUrl = response.canliiUrl;
      paint();
      for (const root of [tools, bar]) {
        const link = root.querySelector('a.canlii');
        if (!state.canliiUrl) link.title = 'No CanLII version found';
      }
    }, () => {});
  }

  async function onClick(event) {
    const button = event.target.closest('button.copy');
    if (!button) return;
    const url = state.canliiUrl || state.pageUrl;
    const plain = state.name, html = `<a href="${escapeHtml(url)}">${escapeHtml(state.name)}</a>`;
    // A copy event, so Word pastes the link without a paragraph of its own.
    let copied = false;
    const onCopy = (copy) => { copy.preventDefault(); copy.stopImmediatePropagation(); copy.clipboardData.setData('text/plain', plain); copy.clipboardData.setData('text/html', html); copied = true; };
    document.addEventListener('copy', onCopy, { once: true, capture: true });
    try { document.execCommand('copy'); } finally { document.removeEventListener('copy', onCopy, true); }
    if (!copied) {
      try { await navigator.clipboard.write([new ClipboardItem({ 'text/plain': new Blob([plain], { type: 'text/plain' }), 'text/html': new Blob([html], { type: 'text/html' }) })]); } catch (_) { return; }
    }
    button.classList.add('done');
    setTimeout(() => button.classList.remove('done'), 900);
  }

  chrome.storage.local.get(settings, (stored) => {
    Object.assign(settings, stored);
    if (!mount()) {
      // The title is parsed after this script ran: wait for it, then stop watching.
      const watcher = new MutationObserver(() => { if (mount()) watcher.disconnect(); });
      watcher.observe(document, { childList: true, subtree: true });
      addEventListener('load', () => { mount(); watcher.disconnect(); }, { once: true });
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of Object.keys(settings)) if (changes[key]) settings[key] = changes[key].newValue ?? settings[key];
    paint();
    showBar();
  });
})();
