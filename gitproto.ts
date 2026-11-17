// gitproto.ts — the git smart-HTTP wire: pkt-line codec, packfile read/write, and the
// upload-pack (v2 + v0) / receive-pack (v0) handlers. Plain packs only (no deltas on
// send); the reader resolves OFS_DELTA and REF_DELTA too, so any client pack parses.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  collectReachable,
  hashObject,
  parseCommit,
  parseTag,
  type GitObject,
  type GitObjectType,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

const PKT_LINE_MAX = 65520;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_LINE_MAX) throw new Error('pkt-line payload too long');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(items: ReadonlyArray<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines. Trailing raw bytes (a pack) are returned as `raw`. */
export function decodePktLines(buf: Buffer): { packets: Pkt[]; raw: Buffer } {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) break; // raw pack bytes follow
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length < 4 || length > PKT_LINE_MAX || offset + length > buf.length) {
      break;
    } else {
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return { packets, raw: buf.subarray(offset) };
}

/** The text lines of the data packets, control packets dropped. */
export function pktTextLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// packfile
// ---------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a packfile (version 2) of plain objects, no deltas. */
export function writePack(objects: Iterable<{ type: GitObjectType; data: Buffer }>): Buffer {
  const entries: Buffer[] = [];
  let count = 0;
  for (const object of objects) {
    const data = object.data;
    const type = TYPE_CODE[object.type];
    // varint: low 4 bits of size in the first byte, then 7 bits per byte, MSB set to continue.
    const headerBytes: number[] = [];
    let size = data.length;
    let first = (type << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) {
      headerBytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    headerBytes.push(first);
    const compressed = deflateSync(data, { level: 1 });
    entries.push(Buffer.concat([Buffer.from(headerBytes), compressed]));
    count += 1;
  }
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(count, 8);
  const body = Buffer.concat([header, ...entries]);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Adler-32 (the checksum a zlib stream ends with), over the inflated data. */
function adler32(data: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; i += 1) {
    a = (a + data[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/**
 * Find the exact length of the zlib stream starting at `offset`. inflateSync ignores
 * trailing bytes, so one inflate of the whole tail gives the output; the stream ends with
 * the Adler-32 of that output, which pins the end (verified by a second inflate of the
 * exact prefix). Falls back to a binary search when the checksum is not found.
 */
function zlibStreamLength(buf: Buffer, offset: number, wantLen: number): number {
  const out = inflateSync(buf.subarray(offset));
  if (out.length !== wantLen) throw new Error('pack object size mismatch');
  const needle = Buffer.alloc(4);
  needle.writeUInt32BE(adler32(out), 0);
  let pos = buf.indexOf(needle, offset + 2);
  while (pos >= 0) {
    const end = pos + 4;
    try {
      if (inflateSync(buf.subarray(offset, end)).length === wantLen) return end - offset;
    } catch {
      // Not the true end; keep scanning for the next occurrence.
    }
    pos = buf.indexOf(needle, pos + 1);
  }
  let lo = offset;
  let hi = buf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      const attempt = inflateSync(buf.subarray(offset, mid));
      if (attempt.length === wantLen) hi = mid;
      else lo = mid + 1;
    } catch {
      lo = mid + 1;
    }
  }
  return lo - offset;
}

/** Apply a git delta to a base object, returning the result. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readDeltaVarint();
  const targetSize = readDeltaVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          offset |= delta[pos] << (i * 8);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          size |= delta[pos] << (i * 8);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      parts.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta result size mismatch');
  return out;
}

/** Read a packfile. Returns the objects keyed by oid, in pack order. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const expected = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(expected)) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const first = pack[offset];
    const typeNum = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while (pack[offset - 1] & 0x80) {
      size |= (pack[offset] & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    let type: GitObjectType;
    let data: Buffer;
    if (typeNum === 6) {
      // OFS_DELTA: negative-offset varint, then the delta.
      let byte = pack[offset];
      offset += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      const base = byOffset.get(entryOffset - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base not found');
      const compressedLen = zlibStreamLength(pack, offset, size);
      const delta = inflateSync(pack.subarray(offset, offset + compressedLen));
      offset += compressedLen;
      data = applyDelta(base.data, delta);
      type = base.type;
    } else if (typeNum === 7) {
      // REF_DELTA: 20-byte base oid, then the delta.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = objects.get(baseOid);
      if (base === undefined) throw new Error('ref-delta base not found');
      const compressedLen = zlibStreamLength(pack, offset, size);
      const delta = inflateSync(pack.subarray(offset, offset + compressedLen));
      offset += compressedLen;
      data = applyDelta(base.data, delta);
      type = base.type;
    } else {
      type = CODE_TYPE[typeNum] as GitObjectType;
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      const compressedLen = zlibStreamLength(pack, offset, size);
      data = inflateSync(pack.subarray(offset, offset + compressedLen));
      offset += compressedLen;
      if (data.length !== size) throw new Error('pack object size mismatch');
    }
    const oid = hashObject(type, data);
    const object: GitObject = { type, data };
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
  }
  return objects;
}

// ---------------------------------------------------------------------------------------------
// Smart HTTP
// ---------------------------------------------------------------------------------------------

import { VIEWER_LOGIN, sendBuffer, sendJson, type HandlerCtx, type Store } from './store.ts';

/** A ref line for advertisements: {oid, name, peeled?}. */
interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs of a repo, sorted by name, with HEAD first where it applies. */
function listRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = repo.objects.get(target);
      if (targetObject !== undefined && targetObject.type === 'commit') line.peeled = target;
    }
    lines.push(line);
  }
  return lines;
}

/** Resolve a tag oid to its commit oid (following tag chains), or the oid itself. */
function peelToCommit(repo: Repo, oid: string): string {
  let current = oid;
  for (let i = 0; i < 8; i += 1) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

const UPLOAD_V2_CAPS = ['agent=makefun-forge/1.0', 'ls-refs', 'fetch=shallow', 'object-format=sha1'];
const UPLOAD_V0_CAPS = 'side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/main agent=makefun-forge/1.0';
const RECEIVE_V0_CAPS = 'report-status side-band-64k delete-refs agent=makefun-forge/1.0';

function v2Advertisement(): Buffer {
  const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', 'flush', 'version 2\n'];
  for (const cap of UPLOAD_V2_CAPS) lines.push(`${cap}\n`);
  lines.push('flush');
  return pktLines(lines);
}

function v0Advertisement(service: 'git-upload-pack' | 'git-receive-pack', repo: Repo): Buffer {
  const refs = listRefs(repo);
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const headLine = headTip === undefined ? null : `${headTip} HEAD\0${caps}\n`;
    if (headLine !== null) parts.push(pktLine(headLine));
    let first = headLine === null;
    for (const ref of refs) {
      const line = first ? `${ref.oid} ${ref.name}\0${caps}\n` : `${ref.oid} ${ref.name}\n`;
      first = false;
      parts.push(pktLine(line));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface FetchParams {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

interface FetchPlan {
  objects: GitObject[];
  shallowOut: string[];
  unshallowOut: string[];
}

/** Resolve a want oid to its commit oid (tags peel to their commit). */
function wantCommit(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') return peelToCommit(repo, oid);
  return null;
}

/**
 * Work out which objects a fetch must send. The rules, per the protocol:
 * - commits within `depth` of the wants (depth 1 = the wants themselves),
 * - minus the commits the client already holds (reachable from haves), except that a
 *   have listed as a shallow boundary only excludes itself, not its ancestry (deepen),
 * - objects are the full closure of the sent commits, minus the full closure of the haves.
 */
function planFetch(repo: Repo, params: FetchParams): FetchPlan {
  const depth = params.depth ?? Infinity;
  const shallowSet = new Set(params.shallow);
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Commits within depth of the wants, with their depth from the nearest want.
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  for (const want of params.wants) {
    const commit = wantCommit(repo, want);
    if (commit !== null) queue.push({ oid: commit, depth: 1 });
  }
  let head = 0;
  while (head < queue.length) {
    const { oid, depth: d } = queue[head]!;
    head += 1;
    if (commitDepth.has(oid) || d > depth) continue;
    commitDepth.set(oid, d);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!commitDepth.has(parent)) queue.push({ oid: parent, depth: d + 1 });
    }
  }
  // Commits the client already holds.
  const heldCommits = new Set<string>();
  for (const have of params.haves) {
    if (shallowSet.has(have)) {
      heldCommits.add(have);
    } else {
      for (const oid of collectReachable([have], (o) => repo.objects.get(o))) {
        const object = repo.objects.get(oid);
        if (object !== undefined && object.type === 'commit') heldCommits.add(oid);
      }
    }
  }
  // Objects the client already holds. A normal have carries its full closure; a have listed
  // as a shallow boundary carries only itself and its own tree — its ancestry is exactly
  // what a deepen is asking for, so it must not be treated as held.
  const heldObjects = new Set<string>();
  for (const have of params.haves) {
    if (shallowSet.has(have)) {
      heldObjects.add(have);
      const object = repo.objects.get(have);
      if (object !== undefined && object.type === 'commit') {
        for (const oid of collectReachable([parseCommit(object.data).tree], lookup)) heldObjects.add(oid);
      }
    } else {
      for (const oid of collectReachable([have], lookup)) heldObjects.add(oid);
    }
  }
  const sendCommits = [...commitDepth.keys()].filter((oid) => !heldCommits.has(oid));
  const sendObjects = new Map<string, GitObject>();
  const treeRoots: string[] = [];
  for (const oid of sendCommits) {
    const object = repo.objects.get(oid);
    if (object !== undefined) sendObjects.set(oid, object);
    if (object !== undefined && object.type === 'commit') treeRoots.push(parseCommit(object.data).tree);
  }
  // The trees/blobs of the sent commits only: a depth-limited fetch must not carry the
  // trees of commits beyond the depth (collectReachable from a commit would follow parents).
  for (const oid of collectReachable(treeRoots, lookup)) {
    if (heldObjects.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object !== undefined) sendObjects.set(oid, object);
  }
  // Tag objects named directly by a want are sent even when their commit is held.
  for (const want of params.wants) {
    const object = repo.objects.get(want);
    if (object !== undefined && object.type === 'tag' && !heldObjects.has(want)) {
      sendObjects.set(want, object);
    }
  }
  const boundary = new Set([...commitDepth.entries()].filter(([, d]) => d === depth).map(([oid]) => oid));
  const shallowOut = [...boundary].filter((oid) => sendCommits.includes(oid)).sort();
  const unshallowOut = params.shallow
    .filter((oid) => {
      if (!commitDepth.has(oid)) return false;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') return false;
      return parseCommit(object.data).parents.every((parent) => commitDepth.has(parent));
    })
    .sort();
  return { objects: [...sendObjects.values()], shallowOut, unshallowOut };
}

/** Split a pack into sideband packets (band 1), each a pkt-line of at most 32 KiB of data. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const piece = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const framed = Buffer.concat([Buffer.from([1]), piece]);
    parts.push(pktLine(framed));
  }
  return Buffer.concat(parts);
}

/** A tiny cache for fetch packs: the same (repo, wants, haves, depth, shallow) always packs the same bytes. */
const fetchPackCache = new Map<string, { pack: Buffer | null; shallowOut: string[]; unshallowOut: string[] }>();
const FETCH_CACHE_MAX = 64;

function fetchPack(repo: Repo, params: FetchParams): { pack: Buffer | null; shallowOut: string[]; unshallowOut: string[] } {
  const key = `${repo.owner}/${repo.name}|${[...params.wants].sort().join(',')}|${[...params.haves].sort().join(',')}|${[...params.shallow].sort().join(',')}|${params.depth ?? ''}`;
  const cached = fetchPackCache.get(key);
  if (cached !== undefined) return cached;
  const plan = planFetch(repo, params);
  const pack = plan.objects.length === 0 ? null : writePack(plan.objects);
  const result = { pack, shallowOut: plan.shallowOut, unshallowOut: plan.unshallowOut };
  if (fetchPackCache.size >= FETCH_CACHE_MAX) fetchPackCache.clear();
  fetchPackCache.set(key, result);
  return result;
}

/** Parse the lines of a v2 fetch request body. */
function parseV2Fetch(lines: string[]): FetchParams {
  const params: FetchParams = { wants: [], haves: [], shallow: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'command=fetch') continue;
    if (line === '') continue;
    if (line.startsWith('agent=') || line.startsWith('object-format=')) continue;
    if (line === 'thin-pack' || line === 'no-progress' || line === 'ofs-delta') continue;
    if (line.startsWith('filter ')) continue;
    if (line.startsWith('want ')) params.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) params.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) params.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) params.depth = Number.parseInt(line.slice(7).trim(), 10);
    else if (line.startsWith('deepen-since ') || line.startsWith('deepen-not ')) {
      // Not supported: treat as no depth limit beyond what deepen says.
    } else if (line === 'done') {
      // End of the argument section.
    }
  }
  return params;
}

/** Parse the lines of a v0 fetch request body. */
function parseV0Fetch(lines: string[]): FetchParams {
  const params: FetchParams = { wants: [], haves: [], shallow: [] };
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      params.wants.push(rest.split(' ')[0]);
    } else if (line.startsWith('have ')) params.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) params.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) params.depth = Number.parseInt(line.slice(7).trim(), 10);
  }
  return params;
}

function v2FetchResponse(repo: Repo, params: FetchParams): Buffer {
  const { pack, shallowOut, unshallowOut } = fetchPack(repo, params);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim());
  if (shallowOut.length > 0 || unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (pack !== null) {
    parts.push(pktLine('packfile\n'), sidebandPack(pack));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v0FetchResponse(repo: Repo, params: FetchParams): Buffer {
  const { pack, shallowOut, unshallowOut } = fetchPack(repo, params);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  if (pack !== null) parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** Handle one ls-refs (v2) request body, returning the response bytes. */
function lsRefsResponse(repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const refs = listRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (headTip !== undefined && keep('HEAD')) {
    const target = symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : '';
    parts.push(pktLine(`${headTip} HEAD${target}\n`));
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    const peeled = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
    parts.push(pktLine(`${ref.oid} ${ref.name}${peeled}\n`));
  }
  if (refs.length === 0 && prefixes.length === 0) {
    // An unborn repository advertises nothing (no unborn lines: the empty-clone check
    // requires zero refs/ entries).
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** The receive-pack report, pkt-lined inside band-1 sideband packets. */
function pushReportResponse(results: Array<{ ref: string; ok: boolean; reason: string }>, unpackOk: boolean, unpackDetail: string): Buffer {
  const lines: string[] = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const result of results) {
    lines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const report = pktLines(lines);
  return Buffer.concat([sidebandPack(report), pktFlush()]);
}

/**
 * Handle a git smart-HTTP request. Returns true when the path is a git route (the
 * response has been sent), false when the caller should try the next router.
 */
export function handleGit(ctx: HandlerCtx): boolean {
  const segments = ctx.segments;
  if (segments.length < 2) return false;
  if (!segments[1].endsWith('.git')) return false;
  const repoName = segments[1].slice(0, -4);
  const owner = segments[0];
  const repo = ctx.store.getRepo(owner, repoName);
  const method = ctx.req.method ?? 'GET';

  // The info/refs path is /{owner}/{repo}.git/info/refs (4 segments).
  if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
    const service = ctx.query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(ctx, 400, { message: 'missing or unknown service' });
      return true;
    }
    if (repo === undefined || owner !== VIEWER_LOGIN) {
      sendJson(ctx, 404, { message: 'Not Found' });
      return true;
    }
    const contentType =
      service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
    if (service === 'git-upload-pack' && ctx.req.headers['git-protocol'] === 'version=2') {
      sendBuffer(ctx, 200, contentType, v2Advertisement());
    } else {
      sendBuffer(ctx, 200, contentType, v0Advertisement(service, repo));
    }
    return true;
  }

  if (segments.length === 3 && (segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack') && method === 'POST') {
    const service = segments[2] as 'git-upload-pack' | 'git-receive-pack';
    if (repo === undefined || owner !== VIEWER_LOGIN) {
      sendJson(ctx, 404, { message: 'Not Found' });
      return true;
    }
    if (service === 'git-upload-pack') {
      handleUploadPack(ctx, repo);
    } else {
      handleReceivePack(ctx, repo);
    }
    return true;
  }
  return false;
}

function handleUploadPack(ctx: HandlerCtx, repo: Repo): void {
  const { packets } = decodePktLines(ctx.body);
  const lines = pktTextLines(packets);
  const isV2 = ctx.req.headers['git-protocol'] === 'version=2';
  const first = (lines[0] ?? '').replace(/\n$/, '');
  if (isV2 || first.startsWith('command=')) {
    if (first === 'command=ls-refs') {
      sendBuffer(ctx, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, lines));
      return;
    }
    if (first === 'command=fetch') {
      const params = parseV2Fetch(lines);
      sendBuffer(ctx, 200, 'application/x-git-upload-pack-result', v2FetchResponse(repo, params));
      return;
    }
    sendBuffer(ctx, 200, 'application/x-git-upload-pack-result', pktLines(['flush']));
    return;
  }
  // v0 fetch.
  const params = parseV0Fetch(lines);
  sendBuffer(ctx, 200, 'application/x-git-upload-pack-result', v0FetchResponse(repo, params));
}

function handleReceivePack(ctx: HandlerCtx, repo: Repo): void {
  const { packets, raw } = decodePktLines(ctx.body);
  const lines = pktTextLines(packets);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const clean = nul >= 0 ? line.slice(0, nul) : line;
    const parts = clean.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (raw.length > 0) {
    try {
      const objects = readPack(raw);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? null;
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === null) {
          results.push({ ref: command.ref, ok: false, reason: 'ref does not exist' });
        } else if (command.oldOid !== current) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== null) {
          results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        } else {
          repo.refs.set(command.ref, command.newOid);
          results.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      // Update: must be a fast-forward from the current tip.
      if (current === null || command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      const store = ctx.store;
      if (!store.isAncestor(repo, current, command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  sendBuffer(ctx, 200, 'application/x-git-receive-pack-result', pushReportResponse(results, unpackOk, unpackDetail));
}
