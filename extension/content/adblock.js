(() => {
    'use strict';

    const GRID_SELECTOR = '.board-layout';
    const AD_SELECTOR = '#board-layout-ad, .board-layout-ad';

    let enabled = false;
    let hidePromotions = false;
    let observer = null;
    let resizeObserver = null;
    let scheduled = false;
    let lastGrid = null;
    let originalStyles = null;

    setInterval(() => {
        if (enabled) {
            try {
                document.querySelector("#board-layout-chessboard > div.board-modal-container-container > div > div > div > div.game-over-ad-sidecar-component").remove()
            } catch {}
        }
    }, 50);

    function applyLayout() {
        scheduled = false;
        if (!enabled) return;

        const grid = document.querySelector(GRID_SELECTOR);
        if (!grid) return;

        if (grid !== lastGrid) {
            lastGrid = grid;

            originalStyles = {
                paddingLeft: grid.style.getPropertyValue('padding-left'),
                paddingLeftPriority: grid.style.getPropertyPriority('padding-left'),
                baseAdWidth: grid.style.getPropertyValue('--baseAdWidth'),
                adWidth: grid.style.getPropertyValue('--adWidth'),
                sidebarMinWidth: grid.style.getPropertyValue('--sidebarMinWidth')
            };
        }

        // Match the Premium layout.
        grid.style.setProperty('padding-left', '182px', 'important');
        grid.style.setProperty('--baseAdWidth', '0px');
        grid.style.setProperty('--adWidth', '0px');
        grid.style.setProperty('--sidebarMinWidth', '500px');

        // Remove ad containers.
        grid.querySelectorAll(AD_SELECTOR).forEach(ad => ad.remove());
        applyPromotions();
    }

    function applyPromotions() {
        if (!hidePromotions) return;

        document.querySelectorAll('a[href*="chess.com/membership"]').forEach(link => {
            const promo = link.closest(
                '[class*="promotion"], [class*="upsell"], [data-cy*="membership"]'
            );

            (promo || link).remove();
        });
    }

    function scheduleApply() {
        if (!enabled || scheduled) return;
        scheduled = true;
        requestAnimationFrame(applyLayout);
    }

    function restoreLayout() {
        if (lastGrid && originalStyles) {
            const restore = (property, value, priority = '') => {
                if (value) {
                    lastGrid.style.setProperty(property, value, priority);
                } else {
                    lastGrid.style.removeProperty(property);
                }
            };

            restore(
                'padding-left',
                originalStyles.paddingLeft,
                originalStyles.paddingLeftPriority
            );

            restore('--baseAdWidth', originalStyles.baseAdWidth);
            restore('--adWidth', originalStyles.adWidth);
            restore('--sidebarMinWidth', originalStyles.sidebarMinWidth);
        }

        lastGrid = null;
        originalStyles = null;
    }

    function setEnabled(value) {
        if (enabled === value) return;
        enabled = value;

        if (enabled) {
            scheduleApply();

            if (!observer) {
                observer = new MutationObserver(scheduleApply);
                observer.observe(document.documentElement, {
                    childList: true,
                    subtree: true
                });
            }

            if (!resizeObserver) {
                resizeObserver = new ResizeObserver(scheduleApply);
                const grid = document.querySelector(GRID_SELECTOR);
                if (grid) resizeObserver.observe(grid);
            }
        } else {
            observer?.disconnect();
            resizeObserver?.disconnect();
            observer = null;
            resizeObserver = null;
            restoreLayout();
        }
    }

    // Read the same saved state used by background.js.
    chrome.storage.local.get('sf', ({
        sf
    }) => {
        setEnabled(sf?.settings?.adBlockEnabled === true);

        hidePromotions = sf?.settings?.hidePromotions === true;
        if (hidePromotions) applyPromotions();
    });

    // React immediately when the popup changes the setting.
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes.sf) return;

        setEnabled(
            changes.sf.newValue?.settings?.adBlockEnabled === true
        );
    });

    window.addEventListener('resize', scheduleApply);

})();