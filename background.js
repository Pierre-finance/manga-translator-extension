// ── Initialisation ─────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// ── Messages ───────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {

  if (message.type === 'CAPTURE_TAB') {
    (async () => {
      try {
        const dataURL = await chrome.tabs.captureVisibleTab(null, { format: 'png' });
        sendResponse({ ok: true, data: { dataURL } });
      } catch (err) {
        const isProtected =
          err.message.includes('chrome://') ||
          err.message.includes('Cannot access') ||
          err.message.includes('chrome-extension://');
        sendResponse({
          ok: false,
          error: isProtected
            ? 'Impossible de capturer cette page (page système ou protégée). Ouvre un site web normal et réessaie.'
            : `Erreur lors de la capture : ${err.message}`,
        });
      }
    })();
    return true;
  }
});
