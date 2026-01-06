/**
 * PhysChat Cloudflare Worker
 * Handles OAuth authentication with AWS Cognito and proxies search requests to Tesseract API
 * Now with Claude AI integration for intelligent query parsing
 */

// Claude API configuration
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-3-haiku-20240307'; // Fast and cheap for query parsing

// Agent tools definition for agentic search
const AGENT_TOOLS = [
  {
    name: "search_papers",
    description: "Search the APS physics journal database for papers matching a query. Use this to find papers on specific topics, concepts, or by author.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query - can be keywords, phrases, or author names"
        },
        search_type: {
          type: "string",
          enum: ["general", "title_focused", "recent"],
          description: "general: searches all fields; title_focused: prioritizes title matches; recent: filters to papers from last 3 years"
        },
        limit: {
          type: "integer",
          description: "Number of results to return (default 10, max 20)"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "analyze_gaps",
    description: "After searching, analyze what's missing from your results. Call this to identify if you need additional searches to better answer the user's question.",
    input_schema: {
      type: "object",
      properties: {
        current_coverage: {
          type: "string",
          description: "Brief description of what the current results cover"
        },
        missing_aspects: {
          type: "array",
          items: { type: "string" },
          description: "List of aspects of the question not yet covered by results"
        },
        suggested_queries: {
          type: "array",
          items: { type: "string" },
          description: "Additional search queries that might fill the gaps"
        }
      },
      required: ["current_coverage", "missing_aspects"]
    }
  },
  {
    name: "finish",
    description: "Call this when you have gathered enough papers to answer the user's question. This signals you're done searching.",
    input_schema: {
      type: "object",
      properties: {
        reasoning: {
          type: "string",
          description: "Explain why the current papers are sufficient to address the user's question"
        },
        coverage_summary: {
          type: "string",
          description: "Brief summary of what topics/aspects are covered by the papers found"
        }
      },
      required: ["reasoning"]
    }
  }
];

// Input sanitization for prompt injection protection (POC level)
const MAX_QUERY_LENGTH = 500;

function sanitizeQuery(input) {
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
    /\[\[.*?\]\]/g,  // Wiki-style injection
  ];

  for (const pattern of injectionPatterns) {
    sanitized = sanitized.replace(pattern, '');
  }

  // Remove URLs
  sanitized = sanitized.replace(/https?:\/\/[^\s]+/gi, '');

  // Limit length
  if (sanitized.length > MAX_QUERY_LENGTH) {
    sanitized = sanitized.substring(0, MAX_QUERY_LENGTH);
  }

  // Normalize whitespace
  sanitized = sanitized.replace(/\s+/g, ' ').trim();

  return sanitized;
}

// Check if query looks suspicious (for logging)
function isSuspiciousQuery(original, sanitized) {
  if (!original || !sanitized) return true;
  const lengthDiff = original.length - sanitized.length;
  // If we removed more than 20% of the content, it's suspicious
  return lengthDiff > original.length * 0.2;
}

// CORS headers for cross-origin requests
// Allow multiple origins for development (restrict in production)
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

// Helper to add CORS headers to response
function addCorsHeaders(response) {
  const newHeaders = new Headers(response.headers);
  Object.entries(corsHeaders).forEach(([key, value]) => {
    newHeaders.set(key, value);
  });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// Handle CORS preflight
function handleOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders,
  });
}

// Generate a random state parameter for OAuth
function generateState() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

// Main request handler
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return handleOptions();
    }

    try {
      // Route requests
      if (path === '/auth') {
        return handleAuthInit(request, env);
      } else if (path === '/auth/callback') {
        return handleAuthCallback(request, env);
      } else if (path === '/search') {
        return addCorsHeaders(await handleSearch(request, env));
      } else if (path === '/ai-search') {
        return addCorsHeaders(await handleAISearch(request, env));
      } else if (path === '/summarize') {
        return addCorsHeaders(await handleSummarize(request, env));
      } else if (path === '/health') {
        return addCorsHeaders(new Response(JSON.stringify({ status: 'ok' }), {
          headers: { 'Content-Type': 'application/json' },
        }));
      } else {
        return addCorsHeaders(new Response(JSON.stringify({ error: 'Not found' }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
    } catch (error) {
      console.error('Worker error:', error);
      return addCorsHeaders(new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }));
    }
  },
};

/**
 * Initialize OAuth flow - redirect to Cognito
 */
function handleAuthInit(request, env) {
  const url = new URL(request.url);
  const workerUrl = `${url.protocol}//${url.host}`;
  const redirectUri = `${workerUrl}/auth/callback`;
  const state = generateState();

  const authUrl = new URL(env.COGNITO_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', env.COGNITO_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', env.COGNITO_SCOPE);
  authUrl.searchParams.set('state', state);

  return new Response(null, {
    status: 302,
    headers: {
      'Location': authUrl.toString(),
      'Set-Cookie': `physchat_state=${state}; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    },
  });
}

/**
 * Handle OAuth callback from Cognito
 */
async function handleAuthCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const errorDescription = url.searchParams.get('error_description');

  if (error) {
    return createCallbackErrorPage(`Authentication failed: ${errorDescription || error}`);
  }

  if (!code) {
    return createCallbackErrorPage('No authorization code received');
  }

  // Exchange code for tokens
  const workerUrl = `${url.protocol}//${url.host}`;
  const redirectUri = `${workerUrl}/auth/callback`;

  try {
    const tokenResponse = await fetch(env.COGNITO_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: env.COGNITO_CLIENT_ID,
        code: code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Token exchange failed:', errorText);
      return createCallbackErrorPage('Failed to exchange authorization code');
    }

    const tokens = await tokenResponse.json();
    const accessToken = tokens.access_token;

    if (!accessToken) {
      return createCallbackErrorPage('No access token received');
    }

    // Return success page that sends token to extension
    return createCallbackSuccessPage(accessToken);

  } catch (error) {
    console.error('Token exchange error:', error);
    return createCallbackErrorPage('An error occurred during authentication');
  }
}

/**
 * Create success callback page
 */
function createCallbackSuccessPage(token) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>PhysChat - Authentication Successful</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f7fa;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      text-align: center;
      max-width: 400px;
    }
    .icon {
      width: 64px;
      height: 64px;
      background: #d1fae5;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    }
    .icon svg {
      width: 32px;
      height: 32px;
      fill: #059669;
    }
    h1 {
      color: #00274c;
      margin: 0 0 12px;
      font-size: 24px;
    }
    p {
      color: #6c757d;
      margin: 0;
      font-size: 16px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
    </div>
    <h1>Authentication Successful!</h1>
    <p>You can close this window and return to journals.aps.org.</p>
  </div>
  <script>
    // Send token to opener window (the extension content script)
    if (window.opener) {
      window.opener.postMessage({
        type: 'PHYSCHAT_AUTH_SUCCESS',
        token: '${token}'
      }, 'https://journals.aps.org');
    }
    // Also try to communicate with extension via chrome API
    // This will be picked up by the background script
    setTimeout(() => {
      window.close();
    }, 2000);
  </script>
</body>
</html>
  `;

  return new Response(html, {
    headers: { 'Content-Type': 'text/html' },
  });
}

/**
 * Create error callback page
 */
function createCallbackErrorPage(message) {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>PhysChat - Authentication Failed</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      margin: 0;
      background: #f5f7fa;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.1);
      text-align: center;
      max-width: 400px;
    }
    .icon {
      width: 64px;
      height: 64px;
      background: #fee2e2;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 20px;
    }
    .icon svg {
      width: 32px;
      height: 32px;
      fill: #dc2626;
    }
    h1 {
      color: #00274c;
      margin: 0 0 12px;
      font-size: 24px;
    }
    p {
      color: #6c757d;
      margin: 0;
      font-size: 16px;
    }
    .error {
      background: #fee2e2;
      color: #991b1b;
      padding: 12px;
      border-radius: 8px;
      margin-top: 16px;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>
    </div>
    <h1>Authentication Failed</h1>
    <p>Please close this window and try again.</p>
    <div class="error">${escapeHtml(message)}</div>
  </div>
</body>
</html>
  `;

  return new Response(html, {
    status: 400,
    headers: { 'Content-Type': 'text/html' },
  });
}

/**
 * Handle search requests
 */
async function handleSearch(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify authorization
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const accessToken = authHeader.substring(7);

  // Parse request body
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { query: rawQuery, limit = 10, sort = 'relevance' } = body;

  if (!rawQuery || typeof rawQuery !== 'string') {
    return new Response(JSON.stringify({ error: 'Query is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Sanitize query for prompt injection protection
  const query = sanitizeQuery(rawQuery);
  if (!query) {
    return new Response(JSON.stringify({ error: 'Invalid query' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Log suspicious queries for monitoring
  if (isSuspiciousQuery(rawQuery, query)) {
    console.warn('Suspicious query detected:', { original: rawQuery.substring(0, 100), sanitized: query.substring(0, 100) });
  }

  // Call Tesseract API
  try {
    const searchResults = await callTesseractSearch(env, accessToken, query, limit, sort);
    return new Response(JSON.stringify(searchResults), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Search error:', error);

    if (error.message === 'Unauthorized') {
      return new Response(JSON.stringify({ error: 'Session expired. Please sign in again.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ error: 'Search failed. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Call Tesseract MCP search API - supports advanced search with clauses
 * @param {Object} searchParams - Can be a string (simple query) or object with advanced options
 */
async function callTesseractSearch(env, accessToken, searchParams, limit, sort = 'relevance') {
  // Normalize searchParams - can be string or object
  const params = typeof searchParams === 'string'
    ? { query: searchParams }
    : searchParams;

  // Build the search arguments - use mcpSearch for reliability
  // mcpSearch is simpler and more reliable than searchPost
  const searchArgs = {
    q: params.query,
    per_page: Math.min(limit, 100),
    sort: sort
  };

  // Add date range if specified (mcpSearch supports these)
  if (params.dateRange) {
    if (params.dateRange.start) {
      searchArgs.start_date = params.dateRange.start;
    }
    if (params.dateRange.end) {
      searchArgs.end_date = params.dateRange.end;
    }
  }

  const mcpRequest = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: 'search-api___mcpSearch',
      arguments: searchArgs
    }
  };

  console.log('Tesseract search request:', JSON.stringify(searchArgs));

  const response = await fetch(env.TESSERACT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(mcpRequest),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    console.error('Tesseract API error:', response.status, errorBody);
    if (response.status === 401 || response.status === 403) {
      throw new Error('Unauthorized');
    }
    throw new Error(`API error: ${response.status} - ${errorBody.substring(0, 200)}`);
  }

  const mcpResponse = await response.json();

  // Parse MCP response
  if (mcpResponse.error) {
    throw new Error(mcpResponse.error.message || 'API error');
  }

  // Extract results from MCP response
  const result = mcpResponse.result;

  // The result might be nested in content
  let searchData;
  if (result && result.content && Array.isArray(result.content)) {
    // Find the text content with the JSON response
    const textContent = result.content.find(c => c.type === 'text');
    if (textContent && textContent.text) {
      searchData = JSON.parse(textContent.text);
    }
  } else if (result && typeof result === 'object') {
    searchData = result;
  }

  if (!searchData) {
    return { total: 0, results: [] };
  }

  // Format results for the extension
  return {
    total: searchData.total || 0,
    results: (searchData.results || []).map(article => ({
      title: article.title,
      authors: article.authors || [],
      abstract: article.abstract,
      journal: article.journal,
      date: article.date,
      volume: article.volume,
      issue: article.issue,
      pages: article.pages,
      doi: article.doi,
      url: article.url || `https://doi.org/${article.doi}`,
      citations: article.citations
    }))
  };
}

/**
 * Handle AI-powered search requests
 * Uses Claude to parse the query and generate an intelligent search strategy
 */
async function handleAISearch(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verify authorization
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const accessToken = authHeader.substring(7);

  // Parse request body
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { query: rawQuery, limit = 15, sort = 'relevance' } = body;

  if (!rawQuery || typeof rawQuery !== 'string') {
    return new Response(JSON.stringify({ error: 'Query is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Sanitize query for prompt injection protection
  const query = sanitizeQuery(rawQuery);
  if (!query) {
    return new Response(JSON.stringify({ error: 'Invalid query' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Log suspicious queries for monitoring
  if (isSuspiciousQuery(rawQuery, query)) {
    console.warn('Suspicious AI query detected:', { original: rawQuery.substring(0, 100), sanitized: query.substring(0, 100) });
  }

  try {
    // Use agentic search - Claude decides what to search and when to stop
    const agentResult = await executeAgenticSearch(env, accessToken, query, 4);

    // If agent failed, fall back to simple search
    if (!agentResult.success) {
      console.log('Agent failed, falling back to simple search:', agentResult.fallbackReason);
      const fallbackResults = await callTesseractSearch(env, accessToken, query, limit, sort);
      return new Response(JSON.stringify({
        query: query,
        aiAnalysis: null,
        fallback: true,
        fallbackReason: agentResult.fallbackReason,
        ...fallbackResults
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Agent succeeded - process results
    const papers = agentResult.papers;

    // Score papers - papers found in multiple searches (if agent searched multiple times) rank higher
    // For now, simple ordering based on when they were found (earlier = more relevant)
    const scoredResults = papers.slice(0, 20);

    // Determine intent from agent steps for synthesis
    const hasRecentSearch = agentResult.agentSteps.some(s => s.type === 'search' && s.searchType === 'recent');
    const intent = hasRecentSearch ? 'survey' : 'specific';

    // Generate answer synthesis from top results
    let synthesis = null;
    if (scoredResults.length > 0 && env.ANTHROPIC_API_KEY) {
      synthesis = await generateAnswerSynthesis(env, query, intent, scoredResults.slice(0, 5));
    }

    // Extract search details from agent steps for the thinking panel
    const searchSteps = agentResult.agentSteps.filter(s => s.type === 'search');
    const analysisSteps = agentResult.agentSteps.filter(s => s.type === 'analysis');
    const finishStep = agentResult.agentSteps.find(s => s.type === 'finish');

    // Return results with agent reasoning
    return new Response(JSON.stringify({
      query: query,
      aiAnalysis: {
        mode: 'agentic',
        interpretation: finishStep?.coverage || `Agent searched for: ${query}`,
        intent: intent,
        concepts: [], // Agent doesn't explicitly list concepts
        agentSteps: agentResult.agentSteps,
        searchesRun: searchSteps.map(s => ({
          query: s.query,
          searchType: s.searchType,
          totalFound: s.totalFound,
          newPapers: s.newPapers,
          status: s.status,
          error: s.error
        })),
        synthesis: synthesis,
        finishReason: agentResult.finishReason
      },
      ranking: {
        method: 'agent_curated',
        totalSearches: agentResult.totalSearches,
        stats: {
          totalUnique: papers.length,
          agentIterations: Math.max(...agentResult.agentSteps.map(s => s.iteration || 0), 0)
        }
      },
      total: scoredResults.length,
      results: scoredResults
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('AI Search error:', error);

    if (error.message === 'Unauthorized') {
      return new Response(JSON.stringify({ error: 'Session expired. Please sign in again.' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Fall back to simple search if AI fails
    console.log('Falling back to simple search');
    try {
      const fallbackResults = await callTesseractSearch(env, accessToken, query, limit, sort);
      return new Response(JSON.stringify({
        query: query,
        aiAnalysis: null,
        fallback: true,
        ...fallbackResults
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (fallbackError) {
      return new Response(JSON.stringify({ error: 'Search failed. Please try again.' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}

/**
 * Use Claude to parse a natural language query into a search strategy
 */
async function parseQueryWithClaude(env, query) {
  // Check if API key is configured
  if (!env.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY not configured, using fallback parsing');
    return fallbackQueryParsing(query);
  }

  const systemPrompt = `You are a physics research search assistant for APS journals. Analyze the user's query to understand their INTENT and generate an optimal search strategy.

## Intent Types
Identify ONE primary intent:
- **explainer**: User wants to understand a concept ("What is...", "How does...work", "Explain...")
  → Prioritize review articles, foundational papers, highly-cited works
- **survey**: User wants current state of field ("Recent advances in...", "Latest research on...")
  → Filter to recent years (2022+), sort by date
- **specific**: User wants papers on a specific phenomenon or result
  → Precise keyword matching, use title field
- **author**: User mentions a researcher name
  → Use author field search
- **comparative**: User comparing concepts ("difference between X and Y", "X vs Y")
  → Search each concept, look for papers discussing both

## Search Strategy
Generate 2-4 searches. Each search can specify:
- **query**: The search terms
- **fields**: Array of ["title", "abstract", "author"] - where to search (default: all)
- **dateRange**: Object {"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"} or null
- **articleTypes**: Array like ["review", "research"] or null (review = review articles, research = original research)
- **weight**: 1.0-2.5 importance

## Rules
- Extract SPECIFIC physics terms, not generic words (effect, cause, relationship, study)
- Preserve compound terms: "quantum entanglement", "dark matter", "Bose-Einstein condensate"
- For explainer intent: include a search for review articles
- For survey intent: always set dateRange.start to at least 2022
- For author queries: put the name in a separate author-field search

Respond with valid JSON only:
{
  "interpretation": "One sentence summary of what user wants to learn",
  "intent": "explainer|survey|specific|author|comparative",
  "concepts": ["concept1", "concept2"],
  "searches": [
    {
      "query": "search terms",
      "fields": ["title", "abstract"],
      "dateRange": null,
      "articleTypes": null,
      "purpose": "brief label",
      "weight": 1.5
    }
  ]
}`;

  const userPrompt = `Generate a search strategy for this query: "${query}"`;

  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 500,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Claude API error:', response.status, errorText);
      return fallbackQueryParsing(query);
    }

    const data = await response.json();
    const content = data.content?.[0]?.text;

    if (!content) {
      console.error('No content in Claude response');
      return fallbackQueryParsing(query);
    }

    // Parse JSON from Claude's response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('No JSON found in Claude response:', content);
      return fallbackQueryParsing(query);
    }

    const parsed = JSON.parse(jsonMatch[0]);

    // Validate the response structure
    if (!parsed.searches || !Array.isArray(parsed.searches) || parsed.searches.length === 0) {
      console.error('Invalid search plan structure:', parsed);
      return fallbackQueryParsing(query);
    }

    return {
      interpretation: parsed.interpretation || 'Searching for: ' + query,
      intent: parsed.intent || 'specific',
      concepts: parsed.concepts || [],
      searches: parsed.searches.slice(0, 4).map(s => ({
        query: s.query || query,
        fields: s.fields || null,
        dateRange: s.dateRange || null,
        articleTypes: s.articleTypes || null,
        purpose: s.purpose || 'search',
        weight: Math.min(Math.max(s.weight || 1.0, 0.5), 2.5)
      }))
    };

  } catch (error) {
    console.error('Error calling Claude:', error);
    return fallbackQueryParsing(query);
  }
}

/**
 * Generate a synthesized answer from search results
 * CRITICAL: Only uses information from the provided abstracts, never from training data
 */
async function generateAnswerSynthesis(env, query, intent, topResults) {
  if (!env.ANTHROPIC_API_KEY || topResults.length === 0) {
    return null;
  }

  // Build context from top results - strip any HTML/MathML from titles
  const paperSummaries = topResults.map((paper, idx) => {
    const cleanTitle = (paper.title || 'Untitled')
      .replace(/<math[^>]*>[\s\S]*?<\/math>/gi, '')
      .replace(/<[^>]+>/g, '')
      .trim();
    const abstract = paper.abstract
      ? paper.abstract.substring(0, 600) + (paper.abstract.length > 600 ? '...' : '')
      : 'No abstract available';
    return `[${idx + 1}] "${cleanTitle}" (${paper.journal || 'Unknown'}, ${paper.date ? new Date(paper.date).getFullYear() : 'n.d.'})\nAbstract: ${abstract}`;
  }).join('\n\n');

  const intentGuidance = {
    'explainer': 'Explain the concept using ONLY what is stated in these abstracts.',
    'survey': 'Summarize the research findings from ONLY these papers.',
    'specific': 'Describe ONLY what these specific papers found.',
    'author': 'Summarize ONLY the research shown in these papers.',
    'comparative': 'Compare concepts using ONLY information from these abstracts.'
  };

  const systemPrompt = `You are a research assistant that synthesizes information EXCLUSIVELY from provided paper abstracts.

CRITICAL RULES:
1. ONLY use information explicitly stated in the abstracts below
2. NEVER add information from your training data or general knowledge
3. If the abstracts don't contain enough information to answer, say "Based on these papers, [what they do cover]"
4. Every claim must be supported by a citation [1], [2], etc.
5. Keep your answer to 2-3 sentences maximum
6. ${intentGuidance[intent] || intentGuidance['specific']}

If you cannot answer the question from the abstracts alone, summarize what the papers DO cover instead of making things up.`;

  const userPrompt = `Question: "${query}"

PAPER ABSTRACTS (use ONLY this information):
${paperSummaries}

Write a 2-3 sentence synthesis using ONLY the information above. Cite with [1], [2], etc.:`;

  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 300,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }]
      })
    });

    if (!response.ok) {
      console.error('Synthesis API error:', response.status);
      return null;
    }

    const data = await response.json();
    const synthesis = data.content?.[0]?.text?.trim();

    return synthesis || null;

  } catch (error) {
    console.error('Error generating synthesis:', error);
    return null;
  }
}

/**
 * Execute agentic search - Claude decides what to search and when it has enough results
 * Returns collected papers and agent reasoning steps
 */
async function executeAgenticSearch(env, accessToken, userQuery, maxIterations = 4) {
  // Check if API key is configured
  if (!env.ANTHROPIC_API_KEY) {
    console.log('ANTHROPIC_API_KEY not configured, falling back to simple search');
    return {
      success: false,
      fallbackReason: 'API key not configured',
      papers: [],
      agentSteps: []
    };
  }

  const systemPrompt = `You are a physics research search agent helping find relevant papers from APS journals.

Your goal: Find papers that best answer the user's question.

WORKFLOW:
1. Analyze the user's question to understand what they're looking for
2. Use search_papers to find relevant papers (you can search multiple times with different queries)
3. After each search, evaluate if you have enough coverage
4. Use analyze_gaps if you think more searches would help
5. Call finish when you have sufficient papers to answer the question

SEARCH STRATEGIES:
- For conceptual questions ("What is X?"): Search for the concept + "review" or foundational terms
- For recent research ("Latest on X"): Use search_type="recent"
- For specific phenomena: Use precise technical terms
- For comparisons ("X vs Y"): Search each concept separately

TIPS:
- Physics terms are specific: "topological insulator" not just "insulator"
- Try synonyms if first search is poor: "BEC" vs "Bose-Einstein condensate"
- 2-3 good searches usually suffice; don't over-search

Call finish when you have 5-15 relevant papers covering the main aspects of the question.`;

  // Initialize conversation
  let messages = [
    { role: 'user', content: `Find papers to answer this question: "${userQuery}"` }
  ];

  const allPapers = new Map(); // DOI -> paper (deduped)
  const agentSteps = []; // Track agent's reasoning for transparency
  let finished = false;
  let finishReason = null;

  for (let iteration = 0; iteration < maxIterations && !finished; iteration++) {
    try {
      // Call Claude with tools
      const response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 1024,
          system: systemPrompt,
          tools: AGENT_TOOLS,
          messages: messages
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error('Agent API error:', response.status, errorText);
        break;
      }

      const data = await response.json();

      // Check stop reason
      if (data.stop_reason === 'end_turn') {
        // Agent finished without calling a tool - extract any text response
        const textContent = data.content?.find(c => c.type === 'text');
        if (textContent) {
          agentSteps.push({
            type: 'thinking',
            iteration: iteration + 1,
            content: textContent.text
          });
        }
        finished = true;
        finishReason = 'Agent completed reasoning';
        break;
      }

      // Process tool calls
      if (data.stop_reason === 'tool_use') {
        // Add assistant's response to conversation
        messages.push({ role: 'assistant', content: data.content });

        // Find tool use blocks
        const toolUses = data.content.filter(c => c.type === 'tool_use');
        const toolResults = [];

        for (const toolUse of toolUses) {
          const toolName = toolUse.name;
          const toolInput = toolUse.input;

          if (toolName === 'search_papers') {
            // Execute search
            const query = toolInput.query;
            const searchType = toolInput.search_type || 'general';
            const limit = Math.min(toolInput.limit || 10, 20);

            agentSteps.push({
              type: 'search',
              iteration: iteration + 1,
              query: query,
              searchType: searchType
            });

            try {
              // Build search params based on search type
              const searchParams = { query };
              if (searchType === 'recent') {
                const threeYearsAgo = new Date();
                threeYearsAgo.setFullYear(threeYearsAgo.getFullYear() - 3);
                searchParams.dateRange = { start: threeYearsAgo.toISOString().split('T')[0] };
              }

              const results = await callTesseractSearch(env, accessToken, searchParams, limit, 'relevance');

              // Add to collected papers (dedupe by DOI)
              let newCount = 0;
              for (const paper of results.results || []) {
                if (paper.doi && !allPapers.has(paper.doi)) {
                  allPapers.set(paper.doi, paper);
                  newCount++;
                }
              }

              // Update step with results
              const lastStep = agentSteps[agentSteps.length - 1];
              lastStep.totalFound = results.total;
              lastStep.newPapers = newCount;
              lastStep.status = 'success';

              // Build result summary for agent
              const paperSummaries = (results.results || []).slice(0, 5).map((p, i) => {
                const cleanTitle = (p.title || 'Untitled')
                  .replace(/<math[^>]*>[\s\S]*?<\/math>/gi, '')
                  .replace(/<[^>]+>/g, '')
                  .substring(0, 100);
                return `${i + 1}. "${cleanTitle}" (${p.journal || 'Unknown'}, ${p.date ? new Date(p.date).getFullYear() : 'n.d.'})`;
              }).join('\n');

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `Found ${results.total} papers. Top results:\n${paperSummaries}\n\nTotal unique papers collected so far: ${allPapers.size}`
              });

            } catch (searchError) {
              console.error('Agent search error:', searchError.message, searchError.stack);
              const lastStep = agentSteps[agentSteps.length - 1];
              lastStep.status = 'error';
              lastStep.error = searchError.message;
              lastStep.errorDetail = searchError.stack;

              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: `Search failed: ${searchError.message}. Try a different query.`,
                is_error: true
              });
            }

          } else if (toolName === 'analyze_gaps') {
            // Agent is analyzing what's missing
            agentSteps.push({
              type: 'analysis',
              iteration: iteration + 1,
              coverage: toolInput.current_coverage,
              gaps: toolInput.missing_aspects,
              suggestions: toolInput.suggested_queries
            });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: `Gap analysis recorded. You have ${allPapers.size} papers. ${toolInput.missing_aspects?.length > 0 ? 'Consider searching for: ' + toolInput.suggested_queries?.slice(0, 2).join(', ') : 'Coverage looks good - consider calling finish.'}`
            });

          } else if (toolName === 'finish') {
            // Agent is done
            agentSteps.push({
              type: 'finish',
              iteration: iteration + 1,
              reasoning: toolInput.reasoning,
              coverage: toolInput.coverage_summary
            });

            finished = true;
            finishReason = toolInput.reasoning;

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: 'Search complete. Proceeding to synthesis.'
            });
          }
        }

        // Add tool results to conversation
        if (toolResults.length > 0) {
          messages.push({ role: 'user', content: toolResults });
        }
      }

    } catch (error) {
      console.error('Agent iteration error:', error);
      agentSteps.push({
        type: 'error',
        iteration: iteration + 1,
        error: error.message
      });
      break;
    }
  }

  // If we hit max iterations without finishing, note it
  if (!finished) {
    agentSteps.push({
      type: 'max_iterations',
      message: `Reached maximum ${maxIterations} iterations`
    });
    finishReason = `Reached iteration limit with ${allPapers.size} papers`;
  }

  return {
    success: true,
    papers: [...allPapers.values()],
    agentSteps: agentSteps,
    finishReason: finishReason,
    totalSearches: agentSteps.filter(s => s.type === 'search').length
  };
}

/**
 * Fallback query parsing when Claude is unavailable
 */
function fallbackQueryParsing(query) {
  // Comprehensive stop words including generic/vague terms
  const stopWords = new Set([
    // Articles, pronouns, prepositions
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should',
    'what', 'how', 'why', 'when', 'where', 'who', 'which', 'can', 'could',
    'i', 'me', 'my', 'you', 'your', 'we', 'our', 'they', 'their',
    'want', 'understand', 'explain', 'help', 'know', 'learn', 'find', 'tell',
    'about', 'between', 'relationship', 'connection', 'and', 'or', 'but', 'with',
    'to', 'of', 'in', 'for', 'on', 'at', 'by', 'from', 'that', 'this', 'it', 'its',
    // Generic terms that don't add search value
    'effect', 'effects', 'affect', 'affects', 'cause', 'causes', 'caused',
    'impact', 'impacts', 'influence', 'influences', 'role', 'roles',
    'change', 'changes', 'result', 'results', 'lead', 'leads',
    'work', 'works', 'make', 'makes', 'made', 'use', 'uses', 'used',
    'show', 'shows', 'shown', 'find', 'finds', 'found', 'study', 'studies',
    'research', 'paper', 'papers', 'article', 'articles',
    'new', 'novel', 'recent', 'important', 'significant', 'different',
    'many', 'some', 'most', 'all', 'any', 'other', 'such', 'like',
    'also', 'well', 'just', 'even', 'still', 'only', 'very', 'really'
  ]);

  // Known physics compound terms to preserve
  const compoundTerms = [
    'quantum mechanics', 'quantum field', 'quantum gravity', 'quantum biology',
    'general relativity', 'special relativity', 'dark matter', 'dark energy',
    'black hole', 'neutron star', 'gravitational wave', 'condensed matter',
    'particle physics', 'nuclear physics', 'statistical mechanics',
    'high energy', 'low temperature', 'room temperature'
  ];

  let normalized = query.toLowerCase().replace(/[?.,!'"]/g, ' ');
  const foundCompounds = [];

  // Extract compound terms first
  for (const compound of compoundTerms) {
    if (normalized.includes(compound)) {
      foundCompounds.push(compound);
      normalized = normalized.replace(new RegExp(compound, 'g'), ' ');
    }
  }

  // Extract remaining meaningful words
  const words = normalized
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopWords.has(w));

  // Combine compounds and single words
  const concepts = [...foundCompounds, ...words];

  const searches = [];

  // If we found compound terms, prioritize those
  if (foundCompounds.length > 0) {
    for (const compound of foundCompounds) {
      searches.push({
        query: compound,
        purpose: compound,
        weight: 2.0
      });
    }
  }

  // Add combined search if we have multiple concepts
  if (concepts.length >= 2) {
    const combo = concepts.slice(0, 2).join(' ');
    if (!searches.some(s => s.query === combo)) {
      searches.push({
        query: combo,
        purpose: 'intersection',
        weight: 1.8
      });
    }
  }

  // Add individual concept searches for non-compound terms
  for (const word of words.slice(0, 2)) {
    if (!foundCompounds.some(c => c.includes(word))) {
      searches.push({
        query: word,
        purpose: word,
        weight: 1.0
      });
    }
  }

  if (searches.length === 0) {
    searches.push({
      query: query.replace(/[?!]/g, '').trim(),
      purpose: 'direct query',
      weight: 1.0
    });
  }

  return {
    interpretation: `Searching for: ${concepts.join(', ') || query}`,
    intent: 'specific',  // Default intent for fallback
    concepts: concepts,
    searches: searches.slice(0, 4)
  };
}

/**
 * Handle AI-powered paper summarization
 */
async function handleSummarize(request, env) {
  if (request.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Parse request body
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid request body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { title, abstract, searchQuery } = body;

  // Allow title-only summarization
  if (!title && !abstract) {
    return new Response(JSON.stringify({ error: 'Title or abstract is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // If no abstract, generate a brief summary from title using AI
  if (!abstract || typeof abstract !== 'string' || abstract.trim().length === 0) {
    if (!env.ANTHROPIC_API_KEY) {
      return new Response(JSON.stringify({
        summary: `Research on: ${title}`,
        aiGenerated: false
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    try {
      let titlePrompt;
      if (searchQuery) {
        titlePrompt = `A user searched for: "${searchQuery}"
This paper was found: "${title}"

Write ONE brief sentence (under 150 characters) that:
1. Describes what this paper investigates
2. Hints at why it's relevant to the search

Don't start with "This paper" - be direct.`;
      } else {
        titlePrompt = `Based on this physics paper title, write a single brief sentence (under 150 characters) describing what this research likely investigates. Be specific to physics. Title: "${title}"`;
      }

      const response = await fetch(CLAUDE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: CLAUDE_MODEL,
          max_tokens: 100,
          messages: [{ role: 'user', content: titlePrompt }]
        })
      });

      if (response.ok) {
        const data = await response.json();
        const summary = data.content?.[0]?.text?.trim();
        if (summary) {
          return new Response(JSON.stringify({
            summary: summary,
            aiGenerated: true,
            fromTitle: true
          }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    } catch (e) {
      console.error('Title-only summarize error:', e);
    }

    return new Response(JSON.stringify({
      summary: `Research on: ${title}`,
      aiGenerated: false
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Check if API key is configured
  if (!env.ANTHROPIC_API_KEY) {
    // Fallback to simple extraction
    return new Response(JSON.stringify({
      summary: extractFirstSentences(abstract, 2),
      aiGenerated: false
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    let systemPrompt, userPrompt;

    if (searchQuery) {
      // Context-aware summary that explains relevance
      systemPrompt = `You are a research assistant helping a physicist find relevant papers. Given a paper and a search query, write ONE sentence (max 200 chars) that:
1. Summarizes the paper's key finding
2. Naturally indicates why it's relevant to what the user is looking for

Don't start with "This paper" or "The authors". Be direct and specific.`;

      userPrompt = `Search query: "${searchQuery}"

Paper title: ${title || 'Untitled'}

Abstract: ${abstract}

Write a single summary sentence (under 200 chars) that captures the finding and its relevance:`;
    } else {
      // Standard summary without search context
      systemPrompt = `You are a scientific paper summarizer. Given a paper's title and abstract, generate a single concise sentence (maximum 200 characters) that captures the key finding. Write for physicists. Be direct, factual, and brief. Never use more than one sentence.`;

      userPrompt = `Title: ${title || 'Untitled'}\n\nAbstract: ${abstract}\n\nProvide a single-sentence summary (under 200 characters):`;
    }

    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 150,
        system: systemPrompt,
        messages: [
          { role: 'user', content: userPrompt }
        ]
      })
    });

    if (!response.ok) {
      console.error('Claude API error for summarize:', response.status);
      return new Response(JSON.stringify({
        summary: extractFirstSentences(abstract, 2),
        aiGenerated: false
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const data = await response.json();
    const summary = data.content?.[0]?.text?.trim();

    if (!summary) {
      return new Response(JSON.stringify({
        summary: extractFirstSentences(abstract, 2),
        aiGenerated: false
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      summary: summary,
      aiGenerated: true
    }), {
      headers: { 'Content-Type': 'application/json' },
    });

  } catch (error) {
    console.error('Summarize error:', error);
    return new Response(JSON.stringify({
      summary: extractFirstSentences(abstract, 2),
      aiGenerated: false
    }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

/**
 * Extract first N sentences from text
 */
function extractFirstSentences(text, n = 2) {
  if (!text) return 'No summary available.';
  const plainText = text.replace(/<[^>]*>/g, '');
  const sentences = plainText.match(/[^.!?]+[.!?]+/g) || [plainText];
  return sentences.slice(0, n).join(' ').trim();
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
