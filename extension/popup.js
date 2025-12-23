// PhysChat Popup Script

// CONFIGURE: Set your Cloudflare Worker URL here
const CONFIG = {
  workerUrl: 'https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev'
};

document.addEventListener('DOMContentLoaded', () => {
  const statusEl = document.getElementById('status');
  const authButton = document.getElementById('authButton');
  const logoutButton = document.getElementById('logoutButton');
  const openSiteButton = document.getElementById('openSiteButton');

  // Check authentication status
  chrome.storage.local.get(['physchat_token'], (result) => {
    if (result.physchat_token) {
      showAuthenticatedState();
    } else {
      showUnauthenticatedState();
    }
  });

  function showAuthenticatedState() {
    statusEl.className = 'status authenticated';
    statusEl.textContent = 'You are signed in. Visit journals.aps.org to search articles.';
    authButton.style.display = 'none';
    logoutButton.style.display = 'block';
  }

  function showUnauthenticatedState() {
    statusEl.className = 'status not-authenticated';
    statusEl.textContent = 'Sign in to search APS articles.';
    authButton.style.display = 'block';
    logoutButton.style.display = 'none';
  }

  // Sign in button
  authButton.addEventListener('click', () => {
    const authUrl = `${CONFIG.workerUrl}/auth`;
    chrome.tabs.create({ url: authUrl });
    window.close();
  });

  // Sign out button
  logoutButton.addEventListener('click', () => {
    chrome.storage.local.remove(['physchat_token'], () => {
      showUnauthenticatedState();
    });
  });

  // Open site button
  openSiteButton.addEventListener('click', () => {
    chrome.tabs.create({ url: 'https://journals.aps.org' });
    window.close();
  });

  // Dev mode: Set token manually
  const setTokenBtn = document.getElementById('setTokenBtn');
  const tokenInput = document.getElementById('tokenInput');

  setTokenBtn.addEventListener('click', () => {
    const token = tokenInput.value.trim();
    if (token) {
      chrome.storage.local.set({ physchat_token: token }, () => {
        showAuthenticatedState();
        tokenInput.value = '';
      });
    }
  });
});
