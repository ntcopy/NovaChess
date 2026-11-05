// Isolated-world content script. Owns chrome.storage and the theme; the page-world engine script
// (content/engine.js) cannot reach chrome.* so it talks to this one via postMessage.
//
// Theming has three layers so it still works however chess.com paints its board:
//   1. a stylesheet with boosted specificity (see buildCss in shared/common.js)
//   2. board detection: any square board-like element (chess.com's server-rendered `div#board`,
//      previews...) is tagged data-nova-board; if the board itself draws nothing, the wrapper or
//      ::before/::after that really paints it is tagged too
//   3. an inline !important fallback if the computed background still isn't ours
(() => {
    const SF = globalThis.SF;
    const ID = Math.random().toString(36).slice(2); // identifies writes made by this tab
    let state = SF.normalizeState(null);
    let lastCss = null;

    // ---------- theme stylesheet ----------
    // Created by the extension's isolated world, so the page's style-src CSP does not apply to it.
    const style = document.createElement('style');
    style.id = 'nova-theme';

    function mount() {
        const parent = document.head || document.documentElement;
        if (parent && style.parentNode !== parent) parent.appendChild(style);
    }

    // ---------- board detection ----------
    const BOARD_SEL = 'wc-chess-board, chess-board, #board.board, .board';
    const A_BOARD = 'data-nova-board';
    const A_PAINT = 'data-nova-paint';
    const A_PSEUDO = 'data-nova-pseudo';
    const tagged = new Set(); // elements carrying any of our attributes
    const inlined = new Map(); // element -> original style attribute (inline fallback)
    const ours = (v) => typeof v === 'string' && v.includes('conic-gradient');
    const hasImage = (v) => !!v && v !== 'none';
    const isNative = (el) =>
        el.localName === 'wc-chess-board' || el.localName === 'chess-board' || (el.id === 'board' && el.classList.contains('board'));

    function findBoards() {
        const set = new Set();
        for (const el of document.querySelectorAll(BOARD_SEL)) {
            if (isNative(el)) {
                set.add(el);
                continue;
            }
            // Other `.board` elements (previews, review boards): only if square and clearly a chess board.
            const r = el.getBoundingClientRect();
            if (r.width >= 100 && Math.abs(r.width / r.height - 1) < 0.07 && el.querySelector('.coordinates, .piece')) set.add(el);
        }
        return set;
    }

    // If the board element draws no image itself, find the bottom-most full-size layer that does.
    // (Never pick layers above it: chess.com's piece layer is a full-size image layer too.)
    function lowestPainter(board) {
        const r = board.getBoundingClientRect();
        if (r.width < 60 || r.height < 60) return null;
        let lowest = null;
        for (const [fx, fy] of [
                [0.5, 0.5],
                [0.3125, 0.4375],
                [0.6875, 0.5625]
            ]) {
            const stack = document.elementsFromPoint(r.left + r.width * fx, r.top + r.height * fy);
            for (let i = stack.length - 1; i >= 0; i--) {
                const el = stack[i];
                if (el === board || !board.contains(el) || el.closest('svg')) continue;
                const b = el.getBoundingClientRect();
                if (b.width >= r.width * 0.9 && b.height >= r.height * 0.9 && hasImage(getComputedStyle(el).backgroundImage)) {
                    lowest = lowest || el;
                    break; // bottom-most match in this stack
                }
            }
        }
        return lowest;
    }

    function pseudoOf(el) {
        const kinds = [];
        for (const w of ['before', 'after']) {
            const cs = getComputedStyle(el, `::${w}`);
            if (cs.content !== 'none' && cs.content !== 'normal' && hasImage(cs.backgroundImage)) kinds.push(w);
        }
        return kinds.join(' ');
    }

    function restoreInline(el) {
        if (!inlined.has(el)) return;
        const orig = inlined.get(el);
        if (orig === null) el.removeAttribute('style');
        else el.setAttribute('style', orig);
        inlined.delete(el);
    }

    function untag(el) {
        el.removeAttribute(A_BOARD);
        el.removeAttribute(A_PAINT);
        el.removeAttribute(A_PSEUDO);
        restoreInline(el);
        tagged.delete(el);
    }

    function inlineFallback(el) {
        if (!inlined.has(el)) inlined.set(el, el.getAttribute('style'));
        el.style.setProperty('background', SF.boardBackground(state.theme), 'important');
    }

    // Runs synchronously with our stylesheet switched off, so we measure the site's own styling and
    // nothing is painted in between (no flicker).
    function scan() {
        style.disabled = true;
        [...tagged].forEach(untag);
        if (state.theme.enabled) {
            for (const board of findBoards()) {
                const targets = [board];
                if (!isNative(board)) board.setAttribute(A_BOARD, '');
                tagged.add(board);
                if (!hasImage(getComputedStyle(board).backgroundImage)) {
                    const painter = lowestPainter(board);
                    if (painter) {
                        painter.setAttribute(A_PAINT, '');
                        tagged.add(painter);
                        targets.push(painter);
                    }
                }
                for (const el of targets) {
                    const kinds = pseudoOf(el);
                    if (kinds) {
                        el.setAttribute(A_PSEUDO, kinds);
                        tagged.add(el);
                    }
                }
            }
        }
        style.disabled = false;

        // Layer 3: if the stylesheet still lost (e.g. the site uses inline !important), force it inline.
        requestAnimationFrame(() => {
            for (const el of tagged) {
                const paints = el.hasAttribute(A_PAINT) || el.hasAttribute(A_BOARD) || isNative(el);
                if (paints && !ours(getComputedStyle(el).backgroundImage)) inlineFallback(el);
            }
        });
    }

    let scanTimer;
    const scanSoon = (ms = 250) => {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scan, ms);
    };

    function applyCss() {
        const css = SF.buildCss(state.theme);
        if (css !== lastCss) {
            style.textContent = css;
            lastCss = css;
            scanSoon(30); // colours changed: redo tags and inline fallbacks
        }
        mount();
    }
    // Re-append once <head> exists so we sit after chess.com's own stylesheets.
    document.addEventListener('DOMContentLoaded', () => {
        mount();
        scanSoon();
    });
    window.addEventListener('load', () => {
        mount();
        scanSoon();
    });

    // Boards appear and re-render as chess.com navigates. Rescan when a new one shows up.
    const isBoardish = (n) => n.nodeType === 1 && (n.matches?.(BOARD_SEL) || n.querySelector?.(BOARD_SEL));
    new MutationObserver((muts) => {
        if (muts.some((m) => [...m.addedNodes].some(isBoardish))) scanSoon(150);
    }).observe(document, {
        childList: true,
        subtree: true
    });
    setInterval(() => {
        const b = document.querySelector(`${BOARD_SEL}`);
        if (b && !b.hasAttribute('data-nova-seen')) {
            b.setAttribute('data-nova-seen', '');
            scanSoon(100);
        }
    }, 1000);

    // ---------- troubleshooting report (popup "Inspect board" button) ----------
    const short = (v, n = 90) => (v && v.length > n ? v.slice(0, n) + '…' : v);
    const desc = (el) => `${el.localName}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 3).join('.') : ''}`;

    function diagnose() {
        const out = [];
        const boards = [...findBoards()];
        out.push(`NovaChess diagnostics  ${location.pathname}`);
        out.push(`theme enabled: ${state.theme.enabled}  preset: ${state.theme.preset}`);
        out.push(`stylesheet: ${style.isConnected ? 'mounted' : 'NOT MOUNTED'}, ${style.sheet?.cssRules.length ?? '?'} rules`);
        out.push(`boards found: ${boards.length}`);
        boards.forEach((b, i) => {
            const r = b.getBoundingClientRect();
            const cs = getComputedStyle(b);
            out.push('', `[board ${i}] <${desc(b)}> ${Math.round(r.width)}x${Math.round(r.height)}  shadowRoot: ${!!b.shadowRoot}`);
            out.push(`  background-image: ${short(cs.backgroundImage)}  ${ours(cs.backgroundImage) ? '(OURS)' : '(NOT ours)'}`);
            out.push(`  inline style: ${short(b.getAttribute('style') || '(none)', 120)}`);
            for (const w of ['before', 'after']) {
                const p = getComputedStyle(b, `::${w}`);
                if (p.content !== 'none' && p.content !== 'normal') out.push(`  ::${w} content=${p.content} bg=${short(p.backgroundImage)}`);
            }
            out.push(`  children: ${[...b.children].slice(0, 6).map(desc).join(', ')}${b.children.length > 6 ? ', …' : ''}`);
            out.push('  stack at board centre (top to bottom):');
            for (const el of document.elementsFromPoint(r.left + r.width / 2, r.top + r.height / 2).slice(0, 8)) {
                const e = getComputedStyle(el);
                const eb = el.getBoundingClientRect();
                const marks = [A_BOARD, A_PAINT].filter((a) => el.hasAttribute(a)).map((a) => `[${a.replace('data-', '')}]`).join('') +
                    (el.hasAttribute(A_PSEUDO) ? `[nova-pseudo=${el.getAttribute(A_PSEUDO)}]` : '');
                out.push(`    <${desc(el)}> ${Math.round(eb.width)}x${Math.round(eb.height)} bg=${short(e.backgroundImage, 60)} ${marks}`);
            }
        });
        out.push('', `tagged elements: ${[...tagged].map(desc).join(', ') || '(none)'}`);
        out.push(`inline fallbacks: ${[...inlined.keys()].map(desc).join(', ') || '(none)'}`);
        const hl = document.querySelector('wc-chess-board .highlight, chess-board .highlight');
        if (hl) out.push(`highlight: ${getComputedStyle(hl).backgroundColor} opacity ${getComputedStyle(hl).opacity}`);

        // chess.com themes pieces and the board through --theme-* custom properties.
        const vars = [];
        const holders = new Set([document.documentElement, document.body, ...boards, ...boards.map((b) => b.parentElement)]);
        for (const el of holders) {
            if (!el) continue;
            for (const name of el.style)
                if (name.startsWith('--')) vars.push(`${desc(el)} ${name}: ${short(el.style.getPropertyValue(name), 70)}`);
        }
        out.push('', `inline custom properties: ${vars.length ? '\n  ' + vars.slice(0, 20).join('\n  ') : '(none)'}`);

        // Readable stylesheet rules that mention the board and set a background.
        const rules = [];
        let blocked = 0;
        const walk = (list) => {
            for (const rule of list) {
                if (rule.cssRules && !rule.selectorText) walk(rule.cssRules);
                else if (rule.selectorText && /board/.test(rule.selectorText) && /background/.test(rule.style?.cssText || '')) {
                    rules.push(`${short(rule.selectorText, 70)} { ${short(rule.style.cssText, 130)} }`);
                }
            }
        };
        for (const sheet of document.styleSheets) {
            if (sheet.ownerNode === style) continue;
            try {
                walk(sheet.cssRules);
            } catch {
                blocked++;
            }
        }
        out.push(`board background rules in readable stylesheets (${blocked} cross-origin sheets unreadable):`);
        out.push(...(rules.length ? rules.slice(0, 15).map((r) => '  ' + r) : ['  (none found)']));
        return out.join('\n');
    }

    try {
        chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
            if (msg?.type === 'nova-diagnose') {
                scan();
                reply(diagnose());
            }
        });
    } catch {
        /* ignore */
    }

    // ---------- storage <-> page ----------
    const post = (type, extra) => window.postMessage({
        __sf: 1,
        type,
        ...extra
    }, location.origin);

    async function load() {
        try {
            const r = await chrome.storage.local.get('sf');
            state = SF.normalizeState(r.sf);
        } catch {
            /* extension was reloaded: keep defaults */
        }
        applyCss();
    }

    async function writeEngine(engine) {
        try {
            const r = await chrome.storage.local.get('sf');
            const cur = SF.normalizeState(r.sf);
            cur.engine = SF.normalizeEngine(engine);
            cur.meta = {
                by: ID
            };
            await chrome.storage.local.set({
                sf: cur
            });
        } catch {
            /* extension context invalidated */
        }
    }

    window.addEventListener('message', (e) => {
        if (e.source !== window || e.data?.__sf !== 1) return;
        if (e.data.type === 'hello') post('state', {
            state
        });
        else if (e.data.type === 'engine-settings') writeEngine(e.data.engine);
    });

    try {
        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== 'local' || !changes.sf) return;
            state = SF.normalizeState(changes.sf.newValue);
            applyCss();
            // Don't echo this tab's own in-page edits back at it.
            if (state.meta.by !== ID) post('state', {
                state
            });
        });
    } catch {
        /* ignore */
    }

    load().then(() => post('state', {
        state
    }));
})();