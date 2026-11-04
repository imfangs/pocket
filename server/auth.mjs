import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { AppError } from "./store.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");
const equal = (a, b) =>
  typeof a === "string" &&
  typeof b === "string" &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const cookieName = "navigator_session";
export class AccessControl {
  constructor(directory, db, options = {}) {
    const minimum = options.minimumPassphraseLength === undefined ? 4 : options.minimumPassphraseLength;
    if (!Number.isInteger(minimum) || minimum < 4 || minimum > 128) throw new Error("Invalid Pocket passphrase policy");
    this.minimumPassphraseLength = minimum;
    this.db = db;
    this.configPath = join(directory, "access.json");
    this.passphrasePath = join(directory, "initial-passphrase.txt");
    this.failures = new Map();
    this.globalFailures = [];
    db.exec(
      "CREATE TABLE IF NOT EXISTS auth_sessions(token_hash TEXT PRIMARY KEY,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL)",
    );
    if (!existsSync(this.configPath))
      this.setPassphrase(randomBytes(Math.max(9, Math.ceil(minimum * 3 / 4))).toString("base64url"));
    this.config();
  }
  config() {
    let c;
    try { c = JSON.parse(readFileSync(this.configPath, "utf8")); }
    catch { throw new Error("登录配置损坏，保持拒绝访问"); }
    if (
      !c || typeof c !== "object" || Array.isArray(c) || c.version !== 1 ||
      typeof c.salt !== "string" || !c.salt ||
      typeof c.hash !== "string" || !/^[a-f0-9]{64}$/.test(c.hash) ||
      typeof c.localToken !== "string" || !/^[a-f0-9]{64}$/.test(c.localToken) ||
      c.passwordPolicyMinimum !== undefined && (!Number.isInteger(c.passwordPolicyMinimum) || c.passwordPolicyMinimum < 4 || c.passwordPolicyMinimum > 128)
    )
      throw new Error("登录配置损坏，保持拒绝访问");
    return c;
  }
  get localToken() {
    return this.config().localToken;
  }
  setPassphrase(passphrase) {
    if (
      typeof passphrase !== "string" ||
      passphrase.trim().length < this.minimumPassphraseLength ||
      passphrase.length > 128
    )
      throw new AppError(`口令需为 ${this.minimumPassphraseLength}–128 个字符`);
    const value = passphrase.trim(),
      salt = randomBytes(16).toString("hex");
    const old = existsSync(this.configPath) ? this.config() : null;
    const c = {
      version: 1,
      passwordPolicyMinimum: this.minimumPassphraseLength,
      salt,
      hash: scryptSync(value, salt, 32).toString("hex"),
      localToken: old?.localToken || randomBytes(32).toString("hex"),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this.configPath + ".tmp", JSON.stringify(c), { mode: 0o600 });
    renameSync(this.configPath + ".tmp", this.configPath);
    chmodSync(this.configPath, 0o600);
    writeFileSync(this.passphrasePath, value + "\n", { mode: 0o600 });
    chmodSync(this.passphrasePath, 0o600);
    this.db.prepare("DELETE FROM auth_sessions").run();
    if (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_devices'").get()) {
      this.db.prepare("DELETE FROM push_devices").run();
      this.db.prepare("DELETE FROM push_deliveries").run();
    }
  }
  cookieToken(req) {
    const raw = String(req.headers.cookie || "")
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    return raw && /^[a-f0-9]{64}$/.test(raw) ? raw : null;
  }
  authenticate(req, localBearerAllowed = false) {
    if (
      localBearerAllowed &&
      equal(req.headers.authorization, `Bearer ${this.localToken}`)
    )
      return true;
    const token = this.cookieToken(req);
    if (!token) return false;
    const row = this.db
      .prepare("SELECT expires_at FROM auth_sessions WHERE token_hash=?")
      .get(digest(token));
    return !!row && row.expires_at > Date.now();
  }
  login(passphrase, ip) {
    const now = Date.now(),
      windowMs = 15 * 60 * 1000;
    this.globalFailures = this.globalFailures.filter((t) => t > now - windowMs);
    for (const [k, times] of this.failures) {
      const current = times.filter((t) => t > now - windowMs);
      if (!current.length) this.failures.delete(k);
      else this.failures.set(k, current);
    }
    const failures = this.failures.get(ip) || [];
    if (failures.length >= 10 || this.globalFailures.length >= 60)
      throw new AppError("尝试次数过多，请 15 分钟后再试", 429);
    const c = this.config();
    const valid =
      typeof passphrase === "string" &&
      passphrase.length <= 128 &&
      equal(scryptSync(passphrase.trim(), c.salt, 32).toString("hex"), c.hash);
    if (!valid) {
      this.failures.set(ip, [...failures, now]);
      this.globalFailures.push(now);
      throw new AppError("口令不正确", 401);
    }
    this.failures.delete(ip);
    const token = randomBytes(32).toString("hex"),
      expiresAt = now + 7 * 24 * 60 * 60 * 1000;
    this.db.prepare("DELETE FROM auth_sessions WHERE expires_at<=?").run(now);
    this.db
      .prepare("INSERT INTO auth_sessions VALUES(?,?,?)")
      .run(digest(token), expiresAt, now);
    return { token, expiresAt };
  }
  logout(req) {
    const token = this.cookieToken(req);
    if (token)
      this.db
        .prepare("DELETE FROM auth_sessions WHERE token_hash=?")
        .run(digest(token));
  }
  cookie(token, secure = true) {
    return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${token ? 604800 : 0}${secure ? "; Secure" : ""}`;
  }
}

export function readConnection(directory) {
  try {
    const c = JSON.parse(
      readFileSync(join(directory, "connection.json"), "utf8"),
    );
    if (!c || typeof c !== "object" || Array.isArray(c) || typeof c.publicOrigin !== "string") throw new Error("Invalid connection");
    const url = new URL(c.publicOrigin);
    if (
      url.protocol === "https:" &&
      /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname) &&
      !url.username && !url.password && !url.port && !url.search && !url.hash && url.pathname === "/"
    )
      return { ...c, publicOrigin: url.origin };
  } catch {}
  return { publicOrigin: null, temporary: true, connected: false };
}
