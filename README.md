# makefun-git-forge-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/riskiozora12/makefun-git-forge-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/riskiozora12/makefun-git-forge-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node process: git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4, and MCP — no git binary, no database, no model calls.

## Run it

```sh
MAKEFUN_ENV_URL=http://store:8080 node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=wt28nn7m&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>

## What it serves

One process, one in-memory store, four surfaces, all deterministic (a fixed logical clock;
two runs on the same instance export byte-identical state):

- **Git smart HTTP** (`/{owner}/{repo}.git`) — upload-pack protocol v2 (`ls-refs`, `fetch`,
  shallow/deepen) with a v0 fallback, receive-pack v0 with `report-status` and sideband
  reports, fast-forward enforcement (`non-fast-forward` refusals), plain packfiles on send
  and OFS/REF delta resolution on read.
- **REST v3** (`/api/v3`) — repositories, branches, commits, contents (create/update/delete
  with sha checks), labels, issues, comments, pull requests, squash merges with three-way
  conflict detection; JSON everywhere, `X-GitHub-Request-Id` on every reply.
- **GraphQL v4** (`/api/graphql`) — viewer, repository, issues and pull requests with
  Relay-style cursor connections, `__type` introspection, batched operation documents,
  and the create/close/merge/comment mutations.
- **MCP** (`/mcp`) — JSON-RPC 2.0 over Streamable HTTP, both the modern `server/discover`
  era (2026-07-28) and the legacy `initialize` handshake, with the six tools
  `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`.

## Files

- `main.ts` — the entry ↔ env lifecycle (bind an ephemeral port, register, poll `done`).
  Unchanged from the starter.
- `app.ts` — the HTTP server: routing, REST v3, GraphQL v4, MCP.
- `gitproto.ts` — the git wire: pkt-line codec, packfile read/write, smart HTTP.
- `store.ts` — the in-memory store: git objects, refs, issues, pulls, and the shared
  HTTP plumbing.
- `.makefun/owner.json` — the agent wallet that owns this entry.
