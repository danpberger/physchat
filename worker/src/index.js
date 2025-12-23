/**
 * PhysChat Cloudflare Worker
 * Handles OAuth authentication with AWS Cognito and proxies search requests to Tesseract API
 * Now with Claude AI integration for intelligent query parsing
 */

// Claude API configuration
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-3-haiku-20240307'; // Fast and cheap for query parsing

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

  // Debug: Log token info
  console.log('Token received, length:', accessToken.length);
  console.log('Token starts with:', accessToken.substring(0, 50));
  console.log('Token ends with:', accessToken.substring(accessToken.length - 20));

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

  const { query, limit = 10, sort = 'relevance' } = body;

  if (!query || typeof query !== 'string') {
    return new Response(JSON.stringify({ error: 'Query is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
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
 * Call Tesseract MCP search API
 */
async function callTesseractSearch(env, accessToken, query, limit, sort = 'relevance') {
  // The Tesseract API uses MCP protocol - we need to format the request accordingly
  const mcpRequest = {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: 'search-api___mcpSearch',
      arguments: {
        q: query,
        per_page: Math.min(limit, 100),
        sort: sort // 'relevance' or 'recent'
      }
    }
  };

  const response = await fetch(env.TESSERACT_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(mcpRequest),
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('Unauthorized');
    }
    throw new Error(`API error: ${response.status}`);
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

  const { query, limit = 15, sort = 'relevance' } = body;

  if (!query || typeof query !== 'string') {
    return new Response(JSON.stringify({ error: 'Query is required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    // Step 1: Use Claude to parse the query and generate search strategy
    const searchPlan = await parseQueryWithClaude(env, query);

    // Step 2: Execute multiple searches based on Claude's plan
    const allResults = new Map(); // DOI -> { article, sources, weight }
    const searchDetails = []; // Track details of each search for transparency

    for (const search of searchPlan.searches) {
      try {
        const results = await callTesseractSearch(
          env,
          accessToken,
          search.query,
          limit,
          sort
        );

        // Track search details
        searchDetails.push({
          query: search.query,
          purpose: search.purpose,
          weight: search.weight,
          totalFound: results.total,
          retrieved: results.results.length
        });

        // Track results with their source and weight
        for (let i = 0; i < results.results.length; i++) {
          const article = results.results[i];
          if (!article.doi) continue;

          const rankWeight = search.weight * (1 - i * 0.02);

          if (allResults.has(article.doi)) {
            const existing = allResults.get(article.doi);
            existing.sources.push(search.purpose);
            existing.weight += rankWeight;
            existing.overlapCount++;
          } else {
            allResults.set(article.doi, {
              article,
              sources: [search.purpose],
              weight: rankWeight,
              overlapCount: 1
            });
          }
        }
      } catch (searchError) {
        console.error(`Search failed for "${search.query}":`, searchError);
        searchDetails.push({
          query: search.query,
          purpose: search.purpose,
          weight: search.weight,
          error: searchError.message
        });
      }
    }

    // Step 3: Score and rank results
    const scoredResults = [...allResults.values()]
      .map(r => ({
        ...r.article,
        sources: r.sources,
        overlapCount: r.overlapCount,
        relevanceScore: r.weight + (r.overlapCount - 1) * 1.5
      }))
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, 20);

    // Calculate overlap statistics
    const overlapStats = {
      totalUnique: allResults.size,
      inMultipleSearches: [...allResults.values()].filter(r => r.overlapCount > 1).length,
      in3PlusSearches: [...allResults.values()].filter(r => r.overlapCount >= 3).length,
      maxOverlap: Math.max(...[...allResults.values()].map(r => r.overlapCount), 0)
    };

    // Return results with detailed AI analysis metadata
    return new Response(JSON.stringify({
      query: query,
      aiAnalysis: {
        interpretation: searchPlan.interpretation,
        concepts: searchPlan.concepts,
        searchesRun: searchDetails
      },
      ranking: {
        method: 'overlap_weighted',
        overlapBonus: 1.5,
        stats: overlapStats
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

  const systemPrompt = `You are a physics research search assistant. Your job is to analyze user queries and generate effective search strategies for a physics article database (APS journals).

CRITICAL: Extract only SPECIFIC physics concepts. NEVER include generic words like:
- "effect", "effects", "affect", "cause", "impact", "influence", "role"
- "relationship", "connection", "interaction" (unless physics-specific)
- "study", "research", "paper", "work", "result"

Given a user's question, you must:
1. Identify the SPECIFIC physics concepts (e.g., "gravity", "biology", "quantum entanglement")
2. Preserve compound physics terms (e.g., "quantum mechanics", "dark matter", "gravitational waves")
3. Generate 2-4 focused search queries using ONLY the specific concepts
4. For relationship questions, search for the intersection of concepts

Example: "What effect does gravity have on biology?"
- Good concepts: ["gravity", "biology"] or ["gravitational effects biology"]
- Bad concepts: ["effect", "gravity", "biology"] - "effect" is too generic!

Respond ONLY with valid JSON:
{
  "interpretation": "Brief summary of what user wants",
  "concepts": ["specific_concept1", "specific_concept2"],
  "searches": [
    {"query": "search terms", "purpose": "brief label", "weight": 1.0-2.0}
  ]
}

Weight: 2.0 for intersection searches, 1.5 for primary concepts, 1.0-1.2 for supporting.`;

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
      concepts: parsed.concepts || [],
      searches: parsed.searches.slice(0, 4).map(s => ({
        query: s.query || query,
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

  const { title, abstract } = body;

  if (!abstract || typeof abstract !== 'string') {
    return new Response(JSON.stringify({ error: 'Abstract is required' }), {
      status: 400,
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
    const systemPrompt = `You are a scientific paper summarizer. Given a paper's title and abstract, generate a single concise sentence (maximum 200 characters) that captures the key finding. Write for physicists. Be direct, factual, and brief. Never use more than one sentence.`;

    const userPrompt = `Title: ${title || 'Untitled'}\n\nAbstract: ${abstract}\n\nProvide a single-sentence summary (under 200 characters):`;

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
