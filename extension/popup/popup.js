(() => {
    const SF = globalThis.SF;
    const $ = (id) => document.getElementById(id);
    let state = SF.normalizeState(null);
    let writeTimer;

    // ---------- General settings ----------
    const settingIds = [
        'adBlockEnabled',
        'hidePromotions',
        'confirmAutoplay',
    ];

    for (const id of settingIds) {
        $(id).addEventListener('change', (e) => {
            state.settings[id] = e.target.checked;
            state.settings = SF.normalizeSettings(state.settings);
            save();
        });
    }


    // ---------- storage ----------
    function save() {
        clearTimeout(writeTimer);
        writeTimer = setTimeout(() => {
            state.meta = {
                by: 'popup'
            };
            chrome.storage.local.set({
                sf: state
            });
        }, 120);
    }
    const flush = () => {
        clearTimeout(writeTimer);
        state.meta = {
            by: 'popup'
        };
        return chrome.storage.local.set({
            sf: state
        });
    };

    // ---------- tabs ----------
    document.querySelectorAll('nav button').forEach((b) =>
        b.addEventListener('click', () => {
            document.querySelectorAll('nav button').forEach((x) => x.classList.toggle('on', x === b));
            $('tab-engine').hidden = b.dataset.tab !== 'engine';
            $('tab-theme').hidden = b.dataset.tab !== 'theme';
            $('tab-settings').hidden = b.dataset.tab !== 'settings';
            const shown = $('tab-' + b.dataset.tab);
            shown.classList.remove('enter');
            void shown.offsetWidth;
            shown.classList.add('enter');
        }),
    );

    // ---------- engine tab ----------
    $('enabled').addEventListener('change', (e) => {
        state.enabled = e.target.checked;
        save();
    });

    $('serverUrl').addEventListener('input', (e) => {
        const ok = SF.validWs(e.target.value.trim());
        e.target.classList.toggle('bad', !ok);
        if (ok) {
            state.serverUrl = e.target.value.trim();
            save();
        }
    });

    const engineSlider = (id, outId, fmt) => {
        $(id).addEventListener('input', (e) => {
            state.engine[id] = Number(e.target.value);
            state.engine = SF.normalizeEngine(state.engine);
            $(outId).textContent = fmt(state.engine[id]);
            save();
        });
    };
    engineSlider('lines', 'linesOut', (v) => `${v}`);
    engineSlider('moveTimeMs', 'moveTimeOut', (v) => `${(v / 1000).toFixed(1)}s`);
    engineSlider('depth', 'depthOut', (v) => `${v}`);

    document.querySelectorAll('#searchMode button').forEach((b) =>
        b.addEventListener('click', () => {
            state.engine.searchMode = b.dataset.v;
            paint();
            save();
        }),
    );

    // ---------- Engine selection ----------
    const engineSelect = $('engineSelect');

    function populateEngineSelect() {
        engineSelect.replaceChildren();

        for (const [id, engine] of Object.entries(SF.ENGINES)) {
            if (!engine.available) continue;

            const option = document.createElement('option');
            option.value = id;
            option.textContent = engine.name;

            engineSelect.appendChild(option);
        }
    }

    function paintEngineSelect() {
        const selected = state.engine.engineId || SF.DEFAULT_ENGINE.engineId;

        // Keep the dropdown synchronized with saved settings.
        engineSelect.value = selected;

        const engine = SF.ENGINES[selected];
    }

    engineSelect.addEventListener('change', () => {
        const engineId = engineSelect.value;
        const engine = SF.ENGINES[engineId];

        if (!engine || !engine.available) {
            paintEngineSelect();
            return;
        }

        state.engine.engineId = engineId;
        state.engine = SF.normalizeEngine(state.engine);

        paintEngineSelect();
        save();
    });

    // Populate options once when the popup loads.
    populateEngineSelect();

    // ---------- theme tab ----------
    const setTheme = (patch) => {
        state.theme = SF.normalizeTheme({
            ...state.theme,
            ...patch,
            preset: 'custom'
        });
        paint();
        save();
    };

    $('themeEnabled').addEventListener('change', (e) => {
        state.theme = SF.normalizeTheme({
            ...state.theme,
            enabled: e.target.checked
        });
        paint();
        save();
    });
    for (const id of ['light', 'dark', 'hl', 'accent']) $(id).addEventListener('input', (e) => setTheme({
        [id]: e.target.value
    }));
    for (const id of ['style', 'pieces', 'coords']) $(id).addEventListener('change', (e) => setTheme({
        [id]: e.target.value
    }));
    $('hlOpacity').addEventListener('input', (e) => setTheme({
        hlOpacity: Number(e.target.value)
    }));
    $('radius').addEventListener('input', (e) => setTheme({
        radius: Number(e.target.value)
    }));
    $('shadow').addEventListener('change', (e) => setTheme({
        shadow: e.target.checked
    }));
    $('pageBgOn').addEventListener('change', (e) =>
        setTheme({
            pageBg: e.target.checked ? $('pageBg').value : ''
        }),
    );
    $('pageBg').addEventListener('input', (e) => setTheme({
        pageBg: e.target.value
    }));
    $('customCss').addEventListener('input', (e) => {
        state.theme = SF.normalizeTheme({
            ...state.theme,
            customCss: e.target.value
        });
        paintPreview();
        save();
    });
    $('resetTheme').addEventListener('click', () => {
        state.theme = SF.normalizeTheme({
            enabled: state.theme.enabled,
            preset: 'midnight'
        });
        state.theme = SF.applyPreset(state.theme, 'midnight');
        state.theme.customCss = '';
        paint();
        save();
    });

    // preset cards
    for (const p of SF.PRESETS) {
        const t = SF.normalizeTheme({
            ...SF.DEFAULT_THEME,
            ...p.theme,
            preset: p.id
        });
        const btn = document.createElement('button');
        btn.className = 'preset';
        btn.dataset.id = p.id;
        const mini = document.createElement('span');
        mini.className = 'mini';
        mini.style.background = SF.boardBackground(t);
        mini.style.backgroundColor = t.light;
        const name = document.createElement('i');
        name.textContent = p.name;
        btn.append(mini, name);
        btn.addEventListener('click', () => {
            state.theme = SF.applyPreset(state.theme, p.id);
            paint();
            save();
        });
        $('presets').appendChild(btn);
    }

    function paintPreview() {
        const t = state.theme;
        const pv = $('preview');
        pv.style.background = SF.boardBackground(t);
        pv.style.borderRadius = t.radius + 'px';
        pv.style.boxShadow = t.shadow ? '0 8px 24px rgba(0,0,0,.55)' : 'none';
        for (const [id, col, row] of [
                ['pvA', 4, 6],
                ['pvB', 4, 4]
            ]) {
            Object.assign($(id).style, {
                left: col * 12.5 + '%',
                top: (7 - row) * 12.5 + '%',
                background: t.hl,
                opacity: t.hlOpacity
            });
        }
        $('pvA').style.left = '37.5%';
        $('pvA').style.top = '75%';
        $('pvB').style.left = '37.5%';
        $('pvB').style.top = '50%';
        $('pvPiece').style.left = '37.5%';
        $('pvPiece').style.top = '50%';
        $('pvPiece').style.filter = {
            shadow: 'drop-shadow(0 2px 2px rgba(0,0,0,.6))',
            glow: `drop-shadow(0 0 1px rgba(255,255,255,.7)) drop-shadow(0 0 4px ${t.accent})`,
            crisp: 'contrast(1.12) saturate(1.15)',
            none: 'none',
        } [t.pieces];
        document.documentElement.style.setProperty('--acc', t.enabled ? t.accent : '#8b7dff');
        pv.style.opacity = t.enabled ? '1' : '0.45';
    }

    function paint() {
        const e = state.engine;
        const t = state.theme;
        paintEngineSelect();
        for (const id of settingIds) {
            $(id).checked = state.settings[id];
        }
        $('enabled').checked = state.enabled;
        if (document.activeElement !== $('serverUrl')) $('serverUrl').value = state.serverUrl;

        $('lines').value = e.lines;
        $('linesOut').textContent = e.lines;
        $('moveTimeMs').value = e.moveTimeMs;
        $('moveTimeOut').textContent = `${(e.moveTimeMs / 1000).toFixed(1)}s`;
        $('depth').value = e.depth;
        $('depthOut').textContent = e.depth;
        document.querySelectorAll('#searchMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === e.searchMode));
        $('rowTime').hidden = e.searchMode !== 'time';
        $('rowDepth').hidden = e.searchMode !== 'depth';
        $('rowTime').style.display = e.searchMode === 'time' ? 'flex' : 'none';
        $('rowDepth').style.display = e.searchMode === 'depth' ? 'flex' : 'none';

        $('themeEnabled').checked = t.enabled;
        for (const id of ['light', 'dark', 'hl', 'accent']) $(id).value = t[id];
        for (const id of ['style', 'pieces', 'coords']) $(id).value = t[id];
        $('hlOpacity').value = t.hlOpacity;
        $('hlOut').textContent = Math.round(t.hlOpacity * 100) + '%';
        $('radius').value = t.radius;
        $('radiusOut').textContent = t.radius + 'px';
        $('shadow').checked = t.shadow;
        $('pageBgOn').checked = !!t.pageBg;
        $('pageBg').value = t.pageBg || '#161512';
        $('pageBg').disabled = !t.pageBg;
        if (document.activeElement !== $('customCss')) $('customCss').value = t.customCss;
        document.querySelectorAll('.preset').forEach((b) => b.classList.toggle('on', b.dataset.id === t.preset));
        paintPreview();
    }

    // ---------- troubleshooting report ----------
    async function inspect(tabId) {
        const pre = $('report');
        pre.hidden = false;
        pre.textContent = 'Inspecting…';
        let text = 'No NovaChess page found. Open a chess.com page with a board, refresh it, then try again.';
        try {
            const ids = tabId != null ? [tabId] : (await chrome.tabs.query({
                active: true,
                currentWindow: true
            })).map((t) => t.id);
            for (const id of ids) {
                try {
                    text = await chrome.tabs.sendMessage(id, {
                        type: 'nova-diagnose'
                    });
                    break;
                } catch {
                    /* no content script in that tab */
                }
            }
        } catch {
            /* ignore */
        }
        pre.textContent = text;
        $('copyReport').hidden = false;
        return text;
    }
    $('inspect').addEventListener('click', () => inspect());
    $('copyReport').addEventListener('click', async () => {
        await navigator.clipboard.writeText($('report').textContent);
        $('copyReport').textContent = 'Copied';
        setTimeout(() => {
            $('copyReport').textContent = 'Copy';
        }, 1500);
    });

    chrome.storage.local.get('sf').then((r) => {
        state = SF.normalizeState(r.sf);
        paint();
    });

    async function loadChessRatings(username) {
        const rapid = document.querySelector('#rapidRating');
        const blitz = document.querySelector('#blitzRating');

        try {
            const response = await fetch(
                `https://api.chess.com/pub/player/${encodeURIComponent(username)}/stats`
            );

            if (!response.ok) throw new Error(`API error: ${response.status}`);

            const stats = await response.json();

            rapid.textContent = stats.chess_rapid?.last?.rating ?? '—';
            blitz.textContent = stats.chess_blitz?.last?.rating ?? '—';

        } catch (error) {
            console.error('Failed to load Chess.com ratings:', error);
            rapid.textContent = '—';
            blitz.textContent = '—';
        }
    }

    function displayProfile(chessProfile) {
        if (!profile) return;

        document.querySelector('#nameView').textContent = chessProfile.username;
        document.querySelector('#avatarImg').src = chessProfile.avatar;
        loadChessRatings(chessProfile.username);
    }

    // Load existing profile when popup opens
    chrome.storage.local.get('chessProfile', ({
        chessProfile
    }) => {
        if (!chessProfile) return;
        displayProfile(chessProfile)
    });

    // Listen for profile updates
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.chessProfile) {
            displayProfile(changes.chessProfile.newValue);
        }
    });


    window.__popup = {
        flush,
        inspect,
        get state() {
            return state;
        }
    }; // test hook
})();