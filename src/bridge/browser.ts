/**
 * Browser control through the DevTools protocol.
 *
 * A web page is not a picture: it has a DOM. So instead of screenshotting the browser and aiming at
 * pixels, these tools hand the model a list of the things on the page with a short reference each, and it
 * says which one to click. Nothing depends on where a window happens to sit, and scrolling cannot make a
 * click land somewhere else.
 */
import * as z from "zod";
import type { Runtime } from "../core/runtime.js";
import { browserAlive, browserProfileDir, CdpSession, closeTab, launchBrowser, listTargets, newTab, type CdpTarget } from "../core/chrome.js";
import { sleep, truncateMiddle } from "../core/util.js";
import type { DefineTool } from "./tools.js";
import { cardResult, versionedUri, VIEWER_URI } from "./widgets.js";

/** The page the tools act on, kept between calls so the model does not have to re-attach every time. */
let current: { session: CdpSession; targetId: string } | null = null;

/**
 * Page-side helpers, injected fresh on every snapshot. Elements get a short ref (e1, e2, …) that later
 * calls can name; the refs live on the elements themselves, so they survive until the page changes.
 */
const SNAPSHOT_JS = `(() => {
  const SEL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=menuitem],[onclick],[contenteditable=""],[contenteditable="true"]';
  const seen = [];
  let n = 0;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none' || Number(s.opacity) < 0.05) return false;
    return r.bottom > 0 && r.right > 0 && r.top < innerHeight * 3 && r.left < innerWidth * 2;
  };
  const label = (el) => {
    const t = (el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.innerText || el.value || el.getAttribute('name') || '').replace(/\\s+/g, ' ').trim();
    return t.slice(0, 120);
  };
  for (const el of document.querySelectorAll(SEL)) {
    if (!visible(el)) continue;
    const ref = 'e' + (++n);
    el.setAttribute('data-cb-ref', ref);
    const r = el.getBoundingClientRect();
    seen.push({
      ref,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute('type') || el.getAttribute('role') || '',
      name: label(el),
      value: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' ? String(el.value ?? '').slice(0, 80) : '',
      disabled: !!el.disabled,
      onScreen: r.top < innerHeight && r.bottom > 0,
    });
    if (n >= 200) break;
  }
  const main = document.querySelector('main,article,[role=main]') || document.body || document.documentElement;
  return {
    url: location.href,
    title: document.title,
    text: ((main && main.innerText) || '').replace(/\\n{3,}/g, '\\n\\n').trim(),
    elements: seen,
    scroll: { y: Math.round(scrollY), height: Math.round((document.body && document.body.scrollHeight) || 0), viewport: Math.round(innerHeight) },
  };
})()`;

const RECT_JS = (ref: string, selector?: string) => `(() => {
  const el = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : `document.querySelector('[data-cb-ref="${ref}"]')`};
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height, tag: el.tagName.toLowerCase(), name: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g,' ').trim().slice(0, 80) };
})()`;

/** Finds an element by its visible text, for when the model has not taken a snapshot. */
const BY_TEXT_JS = (text: string) => `(() => {
  const want = ${JSON.stringify(text)}.toLowerCase();
  const cands = [...document.querySelectorAll('a,button,input,select,textarea,[role=button],[role=link],[role=tab],[onclick]')];
  const score = (el) => {
    const t = ((el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '') + '').replace(/\\s+/g,' ').trim().toLowerCase();
    if (!t) return -1;
    if (t === want) return 3;
    if (t.startsWith(want)) return 2;
    if (t.includes(want)) return 1;
    return -1;
  };
  let best = null, bestScore = 0;
  for (const el of cands) { const s = score(el); if (s > bestScore) { best = el; bestScore = s; } }
  if (!best) return null;
  best.setAttribute('data-cb-ref', 'ehit');
  return 'ehit';
})()`;

/**
 * Lets go of the browser. The open socket keeps the event loop alive, so anything short-lived (a test, a
 * one-off script) has to call this or it never exits.
 */
export async function closeBrowser(quit = false) {
  if (!current) return;
  if (quit) await current.session.send("Browser.close").catch(() => {});
  current.session.close();
  current = null;
}

async function attach(rt: Runtime, opts: { url?: string; newTab?: boolean } = {}) {
  const cfg = rt.config.browser;
  if (current && current.session.open && !opts.newTab) return current;
  await launchBrowser({ port: cfg.port, chromePath: cfg.chromePath, ownProfile: cfg.ownProfile, headless: cfg.headless, startUrl: opts.url });
  let target: CdpTarget | undefined;
  if (opts.newTab && opts.url) target = await newTab(cfg.port, opts.url);
  else {
    const targets = await listTargets(cfg.port);
    target = targets.find((t) => t.id === current?.targetId) ?? targets.at(-1);
    if (!target) target = await newTab(cfg.port, opts.url ?? "about:blank");
  }
  if (!target?.webSocketDebuggerUrl) throw new Error("the browser gave no debugging endpoint for that tab");
  current?.session.close();
  const session = await CdpSession.connect(target.webSocketDebuggerUrl);
  await session.send("Page.enable").catch(() => {});
  await session.send("Runtime.enable").catch(() => {});
  current = { session, targetId: target.id };
  return current;
}

/** A cheap fingerprint of the page, to tell whether an action actually did anything. */
const STATE_JS = `(() => ({ url: location.href, len: ((document.body && document.body.innerText) || '').length }))()`;

/**
 * Some pages ignore protocol-level mouse and key events (custom widgets, frameworks that only listen for
 * their own handlers). When nothing changed, fall back to asking the DOM to do it, and say which worked.
 */
async function pageState(session: CdpSession) {
  return session.evaluate<{ url: string; len: number }>(STATE_JS).catch(() => ({ url: "", len: -1 }));
}

function changed(a: { url: string; len: number }, b: { url: string; len: number }) {
  return a.url !== b.url || Math.abs(a.len - b.len) > 40;
}

/**
 * Presses Enter the way a keyboard does. Two events are not enough: a page that listens for keypress (or
 * a framework that does) needs the char event in the middle, which is why submitting used to do nothing.
 */
async function pressEnter(session: CdpSession) {
  const base = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
  await session.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await session.send("Input.dispatchKeyEvent", { type: "char", text: "\r", ...base });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

/**
 * Many sites answer a search without a page load: they rewrite the address and swap the content in. So
 * waiting for the load event alone reports "nothing happened". Watch the address instead.
 */
async function waitForChange(session: CdpSession, before: string, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await sleep(300);
    const now = await session.evaluate<string>("location.href").catch(() => before);
    if (now !== before) {
      await sleep(600);
      return true;
    }
  }
  return false;
}

/** Waits for the page to settle: load event, then a short quiet period for client-side rendering. */
async function waitForLoad(session: CdpSession, ms = 15_000) {
  const done = new Promise<void>((resolve) => {
    session.on("Page.loadEventFired", () => resolve());
    setTimeout(resolve, ms);
  });
  await done;
  await sleep(400);
}

function renderSnapshot(s: any, limit: number): string {
  const lines = [`${s.title || "(no title)"} — ${s.url}`, ""];
  if (s.elements.length) {
    lines.push("Things you can act on (use the ref with browser_click / browser_type):");
    for (const e of s.elements.slice(0, limit)) {
      const bits = [e.ref.padEnd(5), e.tag + (e.type ? `[${e.type}]` : ""), e.name || "(no label)"];
      if (e.value) bits.push(`= "${e.value}"`);
      if (e.disabled) bits.push("(disabled)");
      if (!e.onScreen) bits.push("(off screen)");
      lines.push("  " + bits.join(" "));
    }
    if (s.elements.length > limit) lines.push(`  … ${s.elements.length - limit} more`);
    lines.push("");
  }
  lines.push("Page text:", truncateMiddle(s.text || "(empty)", 6000));
  if (s.scroll.height > s.scroll.viewport * 1.2) lines.push("", `(scrolled to ${s.scroll.y} of ${s.scroll.height - s.scroll.viewport}; browser_scroll for more)`);
  return lines.join("\n");
}

export function registerBrowser(define: DefineTool, rt: Runtime) {
  /**
   * A click can start a navigation, and a snapshot taken while the old document is being torn down fails.
   * One retry after a short wait covers that without making every call slow.
   */
  const snap = async (session: CdpSession) => {
    try {
      return await session.evaluate<any>(SNAPSHOT_JS);
    } catch {
      await sleep(1500);
      return await session.evaluate<any>(SNAPSHOT_JS);
    }
  };

  define(
    "browser_open",
    {
      title: "Open the browser",
      description:
        "Start (or reuse) the browser this PC drives and go to a URL. Use these browser_* tools for anything on the web instead of screenshots and mouse clicks: they name elements rather than guessing at pixels. The browser has its own profile, so the owner's other sessions are not visible to you; if a site needs a login, ask the owner to sign in once in that window.",
      input: { url: z.string().optional(), new_tab: z.boolean().optional() },
      effect: "execute",
      openWorld: true,
    },
    async (a) => {
      const { session } = await attach(rt, { url: a.url, newTab: a.new_tab });
      if (a.url) {
        await session.send("Page.navigate", { url: a.url });
        await waitForLoad(session);
      }
      const s = await snap(session);
      return renderSnapshot(s, 40);
    },
  );

  define(
    "browser_navigate",
    {
      title: "Go to a page",
      description: "Navigate the current tab: a URL, or 'back' / 'forward' / 'reload'. Returns what the page says afterwards.",
      input: { to: z.string().describe("URL, or back / forward / reload") },
      effect: "execute",
      openWorld: true,
    },
    async (a) => {
      const { session } = await attach(rt);
      const to = a.to.trim();
      if (to === "back" || to === "forward") {
        const hist = await session.send<any>("Page.getNavigationHistory");
        const index = hist.currentIndex + (to === "back" ? -1 : 1);
        const entry = hist.entries[index];
        if (!entry) return `nothing to go ${to} to`;
        await session.send("Page.navigateToHistoryEntry", { entryId: entry.id });
      } else if (to === "reload") {
        await session.send("Page.reload");
      } else {
        await session.send("Page.navigate", { url: /^[a-z]+:\/\//i.test(to) ? to : `https://${to}` });
      }
      await waitForLoad(session);
      return renderSnapshot(await snap(session), 40);
    },
  );

  define(
    "browser_snapshot",
    {
      title: "Read the page",
      description:
        "What the current page says, plus every element you can act on with a short ref (e1, e2 …). Call this before clicking, and again after the page changes — refs are only valid for the page as it was.",
      input: { limit: z.number().int().min(5).max(200).optional() },
      effect: "read",
    },
    async (a) => {
      const { session } = await attach(rt);
      return renderSnapshot(await snap(session), a.limit ?? 60);
    },
  );

  define(
    "browser_click",
    {
      title: "Click on the page",
      description: "Click an element by its ref from browser_snapshot, or by visible text, or by CSS selector. Reports what the page looks like afterwards.",
      input: {
        ref: z.string().optional().describe("A ref from browser_snapshot, e.g. e12"),
        text: z.string().optional().describe("Visible text of the thing to click, when you have no ref"),
        selector: z.string().optional().describe("CSS selector, for when neither of the above fits"),
      },
      effect: "execute",
    },
    async (a) => {
      const { session } = await attach(rt);
      let ref = a.ref;
      if (!ref && a.text) {
        ref = (await session.evaluate<string | null>(BY_TEXT_JS(a.text))) ?? undefined;
        if (!ref) throw new Error(`nothing on the page matches "${a.text}" — call browser_snapshot and use a ref`);
      }
      if (!ref && !a.selector) throw new Error("give ref, text or selector");
      const rect = await session.evaluate<any>(RECT_JS(ref ?? "", a.selector));
      if (!rect) throw new Error("that element is not on the page any more — take a fresh browser_snapshot");
      await sleep(150);
      // A real mouse event at the element's centre, so pages that ignore synthetic clicks still respond.
      for (const type of ["mousePressed", "mouseReleased"]) {
        await session.send("Input.dispatchMouseEvent", { type, x: Math.round(rect.x), y: Math.round(rect.y), button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
      }
      const before = await pageState(session);
      await sleep(700);
      let how = "";
      if (!changed(before, await pageState(session))) {
        // Nothing moved: ask the element itself, which covers widgets that ignore raw input events.
        const fell = await session.evaluate<boolean>(`(() => { const el = document.querySelector('[data-cb-ref="${a.selector ? "" : (ref ?? "")}"]') || ${a.selector ? `document.querySelector(${JSON.stringify(a.selector)})` : "null"}; if (!el) return false; el.click(); return true })()`).catch(() => false);
        if (fell) {
          await sleep(900);
          how = " (the page ignored a real click, so the element was clicked directly)";
        }
      }
      await waitForChange(session, before.url, 1500);
      const s = await snap(session);
      return `clicked ${rect.tag} "${rect.name || a.text || ref}"${how}\n\n${renderSnapshot(s, 40)}`;
    },
  );

  define(
    "browser_type",
    {
      title: "Type into the page",
      description: "Put text into a field (by ref or selector). Set submit to press Enter afterwards. Set clear to replace what is already there.",
      input: {
        text: z.string(),
        ref: z.string().optional(),
        selector: z.string().optional(),
        submit: z.boolean().optional(),
        clear: z.boolean().optional(),
      },
      effect: "execute",
    },
    async (a) => {
      const { session } = await attach(rt);
      if (!a.ref && !a.selector) throw new Error("give ref or selector for the field to type into");
      const rect = await session.evaluate<any>(RECT_JS(a.ref ?? "", a.selector));
      if (!rect) throw new Error("that field is not on the page any more — take a fresh browser_snapshot");
      for (const type of ["mousePressed", "mouseReleased"]) {
        await session.send("Input.dispatchMouseEvent", { type, x: Math.round(rect.x), y: Math.round(rect.y), button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
      }
      if (a.clear) {
        await session.send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
        await session.send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: 2, key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
      }
      await session.send("Input.insertText", { text: a.text });
      let submitted = "";
      if (a.submit) {
        const before = await pageState(session);
        await pressEnter(session);
        // Only a new address counts as "went somewhere": a suggestions dropdown changes the page text
        // without submitting anything, and treating that as success hid the failure.
        let moved = await waitForChange(session, before.url, 5000);
        if (!moved) {
          // Enter did nothing: submit the form the field belongs to, or press its submit button.
          const fell = await session
            .evaluate<string>(
              `(() => { const el = document.querySelector('[data-cb-ref="${a.ref ?? ""}"]') || ${a.selector ? `document.querySelector(${JSON.stringify(a.selector)})` : "null"};
                if (!el) return 'no field';
                const f = el.form || el.closest('form');
                if (f) { if (f.requestSubmit) f.requestSubmit(); else f.submit(); return 'form'; }
                const b = document.querySelector('button[type=submit],input[type=submit]');
                if (b) { b.click(); return 'button'; }
                return 'nothing'; })()`,
            )
            .catch(() => "nothing");
          moved = await waitForChange(session, before.url, 5000);
          submitted = moved ? ` and submitted the form (Enter alone did nothing, used the ${fell})` : " and pressed Enter, but the page did not change — look for a search button in the list below and click it";
        } else {
          submitted = " and pressed Enter";
        }
      }
      await sleep(300);
      return `typed ${a.text.length} characters into ${rect.tag} "${rect.name || a.ref || a.selector}"${submitted}\n\n${renderSnapshot(await snap(session), 40)}`;
    },
  );

  define(
    "browser_scroll",
    {
      title: "Scroll the page",
      description: "Scroll the current page. amount is in viewport heights: 1 = one screen down, -1 = one screen up. Or pass to='top'/'bottom'.",
      input: { amount: z.number().optional(), to: z.enum(["top", "bottom"]).optional() },
      effect: "execute",
    },
    async (a) => {
      const { session } = await attach(rt);
      const js = a.to === "top" ? "scrollTo(0,0)" : a.to === "bottom" ? "scrollTo(0,document.body.scrollHeight)" : `scrollBy(0, innerHeight * ${a.amount ?? 1})`;
      await session.evaluate(`(() => { ${js}; return true })()`);
      await sleep(500);
      return renderSnapshot(await snap(session), 40);
    },
  );

  define(
    "browser_tabs",
    {
      title: "Browser tabs",
      description: "List the open tabs, switch to one, open a new one, close one, or quit the browser entirely.",
      input: { action: z.enum(["list", "select", "new", "close", "quit"]).optional(), id: z.string().optional(), url: z.string().optional() },
      effect: "execute",
    },
    async (a) => {
      const cfg = rt.config.browser;
      if (!(await browserAlive(cfg.port))) await attach(rt);
      const action = a.action ?? "list";
      if (action === "quit") {
        await closeBrowser(true);
        return "the browser is closed";
      }
      if (action === "new") {
        await attach(rt, { url: a.url ?? "about:blank", newTab: true });
      } else if (action === "close") {
        if (!a.id) throw new Error("close needs the tab id from the list");
        await closeTab(cfg.port, a.id);
        if (current?.targetId === a.id) (current.session.close(), (current = null));
      } else if (action === "select") {
        if (!a.id) throw new Error("select needs the tab id from the list");
        const t = (await listTargets(cfg.port)).find((x) => x.id === a.id);
        if (!t?.webSocketDebuggerUrl) throw new Error("no such tab");
        current?.session.close();
        current = { session: await CdpSession.connect(t.webSocketDebuggerUrl), targetId: t.id };
        await current.session.send("Page.enable").catch(() => {});
        await current.session.send("Page.bringToFront").catch(() => {});
      }
      const tabs = await listTargets(cfg.port);
      return tabs.map((t) => `${t.id === current?.targetId ? "*" : " "} ${t.id}  ${t.title || "(no title)"}  ${t.url}`).join("\n") || "no tabs open";
    },
  );

  define(
    "browser_eval",
    {
      title: "Run JavaScript in the page",
      description: "Evaluate an expression in the current page and return its value. For reading data out of a page or checking state — prefer browser_snapshot / browser_click for ordinary interaction.",
      input: { expression: z.string().max(8000) },
      effect: "execute",
    },
    async (a) => {
      const { session } = await attach(rt);
      const value = await session.evaluate(`(async () => (${a.expression}))()`);
      return typeof value === "string" ? value : JSON.stringify(value, null, 2)?.slice(0, 20_000) ?? String(value);
    },
  );

  define(
    "browser_screenshot",
    {
      title: "Picture of the page",
      description: "A picture of the current page, as a card. Use it to show the owner what a page looks like — for acting on the page, browser_snapshot is better.",
      input: { full_page: z.boolean().optional() },
      effect: "read",
      meta: { "openai/outputTemplate": VIEWER_URI, "openai/widgetAccessible": true },
    },
    async (a) => {
      const { session } = await attach(rt);
      const shot = await session.send<any>("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!a.full_page });
      const info = await session.evaluate<any>("({ url: location.href, title: document.title })");
      return cardResult(
        { kind: "image", title: info.title || info.url, meta: info.url },
        { kind: "image", mime: "image/png", data: shot.data, title: info.title || info.url, meta: info.url, path: info.url },
        [
          { type: "image", data: shot.data, mimeType: "image/png" },
          { type: "text", text: `screenshot of ${info.url}` },
        ],
      );
    },
  );

  void browserProfileDir;
  void versionedUri;
}
