# PhysChat - APS Article Search Extension

A Chrome browser extension that provides a sidebar search interface for APS physics articles on journals.aps.org.

## Features

- Collapsible sidebar that appears on journals.aps.org
- Search across all APS journals using the Tesseract API
- Results include title, authors, DOI, summary, and direct links
- Article links navigate in the same tab while preserving the sidebar
- APS-branded UI with navy blue color scheme

## Project Structure

```
PhysChat/
├── extension/           # Chrome extension files
│   ├── manifest.json    # Extension manifest (v3)
│   ├── content.js       # Sidebar injection and search logic
│   ├── styles.css       # Sidebar styling
│   ├── background.js    # Service worker for auth handling
│   ├── popup.html       # Extension popup UI
│   ├── popup.js         # Popup logic
│   └── icons/           # Extension icons (need to be created)
│
└── worker/              # Cloudflare Worker
    ├── wrangler.toml    # Worker configuration
    ├── package.json     # Dependencies
    └── src/
        └── index.js     # OAuth proxy and search API
```

## Setup Instructions

### 1. Set Up Cloudflare Worker

1. **Create a Cloudflare account** (if you don't have one):
   - Go to https://dash.cloudflare.com/sign-up
   - Verify your email

2. **Install Wrangler CLI**:
   ```bash
   npm install -g wrangler
   ```

3. **Login to Cloudflare**:
   ```bash
   wrangler login
   ```
   This opens a browser window - authorize the CLI.

4. **Deploy the worker**:
   ```bash
   cd worker
   npm install
   wrangler deploy
   ```

5. **Note your worker URL** - it will be something like:
   ```
   https://physchat-worker.YOUR_SUBDOMAIN.workers.dev
   ```

### 2. Update Extension Configuration

After deploying the worker, update the worker URL in these files:

1. `extension/content.js` - Line 9:
   ```javascript
   workerUrl: 'https://physchat-worker.YOUR_SUBDOMAIN.workers.dev'
   ```

2. `extension/background.js` - Line 5:
   ```javascript
   workerUrl: 'https://physchat-worker.YOUR_SUBDOMAIN.workers.dev'
   ```

3. `extension/popup.js` - Line 4:
   ```javascript
   workerUrl: 'https://physchat-worker.YOUR_SUBDOMAIN.workers.dev'
   ```

### 3. Create Extension Icons

Create PNG icons in `extension/icons/`:
- `icon16.png` (16x16 pixels)
- `icon48.png` (48x48 pixels)
- `icon128.png` (128x128 pixels)

### 4. Load the Extension in Chrome

1. Open Chrome and go to `chrome://extensions/`
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `extension` folder
5. The PhysChat extension should now appear

### 5. Test the Extension

1. Navigate to https://journals.aps.org
2. The PhysChat sidebar should appear on the right
3. Click "Sign In" to authenticate with your APS/STAP credentials
4. After authentication, try searching for articles

## Authentication Flow

1. User clicks "Sign In" in the sidebar
2. Browser opens Cognito OAuth authorization page
3. User logs in with APS/STAP credentials
4. Cognito redirects to worker's `/auth/callback`
5. Worker exchanges code for access token
6. Token is sent back to extension via postMessage
7. Extension stores token and uses it for API calls

## API Endpoints (Worker)

- `GET /auth` - Initiates OAuth flow
- `GET /auth/callback` - Handles OAuth callback
- `POST /search` - Search articles (requires Bearer token)
- `GET /health` - Health check

## Development

### Local Worker Development

```bash
cd worker
wrangler dev
```

This starts a local development server at `http://localhost:8787`.

### Testing the Extension

1. Make changes to extension files
2. Go to `chrome://extensions/`
3. Click the refresh icon on the PhysChat extension
4. Reload journals.aps.org to see changes

## Distribution

For internal APS distribution:

**Option A: Share the extension folder**
- Zip the `extension` folder
- Recipients load it as an unpacked extension

**Option B: Chrome Web Store (unlisted)**
- Package as .crx file
- Upload to Chrome Web Store as unlisted
- Share direct link with team members

## Troubleshooting

### "Failed to search" error
- Check that you're authenticated (sign out and sign in again)
- Verify the worker URL is correct in all files
- Check worker logs: `wrangler tail`

### Sidebar doesn't appear
- Ensure you're on journals.aps.org (not another domain)
- Check Chrome extensions page for errors
- Try refreshing the page

### Authentication loop
- Clear extension storage: right-click extension icon > "Inspect popup" > Application > Local Storage > Clear
- Try signing in again

## Configuration

### Worker Environment Variables

Set in `wrangler.toml` or as Cloudflare secrets:

- `COGNITO_CLIENT_ID` - AWS Cognito client ID
- `COGNITO_AUTH_URL` - Cognito authorization endpoint
- `COGNITO_TOKEN_URL` - Cognito token endpoint
- `COGNITO_SCOPE` - OAuth scope
- `TESSERACT_API_URL` - Tesseract MCP API endpoint
