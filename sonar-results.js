'use strict';

(function exposeResults(global) {
  const ROW_HEIGHT = 132, OVERSCAN = 3;
  function markedText(document, text, marks = []) {
    const fragment = document.createDocumentFragment();
    let offset = 0;
    for (const mark of marks) {
      if (!Number.isInteger(mark.start) || !Number.isInteger(mark.end) || mark.start < offset || mark.end <= mark.start || mark.start >= text.length) continue;
      fragment.append(document.createTextNode(text.slice(offset, mark.start)));
      const highlight = document.createElement('mark');
      highlight.textContent = text.slice(mark.start, mark.end); fragment.append(highlight);
      offset = Math.min(text.length, mark.end);
    }
    fragment.append(document.createTextNode(text.slice(offset)));
    return fragment;
  }
  function visibleRange(count, top, height) {
    const start = Math.max(0, Math.min(count, Math.floor(top / ROW_HEIGHT) - OVERSCAN));
    return { start, end: Math.min(count, start + Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2) };
  }
  class ResultsList {
    constructor(viewport, spacer, rows, choose) {
      Object.assign(this, { viewport, spacer, rows, choose, results: [], selected: -1, start: -1, end: -1, frame: 0 });
      this.onScroll = () => {
        if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.render(); });
      };
      viewport.addEventListener('scroll', this.onScroll, { passive: true });
      this.resize = new ResizeObserver(this.onScroll); this.resize.observe(viewport);
      rows.addEventListener('click', event => {
        const row = event.target.closest('[data-result]');
        if (row) choose(Number(row.dataset.result), true);
      });
      viewport.addEventListener('keydown', event => {
        const steps = { ArrowDown: 1, ArrowUp: -1, PageDown: Math.max(1, Math.floor(viewport.clientHeight / ROW_HEIGHT)), PageUp: -Math.max(1, Math.floor(viewport.clientHeight / ROW_HEIGHT)) };
        if (event.key in steps) {
          event.preventDefault(); choose(Math.max(0, Math.min(this.results.length - 1, this.selected + steps[event.key])), false);
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault(); choose(event.key === 'Home' ? 0 : this.results.length - 1, false);
        } else if (event.key === 'Enter' && this.selected >= 0) {
          event.preventDefault(); choose(this.selected, true);
        }
      });
    }
    setResults(results, selected = 0, top = 0) {
      this.results = results; this.selected = selected; this.start = this.end = -1;
      this.spacer.style.height = `${results.length * ROW_HEIGHT}px`;
      this.viewport.scrollTop = top; this.render();
    }
    select(index, scroll = true) {
      this.selected = index;
      if (scroll && index >= 0) {
        const top = index * ROW_HEIGHT, bottom = top + ROW_HEIGHT;
        if (top < this.viewport.scrollTop) this.viewport.scrollTop = top;
        else if (bottom > this.viewport.scrollTop + this.viewport.clientHeight) this.viewport.scrollTop = bottom - this.viewport.clientHeight;
      }
      this.render();
    }
    render() {
      const { start, end } = visibleRange(this.results.length, this.viewport.scrollTop, this.viewport.clientHeight);
      if (start !== this.start || end !== this.end) {
        const document = this.rows.ownerDocument, fragment = document.createDocumentFragment();
        for (let i = start; i < end; i++) {
          const result = this.results[i], row = document.createElement('div');
          row.className = 'result-row'; row.dataset.result = i; row.id = `sonar-result-${i}`;
          row.setAttribute('role', 'option'); row.setAttribute('aria-posinset', i + 1); row.setAttribute('aria-setsize', this.results.length);
          const title = document.createElement('div'); title.className = 'result-title'; title.textContent = result.title; title.title = result.title;
          const meta = document.createElement('div'); meta.className = 'result-meta';
          const label = document.createElement('span'), action = document.createElement('span');
          let site = ''; try { site = new URL(result.url).hostname; } catch (_) { /* Text only. */ }
          label.textContent = result.locator || site || 'Page text'; action.textContent = 'Open ↗'; meta.append(label, action);
          const text = document.createElement('p'); text.className = 'result-text';
          if (result.leading) text.append('…'); text.append(markedText(document, result.preview, result.marks)); if (result.trailing) text.append('…');
          row.append(title, meta, text); fragment.append(row);
        }
        this.rows.replaceChildren(fragment); this.rows.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
        this.start = start; this.end = end;
      }
      for (const row of this.rows.children) row.setAttribute('aria-selected', Number(row.dataset.result) === this.selected);
      if (this.selected >= start && this.selected < end) this.viewport.setAttribute('aria-activedescendant', `sonar-result-${this.selected}`);
      else this.viewport.removeAttribute('aria-activedescendant');
    }
  }
  const api = { ROW_HEIGHT, visibleRange, markedText, ResultsList };
  global.LegalPinpointerResults = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
