# PhysChat

AI-assisted physics article search interface, designed as a narrow browser extension sidebar.

## Project Overview

PhysChat is a proof-of-concept tool that uses Claude AI to intelligently parse natural language physics questions and search the APS (American Physical Society) Tesseract database. It demonstrates transparent AI-assisted search with visible reasoning.

## Architecture

```
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────┐
│   test.html     │────▶│  Cloudflare Worker   │────▶│  APS Tesseract  │
│  (Frontend UI)  │     │  (Proxy + AI calls)  │     │      API        │
└─────────────────┘     └──────────────────────┘     └─────────────────┘
                               │
                               ▼
                        ┌──────────────┐
                        │  Claude API  │
                        │   (Haiku)    │
                        └──────────────┘
```

## Key Files

- `test.html` - Single-file frontend with embedded CSS/JS
- `config.local.js` - Local dev config (gitignored) - copy from `config.local.example.js`
- `worker/` - Cloudflare Worker backend (if present)

## Design Constraints

- **Width: 380px max** - Designed as browser extension sidebar that overlays other pages
- **Narrow-first design** - All UI must work in constrained horizontal space
- **Transparent AI** - Show users how searches are constructed and ranked

## Key Features

1. **Multi-search strategy** - AI generates multiple targeted searches from a single query
2. **Overlap analysis** - Articles found in multiple searches ranked higher
3. **AI summaries** - Top results get Claude-generated summaries
4. **Thinking panel** - Shows search process stages for transparency

## Configuration

Create `config.local.js` (gitignored) with:
```javascript
const PHYSCHAT_CONFIG = {
  workerUrl: 'https://your-worker.workers.dev',
  devToken: 'your-aps-tesseract-token'
};
```

## Search Algorithm

1. Claude Haiku parses natural language query
2. Generates 3-5 targeted search queries with weights
3. Executes searches in parallel against Tesseract API
4. Deduplicates results by DOI
5. Scores: `relevanceScore = totalWeight + (overlapCount - 1) × 1.5`
6. Returns top 20 ranked results

## UI Components

- **Search box** - Query input, sort selector, AI toggle
- **Thinking panel** - Collapsible search process log (dark theme)
- **Synthesis panel** - Summary with themes and stats (blue gradient)
- **Article cards** - Compact result cards with match badges

## Development

Open `test.html` directly in browser (file:// protocol works).
Requires valid APS Tesseract token in config.local.js.

## API Endpoints (Worker)

- `POST /search` - Direct search passthrough
- `POST /ai-search` - AI-powered multi-search
- `POST /summarize` - Generate article summary

## Style Notes

- Primary color: `#00274c` (dark blue)
- Accent: `#0077b6` (bright blue)
- AI gradient: `#8b5cf6` → `#6366f1` (purple)
- Font: System UI stack (-apple-system, BlinkMacSystemFont, etc.)
