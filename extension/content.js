// PhysChat Content Script
// Injects sidebar into journals.aps.org pages

(function() {
  'use strict';

  // Configuration - will be updated with actual Worker URL after deployment
  // CONFIGURE: Set your Cloudflare Worker URL here
  const CONFIG = {
    workerUrl: 'https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev',
    maxResults: 10
  };

  // State
  let isAuthenticated = false;
  let authToken = null;
  let isCollapsed = false;

  // Initialize
  function init() {
    loadAuthState();
    injectSidebar();
    setupEventListeners();
  }

  // Load authentication state from storage
  function loadAuthState() {
    chrome.storage.local.get(['physchat_token', 'physchat_collapsed'], (result) => {
      if (result.physchat_token) {
        authToken = result.physchat_token;
        isAuthenticated = true;
        updateAuthUI();
      }
      if (result.physchat_collapsed) {
        isCollapsed = result.physchat_collapsed;
        if (isCollapsed) {
          document.getElementById('physchat-sidebar')?.classList.add('collapsed');
          document.getElementById('physchat-toggle-tab')?.classList.add('sidebar-collapsed');
        }
      }
    });
  }

  // Save collapsed state
  function saveCollapsedState() {
    chrome.storage.local.set({ physchat_collapsed: isCollapsed });
  }

  // Inject sidebar HTML
  function injectSidebar() {
    const sidebarHTML = `
      <div id="physchat-sidebar">
        <div id="physchat-header">
          <h1>
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 0 0 1.48-5.34c-.47-2.78-2.79-5-5.59-5.34a6.505 6.505 0 0 0-7.27 7.27c.34 2.8 2.56 5.12 5.34 5.59a6.5 6.5 0 0 0 5.34-1.48l.27.28v.79l4.25 4.25c.41.41 1.08.41 1.49 0 .41-.41.41-1.08 0-1.49L15.5 14zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
            </svg>
            PhysChat
          </h1>
          <button id="physchat-close-btn" title="Collapse sidebar">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M8.59 16.59L13.17 12 8.59 7.41 10 6l6 6-6 6-1.41-1.41z"/>
            </svg>
          </button>
        </div>

        <div id="physchat-auth-banner">
          <p>Sign in to search articles</p>
          <button id="physchat-login-btn">Sign In</button>
        </div>

        <div id="physchat-search-container">
          <form id="physchat-search-form">
            <input
              type="text"
              id="physchat-search-input"
              placeholder="Search physics articles..."
              autocomplete="off"
            />
            <button type="submit" id="physchat-search-btn" title="Search">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 0 0 1.48-5.34c-.47-2.78-2.79-5-5.59-5.34a6.505 6.505 0 0 0-7.27 7.27c.34 2.8 2.56 5.12 5.34 5.59a6.5 6.5 0 0 0 5.34-1.48l.27.28v.79l4.25 4.25c.41.41 1.08.41 1.49 0 .41-.41.41-1.08 0-1.49L15.5 14zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
              </svg>
            </button>
          </form>
        </div>

        <div id="physchat-results">
          <div id="physchat-loading">
            <div class="physchat-spinner"></div>
            <p>Searching articles...</p>
          </div>

          <div id="physchat-error"></div>

          <div id="physchat-empty">
            <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
              <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-5 14H7v-2h7v2zm3-4H7v-2h10v2zm0-4H7V7h10v2z"/>
            </svg>
            <h3>Search APS Articles</h3>
            <p>Enter a query to search for physics articles across APS journals.</p>
          </div>

          <div id="physchat-results-list"></div>
        </div>
      </div>

      <div id="physchat-toggle-tab" title="Open PhysChat">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M15.41 16.59L10.83 12l4.58-4.59L14 6l-6 6 6 6 1.41-1.41z"/>
        </svg>
      </div>
    `;

    const container = document.createElement('div');
    container.id = 'physchat-container';
    container.innerHTML = sidebarHTML;
    document.body.appendChild(container);

    // Apply initial collapsed state
    if (isCollapsed) {
      document.getElementById('physchat-sidebar').classList.add('collapsed');
      document.getElementById('physchat-toggle-tab').classList.add('sidebar-collapsed');
    }
  }

  // Setup event listeners
  function setupEventListeners() {
    // Close/collapse button
    document.getElementById('physchat-close-btn').addEventListener('click', toggleSidebar);

    // Toggle tab
    document.getElementById('physchat-toggle-tab').addEventListener('click', toggleSidebar);

    // Login button
    document.getElementById('physchat-login-btn').addEventListener('click', initiateLogin);

    // Search form
    document.getElementById('physchat-search-form').addEventListener('submit', handleSearch);

    // Listen for auth callback messages
    window.addEventListener('message', handleAuthMessage);

    // Listen for storage changes (for auth updates from popup)
    chrome.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === 'local' && changes.physchat_token) {
        if (changes.physchat_token.newValue) {
          authToken = changes.physchat_token.newValue;
          isAuthenticated = true;
        } else {
          authToken = null;
          isAuthenticated = false;
        }
        updateAuthUI();
      }
    });
  }

  // Toggle sidebar visibility
  function toggleSidebar() {
    const sidebar = document.getElementById('physchat-sidebar');
    const tab = document.getElementById('physchat-toggle-tab');

    isCollapsed = !isCollapsed;
    sidebar.classList.toggle('collapsed', isCollapsed);
    tab.classList.toggle('sidebar-collapsed', isCollapsed);

    saveCollapsedState();
  }

  // Update authentication UI
  function updateAuthUI() {
    const authBanner = document.getElementById('physchat-auth-banner');
    if (isAuthenticated) {
      authBanner.classList.add('hidden');
    } else {
      authBanner.classList.remove('hidden');
    }
  }

  // Initiate OAuth login
  function initiateLogin() {
    const authUrl = `${CONFIG.workerUrl}/auth`;
    const width = 500;
    const height = 600;
    const left = (window.screen.width - width) / 2;
    const top = (window.screen.height - height) / 2;

    window.open(
      authUrl,
      'PhysChat Login',
      `width=${width},height=${height},left=${left},top=${top}`
    );
  }

  // Handle auth callback message from popup window
  function handleAuthMessage(event) {
    if (event.data && event.data.type === 'PHYSCHAT_AUTH_SUCCESS') {
      authToken = event.data.token;
      isAuthenticated = true;
      chrome.storage.local.set({ physchat_token: authToken });
      updateAuthUI();
    }
  }

  // Handle search form submission
  async function handleSearch(event) {
    event.preventDefault();

    const input = document.getElementById('physchat-search-input');
    const query = input.value.trim();

    if (!query) return;

    if (!isAuthenticated) {
      showError('Please sign in to search articles.');
      return;
    }

    showLoading(true);
    hideError();
    hideEmpty();
    clearResults();

    try {
      const results = await performSearch(query);
      displayResults(results);
    } catch (error) {
      console.error('PhysChat search error:', error);
      showError(error.message || 'An error occurred while searching. Please try again.');
    } finally {
      showLoading(false);
    }
  }

  // Perform search API call
  async function performSearch(query) {
    const response = await fetch(`${CONFIG.workerUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        query: query,
        limit: CONFIG.maxResults
      })
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Token expired, clear auth state
        authToken = null;
        isAuthenticated = false;
        chrome.storage.local.remove('physchat_token');
        updateAuthUI();
        throw new Error('Your session has expired. Please sign in again.');
      }
      throw new Error('Search failed. Please try again.');
    }

    return response.json();
  }

  // Display search results
  function displayResults(data) {
    const resultsContainer = document.getElementById('physchat-results-list');
    const results = data.results || [];

    if (results.length === 0) {
      showEmpty();
      return;
    }

    // Show results count
    const countHTML = `<div id="physchat-results-count">Found ${data.total || results.length} articles${data.total > results.length ? ` (showing ${results.length})` : ''}</div>`;

    const resultsHTML = results.map(result => createResultCard(result)).join('');
    resultsContainer.innerHTML = countHTML + resultsHTML;

    // Add click handlers for article links
    resultsContainer.querySelectorAll('.physchat-article-link').forEach(link => {
      link.addEventListener('click', handleArticleClick);
    });
  }

  // Create HTML for a result card
  function createResultCard(result) {
    const authors = formatAuthors(result.authors || []);
    const summary = generateSummary(result.abstract || '');
    const articleUrl = result.url || `https://doi.org/${result.doi}`;

    return `
      <div class="physchat-result-card">
        <h3 class="physchat-result-title">
          <a href="${escapeHtml(articleUrl)}" class="physchat-article-link" data-url="${escapeHtml(articleUrl)}">${escapeHtml(result.title || 'Untitled')}</a>
        </h3>
        <p class="physchat-result-authors">${escapeHtml(authors)}</p>
        <div class="physchat-result-meta">
          ${result.journal ? `<span class="physchat-result-badge journal">${escapeHtml(result.journal)}</span>` : ''}
          ${result.date ? `<span class="physchat-result-badge">${escapeHtml(result.date)}</span>` : ''}
          ${result.doi ? `<span class="physchat-result-badge">DOI: ${escapeHtml(result.doi)}</span>` : ''}
        </div>
        <p class="physchat-result-summary">${escapeHtml(summary)}</p>
        <a href="${escapeHtml(articleUrl)}" class="physchat-result-link physchat-article-link" data-url="${escapeHtml(articleUrl)}">
          View Article
          <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z"/>
          </svg>
        </a>
      </div>
    `;
  }

  // Format authors list
  function formatAuthors(authors) {
    if (!authors || authors.length === 0) return 'Unknown authors';
    if (authors.length <= 3) return authors.join(', ');
    return `${authors.slice(0, 3).join(', ')} et al.`;
  }

  // Generate summary from abstract (first 1-2 sentences)
  function generateSummary(abstract) {
    if (!abstract) return 'No summary available.';

    // Remove HTML tags
    const plainText = abstract.replace(/<[^>]*>/g, '');

    // Get first 1-2 sentences (up to ~200 chars)
    const sentences = plainText.match(/[^.!?]+[.!?]+/g) || [plainText];
    let summary = sentences[0] || plainText;

    if (summary.length < 100 && sentences.length > 1) {
      summary += ' ' + sentences[1];
    }

    if (summary.length > 250) {
      summary = summary.substring(0, 247) + '...';
    }

    return summary.trim();
  }

  // Handle article link click - navigate in same tab
  function handleArticleClick(event) {
    event.preventDefault();
    const url = event.currentTarget.dataset.url;
    if (url) {
      // Navigate in the same tab, sidebar will persist due to content script
      window.location.href = url;
    }
  }

  // Show/hide loading state
  function showLoading(show) {
    document.getElementById('physchat-loading').classList.toggle('visible', show);
  }

  // Show error message
  function showError(message) {
    const errorEl = document.getElementById('physchat-error');
    errorEl.textContent = message;
    errorEl.classList.add('visible');
  }

  // Hide error message
  function hideError() {
    document.getElementById('physchat-error').classList.remove('visible');
  }

  // Show empty state
  function showEmpty() {
    document.getElementById('physchat-empty').style.display = 'flex';
  }

  // Hide empty state
  function hideEmpty() {
    document.getElementById('physchat-empty').style.display = 'none';
  }

  // Clear results
  function clearResults() {
    document.getElementById('physchat-results-list').innerHTML = '';
  }

  // Escape HTML to prevent XSS
  function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
