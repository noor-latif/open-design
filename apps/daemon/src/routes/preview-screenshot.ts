import type { Express } from 'express';

// Lazy dynamic import so daemon starts even if playwright not installed.
// Returns 503 with reason 'screenshot_unavailable' if import fails.

const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB
const MIN_HTML_BYTES = 1;
const MIN_DIM = 1;
const MAX_DIM = 3000;
const DEFAULT_WIDTH = 1280;
const DEFAULT_HEIGHT = 800;
const SCREENSHOT_TIMEOUT_MS = 10_000;

type Browser = any;
let browser: Browser | null = null;
let browserPromise: Promise<Browser> | null = null;
let playwrightUnavailable = false;

async function getChromium(): Promise<any> {
  try {
    const mod: any = await import('playwright-core');
    if (!mod?.chromium) throw new Error('chromium export missing');
    return mod.chromium;
  } catch (err: any) {
    playwrightUnavailable = true;
    throw err;
  }
}

async function getBrowser(): Promise<Browser> {
  if (browser) return browser;
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const chromium = await getChromium();
    // Prefer system Chromium on Alpine (apk) to avoid 400MB bundled download.
    // Fall back to Playwright's bundled path if system binary missing.
    const systemPaths = [
      process.env.CHROMIUM_PATH,
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/usr/bin/google-chrome',
    ].filter(Boolean) as string[];
    let lastErr: any = null;
    for (const exe of systemPaths) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const { promises: fs } = await import('node:fs');
        // eslint-disable-next-line no-await-in-loop
        await fs.access(exe);
        const b: Browser = await chromium.launch({
          executablePath: exe,
          args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
        });
        try {
          b.on('disconnected', () => {
            browser = null;
            browserPromise = null;
          });
        } catch {}
        browser = b;
        return b;
      } catch (e) {
        lastErr = e;
      }
    }
    // Fallback to bundled Playwright chromium (bookworm / non-Alpine).
    const b: Browser = await chromium.launch({
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    // Reset singleton if browser disconnects/crashes so next request can relaunch.
    try {
      b.on('disconnected', () => {
        browser = null;
        browserPromise = null;
      });
    } catch {
      // ignore
    }
    browser = b;
    return b;
  })();
  try {
    const b = await browserPromise;
    return b;
  } catch (e) {
    browserPromise = null;
    throw e;
  }
}

function validateInput(body: any): { error?: string; reason?: string; status?: number } | { html: string; width: number; height: number; full: boolean; selector?: string | undefined } {
  const html = body?.html;
  if (typeof html !== 'string') {
    return { error: 'html is required and must be a string', reason: 'invalid_html', status: 400 };
  }
  const byteLen = Buffer.byteLength(html, 'utf8');
  if (byteLen < MIN_HTML_BYTES || byteLen > MAX_HTML_BYTES) {
    return { error: `html must be ${MIN_HTML_BYTES}..${MAX_HTML_BYTES} bytes (got ${byteLen})`, reason: 'invalid_html', status: 400 };
  }
  let width = DEFAULT_WIDTH;
  let height = DEFAULT_HEIGHT;
  if (body.width !== undefined) {
    const w = Number(body.width);
    if (!Number.isFinite(w) || !Number.isInteger(w) || w < MIN_DIM || w > MAX_DIM) {
      return { error: `width must be integer ${MIN_DIM}..${MAX_DIM}`, reason: 'invalid_width', status: 400 };
    }
    width = w;
  }
  if (body.height !== undefined) {
    const h = Number(body.height);
    if (!Number.isFinite(h) || !Number.isInteger(h) || h < MIN_DIM || h > MAX_DIM) {
      return { error: `height must be integer ${MIN_DIM}..${MAX_DIM}`, reason: 'invalid_height', status: 400 };
    }
    height = h;
  }
  const full = Boolean(body.full);
  let selector: string | undefined;
  if (body.selector !== undefined) {
    if (typeof body.selector !== 'string') {
      return { error: 'selector must be a string', reason: 'invalid_selector', status: 400 };
    }
    const trimmed = body.selector.trim();
    if (trimmed.length === 0) {
      return { error: 'selector must not be empty', reason: 'invalid_selector', status: 400 };
    }
    if (trimmed.length > 1000) {
      return { error: 'selector too long', reason: 'invalid_selector', status: 400 };
    }
    selector = trimmed;
  }
  return { html, width, height, full, selector };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, reason = 'timeout'): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(reason)), ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    return result as T;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function registerPreviewScreenshotRoutes(app: Express): void {
  app.get('/api/preview/screenshot/health', async (_req, res) => {
    // Lazy probe: try dynamic import without launching browser.
    try {
      await getChromium();
      res.json({ ok: true, available: true });
    } catch {
      res.json({ ok: true, available: false, reason: 'screenshot_unavailable' });
    }
  });

  app.post('/api/preview/screenshot', async (req, res) => {
    const validation: any = validateInput(req.body);
    if (validation.error) {
      return res.status(validation.status ?? 400).json({ error: validation.error, reason: validation.reason });
    }
    const { html, width, height, full, selector } = validation as {
      html: string;
      width: number;
      height: number;
      full: boolean;
      selector?: string;
    };

    let b: Browser;
    try {
      b = await getBrowser();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      return res.status(503).json({ error: 'screenshot unavailable: playwright not installed or failed to launch', reason: 'screenshot_unavailable', detail: msg });
    }

    let context: any = null;
    let page: any = null;
    try {
      const work = (async () => {
        context = await b.newContext({
          viewport: { width, height },
        });
        page = await context.newPage();
        // Apply viewport explicitly as well for hosts that expect setViewportSize path.
        try {
          await page.setViewportSize({ width, height });
        } catch {
          // context viewport already covers it
        }

        await page.setContent(html, { waitUntil: 'networkidle', timeout: SCREENSHOT_TIMEOUT_MS });

        // Wait for fonts to be ready; best-effort.
        try {
          await page.evaluate(`document.fonts.ready`).catch(() => {});
        } catch {
          // ignore font wait failure
        }

        let buffer: Buffer;
        if (selector) {
          const loc = page.locator(selector);
          buffer = await loc.screenshot({ type: 'png', timeout: SCREENSHOT_TIMEOUT_MS });
        } else if (full) {
          buffer = await page.screenshot({ type: 'png', fullPage: true, timeout: SCREENSHOT_TIMEOUT_MS });
        } else {
          buffer = await page.screenshot({ type: 'png', timeout: SCREENSHOT_TIMEOUT_MS });
        }

        const base64 = buffer.toString('base64');
        return {
          dataUrl: `data:image/png;base64,${base64}`,
          w: width,
          h: height,
        };
      })();

      const result = await withTimeout(work, SCREENSHOT_TIMEOUT_MS, 'screenshot timeout');
      return res.json(result);
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const isTimeout = /timeout/i.test(msg);
      return res.status(500).json({
        error: isTimeout ? 'screenshot timeout' : 'screenshot failed',
        reason: isTimeout ? 'screenshot_timeout' : 'screenshot_failed',
        detail: msg,
      });
    } finally {
      try {
        if (page) await page.close().catch(() => {});
      } catch {}
      try {
        if (context) await context.close().catch(() => {});
      } catch {}
    }
  });
}
