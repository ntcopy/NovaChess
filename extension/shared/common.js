// NovaChess: shared by both content scripts and the popup. Defines globalThis.SF:
// settings schema + validation, theme presets, and the CSS builder for chess.com themes.
(() => {
    const DEFAULT_URL = 'ws://localhost:8765';

    // ---------- validation helpers ----------
    const bool = (v, d) => (typeof v === 'boolean' ? v : d);
    const int = (v, lo, hi, d) => {
        const n = Math.round(Number(v));
        return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d;
    };
    const num = (v, lo, hi, d) => {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : d;
    };
    const oneOf = (v, list, d) => (list.includes(v) ? v : d);
    const color = (v, d) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : d);

    // ---------- colour math ----------
    const rgb = (hex) => {
        const n = parseInt(hex.slice(1), 16);
        return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    };
    const rgba = (hex, a) => `rgba(${rgb(hex).join(',')},${a})`;
    const lum = (hex) => {
        const [r, g, b] = rgb(hex).map((c) => {
            const v = c / 255;
            return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const mix = (a, b, t) => {
        const A = rgb(a);
        const B = rgb(b);
        return '#' + A.map((c, i) => Math.round(c + (B[i] - c) * t).toString(16).padStart(2, '0')).join('');
    };

    // ---------- engine settings ----------
    const DEFAULT_ENGINE = {
        engineId: 'stockfish19',
        lines: 1,
        showArrows: true,
        showHighlights: true,
        showPanelMoves: true,
        showEvalBar: true,
        searchMode: 'time',
        moveTimeMs: 1500,
        depth: 16,
        analyzeOpponent: true,
        autoplayDelayMs: 600,
        humanization: false,
        humanizationMinDelayMs: 1000,
        humanizationMaxDelayMs: 4000,
        humanizationTargetLossPercent: 10,
        humanizationMaxLossPercent: 25,
        humanizationMaxLossCapCp: 500,
        humanizationMinLossCp: 20,
    };

    const ENGINES = {
        stockfish19: {
            name: 'Stockfish 19',
            available: true
        },
        stockfish18: {
            name: 'Stockfish 18',
            available: true
        },
        stockfish17: {
            name: 'Stockfish 17',
            available: true
        },
        lc0: {
            name: 'Leela Chess Zero',
            available: false
        },
        torch: {
            name: 'Torch',
            available: false
        },
    };

    function normalizeEngine(o) {
        o = o && typeof o === 'object' ? o : {};
        const d = DEFAULT_ENGINE;

        const out = {
            engineId: oneOf(
                o.engineId,
                Object.keys(ENGINES).filter(id => ENGINES[id].available),
                d.engineId
            ),

            lines: int(o.lines, 1, 5, d.lines),
            searchMode: oneOf(o.searchMode, ['time', 'depth'], d.searchMode),
            moveTimeMs: int(o.moveTimeMs, 100, 15000, d.moveTimeMs),
            depth: int(o.depth, 1, 40, d.depth),
            autoplayDelayMs: int(o.autoplayDelayMs, 0, 10000, d.autoplayDelayMs),
            humanizationMinDelayMs: int(
                o.humanizationMinDelayMs, 250, 10000, d.humanizationMinDelayMs
            ),
            humanizationMaxDelayMs: int(
                o.humanizationMaxDelayMs,
                int(o.humanizationMinDelayMs, 250, 10000, d.humanizationMinDelayMs),
                15000,
                d.humanizationMaxDelayMs
            ),
            humanizationTargetLossPercent: int(
                o.humanizationTargetLossPercent, 0, 30,
                d.humanizationTargetLossPercent
            ),

            humanizationMaxLossPercent: int(
                o.humanizationMaxLossPercent, 1, 50,
                d.humanizationMaxLossPercent
            ),

            humanizationMaxLossCapCp: int(
                o.humanizationMaxLossCapCp, 50, 1000,
                d.humanizationMaxLossCapCp
            ),

            humanizationMinLossCp: int(
                o.humanizationMinLossCp, 0, 100,
                d.humanizationMinLossCp
            ),
        };

        for (const k of [
                'showArrows',
                'showHighlights',
                'showPanelMoves',
                'showEvalBar',
                'analyzeOpponent',
                'humanization'
            ]) {
            out[k] = bool(o[k], d[k]);
        }

        return out;
    }

    const DEFAULT_SETTINGS = {
        adBlockEnabled: false,
        hidePromotions: false,
        confirmAutoplay: true,
    };

    function normalizeSettings(o) {
        o = o && typeof o === 'object' ? o : {};

        return {
            adBlockEnabled: bool(o.adBlockEnabled, DEFAULT_SETTINGS.adBlockEnabled),
            hidePromotions: bool(o.hidePromotions, DEFAULT_SETTINGS.hidePromotions),
            confirmAutoplay: bool(o.confirmAutoplay, DEFAULT_SETTINGS.confirmAutoplay),
        };
    }

    // ---------- themes ----------
    const DEFAULT_THEME = {
        enabled: true,
        preset: 'midnight',
        light: '#c5cbe3',
        dark: '#5a6899',
        style: 'soft', // flat | soft | grain | wood
        hl: '#8aa4ff',
        hlOpacity: 0.45,
        accent: '#3ddc97',
        pageBg: '#0f1220', // '' = leave chess.com's own page background
        radius: 6,
        shadow: true,
        pieces: 'shadow', // none | shadow | glow | crisp
        coords: 'match', // match | default | swap
        customCss: '',
    };

    const P = (id, name, theme) => ({
        id,
        name,
        theme
    });
    const PRESETS = [
        P('midnight', 'Midnight', {
            light: '#c5cbe3',
            dark: '#5a6899',
            style: 'soft',
            hl: '#8aa4ff',
            hlOpacity: 0.45,
            accent: '#3ddc97',
            pageBg: '#0f1220',
            radius: 6,
            shadow: true,
            pieces: 'shadow'
        }),
        P('forest', 'Forest', {
            light: '#e6e4c4',
            dark: '#5e8d4a',
            style: 'flat',
            hl: '#f2e94e',
            hlOpacity: 0.5,
            accent: '#ff9f43',
            pageBg: '#11160f',
            radius: 4,
            shadow: true,
            pieces: 'shadow'
        }),
        P('walnut', 'Walnut', {
            light: '#ecd3a5',
            dark: '#a8713d',
            style: 'wood',
            hl: '#ffd34d',
            hlOpacity: 0.5,
            accent: '#2fbf71',
            pageBg: '#1a120c',
            radius: 4,
            shadow: true,
            pieces: 'shadow'
        }),
        P('rose', 'Rosé', {
            light: '#f7e6e8',
            dark: '#c97b92',
            style: 'soft',
            hl: '#ffd86b',
            hlOpacity: 0.55,
            accent: '#3b9cff',
            pageBg: '#1c1217',
            radius: 10,
            shadow: true,
            pieces: 'shadow'
        }),
        P('ocean', 'Ocean', {
            light: '#d6eef2',
            dark: '#4b8fab',
            style: 'soft',
            hl: '#ffe066',
            hlOpacity: 0.5,
            accent: '#ff6b81',
            pageBg: '#0a1620',
            radius: 8,
            shadow: true,
            pieces: 'shadow'
        }),
        P('neon', 'Neon', {
            light: '#3c4175',
            dark: '#232650',
            style: 'flat',
            hl: '#ff2e97',
            hlOpacity: 0.5,
            accent: '#00f5d4',
            pageBg: '#090a18',
            radius: 2,
            shadow: true,
            pieces: 'glow'
        }),
        P('slate', 'Slate', {
            light: '#d9d9d9',
            dark: '#707880',
            style: 'grain',
            hl: '#6ec1ff',
            hlOpacity: 0.5,
            accent: '#f5a623',
            pageBg: '#141516',
            radius: 2,
            shadow: false,
            pieces: 'crisp'
        }),
        P('sand', 'Sand', {
            light: '#f1e8d5',
            dark: '#b89c78',
            style: 'grain',
            hl: '#7dd3a8',
            hlOpacity: 0.55,
            accent: '#d1495b',
            pageBg: '',
            radius: 6,
            shadow: true,
            pieces: 'shadow'
        }),
    ];

    function normalizeTheme(o) {
        const given = o && typeof o === 'object' ? o : {};
        const d = DEFAULT_THEME;
        const known = given.preset === 'custom' || PRESETS.some((p) => p.id === given.preset);
        return {
            enabled: bool(given.enabled, d.enabled),
            preset: known ? given.preset : Object.keys(given).length ? 'custom' : d.preset,
            light: color(given.light, d.light),
            dark: color(given.dark, d.dark),
            style: oneOf(given.style, ['flat', 'soft', 'grain', 'wood'], d.style),
            hl: color(given.hl, d.hl),
            hlOpacity: num(given.hlOpacity, 0.1, 0.9, d.hlOpacity),
            accent: color(given.accent, d.accent),
            pageBg: given.pageBg === '' ? '' : color(given.pageBg, d.pageBg),
            radius: int(given.radius, 0, 24, d.radius),
            shadow: bool(given.shadow, d.shadow),
            pieces: oneOf(given.pieces, ['none', 'shadow', 'glow', 'crisp'], d.pieces),
            coords: oneOf(given.coords, ['match', 'default', 'swap'], d.coords),
            customCss: typeof given.customCss === 'string' ? given.customCss.slice(0, 20000) : '',
        };
    }

    function applyPreset(theme, id) {
        const p = PRESETS.find((x) => x.id === id);
        return p ? normalizeTheme({
            ...theme,
            ...p.theme,
            preset: id
        }) : theme;
    }

    // ---------- full stored state ----------
    const validWs = (u) => typeof u === 'string' && /^wss?:\/\/[^\s/]+(\/\S*)?$/i.test(u);

    function normalizeState(raw) {
        raw = raw && typeof raw === 'object' ? raw : {};
        return {
            enabled: raw.enabled !== false,
            serverUrl: validWs(raw.serverUrl) ? raw.serverUrl : DEFAULT_URL,
            engine: normalizeEngine(raw.engine),
            theme: normalizeTheme(raw.theme),
            settings: normalizeSettings(raw.settings),
            meta: {
                by: typeof raw.meta?.by === 'string' ? raw.meta.by.slice(0, 40) : ''
            },
        };
    }

    // ---------- CSS ----------
    // Textures are SVG noise layered over the checkerboard. The board itself is pure CSS gradients,
    // so it still renders if a page CSP blocks data: images.
    const svgUri = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    const TEXTURE = {
        grain: "<svg xmlns='http://www.w3.org/2000/svg' width='300' height='300'><filter id='n' x='0' y='0' width='100%' height='100%'>" +
            "<feTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='2' seed='7' stitchTiles='stitch'/>" +
            "<feColorMatrix values='0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 .26 -.045'/></filter>" +
            "<rect width='300' height='300' filter='url(#n)'/></svg>",
        wood: "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'><filter id='n' x='0' y='0' width='100%' height='100%'>" +
            "<feTurbulence type='fractalNoise' baseFrequency='.006 .22' numOctaves='3' seed='4'/>" +
            "<feColorMatrix values='0 0 0 0 .22  0 0 0 0 .1  0 0 0 0 .02  0 0 0 1.1 -.42'/></filter>" +
            "<rect width='600' height='600' filter='url(#n)'/></svg>",
    };

    // CSS `background` value for the board: top-left square (a8) is light, like chess.com.
    function boardBackground(t) {
        const layers = [];
        if (t.style === 'soft') layers.push('linear-gradient(135deg, rgba(255,255,255,.16), rgba(0,0,0,.18)) 0 0 / 100% 100%');
        if (t.style === 'grain' || t.style === 'wood') layers.push(`${svgUri(TEXTURE[t.style])} 0 0 / 100% 100%`);
        layers.push(`conic-gradient(${t.dark} 25%, ${t.light} 0 50%, ${t.dark} 0 75%, ${t.light} 0) 0 0 / 25% 25%`);
        return layers.join(', ');
    }

    function buildCss(t) {
        if (!t || !t.enabled) return '';
        // `:not(#nova)` adds ID-level specificity so we beat the site's own !important rules.
        const ID = ':not(#nova)';
        // Boards: the interactive element, chess.com's server-rendered `div#board.board`, and anything
        // else the bridge has tagged as a board (previews, review boards...).
        const BOARDS = ['wc-chess-board', 'chess-board', '#board.board', '[data-nova-board]'];
        const B = (s = '') => BOARDS.map((b) => `${b}${ID}${s}`).join(', ');
        const css = [];

        css.push(`:root{--nova-light:${t.light};--nova-dark:${t.dark};--nova-hl:${t.hl};--nova-accent:${t.accent}}`);

        // The bridge marks any element that is really painting the board (a wrapper div, or a
        // ::before/::after) with data-nova-paint / data-nova-pseudo, so those get the checkerboard too.
        const bg = `background:${boardBackground(t)} !important;`;
        css.push(`${B()}, [data-nova-paint]${ID}{${bg}}`);
        css.push(`[data-nova-pseudo~="before"]${ID}::before{${bg}}`);
        css.push(`[data-nova-pseudo~="after"]${ID}::after{${bg}}`);

        let frame = '';
        if (t.radius) frame += `border-radius:${t.radius}px !important;`;
        if (t.shadow) frame += 'box-shadow:0 12px 40px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.05) !important;';
        if (frame) css.push(`${B()}{${frame}}`);

        css.push(`${B(' .highlight')}{background-color:${t.hl} !important;opacity:${t.hlOpacity} !important}`);
        css.push(`${B(' .hint')}{background:radial-gradient(${rgba(t.hl, 0.6)} 19%,transparent 20%) !important}`);
        css.push(`${B(' .capture-hint')}{background:radial-gradient(transparent 0%,transparent 79%,${rgba(t.hl, 0.6)} 80%) !important}`);

        const pieceFilter = {
            shadow: 'drop-shadow(0 2px 2px rgba(0,0,0,.45))',
            glow: `drop-shadow(0 0 1px rgba(255,255,255,.7)) drop-shadow(0 0 4px ${t.accent})`,
            crisp: 'contrast(1.12) saturate(1.15)',
        } [t.pieces];
        if (pieceFilter) css.push(`${B(' .piece')}{filter:${pieceFilter} !important}`);

        if (t.coords !== 'default') {
            const onLight = t.coords === 'match' ? t.dark : t.light;
            const onDark = t.coords === 'match' ? t.light : t.dark;
            css.push(`.coordinate-light{fill:${onLight} !important}.coordinate-dark{fill:${onDark} !important}`);
        }

        if (t.pageBg) css.push(`html,body{background-color:${t.pageBg} !important;background-image:none !important}`);
        if (t.customCss.trim()) css.push(t.customCss);
        return css.join('\n');
    }

    globalThis.SF = {
        DEFAULT_URL,
        DEFAULT_ENGINE,
        DEFAULT_THEME,
        ENGINES,
        PRESETS,
        normalizeEngine,
        normalizeTheme,
        normalizeState,
        applyPreset,
        validWs,
        boardBackground,
        buildCss,
        rgba,
        lum,
        mix,
        DEFAULT_SETTINGS,
        normalizeSettings
    };
})();