const FEATURES = [
  ['seizureMode', SEIZURE],
  ['earthquake', EARTHQUAKE],
  ['drunkMode', DRUNK],
  ['blunderAlarm', BLUNDER_ALARM],
  ['trashTalk', TRASH_TALK],
];

chrome.storage.local.get('sf', ({ sf }) => {
  for (const [k, f] of FEATURES) sf?.settings?.[k] === true ? f.start() : f.stop();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.sf) return;
  for (const [k, f] of FEATURES) changes.sf.newValue?.settings?.[k] === true ? f.start() : f.stop();
});
window.addEventListener('message', (e) => e.data?.__novaEval && console.log('[nova-fun] eval', e.data));