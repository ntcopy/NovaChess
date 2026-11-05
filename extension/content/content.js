(() => {
    "use strict";

    function injectModalAssets() {
        const inject = () => {
            if (!document.body) return;
            injectAutoplayModal();
        };

        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', inject, {
                once: true
            });
        } else {
            inject();
        }
    }

    function injectAutoplayModal() {
        if (document.getElementById('novachess-autoplay-warning')) return;

        const modal = document.createElement('div');

        modal.innerHTML = `
        <div
        class="vm-backdrop"
        id="novachess-autoplay-warning"
        data-static
        role="dialog"
        aria-modal="true"
        aria-labelledby="novachess-autoplay-title"
        aria-hidden="true"
        >
        <div class="vm-dialog">
            <div class="vm-header">
            <div class="vm-icon">⚠️</div>
            <h2 class="vm-title" id="novachess-autoplay-title">
                Enable Autoplay?
            </h2>
            <p class="vm-sub">Important fair-play notice</p>
            </div>

            <div class="vm-content">
            <p class="vm-body">
                Autoplay uses automated moves to play chess on your behalf.
                Using automated play during live games may violate Chess.com's
                Fair Play Policy and could result in account restrictions.
            </p>

            <div class="vm-actions">
                <button class="vm-btn vm-btn--danger"
                        data-modal-close="true"
                        id="novachess-autoplay-accept">
                Enable Autoplay
                </button>
                <button class="vm-btn vm-btn--ghost"
                        data-modal-close="false">
                Cancel
                </button>
            </div>
            </div>
        </div>
        </div>
    `;

        document.body.appendChild(modal.firstElementChild);
    }

    injectModalAssets();

    window.addEventListener('message', async (event) => {
        if (event.source !== window || event.origin !== location.origin) return;

        const data = event.data;
        if (data?.type !== 'NOVACHESS_AUTOPLAY_CONFIRM') return;
        if (typeof data.requestId !== 'string') return;

        // Respect the user's confirmation preference.
        const {
            sf
        } = await chrome.storage.local.get('sf');

        if (sf?.settings?.confirmAutoplay === false) {
            window.postMessage({
                type: 'NOVACHESS_AUTOPLAY_CONFIRM_RESULT',
                requestId: data.requestId,
                approved: true
            }, location.origin);
            return;
        }

        const modal = document.querySelector('#novachess-autoplay-warning');

        if (!modal || !window.Modal) {
            window.postMessage({
                type: 'NOVACHESS_AUTOPLAY_CONFIRM_RESULT',
                requestId: data.requestId,
                approved: false
            }, location.origin);
            return;
        }

        const approved = await new Promise(resolve => {
            const onClose = (event) => {
                modal.removeEventListener('modal:close', onClose);
                resolve(event.detail === true || event.detail === 'true');
            };

            modal.addEventListener('modal:close', onClose, {
                once: true
            });
            window.Modal.open(modal);
        });

        window.postMessage({
            type: 'NOVACHESS_AUTOPLAY_CONFIRM_RESULT',
            requestId: data.requestId,
            approved
        }, location.origin);
    });

    const LOGOS = {
        "/bundles/web/images/logo/logo.svg": "novachess-logo.svg",
        "/bundles/web/images/logo/logo-pawn.svg": "novachess-pawn.svg"
    };

    function getChessComProfile() {
        const profile = document.querySelector('a.sidebar-link[href*="/member/"]');

        if (!profile) return null;

        const username = profile.querySelector('.sidebar-link-text')?.textContent.trim();
        const avatar = profile.querySelector('img.cc-avatar-img')?.src;

        if (!username || !avatar) return null;

        return {
            username,
            avatar
        };
    }

    // Avoid unnecessary storage writes
    let lastProfile = '';

    function updateProfile() {
        const profile = getChessComProfile();

        if (!profile) return;

        const serialized = JSON.stringify(profile);

        // Skip if nothing changed
        if (serialized === lastProfile) return;

        lastProfile = serialized;

        chrome.storage.local.set({
            chessProfile: profile
        });
    }

    // Observe Chess.com's dynamically rendered sidebar
    const observer1 = new MutationObserver(() => {
        updateProfile();
    });

    function startProfileObserver() {
        if (!document.documentElement) {
            requestAnimationFrame(startProfileObserver);
            return;
        }

        observer1.observe(document.documentElement, {
            childList: true,
            subtree: true
        });

        // Initial lookup
        updateProfile();
    }

    startProfileObserver();

    const extensionUrl = path => chrome.runtime.getURL(path);

    function replacement(value) {
        if (!value) return null;

        try {
            const url = new URL(value, location.href);

            if (
                !/(^|\.)chess\.com$/i.test(url.hostname) ||
                !LOGOS[url.pathname]
            ) return null;

            return extensionUrl(LOGOS[url.pathname]);
        } catch {
            return null;
        }
    }

    function rewriteSrcset(value) {
        if (!value) return value;

        return value.split(",").map(candidate => {
            const parts = candidate.trim().split(/\s+/);
            const local = replacement(parts[0]);

            if (local) parts[0] = local;
            return parts.join(" ");
        }).join(", ");
    }

    function processElement(el) {
        if (!(el instanceof Element)) return;

        // Regular image elements
        if (el instanceof HTMLImageElement) {
            const local = replacement(el.src);
            if (local) el.src = local;

            const srcset = el.getAttribute("srcset");
            if (srcset) {
                const updated = rewriteSrcset(srcset);
                if (updated !== srcset) el.setAttribute("srcset", updated);
            }
        }

        // Responsive image sources
        if (el instanceof HTMLSourceElement) {
            const srcset = el.getAttribute("srcset");
            if (srcset) {
                const updated = rewriteSrcset(srcset);
                if (updated !== srcset) el.setAttribute("srcset", updated);
            }
        }

        // Inline SVG image references
        if (el instanceof SVGImageElement || el instanceof SVGUseElement) {
            for (const attr of ["href", "xlink:href"]) {
                const value = el.getAttribute(attr);
                const local = replacement(value);

                if (local) el.setAttribute(attr, local);
            }
        }

        // Inline CSS background images and CSS-driven logos
        if (el instanceof HTMLElement) {
            const bg = getComputedStyle(el).backgroundImage;

            if (bg && bg !== "none") {
                for (const [path, file] of Object.entries(LOGOS)) {
                    if (bg.includes(path)) {
                        el.style.backgroundImage =
                            `url("${extensionUrl(file)}")`;
                    }
                }
            }
        }
    }

    function scan(root) {
        processElement(root);

        root.querySelectorAll?.(
            "img, source, image, use, [style]"
        ).forEach(processElement);
    }

    // Process existing content
    scan(document.documentElement);

    // Watch for dynamically inserted logos and changed attributes
    const observer = new MutationObserver(records => {
        for (const record of records) {
            if (record.type === "attributes") {
                processElement(record.target);
            }

            for (const node of record.addedNodes) {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    scan(node);
                }
            }
        }
    });

    observer.observe(document.documentElement, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: [
            "src",
            "srcset",
            "href",
            "style"
        ]
    });

    console.log("[NovaChess] Logo replacement active.");
})();