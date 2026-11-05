// NovaChess: page-side engine UI. Runs in the page's MAIN world so it can read
// wc-chess-board.game. It never touches chrome.*; settings and themes arrive from the isolated
// bridge (content/bridge.js) over window.postMessage.
//
(() => {
    const SF = globalThis.SF;
    if (!SF || window.__novaEngineLoaded) return;
    window.__novaEngineLoaded = true;

    // ---------- Fixed config ----------
    const OPPONENT_MOVE_TIME_MS = 600; // eval-bar-only search while the opponent is to move
    const BAR_SIDE = 'left'; // 'left' | 'right'
    const BAR_W = 26;

    // ---------- Shared state (survives board re-creation) ----------
    const CFG = {
        enabled: true,
        serverUrl: SF.DEFAULT_URL
    };
    const S = {
        ...SF.DEFAULT_ENGINE,
        autoplay: false,
        humanization: false
    }; // autoplay always starts off
    const ENGINE_PATHS = [
      /^\/play\/computer/,
      /^\/game\/computer/,
      /^\/analysis/,
      /^\/game\/\d+$/,
      /^\/play\/online/,
      /^\/play\/coach$/
    ];
    let T = SF.normalizeTheme(null);
    let confirmAutoplay = SF.DEFAULT_SETTINGS.confirmAutoplay;
    let themeKey = JSON.stringify(T);
    let session = null;

    const post = (type, extra) => window.postMessage({
        __sf: 1,
        type,
        ...extra
    }, location.origin);
    const persist = () => post('engine-settings', {
        engine: SF.normalizeEngine(S)
    });
    const autoplayConfirmations = new Map();

    window.addEventListener('message', (event) => {
        if (event.source !== window || event.origin !== location.origin) return;

        const data = event.data;
        if (data?.type !== 'NOVACHESS_AUTOPLAY_CONFIRM_RESULT') return;

        const resolve = autoplayConfirmations.get(data.requestId);
        if (!resolve) return;

        autoplayConfirmations.delete(data.requestId);
        resolve(data.approved === true);
    });

    function requestAutoplayConfirmation() {
        const requestId = crypto.randomUUID();

        return new Promise(resolve => {
            autoplayConfirmations.set(requestId, resolve);

            window.postMessage({
                type: 'NOVACHESS_AUTOPLAY_CONFIRM',
                requestId
            }, location.origin);
        });
    }

    // ---------- Theme-derived colours ----------
    const ACC = () => (T.enabled ? T.accent : '#2fbf71');
    const PAL = () => [ACC(), '#3b9cff', '#f5a623', '#b57cff', '#ff6b81'];
    const barColors = () =>
        T.enabled ? {
            w: T.light,
            b: SF.mix(T.dark, '#000000', 0.5)
        } : {
            w: '#f2f2f2',
            b: '#262421'
        };
    const textOn = (bg) => (SF.lum(bg) > 0.45 ? '#222' : '#eee');

    // ---------- Small helpers (styling via CSSOM so page CSP can't block it) ----------
    const h = (tag, style, text) => {
        const n = document.createElement(tag);
        if (style) Object.assign(n.style, style);
        if (text != null) n.textContent = text;
        return n;
    };
    const NS = 'http://www.w3.org/2000/svg';
    const s = (parent, name, attrs) => {
        const n = document.createElementNS(NS, name);
        for (const [k, v] of Object.entries(attrs || {})) n.setAttribute(k, v);
        parent.appendChild(n);
        return n;
    };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    const toWhite = (sc, turn) => (turn === 'w' ? sc : {
        type: sc.type,
        value: -sc.value
    });
    const fmtScore = (sc) =>
        sc.type === 'mate' ?
        `${sc.value > 0 ? '+' : '-'}M${Math.abs(sc.value)}` :
        `${sc.value >= 0 ? '+' : '-'}${(Math.abs(sc.value) / 100).toFixed(2)}`;

    // "1. e4 e5 2. Nf3" style tokens, numbered from the position's move number.
    function formatPv(moves, fen) {
        const [, turn, , , , full] = fen.split(' ');
        let n = Number(full) || 1;
        let t = turn;
        const out = [];
        moves.forEach((mv, i) => {
            if (t === 'w') out.push(`${n}.`, mv);
            else {
                if (i === 0) out.push(`${n}...`);
                out.push(mv);
                n++;
            }
            t = t === 'w' ? 'b' : 'w';
        });
        return out;
    }

    const RERUN = [
        'lines',
        'searchMode',
        'moveTimeMs',
        'depth',
        'analyzeOpponent',
        'humanization',
    ];
    const RERENDER = ['showArrows', 'showHighlights', 'showPanelMoves'];

    // =====================================================================================
    // One session per board element. Created when you land on a bot/analysis board, destroyed
    // when you leave, so chess.com's single-page navigation just works.
    // =====================================================================================
    function createSession(board) {
        let ws;
        let stopped = false;
        let reqId = 0;
        let lastKey = '';
        let timer;
        let retry;
        let lastRender = null; // { m, done } for the current position
        let lastDone = null; // final bestmove message for the current position
        let autoplayTimer;
        let noteTimer;
        let playing = false;
        let lastBar = null; // last eval shown on the bar (White's perspective)
        let engineReady = false;
        let engineRequestId = 0;
        let pendingEngineRequest = null;
        const cleanups = [];

        // ---------- Board state ----------
        const isFlipped = () => board.classList.contains('flipped');
        const myColor = () => (board.game?.getPlayingAs?.() === 2 || isFlipped() ? 'b' : 'w');

        function switchEngine(engineId) {
            if (!SF.ENGINES[engineId]) {
                showNote(`Unknown engine: ${engineId}`);
                return;
            }

            if (ws?.readyState !== WebSocket.OPEN) {
                showNote('Engine server is disconnected.');
                return;
            }

            engineReady = false;
            lastKey = '';

            const id = `engine-${++engineRequestId}`;
            pendingEngineRequest = id;

            setStatus(`Switching to ${SF.ENGINES[engineId].name}…`, '#f5a623', true);

            ws.send(JSON.stringify({
                type: 'engine',
                id,
                engine: engineId,
            }));
        }

        function readPosition() {
            const nativeFen = board.game?.getFEN?.();
            if (nativeFen) return {
                fen: nativeFen,
                turn: nativeFen.split(' ')[1]
            };

            // DOM fallback. Piece classes look like "piece wp square-52" (file, rank; 52 = e2).
            const grid = Array.from({
                length: 8
            }, () => Array(8).fill(''));
            const at = {};
            board.querySelectorAll('.piece').forEach((el) => {
                const cls = [...el.classList];
                const sq = cls.find((c) => /^square-[1-8][1-8]$/.test(c));
                const pc = cls.find((c) => /^[wb][pnbrqk]$/.test(c));
                if (!sq || !pc) return;
                const f = +sq[7] - 1;
                const r = +sq[8] - 1;
                grid[7 - r][f] = pc[0] === 'w' ? pc[1].toUpperCase() : pc[1];
                at['abcdefgh' [f] + (r + 1)] = pc;
            });

            const placement = grid
                .map((row) => {
                    let out = '';
                    let empty = 0;
                    for (const c of row) {
                        if (c) {
                            if (empty) out += empty;
                            empty = 0;
                            out += c;
                        } else empty++;
                    }
                    return out + (empty || '');
                })
                .join('/');

            // Side to move: the last-move highlight on a square holding a piece is the destination;
            // whoever owns that piece just moved. No highlights means the game hasn't started.
            let turn = 'w';
            for (const el of board.querySelectorAll('.highlight')) {
                const m = el.className.match(/square-([1-8])([1-8])/);
                const piece = m && at['abcdefgh' [m[1] - 1] + m[2]];
                if (piece) {
                    turn = piece[0] === 'w' ? 'b' : 'w';
                    break;
                }
            }

            let castling = '';
            if (at.e1 === 'wk' && at.h1 === 'wr') castling += 'K';
            if (at.e1 === 'wk' && at.a1 === 'wr') castling += 'Q';
            if (at.e8 === 'bk' && at.h8 === 'br') castling += 'k';
            if (at.e8 === 'bk' && at.a8 === 'br') castling += 'q';

            return {
                fen: `${placement} ${turn} ${castling || '-'} - 0 1`,
                turn
            };
        }

        // ---------- Board overlay: highlights + arrows ----------
        if (getComputedStyle(board).position === 'static') board.style.position = 'relative';

        const svg = document.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 8 8');
        Object.assign(svg.style, {
            position: 'absolute',
            inset: '0',
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            zIndex: '50',
            filter: 'drop-shadow(0 1px 2px rgba(0,0,0,.4))',
        });
        board.appendChild(svg);

        const center = (sq) => {
            const f = sq.charCodeAt(0) - 97;
            const r = +sq[1] - 1;
            return isFlipped() ? [7 - f + 0.5, r + 0.5] : [f + 0.5, 7 - r + 0.5];
        };

        const fadeIn = (node, to) => node.animate([{
            opacity: 0
        }, {
            opacity: to
        }], {
            duration: 180,
            easing: 'ease-out'
        });
        let prevKeys = new Set(); // what's drawn now; only new items animate in, so streaming updates don't flicker

        function arrow(l, col, width, opacity, fresh) {
            const [x1, y1] = center(l.from);
            const [x2, y2] = center(l.to);
            const adx = Math.abs(x2 - x1);
            const ady = Math.abs(y2 - y1);
            const knight = (adx === 1 && ady === 2) || (adx === 2 && ady === 1);
            // Knights get an L: travel the long leg first, then the short one.
            const pts = knight ? [
                [x1, y1], ady > adx ? [x1, y2] : [x2, y1],
                [x2, y2]
            ] : [
                [x1, y1],
                [x2, y2]
            ];

            const [px, py] = pts[pts.length - 2];
            const len = Math.hypot(x2 - px, y2 - py);
            const ux = (x2 - px) / len;
            const uy = (y2 - py) / len;
            const tip = [x2 - ux * 0.08, y2 - uy * 0.08];
            const headLen = width * 2.6;
            const headHalf = width * 1.55;
            const base = [tip[0] - ux * headLen, tip[1] - uy * headLen];
            const shaft = [...pts.slice(0, -1), base];

            const g = s(svg, 'g');
            g.style.opacity = opacity;
            s(g, 'path', {
                d: 'M' + shaft.map((p) => p.join(' ')).join(' L'),
                fill: 'none',
                stroke: col,
                'stroke-width': width,
                'stroke-linecap': 'round',
                'stroke-linejoin': 'round',
            });
            s(g, 'polygon', {
                points: `${tip} ${base[0] - uy * headHalf},${base[1] + ux * headHalf} ${base[0] + uy * headHalf},${base[1] - ux * headHalf}`,
                fill: col,
                stroke: col,
                'stroke-width': 0.03,
                'stroke-linejoin': 'round',
            });

            if (l.promotion) {
                s(g, 'circle', {
                    cx: x2 + 0.3,
                    cy: y2 - 0.3,
                    r: 0.2,
                    fill: col,
                    stroke: '#fff',
                    'stroke-width': 0.03
                });
                const t = s(g, 'text', {
                    x: x2 + 0.3,
                    y: y2 - 0.3,
                    'text-anchor': 'middle',
                    'dominant-baseline': 'central',
                    'font-size': 0.26,
                    'font-weight': 700,
                    'font-family': 'sans-serif',
                    fill: '#fff',
                });
                t.textContent = l.promotion.toUpperCase();
            }
            if (fresh) fadeIn(g, opacity);
        }

        function drawBoard(lines, arrows, highlights) {
            svg.replaceChildren();
            const keys = new Set();
            const best = lines[0];
            const pal = PAL();

            if (best && highlights) {
                for (const [sq, a] of [
                        [best.from, 0.2],
                        [best.to, 0.32]
                    ]) {
                    const [cx, cy] = center(sq);
                    const k = `sq:${best.from}${best.to}:${sq}:${pal[0]}`;
                    keys.add(k);
                    const r = s(svg, 'rect', {
                        x: cx - 0.47,
                        y: cy - 0.47,
                        width: 0.94,
                        height: 0.94,
                        rx: 0.08,
                        fill: pal[0],
                        'fill-opacity': a,
                        stroke: pal[0],
                        'stroke-opacity': 0.7,
                        'stroke-width': 0.05,
                    });
                    if (!prevKeys.has(k)) fadeIn(r, 1);
                }
            }
            if (arrows) {
                // Alternatives first so the best move is drawn on top.
                for (let i = lines.length - 1; i >= 0; i--) {
                    const l = lines[i];
                    const k = `ar:${l.from}${l.to}${l.promotion || ''}:${pal[i % pal.length]}`;
                    keys.add(k);
                    arrow(l, pal[i % pal.length], i === 0 ? 0.17 : i === 1 ? 0.12 : 0.1, i === 0 ? 0.92 : 0.6, !prevKeys.has(k));
                }
            }
            prevKeys = keys;
        }

        const clearBoard = () => {
            svg.replaceChildren();
            prevKeys = new Set();
        };

        // ---------- Eval bar ----------
        const bar = h('div', {
            position: 'fixed',
            zIndex: '99998',
            width: BAR_W + 'px',
            borderRadius: '6px',
            overflow: 'hidden',
            boxShadow: '0 2px 10px rgba(0,0,0,.45)',
            transition: 'opacity .3s',
            display: S.showEvalBar ? 'block' : 'none',
        });
        const barFill = h('div', {
            position: 'absolute',
            left: '0',
            right: '0',
            height: '50%',
            bottom: '0',
            transition: 'height .45s ease',
        });
        const barLabel = h('div', {
            position: 'absolute',
            left: '0',
            right: '0',
            textAlign: 'center',
            font: '700 10px/1 ui-monospace, Menlo, Consolas, monospace',
            bottom: '5px',
        }, '0.0');
        bar.append(barFill, barLabel);
        document.body.appendChild(bar);

        function placeBar() {
            const r = board.getBoundingClientRect();
            bar.style.top = r.top + 'px';
            bar.style.height = r.height + 'px';
            bar.style.left = (BAR_SIDE === 'left' ? r.left - BAR_W - 8 : r.right + 8) + 'px';
        }

        function setBar(sc) { // sc is from White's perspective
            lastBar = sc;
            const c = barColors();
            bar.style.background = c.b;
            barFill.style.background = c.w;
            const frac = sc.type === 'mate' ? (sc.value > 0 ? 1 : 0) : 1 / (1 + Math.exp(-0.00368208 * sc.value));
            const shown = sc.type === 'mate' ? frac : Math.min(Math.max(frac, 0.03), 0.97);
            const flipped = isFlipped();
            barFill.style.height = shown * 100 + '%';
            barFill.style.top = flipped ? '0' : 'auto';
            barFill.style.bottom = flipped ? 'auto' : '0';

            const whiteBetter = frac >= 0.5;
            const atTop = whiteBetter ? flipped : !flipped; // which end the leading side occupies
            barLabel.style.top = atTop ? '5px' : 'auto';
            barLabel.style.bottom = atTop ? 'auto' : '5px';
            barLabel.style.color = textOn(whiteBetter ? c.w : c.b);
            barLabel.textContent = sc.type === 'mate' ? `M${Math.abs(sc.value)}` : (Math.abs(sc.value) / 100).toFixed(1);
        }

        // ---------- Panel: header, autoplay switch, settings drawer, move list ----------
        const panel = h('div', {
            position: 'fixed',
            right: '16px',
            bottom: '16px',
            width: '400px',
            zIndex: '99999',
            borderRadius: '12px',
            background: 'rgba(24,26,30,.95)',
            color: '#e9ecef',
            overflowX: 'hidden',
            overflowY: 'auto',
            maxHeight: '85vh',
            font: '12px/1.4 -apple-system, "Segoe UI", Roboto, sans-serif',
            userSelect: 'none',
            boxShadow: '0 10px 30px rgba(0,0,0,.5)',
        });
        const head = h('div', {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '9px 12px',
            cursor: 'move'
        });
        const dot = h('span', {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: '#777',
            flex: 'none'
        });
        const title = h('span', {
            fontWeight: '600'
        }, 'Connecting…');
        const engineBadge = h('span', {
            padding: '1px 7px',
            borderRadius: '4px',
            fontSize: '10px',
            fontWeight: '700',
            color: '#dce8ff',
            background: 'rgba(59,156,255,.18)',
            border: '1px solid rgba(59,156,255,.35)',
            whiteSpace: 'nowrap',
        }, 'Stockfish 19');
        const autoBadge = h('span', {
            display: 'none',
            padding: '1px 7px',
            borderRadius: '4px',
            fontSize: '10px',
            fontWeight: '700',
            color: '#5ad38a',
            background: 'rgba(47,191,113,.15)',
            border: '1px solid rgba(47,191,113,.3)',
            whiteSpace: 'nowrap',
        }, 'AUTO');
        const sub = h('span', {
            marginLeft: 'auto',
            color: '#9aa3ad',
            fontVariantNumeric: 'tabular-nums'
        });
        const gear = h('span', {
            cursor: 'pointer',
            color: '#9aa3ad',
            fontSize: '14px',
            padding: '0 2px',
            lineHeight: '1'
        }, '⚙');
        const fold = h('span', {
            cursor: 'pointer',
            color: '#9aa3ad',
            fontSize: '14px',
            padding: '0 2px',
            lineHeight: '1'
        }, '–');
        head.append(dot, title, engineBadge, autoBadge, sub, gear, fold);

        const track = h('div', {
            height: '2px',
            background: 'rgba(255,255,255,.08)'
        });
        const prog = h('div', {
            height: '100%',
            width: '0%'
        });
        track.appendChild(prog);

        const repaints = [];
        const refreshControls = () => repaints.forEach((f) => f());

        function makeSwitch(get, set) {
            const trackEl = h('span', {
                width: '30px',
                height: '16px',
                borderRadius: '8px',
                position: 'relative',
                flex: 'none',
                cursor: 'pointer',
                transition: 'background .15s',
                display: 'inline-block',
            });
            const knob = h('span', {
                position: 'absolute',
                top: '2px',
                left: '2px',
                width: '12px',
                height: '12px',
                borderRadius: '50%',
                background: '#fff',
                transition: 'transform .15s',
            });
            trackEl.appendChild(knob);
            const paint = () => {
                const on = get();
                trackEl.style.background = on ? ACC() : '#4a515a';
                knob.style.transform = on ? 'translateX(14px)' : 'translateX(0)';
            };
            trackEl.addEventListener('click', () => set(!get()));
            paint();
            return {
                el: trackEl,
                paint
            };
        }

        const labelRow = (label, control) => {
            const r = h('div', {
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: '10px',
                padding: '5px 0'
            });
            r.append(h('span', {
                color: '#cfd5db'
            }, label), control);
            return r;
        };

        function toggleRow(label, key) {
            const sw = makeSwitch(() => S[key], (v) => {
                S[key] = v;
                commit(key);
            });
            repaints.push(sw.paint);
            return labelRow(label, sw.el);
        }

        function segRow(label, key, options) {
            const wrap = h('span', {
                display: 'inline-flex',
                borderRadius: '6px',
                overflow: 'hidden',
                border: '1px solid rgba(255,255,255,.15)',
            });
            const btns = options.map(([v, text]) => {
                const b = h('span', {
                    padding: '2px 10px',
                    cursor: 'pointer',
                    fontSize: '11px'
                }, text);
                b.addEventListener('click', () => {
                    S[key] = v;
                    commit(key);
                });
                wrap.appendChild(b);
                return [v, b];
            });
            repaints.push(() => btns.forEach(([v, b]) => {
                b.style.background = S[key] === v ? ACC() : 'transparent';
                b.style.color = S[key] === v ? textOn(ACC()) : '#cfd5db';
            }));
            return labelRow(label, wrap);
        }

        function sliderRow(label, key, min, max, step, fmt) {
            const input = h('input', {
                flex: '1',
                minWidth: '0',
                cursor: 'pointer',
                margin: '0'
            });
            input.type = 'range';
            input.min = min;
            input.max = max;
            input.step = step;
            const val = h('span', {
                width: '48px',
                flex: 'none',
                textAlign: 'right',
                color: '#9aa3ad',
                fontVariantNumeric: 'tabular-nums',
            });
            input.addEventListener('input', () => {
                val.textContent = fmt(Number(input.value));
            });
            input.addEventListener('change', () => {
                S[key] = Number(input.value);
                commit(key);
            });
            repaints.push(() => {
                input.value = S[key];
                input.style.accentColor = ACC();
                val.textContent = fmt(S[key]);
            });
            const row = h('div', {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '5px 0'
            });
            row.append(h('span', {
                width: '82px',
                flex: 'none',
                color: '#cfd5db'
            }, label), input, val);
            return row;
        }

        // Autoplay strip (always visible)
        const autoSwitch = makeSwitch(() => S.autoplay, setAutoplay);
        const HumanizationSwitch = makeSwitch(() => S.humanization, (v) => {
            S.humanization = v;
            commit('humanization');
        });

        repaints.push(autoSwitch.paint);
        repaints.push(HumanizationSwitch.paint);

        const autoRow = h('div', {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '7px 12px',
            borderTop: '1px solid rgba(255,255,255,.07)',
        });

        autoRow.append(
            h('span', {
                fontWeight: '600'
            }, 'Autoplay best move'),
            autoSwitch.el
        );

        autoRow.append(
            h('span', {
                fontWeight: '600'
            }, 'Humanization'),
            HumanizationSwitch.el
        );

        // Settings drawer
        const drawer = h('div', {
            display: 'none',
            padding: '4px 12px 8px',
            borderTop: '1px solid rgba(255,255,255,.07)'
        });
        const rowTime = sliderRow('Think time', 'moveTimeMs', 200, 10000, 100, (v) => `${(v / 1000).toFixed(1)}s`);
        const rowDepth = sliderRow('Depth', 'depth', 1, 30, 1, (v) => `${v}`);
        // Humanization customization
        const humanizationOptions = h('div', {
            display: S.humanization ? 'block' : 'none',
            padding: '8px 0 2px',
            borderTop: '1px solid rgba(255,255,255,.07)',
            marginTop: '8px',
        });

        const humanizationMinDelay = sliderRow(
            'Min delay',
            'humanizationMinDelayMs',
            250, 10000, 250,
            v => `${(v / 1000).toFixed(2)}s`
        );

        const humanizationMaxDelay = sliderRow(
            'Max delay',
            'humanizationMaxDelayMs',
            250, 15000, 250,
            v => `${(v / 1000).toFixed(2)}s`
        );

        const humanizationTarget = sliderRow(
            'Target loss',
            'humanizationTargetLossPercent',
            0, 30, 1,
            v => `${v}%`
        );

        const humanizationMax = sliderRow(
            'Maximum loss',
            'humanizationMaxLossPercent',
            1, 50, 1,
            v => `${v}%`
        );

        const humanizationCap = sliderRow(
            'Loss ceiling',
            'humanizationMaxLossCapCp',
            50, 1000, 25,
            v => `${(v / 100).toFixed(2)}`
        );

        const humanizationMin = sliderRow(
            'Minimum loss',
            'humanizationMinLossCp',
            0, 100, 5,
            v => `${(v / 100).toFixed(2)}`
        );

        humanizationOptions.append(
            h('div', {
                color: '#9aa3ad',
                fontWeight: '700',
                fontSize: '10px',
                letterSpacing: '.5px',
                padding: '4px 0 6px',
            }, 'HUMANIZATION OPTIONS'),

            humanizationMinDelay,
            humanizationMaxDelay,
            humanizationTarget,
            humanizationMax,
            humanizationMin,
            humanizationCap
        );

        repaints.push(() => {
            humanizationOptions.style.display =
                S.humanization ? 'block' : 'none';
        });
        repaints.push(() => {
            rowTime.style.display = S.searchMode === 'time' ? 'flex' : 'none';
            rowDepth.style.display = S.searchMode === 'depth' ? 'flex' : 'none';
            autoBadge.style.display = S.autoplay ? 'inline-block' : 'none';
            autoBadge.style.color = '#fff';
            prog.style.background = ACC();
        });
        const reset = h('div', {
            color: '#9aa3ad',
            cursor: 'pointer',
            padding: '6px 0 0',
            fontSize: '11px',
            textDecoration: 'underline'
        }, 'Reset to defaults');
        reset.addEventListener('click', () => {
            const keys = Object.keys(SF.DEFAULT_ENGINE);
            Object.assign(S, SF.DEFAULT_ENGINE);
            Object.assign(S, SF.normalizeEngine(S));
            persist();
            afterChange(keys);
        });
        drawer.append(
            sliderRow('Moves shown', 'lines', 1, 5, 1, (v) => `${v}`),
            segRow('Search by', 'searchMode', [
                ['time', 'Time'],
                ['depth', 'Depth']
            ]),
            rowTime,
            rowDepth,
            toggleRow('Arrows', 'showArrows'),
            toggleRow('Highlight squares', 'showHighlights'),
            toggleRow('Move list', 'showPanelMoves'),
            toggleRow('Eval bar', 'showEvalBar'),
            sliderRow('Autoplay delay', 'autoplayDelayMs', 0, 3000, 100, (v) => `${(v / 1000).toFixed(1)}s`),
            humanizationOptions,
            reset,
        );

        const note = h('div', {
            display: 'none',
            padding: '6px 12px',
            color: '#ffb3ad',
            background: 'rgba(229,83,75,.14)',
            fontSize: '11px',
        });
        const rows = h('div');
        const body = h('div');
        body.append(note, drawer, rows);
        panel.append(head, track, autoRow, body);
        document.body.appendChild(panel);

        function showNote(text, ms = 5000) {
            note.textContent = text;
            note.style.display = 'block';
            clearTimeout(noteTimer);
            noteTimer = setTimeout(() => {
                note.style.display = 'none';
            }, ms);
        }

        gear.addEventListener('click', () => {
            body.style.display = '';
            fold.textContent = '–';
            drawer.style.display = drawer.style.display === 'none' ? 'block' : 'none';
        });
        fold.addEventListener('click', () => {
            const hidden = body.style.display === 'none';
            body.style.display = hidden ? '' : 'none';
            fold.textContent = hidden ? '–' : '+';
        });
        head.addEventListener('mousedown', (e) => {
            if (e.target === fold || e.target === gear) return;
            const r = panel.getBoundingClientRect();
            const ox = e.clientX - r.left;
            const oy = e.clientY - r.top;
            const move = (ev) =>
                Object.assign(panel.style, {
                    left: ev.clientX - ox + 'px',
                    top: ev.clientY - oy + 'px',
                    right: 'auto',
                    bottom: 'auto'
                });
            const up = () => {
                document.removeEventListener('mousemove', move);
                document.removeEventListener('mouseup', up);
            };
            document.addEventListener('mousemove', move);
            document.addEventListener('mouseup', up);
            e.preventDefault();
        });

        let dotAnim = null;
        let progAnim = null;

        function updateEngineBadge(message = {}) {
            const engineId =
                message.engine ??
                S.engineId ??
                'stockfish19';

            const name =
                message.name ??
                SF.ENGINES[engineId]?.name ??
                'Unknown engine';

            engineBadge.textContent = name;
            engineBadge.title = `Analysis engine: ${name}`;
        }

        function setStatus(text, col, busy, depth) {
            title.textContent = text;
            dot.style.background = col;
            sub.textContent = depth ? `depth ${depth}` : '';
            if (busy && !dotAnim) {
                dotAnim = dot.animate([{
                    opacity: 0.3
                }, {
                    opacity: 1
                }], {
                    duration: 700,
                    iterations: Infinity,
                    direction: 'alternate'
                });
            }
            if (!busy && dotAnim) {
                dotAnim.cancel();
                dotAnim = null;
            }
        }
        const startProgress = (ms) => {
            progAnim?.cancel();
            progAnim = prog.animate([{
                width: '0%'
            }, {
                width: '100%'
            }], {
                duration: ms,
                easing: 'linear',
                fill: 'forwards'
            });
        };
        const stopProgress = () => {
            progAnim?.cancel();
            progAnim = null;
            prog.style.width = '0%';
        };

        function renderRows(lines, turn, fen) {
            const me = myColor();
            const pal = PAL();
            rows.replaceChildren(
                ...lines.map((l, i) => {
                    const w = toWhite(l.score, turn);
                    const mine = me === 'w' ? w.value : -w.value; // positive = good for me
                    const lim = w.type === 'mate' ? 0 : 30;
                    const evColor = mine > lim ? '#5ad38a' : mine < -lim ? '#ff7a7a' : '#e9ecef';

                    const row = h('div', {
                        display: 'flex',
                        gap: '8px',
                        padding: '6px 12px',
                        alignItems: 'baseline',
                        borderTop: '1px solid rgba(255,255,255,.07)',
                    });
                    const sw = h('span', {
                        width: '8px',
                        height: '8px',
                        borderRadius: '2px',
                        flex: 'none',
                        alignSelf: 'center',
                        background: pal[i % pal.length],
                    });
                    const ev = h('span', {
                        width: '46px',
                        flex: 'none',
                        textAlign: 'right',
                        fontWeight: '700',
                        fontVariantNumeric: 'tabular-nums',
                        color: evColor,
                    }, fmtScore(w));

                    const tokens = formatPv(l.pvSan || l.pv, fen);
                    const mv = h('span', {
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        minWidth: '0'
                    });
                    mv.append(
                        h('strong', {
                            color: '#fff',
                            fontSize: '13px'
                        }, tokens[1]),
                        h('span', {
                            color: '#9aa3ad'
                        }, ' ' + tokens.slice(2).join(' ')),
                    );
                    row.append(sw, ev, mv);
                    return row;
                }),
            );
        }

        // ---------- Rendering a server message ----------
        function render(m, done) {
            const turn = m.fen.split(' ')[1];
            const myTurn = turn === myColor();
            updateEngineBadge(m);
            const all = m.lines || [];
            const lines = all.slice(0, S.humanization ? 5 : S.lines);
            const depth = all[0]?.depth;

            drawBoard(lines, myTurn && S.showArrows, myTurn && S.showHighlights);
            if (all[0]) setBar(toWhite(all[0].score, turn));
            if (myTurn && S.showPanelMoves) renderRows(lines, turn, m.fen);
            else rows.replaceChildren();

            if (!done) {
                if (myTurn && S.searchMode === 'depth' && depth) prog.style.width = Math.min(100, (depth / S.depth) * 100) + '%';
                return setStatus(myTurn ? 'Thinking…' : "Opponent's turn", '#f5a623', true, depth);
            }
            stopProgress();
            if (!all.length) return setStatus('No legal moves', '#777', false);
            setStatus(myTurn ? 'Best move' + (S.lines > 1 ? 's' : '') : "Opponent's turn", myTurn ? ACC() : '#777', false, depth);
        }
        const rerender = () => lastRender && render(lastRender.m, lastRender.done);

        // ---------- Humanization / percentage-based selection ----------

        const randomInt = (min, max) =>
            Math.floor(Math.random() * (max - min + 1)) + min;

        function scoreValue(score) {
            if (!score || !Number.isFinite(score.value)) return null;
            return score.type === 'cp' ? score.value : null;
        }

        function selectHumanizedMove(m) {
            const candidates = (m.lines || []).filter(line =>
                line.move &&
                line.from &&
                line.to &&
                line.score
            );

            if (!candidates.length) return m;

            const best = candidates[0];

            // Don't voluntarily deviate from a forced-mate evaluation.
            if (best.score.type === 'mate') {
                return {
                    ...m,
                    ...best
                };
            }

            const bestScore = scoreValue(best.score);
            if (bestScore === null) return m;

            // Compare candidates evaluated at the same depth.
            const comparable = candidates.filter(line =>
                line.depth === best.depth &&
                line.score?.type === 'cp' &&
                scoreValue(line.score) !== null
            );

            if (!comparable.length) return {
                ...m,
                ...best
            };

            const targetPercent = S.humanizationTargetLossPercent / 100;
            const maxPercent = S.humanizationMaxLossPercent / 100;

            // Scale the acceptable loss according to the current advantage.
            const advantage = Math.max(0, bestScore);

            const targetLoss = Math.min(
                S.humanizationMaxLossCapCp,
                Math.max(
                    S.humanizationMinLossCp,
                    advantage * targetPercent
                )
            );

            const maxLoss = Math.min(
                S.humanizationMaxLossCapCp,
                Math.max(
                    S.humanizationMinLossCp,
                    advantage * maxPercent
                )
            );

            // Keep a comfortable winning position above +1.00.
            const winningFloor = bestScore >= 150 ? 100 : -Infinity;

            const safe = comparable
                .map(line => {
                    const score = scoreValue(line.score);

                    return {
                        line,
                        score,
                        loss: bestScore - score,
                    };
                })
                .filter(candidate =>
                    candidate.loss >= 0 &&
                    candidate.loss <= maxLoss &&
                    candidate.score >= winningFloor
                );

            if (!safe.length) return {
                ...m,
                ...best
            };

            // Prefer moves near the target loss, while retaining some variation.
            const temperature = Math.max(20, maxLoss * 0.15);

            const weighted = safe.map(candidate => ({
                ...candidate,
                weight: Math.exp(
                    -Math.abs(candidate.loss - targetLoss) / temperature
                ),
            }));

            const totalWeight = weighted.reduce(
                (sum, candidate) => sum + candidate.weight,
                0
            );

            let roll = Math.random() * totalWeight;
            let selected = weighted[0];

            for (const candidate of weighted) {
                roll -= candidate.weight;

                if (roll <= 0) {
                    selected = candidate;
                    break;
                }
            }

            return {
                ...m,
                ...selected.line,
                move: selected.line.move,
                lines: [
                    selected.line,
                    ...comparable.filter(line => line !== selected.line),
                ],
            };
        }

        function getAutoplayDelay() {
            if (!S.humanization) return S.autoplayDelayMs;

            return randomInt(
                S.humanizationMinDelayMs,
                S.humanizationMaxDelayMs
            );
        }

        async function clickAt(x, y, target) {
            for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
                const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
                target.dispatchEvent(new Ctor(type, {
                    bubbles: true,
                    cancelable: true,
                    composed: true,
                    view: window,
                    clientX: x,
                    clientY: y,
                    button: 0,
                    buttons: type.endsWith('down') ? 1 : 0,
                    pointerId: 1,
                    pointerType: 'mouse',
                    isPrimary: true,
                }));
                await sleep(20);
            }
        }
        const clickSquare = (sq) => {
            const r = board.getBoundingClientRect();
            const [cx, cy] = center(sq);
            const x = r.left + (cx / 8) * r.width;
            const y = r.top + (cy / 8) * r.height;
            return clickAt(x, y, document.elementFromPoint?.(x, y) || board);
        };

        // Preferred: chess.com's own game object (internal API, may change).
        function tryApi(m) {
            try {
                if (typeof board.game?.move !== 'function') return false;
                board.game.move({
                    from: m.from,
                    to: m.to,
                    promotion: m.promotion || undefined,
                    animate: true,
                    userGenerated: true
                });
                return true;
            } catch (e) {
                console.warn('[nova] api move failed', e);
                return false;
            }
        }
        // Fallback: click the from-square, then the to-square (and the promotion piece if asked).
        async function clickMove(m) {
            await clickSquare(m.from);
            await sleep(120);
            await clickSquare(m.to);
            if (m.promotion) {
                await sleep(300);
                const c = `${myColor()}${m.promotion}`;
                const el = document.querySelector(`.promotion-window .${c}, .promotion-piece.${c}`);
                if (el) {
                    const r = el.getBoundingClientRect();
                    await clickAt(r.left + r.width / 2, r.top + r.height / 2, el);
                }
            }
        }

        async function playMove(m) {
            if (playing()) return;
            playing = true;
            const san = m.lines?.[0]?.pvSan?.[0] || m.move;
            try {
                setStatus(`Playing ${san}`, ACC(), false, m.lines?.[0]?.depth);
                const moved = () => stopped || readPosition().fen !== m.fen;
                if (tryApi(m)) await sleep(500);
                if (!moved()) {
                    await clickMove(m);
                    await sleep(600);
                }
                const didMove = !stopped && readPosition().fen !== m.fen;
                if (!didMove) {
                    showNote(`Autoplay couldn't make ${san}. Play it manually.`);
                }
            } finally {
                playing = false;
            }
        }

        function maybeAutoplay(m) {
            clearTimeout(autoplayTimer);

            if (!S.autoplay || !m.move || playing()) return;
            if (m.fen.split(' ')[1] !== myColor()) return;

            const selected = S.humanization ?
                selectHumanizedMove(m) :
                m;

            autoplayTimer = setTimeout(() => {
                if (!S.autoplay || m.id !== reqId) return;
                playMove(selected);
            }, getAutoplayDelay());
        }

        function onHumanizationChange() {
            autoBadge.textContent = S.humanization ? 'AUTO ♟' : 'AUTO';
        }

        let autoplayConfirmationPending = false;

        async function setAutoplay(enabled) {
            if (autoplayConfirmationPending || stopped) return;

            // Disabling Autoplay never requires confirmation.
            if (!enabled) {
                S.autoplay = false;
                commit('autoplay');
                return;
            }

            autoplayConfirmationPending = true;

            try {
                // Only request approval when the setting is enabled.
                if (confirmAutoplay) {
                    const approved = await requestAutoplayConfirmation();

                    if (!approved || stopped) {
                        refreshControls();
                        return;
                    }
                }

                if (stopped) return;

                S.autoplay = true;
                commit('autoplay');

            } catch (error) {
                console.error('[nova] Autoplay confirmation failed:', error);
                showNote('Could not confirm Autoplay. It was not enabled.');
                refreshControls();

            } finally {
                autoplayConfirmationPending = false;
                refreshControls();
            }
        }

        function onAutoplayChange() {
            clearTimeout(autoplayTimer);

            if (!S.autoplay) return;

            if (lastDone && lastDone.id === reqId) {
                maybeAutoplay(lastDone);
            }
        }

        // ---------- Applying settings changes ----------
        function afterChange(keys) {
            refreshControls();
            if (keys.includes('showEvalBar')) bar.style.display = S.showEvalBar ? 'block' : 'none';
            if (keys.includes('autoplay')) onAutoplayChange();
            if (keys.includes('humanization')) onHumanizationChange();
            const humanizationSettings = [
                'humanizationTargetLossPercent',
                'humanizationMaxLossPercent',
                'humanizationMaxLossCapCp',
                'humanizationMinLossCp',
                'humanizationMinDelayMs',
                'humanizationMaxDelayMs',
            ];

            if (keys.some(k => humanizationSettings.includes(k))) {
                onAutoplayChange();
            }
            if (keys.some((k) => RERUN.includes(k))) {
                lastKey = ''; // force a fresh analysis of the current position
                schedule();
            } else if (keys.some((k) => RERENDER.includes(k))) rerender();
        }

        function commit(key) {
            Object.assign(S, SF.normalizeEngine(S));
            persist();
            afterChange([key]);
        }

        // Theme changed: recolour everything that follows the accent / board colours.
        function restyle() {
            refreshControls();
            if (lastBar) setBar(lastBar);
            else {
                const c = barColors();
                bar.style.background = c.b;
                barFill.style.background = c.w;
                barLabel.style.color = textOn(c.w);
            }
            if (lastRender) rerender();
        }

        // ---------- WebSocket + position watching ----------
        function update() {
            const pos = readPosition();
            const me = myColor();
            const key = `${pos.fen}|${me}|${isFlipped()}`;
            if (key === lastKey) return;
            lastKey = key;

            const id = ++reqId; // invalidates replies for any earlier position
            lastRender = null;
            lastDone = null;
            clearTimeout(autoplayTimer);
            clearBoard();
            rows.replaceChildren();
            placeBar();

            const myTurn = pos.turn === me;
            bar.style.opacity = myTurn ? '1' : '0.6';

            if (!myTurn && !S.analyzeOpponent) {
                stopProgress();
                return setStatus("Opponent's turn", '#777', false);
            }
            if (ws?.readyState !== WebSocket.OPEN || !engineReady) return;

            const depthMode = myTurn && S.searchMode === 'depth';
            const ms = myTurn ? S.moveTimeMs : OPPONENT_MOVE_TIME_MS;
            setStatus(myTurn ? 'Thinking…' : "Opponent's turn", '#f5a623', true);
            if (depthMode) stopProgress();
            else startProgress(ms);
            ws.send(JSON.stringify({
                type: 'analyze',
                id,
                fen: pos.fen,
                movetime: depthMode ? 15000 : ms, // in depth mode this is only a safety cap
                depth: depthMode ? S.depth : undefined,
                lines: myTurn ? (S.humanization ? 5 : S.lines) : 1,
            }));
        }

        function schedule() {
            clearTimeout(timer);
            timer = setTimeout(update, 150);
        }

        function connect() {
            if (stopped) return;
            let sock;
            try {
                sock = new WebSocket(CFG.serverUrl);
            } catch (e) {
                setStatus('Bad server URL', '#e5534b', false);
                return;
            }
            ws = sock;
            sock.onopen = () => {
                if (ws !== sock) return;

                console.log('[nova] connected');

                switchEngine(S.engineId || 'stockfish19');
            };
            sock.onmessage = (e) => {
                if (ws !== sock) return;

                let m;
                try {
                    m = JSON.parse(e.data);
                } catch (err) {
                    console.error('[nova] Invalid server message:', e.data, err);
                    return;
                }

                if (m.type === 'engine') {
                    console.log('[nova] Engine ready:', m.name, m.status);

                    updateEngineBadge(m);

                    if (m.id === pendingEngineRequest) {
                        pendingEngineRequest = null;
                        engineReady = m.status === 'ready';

                        if (engineReady) {
                            lastKey = '';
                            schedule();
                        } else {
                            setStatus('Engine failed to start', '#e5534b', false);
                        }
                    }

                    return;
                }

                if (m.type === 'error') {
                    console.error('[nova] Server error:', m.message, 'Request:', m.id);
                    showNote(m.message);
                    return;
                }

                if (m.id !== reqId) {
                    console.debug('[nova] Ignoring stale response:', m.id, 'Current:', reqId);
                    return;
                }

                if (m.type === 'info') {
                    lastRender = {
                        m,
                        done: false
                    };
                    render(m, false);
                } else if (m.type === 'bestmove') {
                    lastRender = {
                        m,
                        done: true
                    };
                    lastDone = m;
                    render(m, true);
                    maybeAutoplay(m);
                }
            };
            sock.onclose = () => {
                if (ws !== sock) return; // an intentional reconnect replaced this socket
                stopProgress();
                engineReady = false;
                pendingEngineRequest = null;
                setStatus('Server offline, retrying', '#e5534b', false);
                if (!stopped) retry = setTimeout(connect, 2000);
            };
        }

        function reconnect() {
            clearTimeout(retry);
            const old = ws;
            ws = null;
            old?.close();
            connect();
        }

        const observer = new MutationObserver((muts) => {
            if (muts.every((m) => svg.contains(m.target))) return; // our own overlay changes
            schedule();
        });
        observer.observe(board, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['class']
        });

        const ro = new ResizeObserver(placeBar);
        ro.observe(board);
        window.addEventListener('resize', placeBar);
        window.addEventListener('scroll', placeBar, true);
        cleanups.push(() => {
            window.removeEventListener('resize', placeBar);
            window.removeEventListener('scroll', placeBar, true);
        });

        placeBar();
        restyle();
        connect();

        return {
            board,
            applyChanges(keys) {
                afterChange(keys);

                if (keys.includes('engineId')) {
                    switchEngine(S.engineId);
                }
            },
            restyle,
            reconnect,
            destroy() {
                stopped = true;
                clearTimeout(timer);
                clearTimeout(retry);
                clearTimeout(autoplayTimer);
                clearTimeout(noteTimer);
                observer.disconnect();
                ro.disconnect();
                cleanups.forEach((f) => f());
                const old = ws;
                ws = null;
                old?.close();
                svg.remove();
                panel.remove();
                bar.remove();
            },
        };
    }

    // =====================================================================================
    // Page lifecycle: chess.com is a single-page app, so poll for "right page + board present".
    // =====================================================================================
    function tick() {
        const onEnginePage = CFG.enabled && ENGINE_PATHS.some((re) => re.test(location.pathname));
        const board = onEnginePage ? document.querySelector('wc-chess-board') : null;
        if (session && (!board || session.board !== board || !board.isConnected)) {
            session.destroy();
            session = null;
        }
        if (!session && board) session = createSession(board);
    }
    setInterval(tick, 400);

    // ---------- Settings from the extension ----------
    function applyState(raw) {
        const st = SF.normalizeState(raw); // never trust postMessage payloads
        confirmAutoplay = st.settings.confirmAutoplay;
        const urlBefore = CFG.serverUrl;
        CFG.enabled = st.enabled;
        CFG.serverUrl = st.serverUrl;

        const changed = Object.keys(st.engine).filter((k) => S[k] !== st.engine[k]);
        Object.assign(S, st.engine);

        const tk = JSON.stringify(st.theme);
        const themeChanged = tk !== themeKey;
        themeKey = tk;
        T = st.theme;

        if (session) {
            if (changed.length) session.applyChanges(changed);
            if (themeChanged) session.restyle();
            if (urlBefore !== CFG.serverUrl) session.reconnect();
        }
        tick();
    }

    window.addEventListener('message', (e) => {
        if (e.source !== window || e.data?.__sf !== 1 || e.data.type !== 'state') return;
        applyState(e.data.state);
    });
    post('hello');
    tick();

    // Console helpers: __nova.get(), __nova.set({ lines: 2, depth: 20 })
    window.__nova = {
        get: () => ({
            ...S
        }),
        set(patch) {
            const keys = [];
            for (const [k, v] of Object.entries(patch || {})) {
                if (k in S) {
                    S[k] = v;
                    keys.push(k);
                }
            }
            Object.assign(S, SF.normalizeEngine(S));
            persist();
            session?.applyChanges(keys);
            return {
                ...S
            };
        },
    };
})();