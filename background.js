// Clicking the toolbar icon opens the creator in its own tab.
// (A popup would close when the file picker opens and lose the chosen file.)
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});
