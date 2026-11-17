// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4, and MCP, all on the
// shared in-memory store. One process, no network beyond the suite, no model calls.
//
// Routing: /healthz (the env's boot probe, no auth) -> git smart HTTP (/{owner}/{repo}.git)
// -> REST /api/v3/* -> GraphQL /api/graphql -> MCP /mcp -> JSON 404. Every reply is JSON
// (except the git pack bytes) and carries a non-empty X-GitHub-Request-Id.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { handleGit } from './gitproto.ts';
import {
  VIEWER_ID,
  VIEWER_LOGIN,
  buildTreeFromMap,
  flattenTree,
  globalId,
  isRecord,
  parseCommit,
  parseGlobalId,
  parseJsonBody,
  parseTree,
  sendJson,
  timeIso,
  type Comment,
  type HandlerCtx,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { Store as StoreImpl } from './store.ts';

// ---------------------------------------------------------------------------------------------
// JSON views (what the wire sees)
// ---------------------------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: globalId('User', VIEWER_LOGIN),
    type: 'User',
    site_admin: false,
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const owner = repo.owner;
  const openIssues = [...repo.issues.values()].filter((issue) => issue.state === 'open').length;
  return {
    id: repo.id,
    node_id: globalId('Repository', `${owner}/${repo.name}`),
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    fork: false,
    created_at: timeIso(repo.createdSeq),
    updated_at: timeIso(repo.createdSeq),
    pushed_at: timeIso(repo.createdSeq),
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
    html_url: `https://github.com/${owner}/${repo.name}`,
    url: `/api/v3/repos/${owner}/${repo.name}`,
    forks_url: `/api/v3/repos/${owner}/${repo.name}/forks`,
    keys_url: `/api/v3/repos/${owner}/${repo.name}/keys{/key_id}`,
    collaborators_url: `/api/v3/repos/${owner}/${repo.name}/collaborators{/collaborator}`,
    teams_url: `/api/v3/repos/${owner}/${repo.name}/teams`,
    hooks_url: `/api/v3/repos/${owner}/${repo.name}/hooks`,
    issue_events_url: `/api/v3/repos/${owner}/${repo.name}/issues/events{/number}`,
    events_url: `/api/v3/repos/${owner}/${repo.name}/events`,
    assignees_url: `/api/v3/repos/${owner}/${repo.name}/assignees{/user}`,
    branches_url: `/api/v3/repos/${owner}/${repo.name}/branches{/branch}`,
    tags_url: `/api/v3/repos/${owner}/${repo.name}/tags`,
    blobs_url: `/api/v3/repos/${owner}/${repo.name}/git/blobs{/sha}`,
    git_tags_url: `/api/v3/repos/${owner}/${repo.name}/git/tags{/sha}`,
    git_refs_url: `/api/v3/repos/${owner}/${repo.name}/git/refs{/sha}`,
    trees_url: `/api/v3/repos/${owner}/${repo.name}/git/trees{/sha}`,
    statuses_url: `/api/v3/repos/${owner}/${repo.name}/statuses/{sha}`,
    languages_url: `/api/v3/repos/${owner}/${repo.name}/languages`,
    stargazers_url: `/api/v3/repos/${owner}/${repo.name}/stargazers`,
    contributors_url: `/api/v3/repos/${owner}/${repo.name}/contributors`,
    subscribers_url: `/api/v3/repos/${owner}/${repo.name}/subscribers`,
    subscription_url: `/api/v3/repos/${owner}/${repo.name}/subscription`,
    issues_url: `/api/v3/repos/${owner}/${repo.name}/issues{/number}`,
    pulls_url: `/api/v3/repos/${owner}/${repo.name}/pulls{/number}`,
    merges_url: `/api/v3/repos/${owner}/${repo.name}/merges`,
    compare_url: `/api/v3/repos/${owner}/${repo.name}/compare/{base}...{head}`,
    commits_url: `/api/v3/repos/${owner}/${repo.name}/commits{/sha}`,
    git_commits_url: `/api/v3/repos/${owner}/${repo.name}/git/commits{/sha}`,
    comments_url: `/api/v3/repos/${owner}/${repo.name}/comments{/number}`,
    issue_comment_url: `/api/v3/repos/${owner}/${repo.name}/issues/comments{/number}`,
    contents_url: `/api/v3/repos/${owner}/${repo.name}/contents/{+path}`,
    archive_url: `/api/v3/repos/${owner}/${repo.name}/{archive_format}{/ref}`,
    downloads_url: `/api/v3/repos/${owner}/${repo.name}/downloads`,
    clone_url: `https://github.com/${owner}/${repo.name}.git`,
    git_url: `git://github.com/${owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${owner}/${repo.name}.git`,
    mirror_url: null,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: [...repo.labels.keys()].indexOf(name) + 1,
    node_id: globalId('Label', `${repo.owner}/${repo.name}/${name}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? '000000',
    default: false,
    description: '',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', `${repo.owner}/${repo.name}/${issue.number}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    labels_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/labels{/name}`,
    comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments`,
    events_url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/events`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: timeIso(issue.createdSeq),
    updated_at: timeIso(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? timeIso(issue.updatedSeq) : null,
    author_association: 'OWNER',
    active_lock_reason: null,
    state_reason: null,
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', `${repo.owner}/${repo.name}/${issue.number}/${comment.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: timeIso(comment.createdSeq),
    updated_at: timeIso(comment.createdSeq),
    author_association: 'OWNER',
  };
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const owner = repo.owner;
  return {
    id: pull.id,
    node_id: globalId('PullRequest', `${owner}/${repo.name}/${pull.number}`),
    url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `https://github.com/${owner}/${repo.name}/pull/${pull.number}.patch`,
    issue_url: `/api/v3/repos/${owner}/${repo.name}/issues/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    user: userJson(),
    body: pull.body,
    created_at: timeIso(pull.createdSeq),
    updated_at: timeIso(pull.createdSeq),
    closed_at: pull.state === 'closed' ? pull.mergedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    labels: [],
    milestone: null,
    draft: false,
    commits_url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}/commits`,
    review_comments_url: `/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}/comments`,
    review_comment_url: `/api/v3/repos/${owner}/${repo.name}/pulls/comments{/number}`,
    comments_url: `/api/v3/repos/${owner}/${repo.name}/issues/${pull.number}/comments`,
    statuses_url: `/api/v3/repos/${owner}/${repo.name}/statuses/${pull.headSha}`,
    head: { label: `${owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, user: userJson(), repo: repoJson(repo) },
    base: { label: `${owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, user: userJson(), repo: repoJson(repo) },
    merged: pull.merged,
    mergeable: pull.state === 'open' ? store.isMergeable(repo, pull) : null,
    rebaseable: null,
    mergeable_state: pull.state === 'open' ? 'clean' : 'unknown',
    merged_by: pull.merged ? userJson() : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 1,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

// ---------------------------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------------------------

function pageParams(ctx: HandlerCtx): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(ctx.query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(ctx.query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

/** A Link header for a paginated list (GitHub style), or null when there is one page. */
function linkHeader(ctx: HandlerCtx, total: number, page: number, perPage: number): string | null {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return null;
  const host = ctx.req.headers.host ?? 'localhost';
  const path = ctx.req.url?.split('?')[0] ?? '/';
  const urlFor = (p: number): string => {
    const query = new URLSearchParams(ctx.query);
    query.set('page', String(p));
    query.set('per_page', String(perPage));
    return `http://${host}${path}?${query.toString()}`;
  };
  const links: string[] = [];
  if (page < totalPages) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`, `<${urlFor(totalPages)}>; rel="last"`);
  return links.join(', ');
}

function sendList(ctx: HandlerCtx, items: readonly unknown[], page: number, perPage: number): void {
  const link = linkHeader(ctx, items.length, page, perPage);
  sendJson(ctx, 200, paginate(items, page, perPage), link === null ? {} : { link });
}

// ---------------------------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------------------------

function notFound(ctx: HandlerCtx): void {
  sendJson(ctx, 404, { message: 'Not Found' });
}

function unauthorized(ctx: HandlerCtx): void {
  sendJson(ctx, 401, { message: 'Requires authentication' });
}

/** The repo at /repos/{owner}/{name}, or null after answering 404. */
function repoOr404(ctx: HandlerCtx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    notFound(ctx);
    return null;
  }
  const repo = ctx.store.getRepo(owner, name);
  if (repo === undefined) {
    notFound(ctx);
    return null;
  }
  return repo;
}

/** Read the request body as JSON; answers 400 on malformed JSON and returns a sentinel. */
const BAD_JSON = Symbol('bad-json');
function bodyJson(ctx: HandlerCtx): unknown {
  if (ctx.body.length === 0) return undefined;
  try {
    return parseJsonBody(ctx);
  } catch {
    sendJson(ctx, 400, { message: 'Problems parsing JSON' });
    return BAD_JSON;
  }
}

/** The tip of a ref name (a branch name, a full ref, or a raw oid), or null. */
function resolveRef(repo: Repo, ref: string | undefined | null): string | null {
  if (ref === undefined || ref === null || ref === '') return null;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  const asBranch = repo.refs.get(`refs/heads/${ref}`);
  if (asBranch !== undefined) return asBranch;
  if (repo.objects.has(ref)) return ref;
  return null;
}

/** The flat path -> {mode, oid} map of a commit's tree (empty for an unborn ref). */
function treeFlat(repo: Repo, tip: string | null): Map<string, { mode: string; oid: string }> {
  if (tip === null) return new Map();
  const treeOid = ctxStoreCommitTree(repo, tip);
  if (treeOid === null) return new Map();
  return flattenTree(repo.objects, treeOid);
}

function ctxStoreCommitTree(repo: Repo, commitOid: string): string | null {
  const object = repo.objects.get(commitOid);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Walk a tree to the entry at `path`; returns the entry, or null when it is not there. */
function treeEntryAt(repo: Repo, treeOid: string, path: string): { mode: string; oid: string } | null {
  if (path === '') return { mode: '40000', oid: treeOid };
  const segments = path.split('/');
  let current = treeOid;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === segments[i]);
    if (entry === undefined) return null;
    if (i === segments.length - 1) return { mode: entry.mode, oid: entry.oid };
    current = entry.oid;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

/** The commits reachable from `tip`, newest first (breadth-first over parents). */
function listCommits(repo: Repo, tip: string, limit: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const queue = [tip];
  let head = 0;
  while (head < queue.length && out.length < limit) {
    const oid = queue[head]!;
    head += 1;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    out.push({
      sha: oid,
      node_id: globalId('Commit', `${repo.owner}/${repo.name}/${oid}`),
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/commit/${oid}`,
      comments_url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${oid}/comments`,
      commit: {
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${oid}`,
        author: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: timeIso(0) },
        committer: { name: 'ada iversen', email: 'adaiversen@example.invalid', date: timeIso(0) },
        message: commit.message.replace(/\n$/, ''),
        tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
        comment_count: 0,
        verification: { verified: false, reason: 'unsigned', signature: null, payload: null, verified_at: null },
      },
      author: userJson(),
      committer: userJson(),
      parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}` })),
    });
    for (const parent of commit.parents) {
      if (!seen.has(parent)) queue.push(parent);
    }
  }
  return out;
}

/**
 * Handle a /api/v3/* request. Returns true when the path is under /api/v3 (the response
 * has been sent), false otherwise. GET /api/v3/ and /api/v3/meta are public, like the
 * real API; every other route needs a Bearer token (401 without one).
 */
function handleRest(ctx: HandlerCtx): boolean {
  const segments = ctx.segments;
  if (segments.length < 2 || segments[0] !== 'api' || segments[1] !== 'v3') return false;
  const method = ctx.req.method ?? 'GET';
  const rest = segments.slice(2);

  // The API root and meta are public.
  if (method === 'GET' && rest.length === 0) {
    sendJson(ctx, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (method === 'GET' && rest.length === 1 && rest[0] === 'meta') {
    sendJson(ctx, 200, { installed_version: '1.0.0', verifiable_password_authentication: true, ssh_key_fingerprints: {}, hooks: [], web: [], api: [], git: [], packages: [], pages: [], importer: [], actions: [], dependabot: [] });
    return true;
  }

  if (ctx.token === null) {
    unauthorized(ctx);
    return true;
  }

  // GET /api/v3/user — the viewer.
  if (method === 'GET' && rest.length === 1 && rest[0] === 'user') {
    sendJson(ctx, 200, userJson());
    return true;
  }

  // POST /api/v3/user/repos — create a repository.
  if (method === 'POST' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    const body = bodyJson(ctx);
    if (body === BAD_JSON) return true;
    if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
      sendJson(ctx, 422, { message: 'Validation Failed: name is required' });
      return true;
    }
    const repo = ctx.store.createRepo(
      VIEWER_LOGIN,
      body.name,
      typeof body.description === 'string' ? body.description : '',
      body.private === true,
    );
    if (repo === null) {
      sendJson(ctx, 422, { message: 'Validation Failed: name already exists on this account' });
      return true;
    }
    sendJson(ctx, 201, repoJson(repo));
    return true;
  }

  // GET /api/v3/user/repos — the viewer's repositories, paginated.
  if (method === 'GET' && rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    const { page, perPage } = pageParams(ctx);
    const repos = ctx.store.listRepos(VIEWER_LOGIN).map((repo) => repoJson(repo));
    sendList(ctx, repos, page, perPage);
    return true;
  }

  // Everything below is /api/v3/repos/{owner}/{repo}[...].
  if (rest.length < 3 || rest[0] !== 'repos') {
    notFound(ctx);
    return true;
  }
  const owner = rest[1];
  const repoName = rest[2];
  const tail = rest.slice(3);

  // GET / PATCH / DELETE /api/v3/repos/{owner}/{repo}
  if (tail.length === 0) {
    if (method === 'GET') {
      const repo = repoOr404(ctx, owner, repoName);
      if (repo !== null) sendJson(ctx, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const repo = repoOr404(ctx, owner, repoName);
      if (repo === null) return true;
      const body = bodyJson(ctx);
      if (body === BAD_JSON) return true;
      if (isRecord(body)) {
        if (typeof body.description === 'string') repo.description = body.description;
        if (typeof body.private === 'boolean') repo.private = body.private;
      }
      sendJson(ctx, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      if (owner !== VIEWER_LOGIN || ctx.store.getRepo(owner, repoName) === undefined) {
        notFound(ctx);
        return true;
      }
      ctx.store.deleteRepo(owner, repoName);
      ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
      ctx.res.end();
      return true;
    }
    notFound(ctx);
    return true;
  }

  // POST /api/v3/repos/{owner}/{repo}/git/refs — create a branch ref.
  if (method === 'POST' && tail.length === 2 && tail[0] === 'git' && tail[1] === 'refs') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    const body = bodyJson(ctx);
    if (body === BAD_JSON) return true;
    if (!isRecord(body) || typeof body.ref !== 'string' || typeof body.sha !== 'string') {
      sendJson(ctx, 422, { message: 'Validation Failed: ref and sha are required' });
      return true;
    }
    const ref = body.ref;
    const sha = body.sha;
    if (!ref.startsWith('refs/') || repo.refs.has(ref)) {
      sendJson(ctx, 422, { message: 'Validation Failed: ref already exists' });
      return true;
    }
    const object = repo.objects.get(sha);
    if (object === undefined || object.type !== 'commit') {
      sendJson(ctx, 422, { message: 'Validation Failed: sha does not name a commit' });
      return true;
    }
    repo.refs.set(ref, sha);
    sendJson(ctx, 201, {
      ref,
      node_id: globalId('Ref', `${owner}/${repoName}/${ref}`),
      url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, '')}`,
      object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
    });
    return true;
  }

  // GET /api/v3/repos/{owner}/{repo}/git/refs[/...] — read one ref (or list all refs).
  if (method === 'GET' && tail.length >= 2 && tail[0] === 'git' && tail[1] === 'refs') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    if (tail.length === 2) {
      sendJson(ctx, 200, [...repo.refs.entries()].map(([ref, sha]) => ({
        ref,
        node_id: globalId('Ref', `${owner}/${repoName}/${ref}`),
        url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, '')}`,
        object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
      })));
      return true;
    }
    const ref = `refs/${tail.slice(2).join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) {
      notFound(ctx);
      return true;
    }
    sendJson(ctx, 200, {
      ref,
      node_id: globalId('Ref', `${owner}/${repoName}/${ref}`),
      url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref.replace(/^refs\//, '')}`,
      object: { sha, type: 'commit', url: `/api/v3/repos/${owner}/${repoName}/git/commits/${sha}` },
    });
    return true;
  }

  // GET /api/v3/repos/{owner}/{repo}/branches
  if (method === 'GET' && tail.length === 1 && tail[0] === 'branches') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    const branches = [...repo.refs.entries()]
      .filter(([name]) => name.startsWith('refs/heads/'))
      .map(([name, sha]) => ({ name: name.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    sendJson(ctx, 200, branches);
    return true;
  }

  // GET /api/v3/repos/{owner}/{repo}/branches/{branch}
  if (method === 'GET' && tail.length >= 2 && tail[0] === 'branches') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    const branch = tail.slice(1).join('/');
    const sha = repo.refs.get(`refs/heads/${branch}`);
    if (sha === undefined) {
      notFound(ctx);
      return true;
    }
    sendJson(ctx, 200, { name: branch, commit: { sha, url: `/api/v3/repos/${owner}/${repoName}/commits/${sha}` }, protected: false });
    return true;
  }

  // GET /api/v3/repos/{owner}/{repo}/commits[?sha=]
  if (method === 'GET' && tail.length === 1 && tail[0] === 'commits') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    const shaParam = ctx.query.get('sha');
    const tip = shaParam === null ? ctx.store.defaultTip(repo) : resolveRef(repo, shaParam);
    if (tip === null) {
      notFound(ctx);
      return true;
    }
    const { perPage } = pageParams(ctx);
    sendJson(ctx, 200, listCommits(repo, tip, perPage));
    return true;
  }

  // Contents: PUT / GET / DELETE /api/v3/repos/{owner}/{repo}/contents/{path...}
  if (tail.length >= 2 && tail[0] === 'contents') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    const path = tail.slice(1).join('/');
    if (method === 'PUT') {
      const body = bodyJson(ctx);
      if (body === BAD_JSON) return true;
      if (!isRecord(body) || typeof body.content !== 'string') {
        sendJson(ctx, 422, { message: 'Validation Failed: content is required' });
        return true;
      }
      const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
      const flat = treeFlat(repo, tip);
      const existing = flat.get(path) ?? null;
      if (existing !== null && body.sha !== existing.oid) {
        sendJson(ctx, 409, { message: 'The sha does not match the current file' });
        return true;
      }
      const bytes = Buffer.from(body.content, 'base64');
      const blobOid = ctx.store.putObject(repo, 'blob', bytes);
      const next = new Map(flat);
      next.set(path, { mode: existing?.mode ?? '100644', oid: blobOid });
      const treeOid = buildTreeFromMap(repo.objects, next);
      const commitOid = ctx.store.makeCommit(repo, {
        tree: treeOid,
        parents: tip === null ? [] : [tip],
        message: typeof body.message === 'string' ? body.message : `Update ${path}`,
      });
      repo.refs.set(`refs/heads/${branch}`, commitOid);
      sendJson(ctx, existing === null ? 201 : 200, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: bytes.length,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          html_url: `https://github.com/${owner}/${repoName}/blob/${branch}/${path}`,
          git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${blobOid}`,
          download_url: null,
          type: 'file',
          encoding: 'base64',
          content: bytes.toString('base64'),
          _links: { self: `/api/v3/repos/${owner}/${repoName}/contents/${path}`, git: `/api/v3/repos/${owner}/${repoName}/git/blobs/${blobOid}`, html: `https://github.com/${owner}/${repoName}/blob/${branch}/${path}` },
        },
        commit: { sha: commitOid, node_id: globalId('Commit', `${owner}/${repoName}/${commitOid}`), url: `/api/v3/repos/${owner}/${repoName}/commits/${commitOid}`, html_url: `https://github.com/${owner}/${repoName}/commit/${commitOid}`, author: userJson(), committer: userJson(), message: typeof body.message === 'string' ? body.message : `Update ${path}`, tree: { sha: treeOid }, parents: tip === null ? [] : [{ sha: tip }] },
      });
      return true;
    }
    if (method === 'GET') {
      const ref = ctx.query.get('ref');
      const tip = ref === null ? ctx.store.defaultTip(repo) : resolveRef(repo, ref);
      if (tip === null) {
        notFound(ctx);
        return true;
      }
      const treeOid = ctxStoreCommitTree(repo, tip);
      if (treeOid === null) {
        notFound(ctx);
        return true;
      }
      const entry = treeEntryAt(repo, treeOid, path);
      if (entry === null) {
        notFound(ctx);
        return true;
      }
      if (entry.mode !== '40000') {
        const blob = repo.objects.get(entry.oid);
        if (blob === undefined) {
          notFound(ctx);
          return true;
        }
        sendJson(ctx, 200, {
          name: path.split('/').pop() ?? path,
          path,
          sha: entry.oid,
          size: blob.data.length,
          url: `/api/v3/repos/${owner}/${repoName}/contents/${path}`,
          html_url: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${path}`,
          git_url: `/api/v3/repos/${owner}/${repoName}/git/blobs/${entry.oid}`,
          download_url: null,
          type: 'file',
          encoding: 'base64',
          content: blob.data.toString('base64'),
          _links: { self: `/api/v3/repos/${owner}/${repoName}/contents/${path}`, git: `/api/v3/repos/${owner}/${repoName}/git/blobs/${entry.oid}`, html: `https://github.com/${owner}/${repoName}/blob/${repo.defaultBranch}/${path}` },
        });
        return true;
      }
      // A directory: list its immediate children.
      const dirObject = repo.objects.get(entry.oid);
      if (dirObject === undefined) {
        notFound(ctx);
        return true;
      }
      const children = parseTree(dirObject.data).map((child) => ({
        name: child.name,
        path: path === '' ? child.name : `${path}/${child.name}`,
        sha: child.oid,
        size: child.mode === '40000' ? 0 : (repo.objects.get(child.oid)?.data.length ?? 0),
        url: `/api/v3/repos/${owner}/${repoName}/contents/${path === '' ? child.name : `${path}/${child.name}`}`,
        html_url: `https://github.com/${owner}/${repoName}/tree/${repo.defaultBranch}/${path === '' ? child.name : `${path}/${child.name}`}`,
        git_url: `/api/v3/repos/${owner}/${repoName}/git/trees/${child.oid}`,
        download_url: null,
        type: child.mode === '40000' ? 'dir' : 'file',
        _links: { self: `/api/v3/repos/${owner}/${repoName}/contents/${path === '' ? child.name : `${path}/${child.name}`}`, git: `/api/v3/repos/${owner}/${repoName}/git/trees/${child.oid}`, html: `https://github.com/${owner}/${repoName}/tree/${repo.defaultBranch}/${path === '' ? child.name : `${path}/${child.name}`}` },
      }));
      sendJson(ctx, 200, children);
      return true;
    }
    if (method === 'DELETE') {
      const body = bodyJson(ctx);
      if (body === BAD_JSON) return true;
      const branch = isRecord(body) && typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
      if (tip === null) {
        notFound(ctx);
        return true;
      }
      const flat = treeFlat(repo, tip);
      const existing = flat.get(path) ?? null;
      if (existing === null) {
        notFound(ctx);
        return true;
      }
      if (isRecord(body) && typeof body.sha === 'string' && body.sha !== existing.oid) {
        sendJson(ctx, 409, { message: 'The sha does not match the current file' });
        return true;
      }
      const next = new Map(flat);
      next.delete(path);
      const treeOid = buildTreeFromMap(repo.objects, next);
      const commitOid = ctx.store.makeCommit(repo, {
        tree: treeOid,
        parents: [tip],
        message: isRecord(body) && typeof body.message === 'string' ? body.message : `Delete ${path}`,
      });
      repo.refs.set(`refs/heads/${branch}`, commitOid);
      sendJson(ctx, 200, { commit: { sha: commitOid, node_id: globalId('Commit', `${owner}/${repoName}/${commitOid}`), url: `/api/v3/repos/${owner}/${repo.name}/commits/${commitOid}` } });
      return true;
    }
    notFound(ctx);
    return true;
  }

  // Labels: POST / GET /api/v3/repos/{owner}/{repo}/labels
  if (tail.length === 1 && tail[0] === 'labels') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    if (method === 'GET') {
      sendJson(ctx, 200, [...repo.labels.keys()].map((name) => labelJson(repo, name)));
      return true;
    }
    if (method === 'POST') {
      const body = bodyJson(ctx);
      if (body === BAD_JSON) return true;
      if (!isRecord(body) || typeof body.name !== 'string' || body.name === '') {
        sendJson(ctx, 422, { message: 'Validation Failed: name is required' });
        return true;
      }
      if (repo.labels.has(body.name)) {
        sendJson(ctx, 422, { message: 'Validation Failed: label already exists' });
        return true;
      }
      const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : '000000';
      repo.labels.set(body.name, { name: body.name, color });
      sendJson(ctx, 201, labelJson(repo, body.name));
      return true;
    }
    notFound(ctx);
    return true;
  }

  // Issues: POST / GET /api/v3/repos/{owner}/{repo}/issues
  if (tail.length === 1 && tail[0] === 'issues') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    if (method === 'POST') {
      const body = bodyJson(ctx);
      if (body === BAD_JSON) return true;
      if (!isRecord(body) || typeof body.title !== 'string' || body.title === '') {
        sendJson(ctx, 422, { message: 'Validation Failed: title is required' });
        return true;
      }
      const rawLabels = Array.isArray(body.labels) ? body.labels : [];
      const labels: string[] = [];
      for (const raw of rawLabels) {
        if (typeof raw === 'string') labels.push(raw);
        else if (isRecord(raw) && typeof raw.name === 'string') labels.push(raw.name);
      }
      const issue = ctx.store.createIssue(repo, body.title, typeof body.body === 'string' ? body.body : '', labels);
      if (issue === null) {
        const missing = labels.find((name) => !repo.labels.has(name)) ?? labels[0] ?? '';
        sendJson(ctx, 422, { message: `Validation Failed: label does not exist: ${missing}` });
        return true;
      }
      sendJson(ctx, 201, issueJson(repo, issue));
      return true;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => {
        const key = sort === 'created' ? a.createdSeq - b.createdSeq : a.number - b.number;
        return direction === 'asc' ? key : -key;
      });
      const { page, perPage } = pageParams(ctx);
      sendList(ctx, issues.map((issue) => issueJson(repo, issue)), page, perPage);
      return true;
    }
    notFound(ctx);
    return true;
  }

  // One issue: GET / PATCH /api/v3/repos/{owner}/{repo}/issues/{number}
  if (tail.length === 2 && tail[0] === 'issues' && /^\d+$/.test(tail[1])) {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    const issue = repo.issues.get(Number(tail[1]));
    if (issue === undefined) {
      notFound(ctx);
      return true;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, issueJson(repo, issue));
      return true;
    }
    if (method === 'PATCH') {
      const body = bodyJson(ctx);
      if (body === BAD_JSON) return true;
      if (isRecord(body)) {
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (Array.isArray(body.labels)) {
          const labels: string[] = [];
          for (const raw of body.labels) {
            if (typeof raw === 'string') labels.push(raw);
            else if (isRecord(raw) && typeof raw.name === 'string') labels.push(raw.name);
          }
          if (labels.every((name) => repo.labels.has(name))) issue.labels = labels;
        }
        issue.updatedSeq = ctx.store.tick();
      }
      sendJson(ctx, 200, issueJson(repo, issue));
      return true;
    }
    notFound(ctx);
    return true;
  }

  // Issue comments: POST / GET /api/v3/repos/{owner}/{repo}/issues/{number}/comments
  if (tail.length === 3 && tail[0] === 'issues' && /^\d+$/.test(tail[1]) && tail[2] === 'comments') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    const issue = repo.issues.get(Number(tail[1]));
    if (issue === undefined) {
      notFound(ctx);
      return true;
    }
    if (method === 'POST') {
      const body = bodyJson(ctx);
      if (body === BAD_JSON) return true;
      if (!isRecord(body) || typeof body.body !== 'string') {
        sendJson(ctx, 422, { message: 'Validation Failed: body is required' });
        return true;
      }
      const comment: Comment = { id: repo.nextCommentId, body: body.body, createdSeq: ctx.store.tick() };
      repo.nextCommentId += 1;
      issue.comments.push(comment);
      sendJson(ctx, 201, commentJson(repo, issue, comment));
      return true;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
      return true;
    }
    notFound(ctx);
    return true;
  }

  // Pulls: POST / GET /api/v3/repos/{owner}/{repo}/pulls
  if (tail.length === 1 && tail[0] === 'pulls') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    if (method === 'POST') {
      const body = bodyJson(ctx);
      if (body === BAD_JSON) return true;
      if (!isRecord(body) || typeof body.title !== 'string' || typeof body.head !== 'string' || typeof body.base !== 'string') {
        sendJson(ctx, 422, { message: 'Validation Failed: title, head and base are required' });
        return true;
      }
      const pull = ctx.store.createPull(repo, body.title, typeof body.body === 'string' ? body.body : '', body.head, body.base);
      if (pull === null) {
        sendJson(ctx, 422, { message: 'Validation Failed: head or base branch is missing, or an open pull request already exists for this head' });
        return true;
      }
      sendJson(ctx, 201, pullJson(ctx.store, repo, pull));
      return true;
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, perPage } = pageParams(ctx);
      sendList(ctx, pulls.map((pull) => pullJson(ctx.store, repo, pull)), page, perPage);
      return true;
    }
    notFound(ctx);
    return true;
  }

  // One pull: GET /api/v3/repos/{owner}/{repo}/pulls/{number}
  if (tail.length === 2 && tail[0] === 'pulls' && /^\d+$/.test(tail[1])) {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    const pull = repo.pulls.get(Number(tail[1]));
    if (pull === undefined) {
      notFound(ctx);
      return true;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, pullJson(ctx.store, repo, pull));
      return true;
    }
    notFound(ctx);
    return true;
  }

  // Pull files: GET /api/v3/repos/{owner}/{repo}/pulls/{number}/files
  if (tail.length === 3 && tail[0] === 'pulls' && /^\d+$/.test(tail[1]) && tail[2] === 'files') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    const pull = repo.pulls.get(Number(tail[1]));
    if (pull === undefined) {
      notFound(ctx);
      return true;
    }
    if (method === 'GET') {
      sendJson(ctx, 200, ctx.store.pullFiles(repo, pull));
      return true;
    }
    notFound(ctx);
    return true;
  }

  // Pull merge: PUT /api/v3/repos/{owner}/{repo}/pulls/{number}/merge
  if (tail.length === 3 && tail[0] === 'pulls' && /^\d+$/.test(tail[1]) && tail[2] === 'merge') {
    const repo = repoOr404(ctx, owner, repoName);
    if (repo === null) return true;
    const pull = repo.pulls.get(Number(tail[1]));
    if (pull === undefined) {
      notFound(ctx);
      return true;
    }
    if (method === 'PUT') {
      const body = bodyJson(ctx);
      if (body === BAD_JSON) return true;
      const mergeSha = ctx.store.squashMerge(repo, pull);
      if (mergeSha === null) {
        sendJson(ctx, 405, { message: 'Pull Request is not mergeable' });
        return true;
      }
      sendJson(ctx, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
      return true;
    }
    notFound(ctx);
    return true;
  }

  notFound(ctx);
  return true;
}

// ---------------------------------------------------------------------------------------------
// GraphQL v4 — a small executor for the documents the suite sends (queries, mutations,
// inline fragments, variables, input objects, and operation batching as a JSON array).
// ---------------------------------------------------------------------------------------------

type GqlValue = string | number | boolean | null | GqlValue[] | { [key: string]: GqlValue };

interface GqlFieldSel {
  kind: 'field';
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  children: GqlSelection[];
}
interface GqlFragmentSel {
  kind: 'fragment';
  typeCondition: string | null;
  children: GqlSelection[];
}
type GqlSelection = GqlFieldSel | GqlFragmentSel;

interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  children: GqlSelection[];
}

/** A variable reference inside an argument value; resolved against the request variables. */
const VAR = Symbol('gql-var');
type GqlArgValue = GqlValue | { [VAR]: string };

class GqlParseError extends Error {}

/** A tiny recursive-descent parser for the GraphQL subset the suite uses. */
class GqlParser {
  private pos = 0;
  private readonly tokens: Array<{ type: 'punct' | 'name' | 'string' | 'int' | 'float'; value: string }> = [];

  constructor(text: string) {
    // Lex the whole document up front.
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
        i += 1;
        continue;
      }
      if (ch === '#') {
        while (i < text.length && text[i] !== '\n') i += 1;
        continue;
      }
      if ('{}()[]:!=$@'.includes(ch)) {
        this.tokens.push({ type: 'punct', value: ch });
        i += 1;
        continue;
      }
      if (ch === '.' && text.slice(i, i + 3) === '...') {
        this.tokens.push({ type: 'punct', value: '...' });
        i += 3;
        continue;
      }
      if (ch === '"') {
        let j = i + 1;
        let value = '';
        while (j < text.length && text[j] !== '"') {
          if (text[j] === '\\' && j + 1 < text.length) {
            const esc = text[j + 1];
            value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
            j += 2;
          } else {
            value += text[j];
            j += 1;
          }
        }
        if (j >= text.length) throw new GqlParseError('unterminated string');
        this.tokens.push({ type: 'string', value });
        i = j + 1;
        continue;
      }
      if (/[0-9-]/.test(ch)) {
        let j = i;
        while (j < text.length && /[0-9.eE+-]/.test(text[j])) j += 1;
        const raw = text.slice(i, j);
        this.tokens.push({ type: raw.includes('.') || raw.includes('e') || raw.includes('E') ? 'float' : 'int', value: raw });
        i = j;
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let j = i;
        while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
        this.tokens.push({ type: 'name', value: text.slice(i, j) });
        i = j;
        continue;
      }
      throw new GqlParseError(`unexpected character ${JSON.stringify(ch)}`);
    }
  }

  private peek(): { type: string; value: string } | undefined {
    return this.tokens[this.pos];
  }

  private next(): { type: string; value: string } {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GqlParseError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.type !== 'punct' || token.value !== value) throw new GqlParseError(`expected ${value}, got ${token.value}`);
  }

  private isPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.type === 'punct' && token.value === value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token !== undefined && token.type === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value as 'query' | 'mutation';
      this.next();
      const nameToken = this.peek();
      if (nameToken !== undefined && nameToken.type === 'name') {
        name = nameToken.value;
        this.next();
      }
    }
    if (this.isPunct('(')) this.skipVariableDefinitions();
    const children = this.parseSelectionSet();
    return { kind, name, children };
  }

  /** Skip ($name: Type = default, ...) — the names are not needed; values come from the request. */
  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.type === 'punct' && token.value === '(') depth += 1;
      else if (token.type === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!this.isPunct('}')) {
      if (this.pos >= this.tokens.length) throw new GqlParseError('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.isPunct('...')) {
      this.next();
      let typeCondition: string | null = null;
      const token = this.peek();
      if (token !== undefined && token.type === 'name' && token.value === 'on') {
        this.next();
        typeCondition = this.next().value;
      }
      return { kind: 'fragment', typeCondition, children: this.parseSelectionSet() };
    }
    const first = this.next();
    if (first.type !== 'name') throw new GqlParseError(`expected a field name, got ${first.value}`);
    let alias: string | null = null;
    let name = first.value;
    if (this.isPunct(':')) {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args: Record<string, GqlValue> = {};
    if (this.isPunct('(')) {
      this.expectPunct('(');
      while (!this.isPunct(')')) {
        const argName = this.next().value;
        this.expectPunct(':');
        args[argName] = this.parseValue() as GqlValue;
      }
      this.expectPunct(')');
    }
    const children = this.isPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, children };
  }

  private parseValue(): GqlArgValue {
    const token = this.next();
    if (token.type === 'punct' && token.value === '$') {
      return { [VAR]: this.next().value };
    }
    if (token.type === 'punct' && token.value === '[') {
      const list: GqlArgValue[] = [];
      while (!this.isPunct(']')) list.push(this.parseValue());
      this.expectPunct(']');
      return list as unknown as GqlValue;
    }
    if (token.type === 'punct' && token.value === '{') {
      const object: Record<string, GqlArgValue> = {};
      while (!this.isPunct('}')) {
        const key = this.next().value;
        this.expectPunct(':');
        object[key] = this.parseValue();
      }
      this.expectPunct('}');
      return object as unknown as GqlValue;
    }
    if (token.type === 'string') return token.value;
    if (token.type === 'int') return Number.parseInt(token.value, 10);
    if (token.type === 'float') return Number.parseFloat(token.value);
    if (token.type === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return token.value; // an enum value
    }
    throw new GqlParseError(`unexpected value token ${token.value}`);
  }
}

/** Resolve variable references in an argument value against the request variables. */
function resolveArg(value: GqlArgValue, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object') {
    if (VAR in (value as Record<symbol, unknown>)) {
      return variables[(value as Record<symbol, string>)[VAR]] ?? null;
    }
    if (Array.isArray(value)) return value.map((item) => resolveArg(item as GqlArgValue, variables));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[key] = resolveArg(item as GqlArgValue, variables);
    return out;
  }
  return value;
}

/** A value the executor can walk: a typed object, a scalar, or a list of them. */
type GqlObject = { __typename: string; [key: string]: unknown };

const ISSUE_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'closedAt', 'url', 'author', 'labels', 'comments', 'repository'];
const PULL_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'author', 'url'];
const REPO_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'createdAt', 'updatedAt', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function cursorForNumber(n: number): string {
  return Buffer.from(`n:${n}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string | undefined | null): number | null {
  if (cursor === undefined || cursor === null) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('n:')) return null;
    const n = Number.parseInt(text.slice(2), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

interface ConnectionItem {
  __typename: string;
  number: number;
  [key: string]: unknown;
}

/** A Relay-style connection over a sorted list, paginated by the item's number. */
function buildConnection<T extends ConnectionItem>(items: T[], typename: string, first: number | undefined, after: string | undefined | null, descending: boolean): GqlObject {
  const afterNumber = numberFromCursor(after);
  const filtered = afterNumber === null ? items : items.filter((item) => (descending ? item.number < afterNumber : item.number > afterNumber));
  const limit = first === undefined ? filtered.length : Math.max(0, first);
  const page = filtered.slice(0, limit);
  const edges = page.map((item) => ({ __typename: `${typename}Edge`, node: item, cursor: cursorForNumber(item.number) }));
  return {
    __typename: typename,
    nodes: page,
    edges,
    totalCount: items.length,
    pageInfo: {
      __typename: 'PageInfo',
      hasNextPage: filtered.length > page.length,
      hasPreviousPage: afterNumber !== null,
      startCursor: edges.length > 0 ? edges[0].cursor : null,
      endCursor: edges.length > 0 ? edges[edges.length - 1].cursor : null,
    },
  };
}

class GqlExecutor {
  readonly errors: Array<{ message: string }> = [];
  readonly store: Store;
  private readonly variables: Record<string, unknown>;

  constructor(store: Store, variables: Record<string, unknown>) {
    this.store = store;
    this.variables = variables;
  }

  /** Run one operation and return its result object ({data} plus errors when any). */
  run(operation: GqlOperation): Record<string, unknown> {
    const root: GqlObject = { __typename: operation.kind === 'mutation' ? 'Mutation' : 'Query' };
    const data = this.executeSelection(root, operation.children);
    const result: Record<string, unknown> = { data };
    if (this.errors.length > 0) result.errors = this.errors;
    return result;
  }

  arg(selection: GqlFieldSel, name: string): unknown {
    const raw = selection.args[name];
    if (raw === undefined) return undefined;
    return resolveArg(raw as GqlArgValue, this.variables);
  }

  private executeSelection(obj: GqlObject, selections: GqlSelection[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'fragment') {
        if (selection.typeCondition === null || selection.typeCondition === obj.__typename) {
          Object.assign(out, this.executeSelection(obj, selection.children));
        }
        continue;
      }
      if (selection.name === '__typename') {
        out[selection.alias ?? '__typename'] = obj.__typename;
        continue;
      }
      const resolver = RESOLVERS[obj.__typename]?.[selection.name];
      if (resolver === undefined) {
        this.errors.push({ message: `Cannot query field "${selection.name}" on type "${obj.__typename}".` });
        continue;
      }
      const value = resolver(this, obj, selection);
      out[selection.alias ?? selection.name] = this.executeValue(value, selection.children);
    }
    return out;
  }

  private executeValue(value: unknown, children: GqlSelection[]): unknown {
    if (value === null || value === undefined) return null;
    if (Array.isArray(value)) return value.map((item) => this.executeValue(item, children));
    if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
      if (children.length === 0) return value;
      return this.executeSelection(value as GqlObject, children);
    }
    return value;
  }

  // -- object builders ---------------------------------------------------------------

  viewerObject(): GqlObject {
    return { __typename: 'Viewer', login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen' };
  }

  userObject(): GqlObject {
    return { __typename: 'User', login: VIEWER_LOGIN, id: VIEWER_ID, name: 'ada iversen' };
  }

  repoObject(repo: Repo): GqlObject {
    return { __typename: 'Repository', repo };
  }

  issueObject(repo: Repo, issue: Issue): GqlObject {
    return { __typename: 'Issue', repo, issue };
  }

  pullObject(repo: Repo, pull: Pull): GqlObject {
    return { __typename: 'PullRequest', repo, pull };
  }

  repoFromGlobalId(id: unknown): Repo | null {
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'Repository') return null;
    const [owner, name] = parsed.key.split('/');
    if (owner === undefined || name === undefined) return null;
    return this.store.getRepo(owner, name) ?? null;
  }

  issueFromGlobalId(id: unknown): { repo: Repo; issue: Issue } | null {
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'Issue') return null;
    const parts = parsed.key.split('/');
    if (parts.length !== 3) return null;
    const repo = this.store.getRepo(parts[0], parts[1]);
    if (repo === undefined) return null;
    const issue = repo.issues.get(Number(parts[2]));
    return issue === undefined ? null : { repo, issue };
  }

  pullFromGlobalId(id: unknown): { repo: Repo; pull: Pull } | null {
    if (typeof id !== 'string') return null;
    const parsed = parseGlobalId(id);
    if (parsed === null || parsed.kind !== 'PullRequest') return null;
    const parts = parsed.key.split('/');
    if (parts.length !== 3) return null;
    const repo = this.store.getRepo(parts[0], parts[1]);
    if (repo === undefined) return null;
    const pull = repo.pulls.get(Number(parts[2]));
    return pull === undefined ? null : { repo, pull };
  }
}

/** Field resolvers per type. Each returns a scalar, a GqlObject, a list, or null. */
type Resolver = (exec: GqlExecutor, obj: GqlObject, selection: GqlFieldSel) => unknown;

const RESOLVERS: Record<string, Record<string, Resolver>> = {
  Query: {
    viewer: (exec) => exec.viewerObject(),
    repository: (exec, _obj, sel) => {
      const owner = exec.arg(sel, 'owner');
      const name = exec.arg(sel, 'name');
      if (typeof owner !== 'string' || typeof name !== 'string') return null;
      if (owner !== VIEWER_LOGIN) return null;
      const repo = exec.store.getRepo(owner, name);
      return repo === undefined ? null : exec.repoObject(repo);
    },
    node: (exec, _obj, sel) => {
      const id = exec.arg(sel, 'id');
      if (typeof id !== 'string') return null;
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.kind === 'Repository') {
        const repo = exec.repoFromGlobalId(id);
        return repo === null ? null : exec.repoObject(repo);
      }
      if (parsed.kind === 'Issue') {
        const found = exec.issueFromGlobalId(id);
        return found === null ? null : exec.issueObject(found.repo, found.issue);
      }
      if (parsed.kind === 'PullRequest') {
        const found = exec.pullFromGlobalId(id);
        return found === null ? null : exec.pullObject(found.repo, found.pull);
      }
      return null;
    },
    __type: (_exec, _obj, sel) => {
      const name = sel.args['name'];
      if (typeof name !== 'string') return null;
      return { __typename: '__Type', name };
    },
  },
  Mutation: {
    createIssue: (exec, _obj, sel) => {
      const input = exec.arg(sel, 'input') as Record<string, unknown> | undefined;
      const repo = input === undefined ? null : exec.repoFromGlobalId(input['repositoryId']);
      if (repo === null || input === undefined || typeof input['title'] !== 'string') {
        exec.errors.push({ message: 'createIssue: the repository could not be found.' });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      const issue = exec.store.createIssue(repo, input['title'], typeof input['body'] === 'string' ? input['body'] : '', []);
      if (issue === null) {
        exec.errors.push({ message: 'createIssue: the issue could not be created.' });
        return { __typename: 'CreateIssuePayload', issue: null };
      }
      return { __typename: 'CreateIssuePayload', issue: exec.issueObject(repo, issue) };
    },
    closeIssue: (exec, _obj, sel) => {
      const input = exec.arg(sel, 'input') as Record<string, unknown> | undefined;
      const found = input === undefined ? null : exec.issueFromGlobalId(input['issueId']);
      if (found === null) {
        exec.errors.push({ message: 'closeIssue: the issue could not be found.' });
        return { __typename: 'CloseIssuePayload', issue: null };
      }
      found.issue.state = 'closed';
      found.issue.updatedSeq = exec.store.tick();
      return { __typename: 'CloseIssuePayload', issue: exec.issueObject(found.repo, found.issue) };
    },
    createPullRequest: (exec, _obj, sel) => {
      const input = exec.arg(sel, 'input') as Record<string, unknown> | undefined;
      const repo = input === undefined ? null : exec.repoFromGlobalId(input['repositoryId']);
      if (
        repo === null || input === undefined || typeof input['title'] !== 'string' ||
        typeof input['headRefName'] !== 'string' || typeof input['baseRefName'] !== 'string'
      ) {
        exec.errors.push({ message: 'createPullRequest: the repository or branches could not be found.' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      const pull = exec.store.createPull(repo, input['title'], typeof input['body'] === 'string' ? input['body'] : '', input['headRefName'], input['baseRefName']);
      if (pull === null) {
        exec.errors.push({ message: 'createPullRequest: the head or base branch is missing, or an open pull request already exists for this head.' });
        return { __typename: 'CreatePullRequestPayload', pullRequest: null };
      }
      return { __typename: 'CreatePullRequestPayload', pullRequest: exec.pullObject(repo, pull) };
    },
    mergePullRequest: (exec, _obj, sel) => {
      const input = exec.arg(sel, 'input') as Record<string, unknown> | undefined;
      const found = input === undefined ? null : exec.pullFromGlobalId(input['pullRequestId']);
      if (found === null) {
        exec.errors.push({ message: 'mergePullRequest: the pull request could not be found.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      const mergeSha = exec.store.squashMerge(found.repo, found.pull);
      if (mergeSha === null) {
        exec.errors.push({ message: 'mergePullRequest: the pull request is not mergeable.' });
        return { __typename: 'MergePullRequestPayload', pullRequest: null };
      }
      return { __typename: 'MergePullRequestPayload', pullRequest: exec.pullObject(found.repo, found.pull) };
    },
    addComment: (exec, _obj, sel) => {
      const input = exec.arg(sel, 'input') as Record<string, unknown> | undefined;
      const found = input === undefined ? null : exec.issueFromGlobalId(input['subjectId']);
      if (found === null || input === undefined || typeof input['body'] !== 'string') {
        exec.errors.push({ message: 'addComment: the subject could not be found.' });
        return { __typename: 'AddCommentPayload', commentEdge: null };
      }
      const comment = { id: found.repo.nextCommentId, body: input['body'], createdSeq: exec.store.tick() };
      found.repo.nextCommentId += 1;
      found.issue.comments.push(comment);
      return {
        __typename: 'AddCommentPayload',
        commentEdge: {
          __typename: 'IssueCommentEdge',
          node: {
            __typename: 'IssueComment',
            id: globalId('IssueComment', `${found.repo.owner}/${found.repo.name}/${found.issue.number}/${comment.id}`),
            body: comment.body,
          },
        },
      };
    },
  },
  Viewer: {
    login: (exec) => VIEWER_LOGIN,
    id: () => VIEWER_ID,
    name: () => 'ada iversen',
  },
  User: {
    login: () => VIEWER_LOGIN,
    id: () => VIEWER_ID,
    name: () => 'ada iversen',
  },
  Repository: {
    id: (_exec, obj) => {
      const repo = obj['repo'] as Repo;
      return globalId('Repository', `${repo.owner}/${repo.name}`);
    },
    databaseId: (_exec, obj) => (obj['repo'] as Repo).id,
    name: (_exec, obj) => (obj['repo'] as Repo).name,
    nameWithOwner: (_exec, obj) => {
      const repo = obj['repo'] as Repo;
      return `${repo.owner}/${repo.name}`;
    },
    owner: (exec) => exec.userObject(),
    defaultBranchRef: (exec, obj) => {
      const repo = obj['repo'] as Repo;
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      if (tip === undefined) return null;
      return { __typename: 'Ref', name: repo.defaultBranch, oid: tip };
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    description: (_exec, obj) => (obj['repo'] as Repo).description,
    createdAt: (_exec, obj) => timeIso((obj['repo'] as Repo).createdSeq),
    updatedAt: (_exec, obj) => timeIso((obj['repo'] as Repo).createdSeq),
    url: (_exec, obj) => {
      const repo = obj['repo'] as Repo;
      return `https://github.com/${repo.owner}/${repo.name}`;
    },
    issue: (exec, obj, sel) => {
      const repo = obj['repo'] as Repo;
      const number = exec.arg(sel, 'number');
      if (typeof number !== 'number') return null;
      const issue = repo.issues.get(number);
      return issue === undefined ? null : exec.issueObject(repo, issue);
    },
    issues: (exec, obj, sel) => {
      const repo = obj['repo'] as Repo;
      const first = exec.arg(sel, 'first');
      const after = exec.arg(sel, 'after');
      const states = exec.arg(sel, 'states');
      const orderBy = exec.arg(sel, 'orderBy') as Record<string, unknown> | undefined;
      let issues = [...repo.issues.values()];
      if (Array.isArray(states) && states.length > 0) {
        const wanted = new Set(states.map((s) => String(s).toLowerCase()));
        issues = issues.filter((issue) => wanted.has(issue.state));
      }
      const descending = orderBy === undefined || orderBy['direction'] !== 'ASC';
      issues.sort((a, b) => {
        const byCreated = descending ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq;
        if (byCreated !== 0) return byCreated;
        return descending ? b.number - a.number : a.number - b.number;
      });
      const nodes = issues.map((issue) => ({ ...exec.issueObject(repo, issue), number: issue.number }));
      return buildConnection(nodes as ConnectionItem[], 'IssueConnection', typeof first === 'number' ? first : undefined, typeof after === 'string' ? after : null, descending);
    },
    pullRequest: (exec, obj, sel) => {
      const repo = obj['repo'] as Repo;
      const number = exec.arg(sel, 'number');
      if (typeof number !== 'number') return null;
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : exec.pullObject(repo, pull);
    },
    pullRequests: (exec, obj, sel) => {
      const repo = obj['repo'] as Repo;
      const first = exec.arg(sel, 'first');
      const after = exec.arg(sel, 'after');
      const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
      const nodes = pulls.map((pull) => ({ ...exec.pullObject(repo, pull), number: pull.number }));
      return buildConnection(nodes as ConnectionItem[], 'PullRequestConnection', typeof first === 'number' ? first : undefined, typeof after === 'string' ? after : null, false);
    },
  },
  Ref: {
    name: (_exec, obj) => obj['name'],
    oid: (_exec, obj) => obj['oid'],
  },
  Issue: {
    id: (exec, obj) => {
      const repo = obj['repo'] as Repo;
      const issue = obj['issue'] as Issue;
      return globalId('Issue', `${repo.owner}/${repo.name}/${issue.number}`);
    },
    databaseId: (_exec, obj) => (obj['issue'] as Issue).id,
    number: (_exec, obj) => (obj['issue'] as Issue).number,
    title: (_exec, obj) => (obj['issue'] as Issue).title,
    body: (_exec, obj) => (obj['issue'] as Issue).body,
    state: (_exec, obj) => ((obj['issue'] as Issue).state === 'open' ? 'OPEN' : 'CLOSED'),
    createdAt: (_exec, obj) => timeIso((obj['issue'] as Issue).createdSeq),
    updatedAt: (_exec, obj) => timeIso((obj['issue'] as Issue).updatedSeq),
    closedAt: (_exec, obj) => {
      const issue = obj['issue'] as Issue;
      return issue.state === 'closed' ? timeIso(issue.updatedSeq) : null;
    },
    url: (_exec, obj) => {
      const repo = obj['repo'] as Repo;
      const issue = obj['issue'] as Issue;
      return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    },
    author: (exec) => exec.userObject(),
    repository: (exec, obj) => exec.repoObject(obj['repo'] as Repo),
  },
  PullRequest: {
    id: (_exec, obj) => {
      const repo = obj['repo'] as Repo;
      const pull = obj['pull'] as Pull;
      return globalId('PullRequest', `${repo.owner}/${repo.name}/${pull.number}`);
    },
    databaseId: (_exec, obj) => (obj['pull'] as Pull).id,
    number: (_exec, obj) => (obj['pull'] as Pull).number,
    title: (_exec, obj) => (obj['pull'] as Pull).title,
    body: (_exec, obj) => (obj['pull'] as Pull).body,
    state: (_exec, obj) => {
      const pull = obj['pull'] as Pull;
      return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
    },
    merged: (_exec, obj) => (obj['pull'] as Pull).merged,
    mergeable: (exec, obj) => {
      const repo = obj['repo'] as Repo;
      const pull = obj['pull'] as Pull;
      if (pull.state !== 'open') return 'UNKNOWN';
      return exec.store.isMergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING';
    },
    headRefName: (_exec, obj) => (obj['pull'] as Pull).head,
    baseRefName: (_exec, obj) => (obj['pull'] as Pull).base,
    headRefOid: (_exec, obj) => (obj['pull'] as Pull).headSha,
    baseRefOid: (_exec, obj) => (obj['pull'] as Pull).baseSha,
    createdAt: (_exec, obj) => timeIso((obj['pull'] as Pull).createdSeq),
    updatedAt: (_exec, obj) => timeIso((obj['pull'] as Pull).createdSeq),
    closedAt: (_exec, obj) => (obj['pull'] as Pull).mergedAt,
    mergedAt: (_exec, obj) => (obj['pull'] as Pull).mergedAt,
    url: (_exec, obj) => {
      const repo = obj['repo'] as Repo;
      const pull = obj['pull'] as Pull;
      return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
    },
    author: (exec) => exec.userObject(),
    files: (exec, obj, sel) => {
      const repo = obj['repo'] as Repo;
      const pull = obj['pull'] as Pull;
      const first = exec.arg(sel, 'first');
      const after = exec.arg(sel, 'after');
      const files = exec.store.pullFiles(repo, pull);
      const nodes = files.map((file, index) => ({ __typename: 'PullRequestFile', number: index + 1, path: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes }));
      return buildConnection(nodes as ConnectionItem[], 'PullRequestFileConnection', typeof first === 'number' ? first : undefined, typeof after === 'string' ? after : null, false);
    },
  },
  PullRequestFile: {
    path: (_exec, obj) => obj['path'],
    additions: (_exec, obj) => obj['additions'],
    deletions: (_exec, obj) => obj['deletions'],
    changes: (_exec, obj) => obj['changes'],
  },
  IssueConnection: {
    nodes: (_exec, obj) => obj['nodes'],
    edges: (_exec, obj) => obj['edges'],
    totalCount: (_exec, obj) => obj['totalCount'],
    pageInfo: (_exec, obj) => obj['pageInfo'],
  },
  PullRequestConnection: {
    nodes: (_exec, obj) => obj['nodes'],
    edges: (_exec, obj) => obj['edges'],
    totalCount: (_exec, obj) => obj['totalCount'],
    pageInfo: (_exec, obj) => obj['pageInfo'],
  },
  PullRequestFileConnection: {
    nodes: (_exec, obj) => obj['nodes'],
    edges: (_exec, obj) => obj['edges'],
    totalCount: (_exec, obj) => obj['totalCount'],
    pageInfo: (_exec, obj) => obj['pageInfo'],
  },
  IssueConnectionEdge: {
    node: (_exec, obj) => obj['node'],
    cursor: (_exec, obj) => obj['cursor'],
  },
  PullRequestConnectionEdge: {
    node: (_exec, obj) => obj['node'],
    cursor: (_exec, obj) => obj['cursor'],
  },
  PullRequestFileConnectionEdge: {
    node: (_exec, obj) => obj['node'],
    cursor: (_exec, obj) => obj['cursor'],
  },
  PageInfo: {
    hasNextPage: (_exec, obj) => obj['hasNextPage'],
    hasPreviousPage: (_exec, obj) => obj['hasPreviousPage'],
    startCursor: (_exec, obj) => obj['startCursor'],
    endCursor: (_exec, obj) => obj['endCursor'],
  },
  __Type: {
    name: (_exec, obj) => obj['name'],
    kind: () => 'OBJECT',
    fields: (_exec, obj) => {
      const name = obj['name'] as string;
      const list = name === 'Issue' ? ISSUE_FIELDS : name === 'PullRequest' ? PULL_FIELDS : name === 'Repository' ? REPO_FIELDS : [];
      return list.map((field) => ({ __typename: '__Field', name: field }));
    },
    enumValues: (_exec, obj) => {
      const name = obj['name'] as string;
      if (name !== 'SearchType') return [];
      return SEARCH_TYPE_VALUES.map((value) => ({ __typename: '__EnumValue', name: value }));
    },
  },
  __Field: {
    name: (_exec, obj) => obj['name'],
  },
  __EnumValue: {
    name: (_exec, obj) => obj['name'],
  },
  CreateIssuePayload: {
    issue: (_exec, obj) => obj['issue'],
  },
  CloseIssuePayload: {
    issue: (_exec, obj) => obj['issue'],
  },
  CreatePullRequestPayload: {
    pullRequest: (_exec, obj) => obj['pullRequest'],
  },
  MergePullRequestPayload: {
    pullRequest: (_exec, obj) => obj['pullRequest'],
  },
  AddCommentPayload: {
    commentEdge: (_exec, obj) => obj['commentEdge'],
  },
  IssueCommentEdge: {
    node: (_exec, obj) => obj['node'],
    cursor: (_exec, obj) => obj['cursor'] ?? null,
  },
  IssueComment: {
    id: (_exec, obj) => obj['id'],
    body: (_exec, obj) => obj['body'],
  },
};

/** Run one GraphQL request body ({query, variables, operationName}) against the store. */
function runGraphqlRequest(store: Store, body: unknown): Record<string, unknown> {
  if (!isRecord(body) || typeof body.query !== 'string') {
    return { errors: [{ message: 'A GraphQL query string is required.' }] };
  }
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  let operations: GqlOperation[];
  try {
    operations = new GqlParser(body.query).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'The query could not be parsed.' }] };
  }
  if (operations.length === 0) {
    return { errors: [{ message: 'The query document is empty.' }] };
  }
  let operation: GqlOperation | undefined;
  if (typeof body.operationName === 'string') {
    operation = operations.find((op) => op.name === body.operationName);
    if (operation === undefined) {
      return { errors: [{ message: `Unknown operation named "${body.operationName}".` }] };
    }
  } else if (operations.length === 1) {
    operation = operations[0];
  } else {
    return { errors: [{ message: 'This document holds several operations; pass operationName to choose one.' }] };
  }
  return new GqlExecutor(store, variables).run(operation);
}

/** Handle POST /api/graphql. Returns true when the path matches (the response is sent). */
function handleGraphql(ctx: HandlerCtx): boolean {
  const segments = ctx.segments;
  if (segments.length !== 2 || segments[0] !== 'api' || segments[1] !== 'graphql') return false;
  if (ctx.req.method !== 'POST') {
    sendJson(ctx, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (ctx.token === null) {
    sendJson(ctx, 401, { message: 'Requires authentication' });
    return true;
  }
  let body: unknown;
  try {
    body = parseJsonBody(ctx);
  } catch {
    sendJson(ctx, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  if (Array.isArray(body)) {
    // Operation batching: one result per request, in order.
    sendJson(ctx, 200, body.map((entry) => runGraphqlRequest(ctx.store, entry)));
    return true;
  }
  sendJson(ctx, 200, runGraphqlRequest(ctx.store, body));
  return true;
}

// ---------------------------------------------------------------------------------------------
// MCP — JSON-RPC 2.0 over Streamable HTTP, both eras: modern 2026-07-28 (server/discover,
// no handshake) and legacy 2025-11-25 and earlier (initialize + notifications/initialized).
// Answers are plain JSON; a notification (no id) gets a bare 202.
// ---------------------------------------------------------------------------------------------

const MCP_NAME = 'makefun-git-forge';
const MCP_VERSION = '1.0.0';
const MCP_PREFERRED_REVISION = '2026-07-28';
const MCP_SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface McpToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
  run: (store: Store, args: Record<string, unknown>) => { text: string; structured: unknown } | { error: string };
}

function mcpRepoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function mcpArgString(args: Record<string, unknown>, ...names: string[]): string | null {
  for (const name of names) {
    const value = args[name];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      name: { type: 'string', description: 'The name of the repository to create.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
    run: (store, args) => {
      const name = mcpArgString(args, 'name');
      if (name === null) return { error: 'create_repo requires a name.' };
      const repo = store.createRepo(
        VIEWER_LOGIN,
        name,
        typeof args['description'] === 'string' ? args['description'] : '',
        args['private'] === true,
      );
      if (repo === null) return { error: `A repository named ${name} already exists.` };
      const view = mcpRepoJson(repo);
      return { text: JSON.stringify(view), structured: view };
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      repository: { type: 'string', description: 'The name of the repository.' },
    },
    required: ['owner', 'repo'],
    run: (store, args) => {
      const owner = mcpArgString(args, 'owner', 'owner_login', 'login', 'user');
      const name = mcpArgString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project');
      if (owner === null || name === null) return { error: 'get_repo requires owner and repo.' };
      if (owner !== VIEWER_LOGIN) return { error: `Repository ${owner}/${name} was not found.` };
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return { error: `Repository ${owner}/${name} was not found.` };
      const view = mcpRepoJson(repo);
      return { text: JSON.stringify(view), structured: view };
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the issue.' },
      body: { type: 'string', description: 'The body of the issue.' },
      description: { type: 'string', description: 'The body of the issue.' },
    },
    required: ['owner', 'repo', 'title'],
    run: (store, args) => {
      const owner = mcpArgString(args, 'owner', 'owner_login', 'login', 'user');
      const name = mcpArgString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project');
      const title = mcpArgString(args, 'title', 'issue_title', 'subject');
      if (owner === null || name === null || title === null) return { error: 'create_issue requires owner, repo, and title.' };
      if (owner !== VIEWER_LOGIN) return { error: `Repository ${owner}/${name} was not found.` };
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return { error: `Repository ${owner}/${name} was not found.` };
      const body = mcpArgString(args, 'body', 'issue_body', 'description', 'content', 'text') ?? '';
      const issue = store.createIssue(repo, title, body, []);
      if (issue === null) return { error: 'The issue could not be created.' };
      const view = { id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state };
      return { text: JSON.stringify(view), structured: view };
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    properties: {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      status: { type: 'string', description: 'Filter by state: open, closed, or all.' },
    },
    required: ['owner', 'repo'],
    run: (store, args) => {
      const owner = mcpArgString(args, 'owner', 'owner_login', 'login', 'user');
      const name = mcpArgString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project');
      if (owner === null || name === null) return { error: 'list_issues requires owner and repo.' };
      if (owner !== VIEWER_LOGIN) return { error: `Repository ${owner}/${name} was not found.` };
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return { error: `Repository ${owner}/${name} was not found.` };
      const state = mcpArgString(args, 'state', 'status') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.createdSeq - a.createdSeq);
      const view = {
        issues: issues.map((issue) => ({ id: issue.id, number: issue.number, title: issue.title, body: issue.body, state: issue.state })),
      };
      return { text: JSON.stringify(view), structured: view };
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    properties: {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      title: { type: 'string', description: 'The title of the pull request.' },
      head: { type: 'string', description: 'The name of the head branch.' },
      base: { type: 'string', description: 'The name of the base branch.' },
      body: { type: 'string', description: 'The body of the pull request.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
    run: (store, args) => {
      const owner = mcpArgString(args, 'owner', 'owner_login', 'login', 'user');
      const name = mcpArgString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project');
      const title = mcpArgString(args, 'title', 'pr_title', 'pull_request_title', 'subject');
      const head = mcpArgString(args, 'head', 'head_ref', 'head_branch', 'source', 'from', 'branch');
      const base = mcpArgString(args, 'base', 'base_ref', 'base_branch', 'target', 'into');
      if (owner === null || name === null || title === null || head === null || base === null) {
        return { error: 'create_pull_request requires owner, repo, title, head, and base.' };
      }
      if (owner !== VIEWER_LOGIN) return { error: `Repository ${owner}/${name} was not found.` };
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return { error: `Repository ${owner}/${name} was not found.` };
      const body = mcpArgString(args, 'body', 'description', 'content', 'text') ?? '';
      const pull = store.createPull(repo, title, body, head, base);
      if (pull === null) return { error: 'The pull request could not be created: the head or base branch is missing, or an open pull request already exists for this head.' };
      const view = {
        id: pull.id,
        number: pull.number,
        title: pull.title,
        body: pull.body,
        state: pull.state,
        head: { ref: pull.head, sha: pull.headSha },
        base: { ref: pull.base, sha: pull.baseSha },
      };
      return { text: JSON.stringify(view), structured: view };
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    properties: {
      owner: { type: 'string', description: 'The login of the repository owner.' },
      repo: { type: 'string', description: 'The name of the repository.' },
      pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      number: { type: 'integer', description: 'The number of the pull request to merge.' },
    },
    required: ['owner', 'repo', 'pull_number'],
    run: (store, args) => {
      const owner = mcpArgString(args, 'owner', 'owner_login', 'login', 'user');
      const name = mcpArgString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'project');
      const rawNumber = args['pull_number'] ?? args['pull_request_number'] ?? args['pr_number'] ?? args['number'] ?? args['issue_number'] ?? args['index'];
      const number = typeof rawNumber === 'number' ? rawNumber : typeof rawNumber === 'string' ? Number.parseInt(rawNumber, 10) : Number.NaN;
      if (owner === null || name === null || !Number.isFinite(number)) {
        return { error: 'merge_pull_request requires owner, repo, and pull_number.' };
      }
      if (owner !== VIEWER_LOGIN) return { error: `Repository ${owner}/${name} was not found.` };
      const repo = store.getRepo(owner, name);
      if (repo === undefined) return { error: `Repository ${owner}/${name} was not found.` };
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { error: `Pull request #${number} was not found.` };
      const mergeSha = store.squashMerge(repo, pull);
      if (mergeSha === null) return { error: `Pull request #${number} is not mergeable.` };
      const view = { id: pull.id, number: pull.number, title: pull.title, state: pull.state, merged: true, sha: mergeSha };
      return { text: JSON.stringify(view), structured: view };
    },
  },
];

function mcpToolList(): Array<Record<string, unknown>> {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  }));
}

/** One JSON-RPC method dispatch; returns the {result} or {error} half of the response. */
function dispatchMcp(ctx: HandlerCtx, body: Record<string, unknown>): { result: unknown } | { error: { code: number; message: string } } {
  const method = body['method'] as string;
  const params = isRecord(body['params']) ? (body['params'] as Record<string, unknown>) : {};

  if (method === 'server/discover') {
    return {
      result: {
        supportedVersions: MCP_SUPPORTED_REVISIONS,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_NAME, version: MCP_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_NAME, version: MCP_VERSION } },
      },
    };
  }

  if (method === 'initialize') {
    const requested = typeof params['protocolVersion'] === 'string' ? params['protocolVersion'] : null;
    const protocolVersion = requested !== null && MCP_SUPPORTED_REVISIONS.includes(requested) ? requested : MCP_PREFERRED_REVISION;
    return {
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: MCP_NAME, version: MCP_VERSION },
      },
    };
  }

  if (method === 'ping') {
    return { result: {} };
  }

  if (method === 'tools/list') {
    return { result: { tools: mcpToolList() } };
  }

  if (method === 'tools/call') {
    const name = typeof params['name'] === 'string' ? params['name'] : '';
    const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) {
      return { error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    const args = isRecord(params['arguments']) ? (params['arguments'] as Record<string, unknown>) : {};
    const outcome = tool.run(ctx.store, args);
    if ('error' in outcome) {
      return { result: { content: [{ type: 'text', text: outcome.error }], isError: true } };
    }
    return { result: { content: [{ type: 'text', text: outcome.text }], structuredContent: outcome.structured } };
  }

  return { error: { code: -32601, message: `Method not found: ${method}` } };
}

/** Handle POST /mcp. Returns true when the path matches (the response is sent). */
function handleMcp(ctx: HandlerCtx): boolean {
  const segments = ctx.segments;
  if (segments.length !== 1 || segments[0] !== 'mcp') return false;
  if (ctx.req.method !== 'POST') {
    sendJson(ctx, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (ctx.token === null) {
    sendJson(ctx, 401, { message: 'Requires authentication' });
    return true;
  }
  let body: unknown;
  try {
    body = parseJsonBody(ctx);
  } catch {
    // A body that is not JSON at all: HTTP 400 with JSON-RPC -32700 (parse error).
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  if (!isRecord(body) || typeof body['method'] !== 'string') {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = body['id'] ?? null;
  if (id === null && (body['method'] as string).startsWith('notifications/')) {
    // A notification (notifications/initialized): 202, no body.
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId, 'mcp-protocol-version': MCP_PREFERRED_REVISION });
    ctx.res.end();
    return true;
  }
  const outcome = dispatchMcp(ctx, body);
  const response: Record<string, unknown> = { jsonrpc: '2.0', id, ...outcome };
  ctx.res.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': ctx.requestId,
    'mcp-protocol-version': MCP_PREFERRED_REVISION,
  });
  ctx.res.end(`${JSON.stringify(response)}\n`);
  return true;
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

let requestCounter = 0;

/** Read the whole request body (up to 64 MiB: a git pack is the largest body the suite sends). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new StoreImpl();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      let body: Buffer;
      try {
        body = await readBody(req);
      } catch {
        res.writeHead(400, {
          'content-type': 'application/json; charset=utf-8',
          'x-github-request-id': `req-${(++requestCounter).toString(16).padStart(8, '0')}`,
        });
        res.end(`${JSON.stringify({ message: 'Problems reading the request body' })}\n`);
        return;
      }
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://entry');
      } catch {
        url = new URL('/', 'http://entry');
      }
      const segments = url.pathname
        .split('/')
        .filter((segment) => segment !== '')
        .map((segment) => {
          try {
            return decodeURIComponent(segment);
          } catch {
            return segment;
          }
        });
      const authorization = req.headers.authorization ?? '';
      const token = authorization.startsWith('Bearer ') && authorization.slice(7) !== '' ? authorization.slice(7) : null;
      const ctx: HandlerCtx = {
        req,
        res,
        store,
        body,
        token,
        requestId: `req-${(++requestCounter).toString(16).padStart(8, '0')}`,
        segments,
        query: url.searchParams,
      };
      try {
        const method = req.method ?? 'GET';
        const path = url.pathname;
        if (method === 'GET' && path === '/healthz') {
          sendJson(ctx, 200, { ok: true });
          return;
        }
        if (handleGit(ctx)) return;
        if (handleRest(ctx)) return;
        if (handleGraphql(ctx)) return;
        if (handleMcp(ctx)) return;
        sendJson(ctx, 404, { message: 'Not Found' });
      } catch (err) {
        // Never let a handler crash the connection: answer a JSON 500.
        if (!res.headersSent) {
          sendJson(ctx, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.end();
        }
      }
    })();
  });
}
