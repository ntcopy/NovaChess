const AD_RULESET_ID = 'novachess_ads';

async function syncAdBlocker() {
    const {
        sf
    } = await chrome.storage.local.get('sf');

    const enabled = sf?.settings?.adBlockEnabled === true;

    await chrome.declarativeNetRequest.updateEnabledRulesets({
        enableRulesetIds: enabled ? [AD_RULESET_ID] : [],
        disableRulesetIds: enabled ? [] : [AD_RULESET_ID],
    });
}

chrome.runtime.onInstalled.addListener(syncAdBlocker);
chrome.runtime.onStartup.addListener(syncAdBlocker);
chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.sf) {
        syncAdBlocker();
    }
});