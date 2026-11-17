// store.ts — the forge's in-memory store: repositories, git objects, refs, issues,
// pull requests, labels and comments. Everything is deterministic: no clock, no
// randomness. A monotonic sequence feeds every created_at/updated_at/merged_at, so two
// runs that see the same requests in the same order produce the same state.
//
// The viewer is the trial scenario's fixed token owner (the kit's wire.ts builds its
// scenario from a fixed seed, so the login is the same in every trial): adaiversen.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0'.repeat(40);
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

/** The identity written on commits the forge itself creates (contents API, merges). */
export const FORGE_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;

/** Base epoch for deterministic timestamps: 2025-01-01T00:00:00Z, plus one second per mutation. */
const TIME_BASE_SEC = 1735689600;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${body.length}\0`, 'utf8'));
  hash.update(body);
  return hash.digest('hex');
}

function isHex40(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Parse a tree object into its entries, in the object's stored order. */
export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > buffer.length) throw new Error('tree entry is truncated');
    const mode = buffer.subarray(offset, space).toString('ascii');
    const name = buffer.subarray(space + 1, nul).toString('utf8');
    const oid = buffer.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** git's tree-entry sort: byte order of the name, a directory compared as if it ended in '/'. */
function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

/** Build a tree object from entries; entries are sorted the way git sorts them. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a commit object. Headers before the blank line are read; unknown ones are dropped. */
export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerPart = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerPart.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object. The message is stored exactly as given (callers add the newline). */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  return Buffer.from(`${lines.join('\n')}\n\n${fields.message}`, 'utf8');
}

/** Parse an annotated tag object. */
export function parseTag(data: Uint8Array): { object: string; type: string; tag: string; tagger: string; message: string } {
  const text = Buffer.from(data).toString('utf8');
  const blank = text.indexOf('\n\n');
  const headerPart = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of headerPart.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message };
}

/** Build an annotated tag object. */
export function buildTag(fields: { object: string; type: string; tag: string; tagger: string; message: string; timestamp: number }): Buffer {
  return Buffer.from(
    `object ${fields.object}\ntype ${fields.type}\ntag ${fields.tag}\ntagger ${fields.tagger} ${fields.timestamp} +0000\n\n${fields.message}`,
    'utf8',
  );
}

/** The object ids reachable from `tips`, following commits, trees and tags. */
export function collectReachable(
  tips: Iterable<string>,
  lookup: (oid: string) => GitObject | undefined,
): Set<string> {
  const seen = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid) || !isHex40(oid)) continue;
    const object = lookup(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      for (const parent of commit.parents) stack.push(parent);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) stack.push(entry.oid);
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

/** The commit ids reachable from `tip`, following parents only (newest first). */
export function collectAncestors(tip: string, lookup: (oid: string) => GitObject | undefined): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const queue = [tip];
  let head = 0;
  while (head < queue.length) {
    const oid = queue[head]!;
    head += 1;
    if (seen.has(oid) || !isHex40(oid)) continue;
    const object = lookup(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

/** The best common ancestor of two commits (the first ancestor of `b` that is also an ancestor of `a`). */
export function mergeBase(
  a: string,
  b: string,
  lookup: (oid: string) => GitObject | undefined,
): string | null {
  const ancestorsA = new Set(collectAncestors(a, lookup));
  for (const oid of collectAncestors(b, lookup)) {
    if (ancestorsA.has(oid)) return oid;
  }
  return null;
}

/** Flatten a tree into path -> {mode, oid}, following nested trees. */
export function flattenTree(
  objects: Map<string, GitObject>,
  treeOid: string,
  prefix = '',
  out: Map<string, { mode: string; oid: string }> = new Map(),
): Map<string, { mode: string; oid: string }> {
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') {
      flattenTree(objects, entry.oid, path, out);
    } else {
      out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  }
  return out;
}

/**
 * Build nested tree objects from a flat path map, storing every intermediate tree in
 * `objects`. Returns the root tree's oid.
 */
export function buildTreeFromMap(objects: Map<string, GitObject>, flat: Map<string, { mode: string; oid: string }>): string {
  interface Node {
    files: Map<string, { mode: string; oid: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of flat) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      const name = segments[i];
      if (!node.dirs.has(name)) node.dirs.set(name, make());
      node = node.dirs.get(name)!;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    const data = buildTree(entries);
    const oid = hashObject('tree', data);
    if (!objects.has(oid)) objects.set(oid, { type: 'tree', data });
    return oid;
  };
  return build(root);
}

/** The paths that differ between two trees, with their old and new blob oids. */
export function diffTrees(
  objects: Map<string, GitObject>,
  oldTreeOid: string | null,
  newTreeOid: string | null,
): Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> {
  const oldMap = oldTreeOid === null ? new Map() : flattenTree(objects, oldTreeOid);
  const newMap = newTreeOid === null ? new Map() : flattenTree(objects, newTreeOid);
  const paths = new Set([...oldMap.keys(), ...newMap.keys()]);
  const out: Array<{ path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }> = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldMap.get(path);
    const newEntry = newMap.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid });
    }
  }
  return out;
}

/** Added/removed line counts between two texts, by a small LCS on lines. */
export function countLineChanges(oldText: string, newText: string): { additions: number; deletions: number } {
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // LCS table, capped: files in this forge are small; fall back to naive counts when huge.
  if (a.length * b.length > 250_000) return { additions: b.length, deletions: a.length };
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = new Uint32Array(rows * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i * cols + j] = a[i] === b[j] ? dp[(i + 1) * cols + (j + 1)] + 1 : Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
    }
  }
  let additions = 0;
  let deletions = 0;
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) {
      deletions += 1;
      i += 1;
    } else {
      additions += 1;
      j += 1;
    }
  }
  deletions += a.length - i;
  additions += b.length - j;
  return { additions, deletions };
}

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  updatedSeq: number;
  comments: Comment[];
}

export interface Pull {
  number: number;
  id: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdSeq: number;
}

export interface Label {
  name: string;
  color: string;
}

export interface Repo {
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  id: number;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  labels: Map<string, Label>;
  nextNumber: number;
  nextCommentId: number;
}

/** A global id for GraphQL: opaque base64 over a typed key, stable across reads. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class Store {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private seq = 0;

  /** The next deterministic timestamp (ISO, one second per mutation after the base epoch). */
  now(): string {
    this.seq += 1;
    return new Date((TIME_BASE_SEC + this.seq) * 1000).toISOString();
  }

  /** The current sequence value, for ordering lists (creation order, newest last). */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    const repo: Repo = {
      owner,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      id: this.nextRepoId,
      createdSeq: this.tick(),
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    return [...this.repos.values()]
      .filter((repo) => repo.owner === owner)
      .sort((a, b) => a.createdSeq - b.createdSeq);
  }

  /** Store one object (idempotent); returns its oid. */
  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Create a commit object in the repo and return its oid. */
  makeCommit(
    repo: Repo,
    fields: { tree: string; parents: readonly string[]; message: string },
  ): string {
    const timestamp = TIME_BASE_SEC + this.tick();
    const data = buildCommit({
      tree: fields.tree,
      parents: fields.parents,
      message: fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`,
      author: FORGE_IDENTITY,
      committer: FORGE_IDENTITY,
      timestamp,
    });
    return this.putObject(repo, 'commit', data);
  }

  /** The tip of a ref, or null when the ref does not exist. */
  refTip(repo: Repo, ref: string): string | null {
    return repo.refs.get(ref) ?? null;
  }

  /** The tip of the default branch, or null for an unborn repository. */
  defaultTip(repo: Repo): string | null {
    return this.refTip(repo, `refs/heads/${repo.defaultBranch}`);
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). Stops as soon as it is found. */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid) || !isHex40(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /** The tree oid of a commit, or null when the commit is unknown. */
  commitTree(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (object === undefined || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** Create an issue; returns null when a named label does not exist. */
  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue | null {
    for (const label of labels) {
      if (!repo.labels.has(label)) return null;
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const seq = this.tick();
    const issue: Issue = {
      number,
      id: repo.id * 1_000_000 + number,
      title,
      body: body ?? '',
      state: 'open',
      labels: [...labels],
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    repo.issues.set(number, issue);
    return issue;
  }

  /** Create a pull request; returns null when the head branch is missing or an open PR from it exists. */
  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) return null;
    for (const pull of repo.pulls.values()) {
      if (pull.head === head && pull.state === 'open') return null;
    }
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pull: Pull = {
      number,
      id: repo.id * 1_000_000 + number,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      createdSeq: this.tick(),
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /**
   * Squash-merge a pull request. Returns the merge commit's oid, or null when the pull
   * cannot merge (conflicted, already closed, or a branch moved).
   */
  squashMerge(repo: Repo, pull: Pull): string | null {
    if (pull.state !== 'open') return null;
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return null;
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    if (base === null) return null;
    const baseTree = this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    const currentTree = this.commitTree(repo, baseTip);
    if (baseTree === null || headTree === null || currentTree === null) return null;
    const headChanges = diffTrees(repo.objects, baseTree, headTree);
    const baseFlat = flattenTree(repo.objects, currentTree);
    const mergeBaseFlat = flattenTree(repo.objects, baseTree);
    // Three-way conflict check: a path both sides changed differently since the merge-base.
    for (const change of headChanges) {
      const mb = mergeBaseFlat.get(change.path);
      const cur = baseFlat.get(change.path);
      const mbOid = mb === undefined ? null : mb.oid;
      const curOid = cur === undefined ? null : cur.oid;
      const headOid = change.newOid;
      if (mbOid !== curOid && mbOid !== headOid && curOid !== headOid) return null;
    }
    const merged = new Map(baseFlat);
    for (const change of headChanges) {
      if (change.newOid === null) merged.delete(change.path);
      else merged.set(change.path, { mode: '100644', oid: change.newOid });
    }
    const newTree = buildTreeFromMap(repo.objects, merged);
    const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
    const mergeSha = this.makeCommit(repo, { tree: newTree, parents: [baseTip], message });
    repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.now();
    pull.mergeCommitSha = mergeSha;
    return mergeSha;
  }

  /** Whether a pull request would merge cleanly right now. */
  isMergeable(repo: Repo, pull: Pull): boolean {
    if (pull.state !== 'open') return false;
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return false;
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    if (base === null) return false;
    const baseTree = this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    const currentTree = this.commitTree(repo, baseTip);
    if (baseTree === null || headTree === null || currentTree === null) return false;
    const headChanges = diffTrees(repo.objects, baseTree, headTree);
    const baseFlat = flattenTree(repo.objects, currentTree);
    const mergeBaseFlat = flattenTree(repo.objects, baseTree);
    for (const change of headChanges) {
      const mb = mergeBaseFlat.get(change.path);
      const cur = baseFlat.get(change.path);
      const mbOid = mb === undefined ? null : mb.oid;
      const curOid = cur === undefined ? null : cur.oid;
      if (mbOid !== curOid && mbOid !== change.newOid && curOid !== change.newOid) return false;
    }
    return true;
  }

  /** The changed files of a pull request (merge-base -> head), with line counts. */
  pullFiles(repo: Repo, pull: Pull): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (headTip === undefined || baseTip === undefined) return [];
    const base = mergeBase(headTip, baseTip, (oid) => repo.objects.get(oid));
    if (base === null) return [];
    const baseTree = this.commitTree(repo, base);
    const headTree = this.commitTree(repo, headTip);
    if (baseTree === null || headTree === null) return [];
    const out: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const change of diffTrees(repo.objects, baseTree, headTree)) {
      const oldText = change.oldOid === null ? '' : (repo.objects.get(change.oldOid)?.data.toString('utf8') ?? '');
      const newText = change.newOid === null ? '' : (repo.objects.get(change.newOid)?.data.toString('utf8') ?? '');
      const { additions, deletions } = countLineChanges(oldText, newText);
      const status = change.status === 'added' ? 'added' : change.status === 'removed' ? 'removed' : 'modified';
      out.push({ filename: change.path, status, additions, deletions, changes: additions + deletions });
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Shared HTTP plumbing for the route handlers
// ---------------------------------------------------------------------------------------------

import type { IncomingMessage, ServerResponse } from 'node:http';

export interface HandlerCtx {
  req: IncomingMessage;
  res: ServerResponse;
  store: Store;
  /** The request body, read whole (empty for requests without one). */
  body: Buffer;
  /** The bearer token from the Authorization header, or null when absent. */
  token: string | null;
  /** A per-request id, echoed as X-GitHub-Request-Id on every reply. */
  requestId: string;
  /** The request path, split into decoded segments (no leading/trailing empty parts). */
  segments: string[];
  /** The parsed query string. */
  query: URLSearchParams;
}

const JSON_TYPE = 'application/json; charset=utf-8';

/** Answer with a JSON body. */
export function sendJson(ctx: HandlerCtx, status: number, value: unknown, extra: Record<string, string> = {}): void {
  const text = `${JSON.stringify(value)}\n`;
  ctx.res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(text);
}

/** Answer with raw bytes and an explicit content type. */
export function sendBuffer(ctx: HandlerCtx, status: number, contentType: string, body: Buffer, extra: Record<string, string> = {}): void {
  ctx.res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': ctx.requestId,
    ...extra,
  });
  ctx.res.end(body);
}

/** Parse the request body as JSON. Returns undefined when the body is empty. Throws on malformed JSON. */
export function parseJsonBody(ctx: HandlerCtx): unknown {
  if (ctx.body.length === 0) return undefined;
  return JSON.parse(ctx.body.toString('utf8'));
}

/** True when `value` is a plain JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The ISO-8601 timestamp of tick `seq` on the store's deterministic clock. */
export function timeIso(seq: number): string {
  return new Date((TIME_BASE_SEC + seq) * 1000).toISOString();
}
