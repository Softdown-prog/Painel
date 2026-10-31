import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";

export type TlsMaterial = { ca: string; cert: string; key: string; rejectUnauthorized: true };
export type IssuedCertificate = {
  directory: string;
  client: TlsMaterial;
  publish: () => void;
  cleanup: () => void;
};
const ROLE = /^u_[a-z][a-z0-9_]{1,29}$/;
const CERT_ROOT = "/data/postgres-tls";

function checkedFile(path: string, secret: boolean): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o022) !== 0 ||
      (secret && (stat.mode & 0o077) !== 0))
    throw new Error("PostgreSQL TLS file has unsafe permissions");
  return readFileSync(path, "utf8");
}
function tlsDirectory(env: NodeJS.ProcessEnv): string {
  const dir = resolve(env['PANEL_POSTGRES_TLS_DIR'] || CERT_ROOT);
  // Do not permit user-requested paths, symlink escapes or arbitrary file reads.
  if ((dir !== CERT_ROOT && !(env['NODE_ENV'] === "test" && process.env['NODE_ENV'] !== "production")) || !existsSync(dir))
    throw new Error("TLS directory not installed");
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0)
    throw new Error("TLS directory is not private");
  return dir;
}
export function adminTls(env: NodeJS.ProcessEnv): TlsMaterial | undefined {
  if (env['PANEL_POSTGRES_TLS_ENABLED'] !== "1") return;
  const dir = tlsDirectory(env);
  return {
    ca: checkedFile(join(dir, "ca.crt"), false),
    cert: checkedFile(join(dir, "admin.crt"), false),
    key: checkedFile(join(dir, "admin.key"), true),
    rejectUnauthorized: true,
  };
}
export function signerReady(env: NodeJS.ProcessEnv): boolean {
  try {
    const dir = tlsDirectory(env);
    return checkedFile(join(dir, "ca.key"), true).includes("PRIVATE KEY") &&
      Boolean(adminTls(env));
  } catch { return false; }
}
function openssl(args: string[]): void {
  // Never use shell or pass keys on the command line. No command output.
  execFileSync("openssl", args, { timeout: 10000, stdio: "ignore" });
}
export function issueCertificate(
  role: string, dataDir: string, env: NodeJS.ProcessEnv = process.env,
): IssuedCertificate {
  if (!ROLE.test(role)) throw new Error("Invalid PostgreSQL role");
  const tlsDir = tlsDirectory(env);
  // Check signer before creating files. The CA private key is never returned.
  checkedFile(join(tlsDir, "ca.key"), true);
  const ca = checkedFile(join(tlsDir, "ca.crt"), false);
  const root = join(dataDir, "database-credentials");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootInfo = lstatSync(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || (rootInfo.mode & 0o077) !== 0)
    throw new Error("Credential folder is not private");
  const slug = role.slice(2).replaceAll("_", "-");
  const target = join(root, slug);
  if (existsSync(target)) throw new Error("Project credentials already exist");
  const pending = mkdtempSync(join(root, ".pending-"));
  let published = false;
  const cleanup = () => {
    if (!published) rmSync(pending, { recursive: true, force: true });
  };
  try {
    const keyPath = join(pending, "client.key");
    const csrPath = join(pending, "client.csr");
    const crtPath = join(pending, "client.crt");
    const extPath = join(pending, "client.ext");
    writeFileSync(extPath, [
      "basicConstraints=critical,CA:FALSE",
      "keyUsage=critical,digitalSignature",
      "extendedKeyUsage=clientAuth",
      "subjectKeyIdentifier=hash",
      "",
    ].join("\n"), { mode: 0o600 });
    openssl(["req", "-new", "-newkey", "rsa:3072", "-nodes",
      "-keyout", keyPath, "-out", csrPath, "-subj", "/CN=" + role]);
    chmodSync(keyPath, 0o600);
    openssl(["x509", "-req", "-in", csrPath,
      "-CA", join(tlsDir, "ca.crt"), "-CAkey", join(tlsDir, "ca.key"),
      "-set_serial", "0x" + randomBytes(16).toString("hex"),
      "-out", crtPath, "-days", "365", "-sha256", "-extfile", extPath]);
    openssl(["verify", "-CAfile", join(tlsDir, "ca.crt"),
      "-purpose", "sslclient", crtPath]);
    copyFileSync(join(tlsDir, "ca.crt"), join(pending, "ca.crt"));
    // Private key and CA are not exposed through the API or browser.
    writeFileSync(join(pending, "connection.json"), JSON.stringify({
      database: "p_" + role.slice(2), user: role,
      host: env['PANEL_POSTGRES_HOST'] || "vps-postgres",
      port: Number(env['PANEL_POSTGRES_PORT'] || 5432),
      sslMode: "verify-full", authentication: "client-certificate",
      expiresAfterDays: 365,
    }) + "\n", { mode: 0o600 });
    rmSync(csrPath); rmSync(extPath);
    const publish = () => {
      if (published) return;
      if (existsSync(target)) throw new Error("Credentials already published");
      renameSync(pending, target);
      published = true;
    };
    return {
      directory: target,
      client: {
        ca, cert: checkedFile(crtPath, false),
        key: checkedFile(keyPath, true),
        rejectUnauthorized: true,
      },
      publish, cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}
