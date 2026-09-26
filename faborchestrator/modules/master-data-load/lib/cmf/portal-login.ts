/**
 * CMF AuthPortal login — the in-app port of the token Lambda's minting step
 * (lambda/cmf-token → Entegris/DataLoader/cmf-auth-lambda/get-cmf-token.mjs).
 *
 * The CMF AuthPortal does not accept an OAuth2 password grant (the token
 * endpoint answers 401 from IIS) and the login page is a SPA whose calls are
 * built at runtime, so the only known way to mint the MES API JWT is to drive
 * the real login in a headless Chromium — exactly what the Lambda did. This
 * file keeps that flow step for step:
 *
 *   1. open the base URL (it redirects to AuthPortal on :9091)
 *   2. username → "Next"
 *   3. password → "Sign in" (or Enter)
 *   4. dismiss the "Trust this device?" prompt ("No, thanks")
 *   5. harvest the JWT from network responses, then storage / cookies,
 *      accepting only iss=AuthPortal with aud containing "MES" (the MessageBus
 *      token is a different JWT and is rejected)
 *
 * Same user agent, same `--host-resolver-rules` mapping (host and host:9091 →
 * the connection's IP, so on-prem hosts resolve without DNS), same
 * ignore-TLS-errors context (the certificates are self-signed / corp-CA; set
 * CMF_TLS_INSECURE=0 to verify them, as for the REST client), same step
 * timeouts (30 s navigation, 15 s per input, 10 s prompt, 30 s token wait).
 *
 * The browser: `playwright-core` (no bundled browser) plus a Chromium found at
 * CMF_CHROMIUM_PATH (or the Lambda's CHROMIUM_EXECUTABLE_PATH), else
 * Playwright's own download if present, else the usual system locations. The
 * images that log in (fabinsight, admin) install the alpine `chromium` package
 * — see deploy/Dockerfile.image.
 */

import { existsSync } from "node:fs";
import type { Browser, Page } from "playwright-core";

/**
 * playwright-core is loaded only when a login actually runs. Importing it at
 * module load put it on the scheduler's boot path, so a packaging problem with
 * the library (a missing file in the image) took the whole scheduler down
 * instead of failing just the token refresh.
 */
async function loadChromium() {
  return (await import("playwright-core")).chromium;
}

const DEBUG = process.env.CMF_PORTAL_LOGIN_DEBUG === "1";
const CMF_TLS_INSECURE = process.env.CMF_TLS_INSECURE !== "0";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

/** Step budgets, unchanged from the Lambda. */
const NAV_TIMEOUT_MS = 30_000;
const INPUT_TIMEOUT_MS = 15_000;
const PROMPT_TIMEOUT_MS = 10_000;
const TOKEN_WAIT_MS = 30_000;
/** Whole-login ceiling (the Lambda had a 180 s function timeout). */
export const LOGIN_TIMEOUT_MS = Math.max(30_000, Number(process.env.CMF_TOKEN_LOGIN_TIMEOUT_MS ?? "120000") || 120_000);

const JWT_RE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

export type CmfPortalLoginFailure =
  | "credentials" // the portal rejected the user / password (or never issued a token after the login)
  | "timeout" // a step or the whole login ran out of time
  | "browser" // no Chromium to run the login with
  | "portal"; // navigation / page errors (unreachable host, TLS, unexpected page)

/** A login failure with a category the caller can map to an error type. */
export class CmfPortalLoginError extends Error {
  constructor(
    public readonly kind: CmfPortalLoginFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = kind === "timeout" ? "TimeoutError" : "CmfPortalLoginError";
  }
}

export interface CmfPortalLoginInput {
  baseUrl: string;
  user: string;
  pass: string;
  /** [[host, ip], …] from the connection row; mapped for the browser like HOST_RESOLVER was. */
  hostResolver?: Array<[string, string]>;
}

export interface CmfPortalLoginResult {
  token: string;
  /** ms epoch, from the JWT's `exp` (fallback: now + 50 min, as the Lambda did). */
  expiresAt: number;
  /** Where the token was found — for the log line only. */
  source: "response" | "storage" | "cookie";
}

/* ------------------------------------------------------------------------ */
/* JWT helpers — verbatim from the Lambda                                     */
/* ------------------------------------------------------------------------ */

function decodeClaims(jwt: string): Record<string, unknown> | null {
  try {
    const payload = jwt.split(".")[1];
    const buf = Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    return JSON.parse(buf.toString("utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** MES API token = audience contains "MES" and issuer is "AuthPortal" (reject the MessageBus token). */
function isMesApiToken(jwt: string): boolean {
  const c = decodeClaims(jwt);
  if (!c) return false;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  return aud.includes("MES") && c.iss === "AuthPortal";
}

function findAllJwts(text: string | null | undefined): string[] {
  if (!text) return [];
  return Array.from(new Set(text.match(JWT_RE) ?? []));
}

function extractMesJwt(text: string): string | null {
  for (const jwt of findAllJwts(text)) if (isMesApiToken(jwt)) return jwt;
  return null;
}

/* ------------------------------------------------------------------------ */
/* Browser                                                                    */
/* ------------------------------------------------------------------------ */

let resolvedExecutable: string | null | undefined;

/**
 * The Chromium this process can launch, or null. Order: CMF_CHROMIUM_PATH /
 * CHROMIUM_EXECUTABLE_PATH (must exist), Playwright's own download for this
 * playwright-core version, then the system locations the images and a
 * developer's machine use.
 */
export async function resolveChromiumExecutable(): Promise<string | null> {
  if (resolvedExecutable !== undefined) return resolvedExecutable;
  const candidates: string[] = [];
  for (const v of [process.env.CMF_CHROMIUM_PATH, process.env.CHROMIUM_EXECUTABLE_PATH]) {
    if (v && v.trim()) candidates.push(v.trim());
  }
  try {
    candidates.push((await loadChromium()).executablePath());
  } catch {
    /* library not loadable, or no download registered for this version */
  }
  candidates.push(
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/usr/lib/chromium/chromium",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  );
  resolvedExecutable = candidates.find((p) => p && existsSync(p)) ?? null;
  return resolvedExecutable;
}

/** Forget the cached lookup (a test, or after the binary was installed). */
export function resetChromiumLookup(): void {
  resolvedExecutable = undefined;
}

/** The Lambda's `HOST_RESOLVER=host=ip` became `--host-resolver-rules`; every pair of the connection is mapped. */
function hostResolverArgs(pairs: Array<[string, string]> | undefined): string[] {
  const rules: string[] = [];
  for (const [host, ip] of pairs ?? []) {
    if (!host || !ip) continue;
    rules.push(`MAP ${host} ${ip}`, `MAP ${host}:9091 ${ip}:9091`);
  }
  return rules.length ? [`--host-resolver-rules=${rules.join(", ")}`] : [];
}

async function launchBrowser(hostResolver: Array<[string, string]> | undefined): Promise<Browser> {
  const executablePath = await resolveChromiumExecutable();
  if (!executablePath) {
    throw new CmfPortalLoginError(
      "browser",
      "No Chromium is available to log in to the CMF portal with. Install it in this image and set CMF_CHROMIUM_PATH to the executable.",
    );
  }
  try {
    const chromium = await loadChromium();
    return await chromium.launch({
      executablePath,
      headless: !DEBUG,
      args: [
        // Container-safe flags (the Lambda got the equivalent from @sparticuz/chromium).
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        ...hostResolverArgs(hostResolver),
      ],
    });
  } catch (e) {
    throw new CmfPortalLoginError(
      "browser",
      `Chromium at ${executablePath} could not be started: ${e instanceof Error ? e.message : String(e)}`,
      { cause: e },
    );
  }
}

/* ------------------------------------------------------------------------ */
/* Page helpers                                                              */
/* ------------------------------------------------------------------------ */

/**
 * Any visible error text the login page is showing. The Lambda never read it —
 * a wrong password simply ended in "MES token not found" after 30 s — but the
 * admin who typed the password deserves the portal's own words when they exist.
 */
async function visibleLoginError(page: Page): Promise<string | null> {
  try {
    const texts = await page.evaluate(() => {
      const sel =
        '[role="alert"], [aria-live="assertive"], [aria-live="polite"], .error, .errors, .mat-error, .alert, .alert-danger, ' +
        '.validation-summary-errors, .text-danger, .error-message, .login-error, [class*="error" i], [class*="invalid" i]';
      const out: string[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t.length <= 300 && !out.includes(t)) out.push(t);
      }
      return out;
    });
    const hit = texts.find((t) =>
      /invalid|incorrect|wrong|denied|locked|disabled|expired|unauthori[sz]ed|failed|not found|unknown|does not exist|try again/i.test(t),
    );
    return hit ?? null;
  } catch {
    return null;
  }
}

async function dumpStorageTokens(page: Page): Promise<string[]> {
  try {
    return await page.evaluate(() => {
      const re = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;
      const all: string[] = [];
      const walk = (store: Storage) => {
        for (const k of Object.keys(store)) {
          const v = store.getItem(k);
          if (typeof v === "string") for (const t of v.match(re) ?? []) all.push(t);
        }
      };
      walk(localStorage);
      walk(sessionStorage);
      for (const t of (document.cookie || "").match(re) ?? []) all.push(t);
      return all;
    });
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------------ */
/* The login                                                                 */
/* ------------------------------------------------------------------------ */

async function runLogin(browser: Browser, input: CmfPortalLoginInput): Promise<CmfPortalLoginResult> {
  const context = await browser.newContext({ ignoreHTTPSErrors: CMF_TLS_INSECURE, userAgent: USER_AGENT });
  const page = await context.newPage();

  let foundToken: string | null = null;
  page.on("response", async (response) => {
    if (foundToken) return;
    try {
      const ct = response.headers()["content-type"] || "";
      if (!ct.includes("json") && !ct.includes("text")) return;
      const body = await response.text().catch(() => "");
      const jwt = extractMesJwt(body);
      if (jwt) {
        foundToken = jwt;
        if (DEBUG) console.error(`[cmf-portal-login] MES token found in ${response.url()}`);
      }
    } catch {
      /* ignore */
    }
  });

  // 1. Navigate (redirects to AuthPortal login).
  try {
    await page.goto(input.baseUrl, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/Timeout/i.test(msg)) {
      throw new CmfPortalLoginError("timeout", `The portal at ${input.baseUrl} did not finish loading within ${NAV_TIMEOUT_MS / 1000} s.`, { cause: e });
    }
    throw new CmfPortalLoginError("portal", `Could not open the portal at ${input.baseUrl}: ${msg.split("\n")[0]}`, { cause: e });
  }

  // 2. Step 1: username + Next.
  const usernameInput = page.locator('input[name="username"]:visible, input[type="text"]:visible').first();
  try {
    await usernameInput.waitFor({ timeout: INPUT_TIMEOUT_MS });
  } catch (e) {
    throw new CmfPortalLoginError(
      "portal",
      `The portal at ${input.baseUrl} did not show a login form (no username field within ${INPUT_TIMEOUT_MS / 1000} s; page title "${await page.title().catch(() => "")}").`,
      { cause: e },
    );
  }
  await usernameInput.fill(input.user);
  await page
    .locator('button[type="submit"]:has-text("Next"), button:has-text("Next"), button[type="submit"]')
    .first()
    .click();

  // 3. Step 2: password + Sign in.
  const passwordInput = page.locator('input[type="password"]:visible').first();
  try {
    await passwordInput.waitFor({ timeout: INPUT_TIMEOUT_MS });
  } catch (e) {
    const shown = await visibleLoginError(page);
    throw new CmfPortalLoginError(
      "credentials",
      shown
        ? `The portal rejected the portal user "${input.user}": ${shown}`
        : `The portal did not ask for a password after the user "${input.user}" (unknown user, or the login page changed).`,
      { cause: e },
    );
  }
  await passwordInput.fill(input.pass);
  const loginButton = page
    .locator(
      'button[type="submit"]:has-text("Sign in"), button:has-text("Sign in"), ' +
        'button[type="submit"]:has-text("Login"), button:has-text("Login"), button[type="submit"]',
    )
    .first();
  if (await loginButton.count()) await loginButton.click();
  else await passwordInput.press("Enter");

  // 4. Dismiss the "Trust this device?" passkey prompt.
  try {
    const noThanks = page
      .locator('button:has-text("No, thanks"), button:has-text("No thanks"), button:has-text("Skip")')
      .first();
    await noThanks.waitFor({ timeout: PROMPT_TIMEOUT_MS });
    await noThanks.click();
  } catch {
    /* no prompt */
  }

  // 5. Wait for the token via network capture, then fall back to storage/cookies.
  const start = Date.now();
  let shownError: string | null = null;
  while (!foundToken && Date.now() - start < TOKEN_WAIT_MS) {
    await page.waitForTimeout(500);
    if (!foundToken && !shownError && Date.now() - start > 3_000) {
      shownError = await visibleLoginError(page);
    }
  }
  let source: CmfPortalLoginResult["source"] = "response";

  if (!foundToken) {
    const dump = await dumpStorageTokens(page);
    const hit = dump.find((t) => isMesApiToken(t));
    if (hit) {
      foundToken = hit;
      source = "storage";
    }
  }
  if (!foundToken) {
    // HttpOnly cookies are invisible to document.cookie; the browser context still has them.
    const cookies = await context.cookies().catch(() => []);
    const hit = cookies.map((c) => c.value).find((v) => isMesApiToken(v));
    if (hit) {
      foundToken = hit;
      source = "cookie";
    }
  }

  if (!foundToken) {
    throw new CmfPortalLoginError(
      "credentials",
      shownError
        ? `The portal rejected the login for "${input.user}": ${shownError}`
        : `The portal did not issue an access token after signing in as "${input.user}" (usually a wrong portal user or password; the page showed no error text).`,
    );
  }

  const claims = decodeClaims(foundToken);
  const exp = typeof claims?.exp === "number" ? claims.exp : undefined;
  const expiresAt = exp ? exp * 1000 : Date.now() + 50 * 60 * 1000;
  return { token: foundToken, expiresAt, source };
}

/**
 * Log in to the CMF portal and return the MES API token + its expiry. Every
 * failure is a CmfPortalLoginError whose `kind` says whether the credentials,
 * the portal, the browser or the clock was the problem.
 */
export async function loginCmfPortal(
  input: CmfPortalLoginInput,
  opts: { timeoutMs?: number } = {},
): Promise<CmfPortalLoginResult> {
  if (!input.user || !input.pass) {
    throw new CmfPortalLoginError("credentials", "A portal user and password are required.");
  }
  const timeoutMs = opts.timeoutMs ?? LOGIN_TIMEOUT_MS;
  const browser = await launchBrowser(input.hostResolver);
  let timer: NodeJS.Timeout | undefined;
  try {
    const ceiling = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new CmfPortalLoginError("timeout", `The portal login did not complete within ${Math.round(timeoutMs / 1000)} s.`)),
        timeoutMs,
      );
    });
    return await Promise.race([runLogin(browser, input), ceiling]);
  } catch (e) {
    if (e instanceof CmfPortalLoginError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    throw new CmfPortalLoginError(
      /Timeout \d+ms exceeded/i.test(msg) ? "timeout" : "portal",
      `The portal login failed: ${msg.split("\n")[0]}`,
      { cause: e },
    );
  } finally {
    if (timer) clearTimeout(timer);
    await browser.close().catch(() => {});
  }
}
