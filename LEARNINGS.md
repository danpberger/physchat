# PhysChat: Learnings on AI-Assisted Scholarly Search

A proof-of-concept exploring how AI can improve (and complicate) searching academic physics literature.

---

## The Build (Chronological)

### Day 1: Basic Search Proxy
**Built:** Chrome extension sidebar + Cloudflare Worker proxying to APS Tesseract API.

**Learning:** The scaffolding is fast. OAuth, API proxy, basic UI—all straightforward. The interesting work is what you do with the AI layer on top.

---

### Day 2: Multi-Query Search Strategy

**Problem:** Users ask questions like "how does gravity work in space?" but search APIs expect keywords. A single query misses relevant papers.

**Solution:** Claude parses the question, identifies intent (explainer, survey, specific, author, comparative), and generates 3-5 targeted searches. Results are deduplicated and ranked by overlap.

**Learning:** Multi-search is powerful. Papers appearing in multiple queries are often the most relevant. This "overlap boost" is a simple but effective signal.

**Theme - Intent Matters:** An "explainer" query should prioritize review articles. A "survey" query should filter to recent years. The same words mean different searches depending on what the user actually wants.

---

### Day 3: Grounded Synthesis (The Hallucination Problem)

**Problem:** Asked Claude to synthesize an answer from search results. It confidently added information from its training data—plausible but not from the papers.

**Solution:** Strict prompting: "ONLY use information explicitly stated in the abstracts below. Every claim must have a citation [1], [2]."

**Learning:** This is the critical risk in AI-assisted search. Users trust that answers come from the sources shown. Hallucinated "facts" mixed with real citations erode that trust completely. Grounding isn't optional—it's the whole point.

**Theme - Transparency:** The "thinking panel" showing search construction isn't just nice UX—it's accountability. Users can see *why* papers were found.

---

### Day 4: Context-Aware Summaries

**Problem:** Paper summaries were generic. "This paper studies X" tells you nothing about relevance to *your* question.

**Solution:** Pass the original search query to the summarizer. Now summaries explain *why* a paper matters for what you asked.

**Learning:** This is where AI genuinely helps. A human scanning 20 abstracts does the same mental work—"is this relevant to my question?" AI can do it instantly, for every result.

**Theme - How AI Actually Helps:**
1. **Query translation** - Natural language → structured search
2. **Relevance explanation** - "Here's why this paper matters *for your question*"
3. **Synthesis** - Connecting findings across papers (when grounded properly)

---

### Day 5: Agentic Search

**Problem:** Pre-planned search strategies are rigid. What if the first search returns poor results? A human would adapt.

**Solution:** Give Claude tools (search_papers, analyze_gaps, finish) and let it decide what to search and when to stop. It can try different terms, evaluate coverage, and iterate.

**Learning:** Agentic search is more flexible but less predictable. The agent might take 2 searches or 4. It might find creative query variations a static plan wouldn't. But it's also a black box—harder to explain why it did what it did.

**Open Question:** Is the added flexibility worth the reduced predictability? For exploratory research, maybe. For reproducible workflows, probably not.

---

## Architectural Notes

### MCP: Necessary or Not?

PhysChat uses the Tesseract MCP (Model Context Protocol) for search. But the AI features (query parsing, synthesis, summarization) are direct Claude API calls.

**Observation:** MCP provides a clean interface for tool use, but for this POC, we could have hit the Tesseract REST API directly with similar results. MCP's value would be clearer in a multi-tool environment where the LLM orchestrates between many services.

**Verdict:** MCP isn't required for the AI-assisted search features themselves. It's an infrastructure choice, not an AI capability choice.

### Cloudflare Workers

Surprisingly capable for this use case. Handles OAuth, proxies API calls, makes Claude requests—all at the edge. Cold starts are negligible. Cost is near-zero for POC traffic.

---

## Key Takeaways

1. **Speed of Development:** Building an AI-assisted search interface took days, not months. The primitives (LLM APIs, tool use, embeddings) are mature enough for rapid prototyping.

2. **Grounding is Everything:** The moment you let an LLM "help" with search results, you inherit the hallucination problem. Strict grounding to source material isn't a feature—it's table stakes.

3. **Intent Detection is High-Value:** Understanding *why* someone is searching transforms the results. Same query, different intent = different optimal search strategy.

4. **Context-Aware Summaries Beat Generic Ones:** Telling users why a paper is relevant *to their question* is more useful than summarizing the paper in isolation.

5. **Transparency Builds Trust:** Showing the search process (queries generated, results found, how ranking works) lets users verify the AI isn't making things up.

6. **Agentic vs. Deterministic is a Tradeoff:** Agents can adapt; deterministic pipelines are predictable. Choose based on use case.

---

## Open Questions

- How do users actually perceive AI-generated summaries vs. author abstracts? Do they trust them?
- Would retrieval-augmented generation (RAG) with full paper text improve synthesis quality?
- At what point does "AI assistance" become "AI doing the research for you"—and is that a problem?
- Can overlap-based ranking be improved with citation analysis or semantic similarity?

---

*Built January 2025 with Claude, Cloudflare Workers, and the APS Tesseract API.*
