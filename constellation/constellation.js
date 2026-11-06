/* Vivaldi UI adapter for weimer.dev's Signal constellation. No page injection. */
(() => {
  "use strict";

  const namespace = globalThis.vivaldiConstellation;
  if (!namespace?.Preset) {
    console.warn("[Constellation] Load constellation-engine.js before constellation.js.");
    return;
  }
  namespace.destroy?.();

  // Edit these in the repository, then rerun the installer.
  const framesPerSecond = 30;
  const maxCanvasPixels = 2_000_000;
  const pixelRatioLimit = 2;
  const preset = new namespace.Preset();
  const canvas = document.createElement("canvas");
  canvas.id = "vivaldi-constellation-canvas";
  canvas.setAttribute("aria-hidden", "true");
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) return;

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const events = new AbortController();
  let root = null;
  let width = 0;
  let height = 0;
  let pixelRatio = 1;
  let backdrop;
  let animationFrame = 0;
  let lastFrameAt = null;
  let cursor;
  let focused = document.hasFocus();
  let minimized = false;
  let browserWindowId;
  let usesBrowserFocus = false;
  let destroyed = false;
  const browserWindows = globalThis.chrome?.windows;

  const pause = () => {
    cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    lastFrameAt = null;
    cursor = undefined;
  };

  const draw = (now, elapsed) => {
    context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    context.fillStyle = backdrop;
    context.fillRect(0, 0, width, height);
    preset.draw(context, {
      width,
      height,
      pixelRatio,
      now,
      elapsed,
      cursor: cursor && {
        x: cursor.x,
        y: cursor.y,
        speed: cursor.speed,
        idleDuration: Math.max(0, now - cursor.observedAt),
      },
    });
    if (cursor) cursor.speed = 0;
  };

  const canAnimate = () => root && !document.hidden && focused && !minimized && !reducedMotion.matches;

  const render = (now) => {
    animationFrame = 0;
    if (!canAnimate()) return;
    if (lastFrameAt === null || now - lastFrameAt >= 1_000 / framesPerSecond - 0.5) {
      const elapsed = lastFrameAt === null ? 1_000 / framesPerSecond : Math.min(now - lastFrameAt, 100);
      draw(now, elapsed);
      lastFrameAt = now;
    }
    animationFrame = requestAnimationFrame(render);
  };

  const syncPlayback = () => {
    pause();
    if (!root) return;
    // Reduced motion and unfocused windows retain a static constellation.
    draw(performance.now(), 0);
    if (canAnimate()) animationFrame = requestAnimationFrame(render);
  };

  const resize = () => {
    if (!root) return;
    const bounds = canvas.getBoundingClientRect();
    const nextWidth = Math.max(1, bounds.width);
    const nextHeight = Math.max(1, bounds.height);
    const nextPixelRatio = Math.min(
      window.devicePixelRatio || 1,
      pixelRatioLimit,
      Math.sqrt(maxCanvasPixels / (nextWidth * nextHeight)),
    );
    if (width === nextWidth && height === nextHeight && pixelRatio === nextPixelRatio) return;
    width = nextWidth;
    height = nextHeight;
    pixelRatio = nextPixelRatio;
    canvas.width = Math.max(1, Math.floor(width * pixelRatio));
    canvas.height = Math.max(1, Math.floor(height * pixelRatio));
    preset.resize({ width, height, pixelRatio });
    backdrop = context.createLinearGradient(0, 0, width, height);
    backdrop.addColorStop(0, "#07151a");
    backdrop.addColorStop(1, "#101222");
    syncPlayback();
  };

  const resizeObserver = new ResizeObserver(resize);
  const mountObserver = new MutationObserver(() => mount());
  const mount = () => {
    if (destroyed || (root?.isConnected && canvas.parentNode === root)) return;
    pause();
    resizeObserver.disconnect();
    mountObserver.disconnect();
    root?.removeAttribute("data-constellation");
    canvas.remove();
    root = document.querySelector("#browser");
    if (!root) {
      // Vivaldi creates its React UI asynchronously.
      mountObserver.observe(document.documentElement, { childList: true, subtree: true });
      return;
    }
    root.setAttribute("data-constellation", "");
    root.prepend(canvas);
    width = 0;
    resize();
    resizeObserver.observe(root);
    // Watch only these two child lists after startup, not the entire live UI.
    mountObserver.observe(root, { childList: true });
    mountObserver.observe(root.parentNode, { childList: true });
  };

  window.addEventListener("pointermove", (event) => {
    if (!canAnimate()) return;
    // Events inside a webview do not bubble to the browser UI. Do not retain
    // attraction when the pointer crosses into a page, panel, or other webview.
    if (event.target instanceof Element && event.target.closest("#webview-container, .webpanel, webview")) {
      cursor = undefined;
      return;
    }
    const bounds = canvas.getBoundingClientRect();
    const observedAt = performance.now();
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const elapsed = cursor ? Math.max(1, observedAt - cursor.observedAt) : 0;
    const speed = cursor ? Math.hypot(x - cursor.x, y - cursor.y) / elapsed * 1_000 : 0;
    cursor = { x, y, speed, observedAt };
  }, { passive: true, signal: events.signal });
  // Capture the boundary event before the pointer enters a guest webview.
  window.addEventListener("pointerover", (event) => {
    if (event.target instanceof Element && event.target.closest("#webview-container, .webpanel, webview")) {
      cursor = undefined;
    }
  }, { passive: true, signal: events.signal });
  document.addEventListener("pointerleave", () => { cursor = undefined; }, { signal: events.signal });
  document.addEventListener("visibilitychange", syncPlayback, { signal: events.signal });
  window.addEventListener("focus", () => {
    if (!usesBrowserFocus) { focused = true; syncPlayback(); }
  }, { signal: events.signal });
  window.addEventListener("blur", () => {
    cursor = undefined;
    if (!usesBrowserFocus) { focused = false; syncPlayback(); }
  }, { signal: events.signal });
  window.addEventListener("resize", resize, { signal: events.signal });
  reducedMotion.addEventListener("change", syncPlayback, { signal: events.signal });

  // A guest webview can take DOM focus without deactivating the browser window.
  // Prefer real browser-window focus/state when the privileged UI exposes it.
  const onBrowserFocus = (id) => {
    if (browserWindowId === undefined) return;
    focused = id === browserWindowId;
    syncPlayback();
  };
  const onBrowserBounds = (browserWindow) => {
    if (browserWindow.id !== browserWindowId) return;
    minimized = browserWindow.state === "minimized";
    syncPlayback();
  };
  if (browserWindows?.getCurrent && browserWindows.onFocusChanged && browserWindows.onBoundsChanged) {
    usesBrowserFocus = true;
    browserWindows.onFocusChanged.addListener(onBrowserFocus);
    browserWindows.onBoundsChanged.addListener(onBrowserBounds);
    try {
      browserWindows.getCurrent((browserWindow) => {
        const error = globalThis.chrome?.runtime?.lastError;
        if (destroyed) return;
        if (error || !browserWindow) {
          usesBrowserFocus = false;
          focused = document.hasFocus();
        } else {
          browserWindowId = browserWindow.id;
          focused = browserWindow.focused;
          minimized = browserWindow.state === "minimized";
        }
        syncPlayback();
      });
    } catch {
      // Some UI contexts expose the namespace but cannot use this API.
      usesBrowserFocus = false;
    }
  }

  const destroy = () => {
    destroyed = true;
    pause();
    events.abort();
    browserWindows?.onFocusChanged?.removeListener(onBrowserFocus);
    browserWindows?.onBoundsChanged?.removeListener(onBrowserBounds);
    resizeObserver.disconnect();
    mountObserver.disconnect();
    canvas.remove();
    root?.removeAttribute("data-constellation");
    root = null;
    if (namespace.destroy === destroy) delete namespace.destroy;
  };
  namespace.destroy = destroy;
  window.addEventListener("pagehide", destroy, { once: true, signal: events.signal });
  mount();
})();
