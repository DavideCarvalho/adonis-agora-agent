/**
 * Skill artifacts from the tasks response's `skill_index` (9.4), fetched and verified as the Agent
 * Skills discovery proposal (revision pinned by the spec) requires: the SHA-256 digest of the raw
 * bytes before anything is used, `.tar.gz` and `.zip` archives with `SKILL.md` at their root, and no
 * path traversal, absolute paths or links leaving the skill directory, within a size limit.
 *
 * Skills are content from the Company (10.1): they grant no access and no approval, and their
 * scripts are never run here.
 */
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import type { CompanyClient } from './company.js';
import { PoppyError } from './errors.js';
import type { SkillEntry } from './types.js';
import { requireSecureUrl } from './util.js';

/** Largest artifact downloaded, and largest total unpacked size, by default (bytes). */
export const DEFAULT_MAX_SKILL_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;

/** A verified skill: `SKILL.md` and, for an archive, its supporting files. */
export interface SkillFiles {
  name: string;
  digest: string;
  /** `SKILL.md`, as text. */
  skillMd: string;
  /** Every file by its path inside the skill directory (`SKILL.md` included). */
  files: Map<string, Uint8Array>;
  /** Symbolic links that stay inside the skill directory: path → target. */
  links: Map<string, string>;
}

export interface FetchSkillOptions {
  /** Default 10 MiB, for the download and for everything unpacked. */
  maxBytes?: number | undefined;
}

/** Verified artifacts by digest: a digest that didn't change isn't downloaded again. */
const cache = new Map<string, SkillFiles>();

/** A skill artifact failed a check: it MUST NOT be used. */
export class SkillVerificationError extends PoppyError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = 'SkillVerificationError';
  }
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new SkillVerificationError('skill_too_large', 'the skill artifact is too large');
  }
  if (!res.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new SkillVerificationError('skill_too_large', 'the skill artifact is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Downloads an artifact with no credentials and no Session header: listing it doesn't make its host
 * an API (9.4). Redirects are followed (the proposal requires it), each to an HTTPS URL on an
 * allowed address (section 3).
 */
async function download(
  company: CompanyClient,
  url: string,
  max: number,
): Promise<{ bytes: Uint8Array; contentType: string; finalUrl: string }> {
  let current = requireSecureUrl(url, 'skill url', company.security);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await company.http.fetch(current.toString(), {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/markdown, text/plain, application/gzip, application/zip, */*' },
    });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      current = requireSecureUrl(
        new URL(location, current).toString(),
        'skill redirect',
        company.security,
      );
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new PoppyError(`http_${res.status}`, `could not fetch the skill at ${current.host}`);
    }
    return {
      bytes: await readCapped(res, max),
      contentType: (res.headers.get('content-type') ?? '').toLowerCase(),
      finalUrl: current.toString(),
    };
  }
  throw new PoppyError('too_many_redirects', 'too many redirects fetching the skill');
}

/** `sha256:` and 64 lowercase hex characters over the raw bytes. */
export function skillDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Fetches a skill from the index and verifies it before returning it: the digest, then for an
 * archive its format, layout and safety. Throws `SkillVerificationError` for anything that fails.
 */
export async function fetchSkill(
  company: CompanyClient,
  skill: SkillEntry,
  opts: FetchSkillOptions = {},
): Promise<SkillFiles> {
  const hit = cache.get(`${skill.digest}|${skill.type}`);
  if (hit) return hit;
  const max = opts.maxBytes ?? DEFAULT_MAX_SKILL_BYTES;
  const { bytes, contentType, finalUrl } = await download(company, skill.url, max);
  if (skillDigest(bytes) !== skill.digest) {
    throw new SkillVerificationError(
      'digest_mismatch',
      `the ${skill.name} skill doesn't match its digest: corrupted or tampered with`,
    );
  }
  let files: Map<string, Uint8Array>;
  let links = new Map<string, string>();
  if (skill.type === 'skill-md') {
    files = new Map([['SKILL.md', bytes]]);
  } else if (skill.type === 'archive') {
    const format = archiveFormat(contentType, finalUrl, bytes);
    const unpacked = format === 'zip' ? unzip(bytes, max) : untarGz(bytes, max);
    files = unpacked.files;
    links = unpacked.links;
  } else {
    throw new SkillVerificationError('unknown_type', `unknown skill type ${String(skill.type)}`);
  }
  const md = files.get('SKILL.md');
  if (!md)
    throw new SkillVerificationError('no_skill_md', 'the archive has no SKILL.md at its root');
  const out: SkillFiles = {
    name: skill.name,
    digest: skill.digest,
    skillMd: new TextDecoder().decode(md),
    files,
    links,
  };
  cache.set(`${skill.digest}|${skill.type}`, out);
  return out;
}

/** From `Content-Type`, then the URL's extension, then the bytes themselves. */
function archiveFormat(contentType: string, url: string, bytes: Uint8Array): 'zip' | 'tar.gz' {
  if (/application\/(x-)?zip/.test(contentType)) return 'zip';
  if (/application\/(x-)?gzip|application\/x-tar\+gzip|application\/x-gtar/.test(contentType)) {
    return 'tar.gz';
  }
  const path = new URL(url).pathname.toLowerCase();
  if (path.endsWith('.zip')) return 'zip';
  if (path.endsWith('.tar.gz') || path.endsWith('.tgz')) return 'tar.gz';
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return 'zip';
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return 'tar.gz';
  throw new SkillVerificationError('unknown_archive', 'the archive is neither .tar.gz nor .zip');
}

/**
 * A path inside the skill directory, normalized; refuses absolute paths and `..` anywhere (the
 * proposal's archive safety, rule 1).
 */
function safePath(raw: string): string {
  const path = raw.replace(/\\/g, '/');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) {
    throw new SkillVerificationError('unsafe_archive', `absolute path in the archive: ${raw}`);
  }
  if (path.split('/').includes('..')) {
    throw new SkillVerificationError('unsafe_archive', `path traversal in the archive: ${raw}`);
  }
  return posix.normalize(path).replace(/^\.\//, '').replace(/\/$/, '');
}

/** A link's target, which must stay inside the skill directory (rule 2). */
function insideLink(path: string, target: string): string {
  if (target.startsWith('/') || /^[A-Za-z]:/.test(target)) {
    throw new SkillVerificationError('unsafe_archive', `link ${path} points outside the skill`);
  }
  const resolved = posix.normalize(posix.join(posix.dirname(path), target));
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new SkillVerificationError('unsafe_archive', `link ${path} points outside the skill`);
  }
  return resolved;
}

interface Unpacked {
  files: Map<string, Uint8Array>;
  links: Map<string, string>;
}

function addFile(out: Unpacked, path: string, data: Uint8Array, total: { n: number }, max: number) {
  total.n += data.byteLength;
  // Rule 3: a limit on the total unpacked size, against decompression bombs.
  if (total.n > max)
    throw new SkillVerificationError('skill_too_large', 'the archive unpacks too large');
  if (path === '' || path === '.') return;
  out.files.set(path, data);
}

function tarString(block: Uint8Array, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return new TextDecoder().decode(end === -1 ? raw : raw.subarray(0, end));
}

function tarNumber(block: Uint8Array, start: number, length: number): number {
  const raw = block.subarray(start, start + length);
  if ((raw[0] ?? 0) & 0x80) {
    // Base-256 (GNU): big sizes; the top bit flags it.
    let n = 0;
    for (let i = 1; i < raw.length; i++) n = n * 256 + (raw[i] ?? 0);
    return n;
  }
  const text = tarString(block, start, length).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/** Pax records (`length key=value\n`). */
function paxRecords(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = new TextDecoder().decode(data);
  let i = 0;
  while (i < text.length) {
    const space = text.indexOf(' ', i);
    if (space === -1) break;
    const len = Number(text.slice(i, space));
    if (!Number.isFinite(len) || len <= 0) break;
    const record = text.slice(space + 1, i + len - 1);
    const eq = record.indexOf('=');
    if (eq !== -1) out[record.slice(0, eq)] = record.slice(eq + 1);
    i += len;
  }
  return out;
}

/** Unpacks a gzip-compressed tar in memory (ustar, pax and GNU long names). */
export function untarGz(bytes: Uint8Array, max = DEFAULT_MAX_SKILL_BYTES): Unpacked {
  let tar: Buffer;
  try {
    tar = gunzipSync(bytes, { maxOutputLength: max + 1024 * 1024 });
  } catch (e) {
    throw new SkillVerificationError('bad_archive', `not a valid .tar.gz: ${(e as Error).message}`);
  }
  const out: Unpacked = { files: new Map(), links: new Map() };
  const total = { n: 0 };
  let offset = 0;
  let longName: string | undefined;
  let longLink: string | undefined;
  let pax: Record<string, string> = {};
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] ?? 0);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    if (data.length < size) throw new SkillVerificationError('bad_archive', 'truncated tar');
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = paxRecords(data);
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') {
      longName = tarString(data, 0, data.length);
      continue;
    }
    if (type === 'K') {
      longLink = tarString(data, 0, data.length);
      continue;
    }
    const prefix = tarString(header, 345, 155);
    const name =
      pax.path ??
      longName ??
      (prefix ? `${prefix}/${tarString(header, 0, 100)}` : tarString(header, 0, 100));
    const linkName = pax.linkpath ?? longLink ?? tarString(header, 157, 100);
    pax = {};
    longName = undefined;
    longLink = undefined;
    const path = safePath(name);
    if (type === '5') continue; // directory
    if (type === '2' || type === '1') {
      // Symlinks and hard links that resolve outside the skill directory are refused (rule 2).
      const target = type === '1' ? safePath(linkName) : insideLink(path, linkName);
      out.links.set(path, target);
      continue;
    }
    if (type === '0' || type === '\0' || type === '7') {
      addFile(out, path, new Uint8Array(data), total, max);
      continue;
    }
    throw new SkillVerificationError(
      'unsafe_archive',
      `unsupported tar entry type ${type} for ${path}`,
    );
  }
  return out;
}

/** Unpacks a zip in memory (stored and deflated entries). */
export function unzip(bytes: Uint8Array, max = DEFAULT_MAX_SKILL_BYTES): Unpacked {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new SkillVerificationError('bad_archive', 'not a valid .zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Unpacked = { files: new Map(), links: new Map() };
  const total = { n: 0 };
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new SkillVerificationError('bad_archive', 'corrupt zip directory');
    }
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLength = buf.readUInt16LE(p + 28);
    const extraLength = buf.readUInt16LE(p + 30);
    const commentLength = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLength);
    p += 46 + nameLength + extraLength + commentLength;
    const path = safePath(name);
    if (name.endsWith('/')) continue;
    if (size > max)
      throw new SkillVerificationError('skill_too_large', 'the archive unpacks too large');
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) {
      throw new SkillVerificationError('bad_archive', 'corrupt zip entry');
    }
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + compressedSize);
    let data: Uint8Array;
    if (method === 0) data = new Uint8Array(raw);
    else if (method === 8) {
      try {
        data = new Uint8Array(inflateRawSync(raw, { maxOutputLength: max + 1 }));
      } catch (e) {
        throw new SkillVerificationError(
          'bad_archive',
          `bad zip entry ${path}: ${(e as Error).message}`,
        );
      }
    } else {
      throw new SkillVerificationError('bad_archive', `unsupported zip compression for ${path}`);
    }
    const mode = (external >>> 16) & 0o170000;
    if (mode === 0o120000) {
      out.links.set(path, insideLink(path, new TextDecoder().decode(data)));
      continue;
    }
    addFile(out, path, data, total, max);
  }
  return out;
}
