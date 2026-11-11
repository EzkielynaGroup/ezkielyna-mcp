# Publish notes (owner)

Built locally on 11 Nov 2026. Nothing is pushed or published yet.

- **GitHub repo:** `EzkielynaGroup/ezkielyna-mcp` (public)
- **Description (<= 120 chars):** MCP server: ask or compare other AI models (DeepSeek, GLM, Claude...), web search and balance via Ezkielyna API
- **Homepage:** https://ezkielyna.store/?utm_source=github&utm_medium=repo&utm_campaign=ezkielyna-mcp
- **Topics:** mcp, mcp-server, model-context-protocol, claude-code, claude-desktop, cursor, opencode, second-opinion, llm, deepseek, web-search, openai-compatible, indonesia

## Owner actions
1. Create the repo under EzkielynaGroup, push `main` (run `bash gh_public_check.sh <dir>` again first).
2. `npm publish` (package `ezkielyna-mcp`, check the name is free: `npm view ezkielyna-mcp`).
3. MCP Registry: `mcp-publisher publish` with `server.json` (needs the npm package live first; `mcpName` is set in package.json).
4. Optional live smoke test with a real Standard/Auto key: `ask_model`, `compare_models` (2 Standard models), `web_search`,
   `check_balance` (confirm the billing endpoint shape on the live gateway), `list_models`.
