// PhysChat Content Script
// Injects sidebar into journals.aps.org pages with AI-powered search

(function() {
  'use strict';

  // Configuration - uses config.local.js if present, otherwise placeholder
  const CONFIG = {
    workerUrl: (typeof PHYSCHAT_CONFIG !== 'undefined' && PHYSCHAT_CONFIG.workerUrl)
      ? PHYSCHAT_CONFIG.workerUrl
      : 'https://YOUR_WORKER_NAME.YOUR_SUBDOMAIN.workers.dev',
    maxResults: 15
  };

  // State
  let isAuthenticated = false;
  let authToken = null;
  let isCollapsed = false;
  let thinkingExpanded = true;
  let currentResults = [];
  let currentTotalFound = 0;
  let currentQuery = '';
  let currentAIAnalysis = null;

  // Input sanitization for prompt injection protection
  // This is a POC-level safeguard - not comprehensive
  function sanitizeInput(input) {
    if (!input || typeof input !== 'string') return '';

    let sanitized = input;

    // Remove code blocks
    sanitized = sanitized.replace(/```[\s\S]*?```/g, '');
    sanitized = sanitized.replace(/`[^`]*`/g, '');

    // Remove HTML/script tags
    sanitized = sanitized.replace(/<[^>]*>/g, '');

    // Remove common prompt injection patterns
    const injectionPatterns = [
      /ignore\s+(previous|above|all)\s+(instructions?|prompts?|rules?)/gi,
      /disregard\s+(previous|above|all)/gi,
      /forget\s+(previous|above|everything)/gi,
      /system\s*:/gi,
      /assistant\s*:/gi,
      /user\s*:/gi,
      /\[INST\]/gi,
      /\[\/INST\]/gi,
      /<<SYS>>/gi,
      /<\/SYS>>/gi,
      /\{\{.*?\}\}/g,  // Template injection
      /\$\{.*?\}/g,    // Template literals
      /<\|.*?\|>/g,    // Special tokens
    ];

    for (const pattern of injectionPatterns) {
      sanitized = sanitized.replace(pattern, '');
    }

    // Remove URLs (could be used for exfiltration)
    sanitized = sanitized.replace(/https?:\/\/[^\s]+/gi, '');

    // Limit length (physics queries shouldn't be excessively long)
    const MAX_QUERY_LENGTH = 500;
    if (sanitized.length > MAX_QUERY_LENGTH) {
      sanitized = sanitized.substring(0, MAX_QUERY_LENGTH);
    }

    // Trim and normalize whitespace
    sanitized = sanitized.replace(/\s+/g, ' ').trim();

    return sanitized;
  }

  // Physics concepts for extraction
  const PHYSICS_TERMS = new Set([
    'quantum', 'entanglement', 'superconductor', 'topological', 'magnetic', 'photon',
    'electron', 'spin', 'lattice', 'phase', 'transition', 'coherence', 'correlation',
    'scattering', 'spectroscopy', 'resonance', 'oscillation', 'coupling', 'interaction',
    'symmetry', 'order', 'disorder', 'fluctuation', 'excitation', 'ground state',
    'fermi', 'bose', 'quasiparticle', 'band', 'gap', 'insulator', 'conductor',
    'semiconductor', 'nanostructure', 'graphene', 'cavity', 'waveguide'
  ]);

  // Initialize
  function init() {
    loadAuthState();
    injectSidebar();
    setupEventListeners();
    restoreSearchState();
  }

  // Save search state before navigation
  function saveSearchState() {
    if (currentResults.length > 0) {
      chrome.storage.local.set({
        physchat_search_state: {
          query: currentQuery,
          results: currentResults,
          totalFound: currentTotalFound,
          aiAnalysis: currentAIAnalysis,
          timestamp: Date.now()
        }
      });
    }
  }

  // Restore search state after navigation
  function restoreSearchState() {
    chrome.storage.local.get(['physchat_search_state'], (result) => {
      const state = result.physchat_search_state;
      if (state && state.results && state.results.length > 0) {
        // Only restore if state is less than 10 minutes old
        const age = Date.now() - (state.timestamp || 0);
        if (age < 10 * 60 * 1000) {
          currentQuery = state.query || '';
          currentResults = state.results;
          currentTotalFound = state.totalFound || currentResults.length;
          currentAIAnalysis = state.aiAnalysis;

          // Restore UI - hide empty state first
          hideEmpty();
          document.getElementById('physchat-search-input').value = currentQuery;
          renderSynthesis(currentResults, currentTotalFound, currentAIAnalysis);
          displayResults(currentResults, currentTotalFound);

          // Fetch AI summaries for top results
          if (currentResults.length > 0) {
            fetchAISummaries(currentResults.slice(0, 5));
          }
        } else {
          // Clear stale state
          clearSearchState();
        }
      }
    });
  }

  // Clear saved search state
  function clearSearchState() {
    chrome.storage.local.remove('physchat_search_state');
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
              placeholder="Ask a question about physics..."
              autocomplete="off"
            />
            <button type="submit" id="physchat-search-btn" title="Search">
              <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                <path d="M15.5 14h-.79l-.28-.27a6.5 6.5 0 0 0 1.48-5.34c-.47-2.78-2.79-5-5.59-5.34a6.505 6.505 0 0 0-7.27 7.27c.34 2.8 2.56 5.12 5.34 5.59a6.5 6.5 0 0 0 5.34-1.48l.27.28v.79l4.25 4.25c.41.41 1.08.41 1.49 0 .41-.41.41-1.08 0-1.49L15.5 14zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/>
              </svg>
            </button>
          </form>
          <div class="physchat-search-options">
            <select id="physchat-sort-select" class="physchat-sort-select">
              <option value="relevance">Relevance</option>
              <option value="recent">Most Recent</option>
            </select>
            <label class="physchat-ai-toggle">
              <input type="checkbox" id="physchat-use-ai" checked />
              <span>AI Search</span>
              <span class="physchat-ai-badge">AI</span>
            </label>
          </div>
        </div>

        <!-- Thinking Panel -->
        <div id="physchat-thinking-panel">
          <div class="physchat-thinking-header">
            <div class="physchat-thinking-title">
              <div class="physchat-status-indicator" id="physchat-status"></div>
              <h3>Search Process</h3>
            </div>
            <button class="physchat-thinking-toggle" id="physchat-thinking-toggle">Collapse</button>
          </div>
          <div class="physchat-thinking-content" id="physchat-thinking-content"></div>
        </div>

        <!-- Synthesis Panel -->
        <div id="physchat-synthesis-panel"></div>

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

    // Thinking panel toggle
    document.getElementById('physchat-thinking-toggle').addEventListener('click', toggleThinking);

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

  // Toggle thinking panel
  function toggleThinking() {
    thinkingExpanded = !thinkingExpanded;
    const content = document.getElementById('physchat-thinking-content');
    const btn = document.getElementById('physchat-thinking-toggle');
    content.classList.toggle('collapsed', !thinkingExpanded);
    btn.textContent = thinkingExpanded ? 'Collapse' : 'Expand';
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

  // Set status indicator
  function setStatus(status) {
    const indicator = document.getElementById('physchat-status');
    indicator.className = 'physchat-status-indicator';
    if (status === 'active') indicator.classList.add('active');
    else if (status === 'complete') indicator.classList.add('complete');
    else if (status === 'error') indicator.classList.add('error');
  }

  // Log to thinking panel
  function logThinking(html) {
    const content = document.getElementById('physchat-thinking-content');
    const line = document.createElement('div');
    line.className = 'log-line';
    line.innerHTML = html;
    content.appendChild(line);
    content.scrollTop = content.scrollHeight;
  }

  // Clear thinking panel
  function clearThinking() {
    document.getElementById('physchat-thinking-content').innerHTML = '';
    setStatus('idle');
  }

  // Show/hide thinking panel
  function showThinkingPanel(show) {
    document.getElementById('physchat-thinking-panel').classList.toggle('visible', show);
  }

  // Show/hide synthesis panel
  function showSynthesisPanel(show) {
    document.getElementById('physchat-synthesis-panel').classList.toggle('visible', show);
  }

  // Handle search form submission
  async function handleSearch(event) {
    event.preventDefault();

    const input = document.getElementById('physchat-search-input');
    const rawQuery = input.value.trim();
    const useAI = document.getElementById('physchat-use-ai').checked;
    const sort = document.getElementById('physchat-sort-select').value;

    if (!rawQuery) return;

    // Sanitize input for prompt injection protection
    const query = sanitizeInput(rawQuery);
    if (!query) {
      showError('Invalid query. Please enter a valid physics question.');
      return;
    }

    if (!isAuthenticated) {
      showError('Please sign in to search articles.');
      return;
    }

    // Store query
    currentQuery = query;

    // Reset UI
    clearThinking();
    showThinkingPanel(useAI);
    showSynthesisPanel(false);
    setStatus('active');
    showLoading(true);
    hideError();
    hideEmpty();
    clearResults();
    clearSearchState();

    try {
      if (useAI) {
        await executeAISearch(query, sort);
      } else {
        await executeSimpleSearch(query, sort);
      }
    } catch (error) {
      console.error('PhysChat search error:', error);
      setStatus('error');
      showError(error.message || 'An error occurred while searching. Please try again.');
    } finally {
      showLoading(false);
    }
  }

  // Execute AI-powered search
  async function executeAISearch(query, sort) {
    logThinking(`<span class="label">Query:</span> <span class="value">"${escapeHtml(query)}"</span>`);
    logThinking(`<span class="label">Processing:</span> <span class="highlight">Analyzing with Claude AI...</span>`);

    const results = await performAISearch(query, sort);

    if (results.error) {
      throw new Error(results.error);
    }

    // Log AI interpretation - handle both agentic and legacy modes
    if (results.aiAnalysis) {
      const isAgentic = results.aiAnalysis.mode === 'agentic';

      if (isAgentic) {
        // Agentic mode - show agent's reasoning steps
        logThinking(`<span class="label">Mode:</span> <span class="highlight">🤖 Agentic Search</span>`);

        // Show each agent step
        const agentSteps = results.aiAnalysis.agentSteps || [];
        for (const step of agentSteps) {
          if (step.type === 'search') {
            const typeLabel = step.searchType === 'recent' ? ' <span style="color:#fbbf24">[recent]</span>' : '';
            if (step.status === 'error') {
              const errorMsg = step.error ? `: ${step.error.substring(0, 50)}` : '';
              logThinking(`<span class="info">→</span> Search: "${escapeHtml(step.query)}"${typeLabel} <span style="color:#ef4444">- Error${escapeHtml(errorMsg)}</span>`);
            } else {
              logThinking(`<span class="info">→</span> Search: "${escapeHtml(step.query)}"${typeLabel} <span class="success">- ${step.totalFound?.toLocaleString() || '?'} found (+${step.newPapers || 0} new)</span>`);
            }
          } else if (step.type === 'analysis') {
            logThinking(`<span class="label">Analysis:</span> <span class="value">${escapeHtml(step.coverage || '')}</span>`);
            if (step.gaps && step.gaps.length > 0) {
              logThinking(`<span style="color:#f59e0b">Gaps:</span> ${step.gaps.map(g => escapeHtml(g)).join(', ')}`);
            }
          } else if (step.type === 'thinking') {
            logThinking(`<span class="label">Thinking:</span> <span class="value">${escapeHtml(step.content?.substring(0, 150) || '')}...</span>`);
          } else if (step.type === 'finish') {
            logThinking(`<span class="success">✓ Agent finished:</span> <span class="value">${escapeHtml(step.reasoning || '')}</span>`);
          } else if (step.type === 'max_iterations') {
            logThinking(`<span style="color:#f59e0b">⚠ ${escapeHtml(step.message || 'Max iterations reached')}</span>`);
          }
        }

        // Show summary
        if (results.aiAnalysis.finishReason) {
          logThinking(`<span class="label">Summary:</span> <span class="value">${escapeHtml(results.aiAnalysis.finishReason)}</span>`);
        }

      } else {
        // Legacy mode - original display
        const intentLabels = {
          'explainer': 'Understanding a concept',
          'survey': 'Surveying recent research',
          'specific': 'Finding specific results',
          'author': 'Author search',
          'comparative': 'Comparing concepts'
        };
        const intentLabel = intentLabels[results.aiAnalysis.intent] || results.aiAnalysis.intent;
        logThinking(`<span class="label">Intent:</span> <span class="highlight">${escapeHtml(intentLabel)}</span>`);

        logThinking(`<span class="label">Interpretation:</span> <span class="value">${escapeHtml(results.aiAnalysis.interpretation)}</span>`);

        if (results.aiAnalysis.concepts && results.aiAnalysis.concepts.length > 0) {
          logThinking(`<span class="label">Concepts:</span> ${results.aiAnalysis.concepts.map(c => `<span class="concept">${escapeHtml(c)}</span>`).join('')}`);
        }

        // Log searches with full query details including filters
        if (results.aiAnalysis.searchesRun) {
          logThinking(`<span class="label">Running ${results.aiAnalysis.searchesRun.length} searches:</span>`);
          for (let i = 0; i < results.aiAnalysis.searchesRun.length; i++) {
            const search = results.aiAnalysis.searchesRun[i];
            let queryStr = search.query ? `"${escapeHtml(search.query)}"` : escapeHtml(search.purpose);

            // Add filter indicators
            const filters = [];
            if (search.fields && search.fields.length > 0 && search.fields[0] !== 'all') {
              filters.push(search.fields.join('+'));
            }
            if (search.dateRange && search.dateRange.start) {
              filters.push(`≥${search.dateRange.start.substring(0, 4)}`);
            }
            if (filters.length > 0) {
              queryStr += ` <span style="color:#888;font-size:10px">[${filters.join(', ')}]</span>`;
            }

            if (search.error) {
              logThinking(`<span class="info">${i + 1}.</span> ${queryStr} <span style="color:#ef4444">- Error</span>`);
            } else {
              logThinking(`<span class="info">${i + 1}.</span> ${queryStr} <span class="success">- ${search.totalFound?.toLocaleString() || '?'} found</span>`);
            }
          }
        }
      }
    }

    // Log ranking info
    if (results.ranking && results.ranking.stats) {
      const stats = results.ranking.stats;
      if (results.ranking.method === 'agent_curated') {
        // Agentic mode stats
        logThinking(`<span class="label">Papers collected:</span> <span class="value">${stats.totalUnique}</span>`);
        if (stats.agentIterations > 1) {
          logThinking(`<span class="label">Agent iterations:</span> <span class="value">${stats.agentIterations}</span>`);
        }
      } else {
        // Legacy mode stats
        logThinking(`<span class="label">Unique articles:</span> <span class="value">${stats.totalUnique}</span>`);
        if (stats.inMultipleSearches > 0) {
          logThinking(`<span class="label">Multi-match:</span> <span class="highlight">${stats.inMultipleSearches} articles</span> (boosted)`);
        }
      }
    }

    setStatus('complete');

    // Store and display results
    currentResults = results.results || [];
    currentTotalFound = results.ranking?.stats?.totalUnique || currentResults.length;
    currentAIAnalysis = results.aiAnalysis || null;

    // Render synthesis panel with AI answer
    renderSynthesis(currentResults, currentTotalFound, currentAIAnalysis);

    // Render results
    displayResults(currentResults, currentTotalFound);

    // Fetch AI summaries for top results (pass query for context)
    if (currentResults.length > 0) {
      fetchAISummaries(currentResults.slice(0, 5), query);
    }
  }

  // Execute simple search (non-AI)
  async function executeSimpleSearch(query, sort) {
    const results = await performSearch(query, CONFIG.maxResults, sort);

    if (results.error) {
      throw new Error(results.error);
    }

    currentResults = results.results || [];
    currentTotalFound = results.total || currentResults.length;
    currentAIAnalysis = null;

    displayResults(currentResults, currentTotalFound);
  }

  // Perform AI search API call
  async function performAISearch(query, sort) {
    const response = await fetch(`${CONFIG.workerUrl}/ai-search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        query: query,
        limit: CONFIG.maxResults,
        sort: sort
      })
    });

    if (!response.ok) {
      if (response.status === 401) {
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

  // Perform simple search API call
  async function performSearch(query, limit, sort) {
    const response = await fetch(`${CONFIG.workerUrl}/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({ query, limit, sort })
    });

    if (!response.ok) {
      if (response.status === 401) {
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

  // Extract concepts from results
  function extractConcepts(results) {
    const conceptCounts = {};
    results.forEach(r => {
      const text = ((r.title || '') + ' ' + (r.abstract || '')).toLowerCase();
      PHYSICS_TERMS.forEach(term => {
        if (text.includes(term)) {
          conceptCounts[term] = (conceptCounts[term] || 0) + 1;
        }
      });
    });
    return Object.entries(conceptCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([term]) => term);
  }

  // Render synthesis panel with AI answer
  function renderSynthesis(results, totalFound, aiAnalysis) {
    const panel = document.getElementById('physchat-synthesis-panel');

    if (results.length === 0) {
      showSynthesisPanel(false);
      return;
    }

    // Check if we have an AI-generated synthesis answer
    const synthesis = aiAnalysis?.synthesis;

    if (synthesis) {
      // Convert [1], [2] references to clickable links
      let synthesisHtml = escapeHtml(synthesis);

      // Replace [n] with clickable links to papers (open in new tab)
      synthesisHtml = synthesisHtml.replace(/\[(\d+)\]/g, (match, num) => {
        const idx = parseInt(num, 10) - 1;
        if (idx >= 0 && idx < results.length) {
          const paper = results[idx];
          const url = paper.url || `https://doi.org/${paper.doi}`;
          return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener" class="physchat-ref-link" title="${escapeHtml(stripHtml(paper.title || ''))}">[${num}]</a>`;
        }
        return match;
      });

      // Show the AI answer
      panel.innerHTML = `
        <div class="physchat-synthesis-answer">
          <div class="physchat-synthesis-text">${synthesisHtml}</div>
          <div class="physchat-synthesis-meta">
            <span class="physchat-synthesis-stat"><strong>${totalFound}</strong> articles found</span>
            <span class="physchat-synthesis-badge">Based on abstracts</span>
          </div>
        </div>
      `;

    } else {
      // Fallback to simple stats
      const concepts = extractConcepts(results);
      const themes = concepts.slice(0, 3);
      const themeStr = themes.length > 0 ? themes.join(', ') : '';

      panel.innerHTML = `
        <span class="physchat-synthesis-stat"><strong>${totalFound}</strong> results</span>
        ${themeStr ? `<span class="physchat-synthesis-divider">|</span><span class="physchat-synthesis-stat">${escapeHtml(themeStr)}</span>` : ''}
      `;
    }

    showSynthesisPanel(true);
  }

  // Display search results
  function displayResults(results, total) {
    const resultsContainer = document.getElementById('physchat-results-list');

    if (results.length === 0) {
      showEmpty();
      return;
    }

    // Extract concepts for tagging
    const allConcepts = extractConcepts(results);

    // Results header
    let html = `
      <div class="physchat-results-header">
        <h2>Articles</h2>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="physchat-results-count">${total.toLocaleString()} found</span>
          <button id="physchat-clear-results" style="background:none;border:1px solid #ccc;border-radius:3px;padding:2px 6px;font-size:10px;color:#666;cursor:pointer;">Clear</button>
        </div>
      </div>
    `;

    // Result cards
    results.forEach((article, idx) => {
      html += createResultCard(article, idx + 1, allConcepts);
    });

    resultsContainer.innerHTML = html;

    // Add click handlers for article links
    resultsContainer.querySelectorAll('.physchat-article-link').forEach(link => {
      link.addEventListener('click', handleArticleClick);
    });

    // Add clear button handler
    const clearBtn = document.getElementById('physchat-clear-results');
    if (clearBtn) {
      clearBtn.addEventListener('click', handleClearResults);
    }
  }

  // Handle clear results button
  function handleClearResults() {
    currentResults = [];
    currentTotalFound = 0;
    currentQuery = '';
    currentAIAnalysis = null;
    clearSearchState();
    clearResults();
    showSynthesisPanel(false);
    showThinkingPanel(false);
    showEmpty();
    document.getElementById('physchat-search-input').value = '';
    document.getElementById('physchat-search-input').focus();
  }

  // Create HTML for a result card
  function createResultCard(article, rank, allConcepts) {
    const authors = formatAuthors(article.authors || []);
    const cleanTitle = stripHtml(article.title || 'Untitled');
    const summary = generateSummary(article.abstract || '', cleanTitle);
    const articleUrl = article.url || `https://doi.org/${article.doi}`;
    const hasAbstract = article.abstract && article.abstract.trim().length > 0;

    // Find concepts in this article
    const articleText = ((cleanTitle) + ' ' + (article.abstract || '')).toLowerCase();
    const articleConcepts = allConcepts.filter(c => articleText.includes(c)).slice(0, 4);

    // Overlap indicator
    const isHighRelevance = article.overlapCount && article.overlapCount > 1;
    const relevanceClass = isHighRelevance ? 'relevant-high' : '';
    const matchBadge = isHighRelevance
      ? `<span class="physchat-match-badge" title="Found in: ${(article.sources || []).join(', ')}">${article.overlapCount}× match</span>`
      : '';

    return `
      <div class="physchat-result-card ${relevanceClass}" data-rank="${rank}">
        <span class="physchat-article-rank">#${rank}</span>
        ${matchBadge}
        <h3 class="physchat-result-title">
          <a href="${escapeHtml(articleUrl)}" class="physchat-article-link" data-url="${escapeHtml(articleUrl)}">${escapeHtml(cleanTitle)}</a>
        </h3>
        <p class="physchat-result-authors">${escapeHtml(authors)}</p>
        <div class="physchat-result-meta">
          ${article.journal ? `<span class="physchat-result-badge journal">${escapeHtml(article.journal)}</span>` : ''}
          ${article.date ? `<span class="physchat-result-badge">${escapeHtml(formatDate(article.date))}</span>` : ''}
        </div>
        <div class="physchat-result-summary ${!hasAbstract ? 'needs-summary' : ''}" data-doi="${escapeHtml(article.doi || '')}" data-title="${encodeURIComponent(article.title || '')}" data-abstract="${encodeURIComponent(article.abstract || '')}">
          <span class="summary-text">${summary ? escapeHtml(summary) : '<em style="color:#999;">Loading summary...</em>'}</span>
        </div>
        ${articleConcepts.length > 0 ? `
        <div class="physchat-concepts">
          ${articleConcepts.map(c => `<span class="physchat-concept-tag">${escapeHtml(c)}</span>`).join('')}
        </div>
        ` : ''}
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

  // Format date
  function formatDate(dateStr) {
    if (!dateStr) return '';
    const date = new Date(dateStr);
    if (isNaN(date)) return dateStr;
    return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short' });
  }

  // Generate summary from abstract (first 1-2 sentences)
  function generateSummary(abstract, title) {
    if (!abstract || abstract.trim().length === 0) {
      // Return empty string - we'll try to get AI summary instead
      return '';
    }

    // Remove HTML tags
    const plainText = abstract.replace(/<[^>]*>/g, '');

    // Get first 1-2 sentences
    const sentences = plainText.match(/[^.!?]+[.!?]+/g) || [plainText];
    let summary = sentences[0] || plainText;

    if (summary.length < 80 && sentences.length > 1) {
      summary += ' ' + sentences[1];
    }

    return summary.trim();
  }

  // Fetch AI summaries for top articles (with search context for relevance)
  async function fetchAISummaries(articles, searchQuery = '') {
    for (const article of articles) {
      // Skip if no title (can't generate anything useful)
      if (!article.title) continue;

      try {
        const response = await fetch(`${CONFIG.workerUrl}/summarize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: article.title,
            abstract: article.abstract || '',
            searchQuery: searchQuery  // Pass search context for relevance-aware summaries
          })
        });

        if (response.ok) {
          const data = await response.json();
          if (data.summary) {
            // Find the summary element and update it
            const summaryEl = document.querySelector(`.physchat-result-summary[data-doi="${article.doi}"]`);
            if (summaryEl) {
              const summaryText = summaryEl.querySelector('.summary-text');
              if (summaryText) {
                summaryText.innerHTML = escapeHtml(data.summary);
                summaryEl.classList.remove('needs-summary');

                // Add AI badge if AI-generated
                if (data.aiGenerated && !summaryEl.querySelector('.physchat-ai-summary-badge')) {
                  summaryEl.classList.add('ai-generated');
                  const badge = document.createElement('span');
                  badge.className = 'physchat-ai-summary-badge';
                  badge.textContent = data.fromTitle ? 'AI*' : 'AI';
                  badge.title = data.fromTitle ? 'Generated from title (no abstract available)' : 'AI-generated summary';
                  summaryEl.appendChild(badge);
                }
              }
            }
          }
        }
      } catch (err) {
        console.error('Failed to fetch AI summary:', err);
        // Update UI to show fallback
        const summaryEl = document.querySelector(`.physchat-result-summary[data-doi="${article.doi}"]`);
        if (summaryEl && summaryEl.classList.contains('needs-summary')) {
          const summaryText = summaryEl.querySelector('.summary-text');
          if (summaryText) {
            summaryText.innerHTML = `<em style="color:#999;">View article for details</em>`;
          }
        }
      }
    }
  }

  // Handle article link click - navigate in same tab, preserving search state
  function handleArticleClick(event) {
    event.preventDefault();
    const url = event.currentTarget.dataset.url;
    if (url) {
      // Save search state before navigating
      saveSearchState();
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

  // Strip HTML/MathML tags from text (for titles that contain markup)
  function stripHtml(text) {
    if (!text) return '';
    // Remove MathML and other XML/HTML tags
    return text
      .replace(/<math[^>]*>[\s\S]*?<\/math>/gi, '')  // Remove MathML blocks
      .replace(/<[^>]+>/g, '')  // Remove any remaining HTML tags
      .replace(/\s+/g, ' ')  // Normalize whitespace
      .trim();
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
