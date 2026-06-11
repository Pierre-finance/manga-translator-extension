// Ouvre le side panel automatiquement au clic sur l'icône
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});

// Gère les messages venant du side panel
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "CAPTURE_TAB") {
    chrome.tabs.captureVisibleTab(null, { format: "png" })
      .then((dataURL) => {
        sendResponse({ success: true, dataURL });
      })
      .catch((err) => {
        const isProtected =
          err.message.includes("chrome://") ||
          err.message.includes("Cannot access") ||
          err.message.includes("chrome-extension://");

        const userMessage = isProtected
          ? "Impossible de capturer cette page (page système ou protégée). Ouvre un site web normal et réessaie."
          : `Erreur lors de la capture : ${err.message}`;

        sendResponse({ success: false, error: userMessage });
      });

    // Indispensable : maintient le canal ouvert pour la réponse asynchrone
    return true;
  }
});
