// PhysChat Background Service Worker
// Handles authentication callbacks and manages extension state

// Try to load config.local.js (gitignored)
try {
  importScripts('config.local.js');
} catch (e) {
  // config.local.js not found - using defaults
}

// Configuration - uses config.local.js if present, otherwise placeholder
const CONFIG = {
  workerUrl: (typeof PHYSCHAT_CONFIG !== 'undefined' && PHYSCHAT_CONFIG.workerUrl)
    ? PHYSCHAT_CONFIG.workerUrl
    : 'https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev'
};

// Listen for messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_AUTH_STATUS') {
    chrome.storage.local.get(['physchat_token'], (result) => {
      sendResponse({ isAuthenticated: !!result.physchat_token });
    });
    return true; // Required for async sendResponse
  }

  if (request.type === 'LOGOUT') {
    chrome.storage.local.remove(['physchat_token'], () => {
      sendResponse({ success: true });
    });
    return true;
  }

  if (request.type === 'SAVE_TOKEN') {
    chrome.storage.local.set({ physchat_token: request.token }, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// Handle OAuth callback URL
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url && changeInfo.url.includes('/auth/callback')) {
    // Extract token from callback URL
    const url = new URL(changeInfo.url);
    const token = url.searchParams.get('token');

    if (token) {
      // Save token
      chrome.storage.local.set({ physchat_token: token }, () => {
        // Close the auth popup/tab
        chrome.tabs.remove(tabId);

        // Notify all journals.aps.org tabs
        chrome.tabs.query({ url: 'https://journals.aps.org/*' }, (tabs) => {
          tabs.forEach((tab) => {
            chrome.tabs.sendMessage(tab.id, {
              type: 'AUTH_SUCCESS',
              token: token
            }).catch(() => {
              // Tab might not have content script loaded yet
            });
          });
        });
      });
    }
  }
});

// Set up context menu for quick access (optional)
chrome.runtime.onInstalled.addListener(() => {
  console.log('PhysChat extension installed');
});
