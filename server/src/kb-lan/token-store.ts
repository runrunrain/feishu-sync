/** Persistent LAN credentials, deliberately outside config and child argv. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const tokenDigest = (token: string): string => crypto.createHash('sha256').update(token).digest('hex');
export function verifyBearer(header: string | undefined, digests: readonly string[]): boolean {
  const match = /^Bearer (fskb_[A-Za-z0-9_-]{43})$/.exec(header ?? '');
  const actual = Buffer.from(tokenDigest(match?.[1] ?? ''), 'hex');
  let accepted = 0;
  // Always compare every registered digest, including malformed/missing bearer.
  for (const digest of digests) accepted |= Number(crypto.timingSafeEqual(actual, Buffer.from(digest, 'hex')));
  return !!match && accepted !== 0;
}
interface TokenFile { v: 1; tokens: Array<{ id: string; token: string; createdAt: string; label: string }> }
export class LanTokenStore {
  readonly directory: string;
  readonly file: string;
  constructor(readonly dataRoot: string) {
    // Canonicalize the intentionally selected data root (macOS /var and /tmp
    // themselves are system symlinks); secrets and descendants may not redirect.
    this.directory = path.join(fs.realpathSync(dataRoot), 'secrets');
    this.file = path.join(this.directory, 'kb-lan-mcp.json');
  }
  private guard(): void {
    // Reject symlink ancestors, including a redirected secrets directory. No
    // path-based chmod/read through an attacker-controlled link is permitted.
    let current = path.resolve(this.directory);
    const root = path.dirname(this.directory);
    while (true) {
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('kb_lan_secret_unsafe_path');
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
      const parent = path.dirname(current);
      if (current === root || current === parent) break;
      current = parent;
    }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
  }
  private read(): TokenFile {
    this.guard();
    let fd: number;
    try {
      const stat = fs.lstatSync(this.file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new Error('kb_lan_secret_unsafe_file');
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, tokens: [] }; throw e; }
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16_384) throw new Error('kb_lan_secret_unsafe_file');
      fs.fchmodSync(fd, 0o600);
      let result: TokenFile;
      try { result = JSON.parse(fs.readFileSync(fd, 'utf8')) as TokenFile; }
      catch { throw new Error('kb_lan_secret_invalid'); }
      if (!result || result.v !== 1 || !Array.isArray(result.tokens) || result.tokens.length > 16 || !result.tokens.every((t) => t && typeof t.token === 'string' && /^fskb_[A-Za-z0-9_-]{43}$/.test(t.token))) throw new Error('kb_lan_secret_invalid');
      return result;
    } finally { fs.closeSync(fd); }
  }
  private save(value: TokenFile): void {
    this.guard();
    // read() also validates an existing target (symlink/hardlink refusal).
    this.read();
    const temporary = path.join(this.directory, `.kb-lan-${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      try {
        fs.writeFileSync(fd, JSON.stringify(value));
        fs.fchmodSync(fd, 0o600);
        fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      fs.renameSync(temporary, this.file);
      fs.chmodSync(this.file, 0o600);
    }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  ensure(): void { if (!this.read().tokens.length) this.rotate(); }
  rotate(): void {
    this.save({ v: 1, tokens: [{ id: 't1', token: 'fskb_' + crypto.randomBytes(32).toString('base64url'), createdAt: new Date().toISOString(), label: 'default' }] });
  }
  revoke(): void { this.save({ v: 1, tokens: [] }); }
  reveal(): string | null { return this.read().tokens[0]?.token ?? null; }
  masked(): string | null { const t = this.reveal(); return t ? `${t.slice(0, 9)}…${t.slice(-4)}` : null; }
  digests(): string[] { return this.read().tokens.map((t) => tokenDigest(t.token)); }
}
