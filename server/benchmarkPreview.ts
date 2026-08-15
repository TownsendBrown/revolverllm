import { spawn } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { BenchmarkCheckResult } from "../shared/benchmarks/types";

const PREVIEW_TIMEOUT_MS = 30_000;
const STATS_SENTINEL = "__PREVIEW_STATS__";
const FRAMES_BEFORE_INPUT = 12;
const FRAMES_AFTER_INPUT = 12;

export interface PreviewStats {
  scripts: number;
  contextRequests: number;
  drawOps: number;
  /** Frames in which the page produced at least one draw/DOM update. */
  framesRendered: number;
  /** requestAnimationFrame / timer callbacks actually invoked. */
  frameCallbacks: number;
  keyListeners: number;
  respondedToInput: boolean;
  /** Whether the no-input and with-input replays matched before the keypress. */
  deterministic: boolean;
  errors: Array<{ phase: string; message: string }>;
}

/**
 * Headless harness: loads the generated page in a `vm` sandbox with a stubbed
 * DOM/canvas, drives animation frames off a fake clock, and replays the same
 * session twice — once idle, once with movement/jump keys held — so input
 * response is measured against a deterministic baseline rather than guessed
 * from self-animating scenes.
 */
const HARNESS_SOURCE = String.raw`
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SENTINEL = "__PREVIEW_STATS__";
const FRAMES_BEFORE = ${FRAMES_BEFORE_INPUT};
const FRAMES_AFTER = ${FRAMES_AFTER_INPUT};
const FRAME_MS = 16;
const SCRIPT_TIMEOUT_MS = 5000;

const html = fs.readFileSync(path.join(__dirname, "page.html"), "utf8");

function extractScripts(source) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(source)) !== null) {
    const attrs = m[1] || "";
    if (/\bsrc\s*=/i.test(attrs)) continue;
    const typeMatch = attrs.match(/\btype\s*=\s*["']?([^"'\s>]+)/i);
    if (typeMatch) {
      const t = typeMatch[1].toLowerCase();
      const isJs =
        t === "module" ||
        t === "text/javascript" ||
        t === "application/javascript" ||
        t === "text/ecmascript";
      if (!isJs) continue;
    }
    if (m[2].trim()) out.push(m[2]);
  }
  return out;
}

const SCRIPTS = extractScripts(html);

const ID_TAGS = {};
const idRe = /<([a-zA-Z][\w-]*)\b[^>]*\bid\s*=\s*["']([^"']+)["']/g;
let idMatch;
while ((idMatch = idRe.exec(html)) !== null) {
  ID_TAGS[idMatch[2]] = idMatch[1].toLowerCase();
}
const CANVAS_ID = (function () {
  const m = html.match(/<canvas\b[^>]*\bid\s*=\s*["']([^"']+)["']/i);
  return m ? m[1] : "__canvas__";
})();

function hashString(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h;
}

/** One full page session. withInput replays the identical timeline plus keys. */
function runSession(withInput) {
  const errors = [];
  let phase = "script";
  function recordError(e) {
    const msg = e && e.message ? String(e.message) : String(e);
    errors.push({ phase: phase, message: msg.slice(0, 200) });
  }
  function safeCall(fn, arg) {
    if (typeof fn !== "function") return;
    try {
      fn(arg);
    } catch (e) {
      recordError(e);
    }
  }

  let ops = [];
  let drawOps = 0;
  let contextRequests = 0;
  function drawOp(name, args) {
    drawOps++;
    ops.push(name + "(" + Array.prototype.slice.call(args).join(",") + ")");
  }

  // ---------- canvas ----------
  function makeGradient() {
    return { addColorStop: function () {} };
  }
  function makeContext(canvas) {
    const state = {
      canvas: canvas,
      fillStyle: "#000000",
      strokeStyle: "#000000",
      lineWidth: 1,
      lineCap: "butt",
      lineJoin: "miter",
      miterLimit: 10,
      font: "10px sans-serif",
      textAlign: "start",
      textBaseline: "alphabetic",
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
      imageSmoothingEnabled: true,
      imageSmoothingQuality: "low",
      shadowBlur: 0,
      shadowColor: "rgba(0,0,0,0)",
      shadowOffsetX: 0,
      shadowOffsetY: 0,
      filter: "none",
      direction: "ltr",
    };
    function imageData(w, h) {
      const width = Math.max(1, w | 0);
      const height = Math.max(1, h | 0);
      return { data: new Uint8ClampedArray(width * height * 4), width: width, height: height };
    }
    const special = {
      measureText: function (t) {
        return {
          width: String(t == null ? "" : t).length * 6,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: String(t == null ? "" : t).length * 6,
        };
      },
      createLinearGradient: function () { return makeGradient(); },
      createRadialGradient: function () { return makeGradient(); },
      createConicGradient: function () { return makeGradient(); },
      createPattern: function () { return {}; },
      getImageData: function (x, y, w, h) { return imageData(w, h); },
      createImageData: function (w, h) { return imageData(w, h); },
      isPointInPath: function () { return false; },
      isPointInStroke: function () { return false; },
      getLineDash: function () { return []; },
      getTransform: function () { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }; },
      getContextAttributes: function () { return { alpha: true }; },
    };
    return new Proxy(state, {
      get: function (t, key) {
        if (typeof key !== "string") return t[key];
        if (Object.prototype.hasOwnProperty.call(special, key)) return special[key];
        if (Object.prototype.hasOwnProperty.call(t, key)) return t[key];
        return function () {
          drawOp(key, arguments);
        };
      },
      set: function (t, key, value) {
        t[key] = value;
        ops.push(String(key) + "=" + String(value));
        return true;
      },
      has: function () { return true; },
    });
  }

  // ---------- DOM ----------
  function makeStyle() {
    const store = {};
    return new Proxy(store, {
      get: function (t, key) {
        if (key === "setProperty") {
          return function (k, v) {
            t[k] = v;
            ops.push("style." + k + "=" + v);
          };
        }
        if (key === "getPropertyValue") return function (k) { return t[k] || ""; };
        if (key === "removeProperty") return function (k) { delete t[k]; };
        const v = t[key];
        return v === undefined ? "" : v;
      },
      set: function (t, key, value) {
        t[key] = value;
        ops.push("style." + String(key) + "=" + String(value));
        return true;
      },
      has: function () { return true; },
    });
  }

  function addListener(map, type, fn) {
    const key = String(type);
    if (!map[key]) map[key] = [];
    if (typeof fn === "function") map[key].push(fn);
    else if (fn && typeof fn.handleEvent === "function") map[key].push(fn.handleEvent.bind(fn));
  }

  function makeElement(tag, id) {
    const tagName = String(tag).toLowerCase();
    const listeners = {};
    const el = {
      tagName: tagName.toUpperCase(),
      localName: tagName,
      nodeType: 1,
      id: id || "",
      className: "",
      title: "",
      src: "",
      href: "",
      width: 800,
      height: 450,
      offsetWidth: 800,
      offsetHeight: 450,
      clientWidth: 800,
      clientHeight: 450,
      offsetLeft: 0,
      offsetTop: 0,
      scrollLeft: 0,
      scrollTop: 0,
      complete: true,
      naturalWidth: 32,
      naturalHeight: 32,
      volume: 1,
      currentTime: 0,
      muted: false,
      loop: false,
      dataset: {},
      children: [],
      childNodes: [],
      parentNode: null,
      style: makeStyle(),
      __listeners: listeners,
      classList: {
        add: function () {},
        remove: function () {},
        toggle: function () {},
        contains: function () { return false; },
        replace: function () {},
      },
      addEventListener: function (type, fn) { addListener(listeners, type, fn); },
      removeEventListener: function () {},
      dispatchEvent: function () { return true; },
      appendChild: function (child) {
        el.children.push(child);
        el.childNodes.push(child);
        if (child) child.parentNode = el;
        return child;
      },
      insertBefore: function (child) { return el.appendChild(child); },
      removeChild: function (child) { return child; },
      replaceChild: function (child) { return child; },
      append: function () {},
      prepend: function () {},
      remove: function () {},
      contains: function () { return false; },
      closest: function () { return null; },
      setAttribute: function (k, v) {
        if (k === "id") el.id = String(v);
        if (k === "width") el.width = Number(v) || el.width;
        if (k === "height") el.height = Number(v) || el.height;
        ops.push("attr." + String(k) + "=" + String(v));
      },
      getAttribute: function (k) { return k === "id" ? el.id : null; },
      hasAttribute: function () { return false; },
      removeAttribute: function () {},
      getBoundingClientRect: function () {
        return {
          x: 0, y: 0, top: 0, left: 0,
          right: el.width, bottom: el.height,
          width: el.width, height: el.height,
        };
      },
      scrollIntoView: function () {},
      focus: function () {},
      blur: function () {},
      click: function () {},
      play: function () { return { then: function () {}, catch: function () {} }; },
      pause: function () {},
      load: function () {},
      requestPointerLock: function () {},
      requestFullscreen: function () { return { then: function () {}, catch: function () {} }; },
      cloneNode: function () { return makeElement(tagName, ""); },
      querySelector: function (s) { return resolveSelector(s); },
      querySelectorAll: function (s) {
        const r = resolveSelector(s);
        return r ? [r] : [];
      },
      getElementsByTagName: function (t) {
        const r = resolveSelector(t);
        return r ? [r] : [];
      },
      getElementsByClassName: function () { return []; },
    };

    // Track text/markup writes so DOM-rendered HUDs register as page updates.
    ["textContent", "innerText", "innerHTML", "outerHTML", "value"].forEach(function (prop) {
      let stored = "";
      Object.defineProperty(el, prop, {
        get: function () { return stored; },
        set: function (v) {
          stored = String(v);
          ops.push(prop + ":" + stored);
        },
        enumerable: true,
        configurable: true,
      });
    });

    ["onclick", "onkeydown", "onkeyup", "onload", "onmousedown", "onmouseup", "onmousemove"].forEach(
      function (prop) {
        el[prop] = null;
      },
    );

    if (tagName === "canvas") {
      el.getContext = function () {
        contextRequests++;
        if (!el.__ctx) el.__ctx = makeContext(el);
        return el.__ctx;
      };
      el.toDataURL = function () { return "data:,"; };
      el.transferControlToOffscreen = function () { return el; };
    }
    return el;
  }

  const byId = {};
  function elementById(id) {
    const key = String(id);
    if (!byId[key]) byId[key] = makeElement(ID_TAGS[key] || "div", key);
    return byId[key];
  }
  function defaultCanvas() {
    if (!byId[CANVAS_ID]) byId[CANVAS_ID] = makeElement("canvas", CANVAS_ID);
    return byId[CANVAS_ID];
  }
  function resolveSelector(sel) {
    const s = String(sel == null ? "" : sel).trim();
    if (!s) return null;
    if (s.charAt(0) === "#") return elementById(s.slice(1).split(/[\s.:\[>]/)[0]);
    const tag = s.split(/[\s.:\[>#]/)[0].toLowerCase();
    if (tag === "canvas") return defaultCanvas();
    if (tag === "body") return body;
    if (tag === "html") return documentElement;
    if (!tag) return makeElement("div", "");
    return makeElement(tag, "");
  }

  const body = makeElement("body", "");
  const documentElement = makeElement("html", "");
  const head = makeElement("head", "");
  const docListeners = {};
  const doc = {
    readyState: "loading",
    title: "",
    body: body,
    head: head,
    documentElement: documentElement,
    hidden: false,
    visibilityState: "visible",
    pointerLockElement: null,
    fullscreenElement: null,
    activeElement: body,
    __listeners: docListeners,
    onkeydown: null,
    onkeyup: null,
    onclick: null,
    addEventListener: function (type, fn) { addListener(docListeners, type, fn); },
    removeEventListener: function () {},
    dispatchEvent: function () { return true; },
    createElement: function (tag) { return makeElement(tag, ""); },
    createElementNS: function (ns, tag) { return makeElement(tag, ""); },
    createTextNode: function (t) { return { nodeType: 3, textContent: String(t) }; },
    createDocumentFragment: function () { return makeElement("fragment", ""); },
    getElementById: function (id) { return elementById(id); },
    querySelector: function (s) { return resolveSelector(s); },
    querySelectorAll: function (s) {
      const r = resolveSelector(s);
      return r ? [r] : [];
    },
    getElementsByTagName: function (t) {
      const r = resolveSelector(t);
      return r ? [r] : [];
    },
    getElementsByClassName: function () { return []; },
    exitPointerLock: function () {},
    exitFullscreen: function () {},
    write: function () {},
    fonts: { ready: { then: function (f) { safeCall(f); } }, load: function () { return { then: function (f) { safeCall(f); } }; } },
  };

  // ---------- clock, timers, rAF ----------
  let now = 0;
  let seq = 1;
  let rafQueue = [];
  let timers = [];
  let frameCallbacks = 0;

  function requestAnimationFrameStub(fn) {
    const id = seq++;
    rafQueue.push({ id: id, fn: fn });
    return id;
  }
  function cancelAnimationFrameStub(id) {
    rafQueue = rafQueue.filter(function (e) { return e.id !== id; });
  }
  function setTimeoutStub(fn, ms) {
    const id = seq++;
    timers.push({ id: id, fn: fn, at: now + (Number(ms) || 0), period: null });
    return id;
  }
  function setIntervalStub(fn, ms) {
    const id = seq++;
    const period = Math.max(1, Number(ms) || FRAME_MS);
    timers.push({ id: id, fn: fn, at: now + period, period: period });
    return id;
  }
  function clearTimerStub(id) {
    timers = timers.filter(function (t) { return t.id !== id; });
  }

  function runFrame() {
    now += FRAME_MS;
    const drawsBefore = drawOps;
    const due = rafQueue;
    rafQueue = [];
    for (let i = 0; i < due.length; i++) {
      frameCallbacks++;
      safeCall(due[i].fn, now);
    }
    for (let guard = 0; guard < 64; guard++) {
      let idx = -1;
      for (let i = 0; i < timers.length; i++) {
        if (timers[i].at <= now) { idx = i; break; }
      }
      if (idx < 0) break;
      const t = timers[idx];
      if (t.period == null) timers.splice(idx, 1);
      else t.at = now + t.period;
      frameCallbacks++;
      safeCall(t.fn);
    }
    const signature = hashString(ops.join("|"));
    const rendered = ops.length > 0;
    ops = [];
    return { signature: signature, rendered: rendered, draws: drawOps - drawsBefore };
  }

  // ---------- events ----------
  function makeKeyEvent(type, key, code, keyCode) {
    return {
      type: type,
      key: key,
      code: code,
      keyCode: keyCode,
      which: keyCode,
      charCode: 0,
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      isTrusted: true,
      target: body,
      currentTarget: body,
      defaultPrevented: false,
      preventDefault: function () {},
      stopPropagation: function () {},
      stopImmediatePropagation: function () {},
    };
  }

  function eventTargets() {
    return [sandbox, doc, body, documentElement, defaultCanvas()];
  }

  function countKeyListeners() {
    let n = 0;
    eventTargets().forEach(function (t) {
      const map = t === sandbox ? windowListeners : t.__listeners;
      if (map) {
        n += (map.keydown || []).length + (map.keyup || []).length;
      }
      if (typeof t.onkeydown === "function") n++;
      if (typeof t.onkeyup === "function") n++;
    });
    return n;
  }

  function dispatch(type, event, targets) {
    targets.forEach(function (t) {
      const map = t === sandbox ? windowListeners : t.__listeners;
      const list = map && map[type] ? map[type].slice() : [];
      for (let i = 0; i < list.length; i++) safeCall(list[i], event);
      const handler = t["on" + type];
      if (typeof handler === "function") safeCall(handler, event);
    });
  }

  function dispatchKey(type, key, code, keyCode) {
    dispatch(type, makeKeyEvent(type, key, code, keyCode), eventTargets());
  }

  // ---------- sandbox globals ----------
  const windowListeners = {};
  let randomState = 123456789;
  function seededRandom() {
    randomState = (randomState * 1103515245 + 12345) & 0x7fffffff;
    return randomState / 0x7fffffff;
  }

  function EventCtor(type, init) {
    const ev = { type: type, bubbles: false, cancelable: false, defaultPrevented: false };
    if (init) for (const k in init) ev[k] = init[k];
    ev.preventDefault = function () {};
    ev.stopPropagation = function () {};
    return ev;
  }
  function noopClass() {
    return function () {
      return {
        observe: function () {},
        unobserve: function () {},
        disconnect: function () {},
        connect: function () {},
        start: function () {},
        stop: function () {},
      };
    };
  }

  const fakeConsole = {
    log: function () {}, warn: function () {}, error: function () {},
    info: function () {}, debug: function () {}, trace: function () {},
    table: function () {}, group: function () {}, groupEnd: function () {},
    time: function () {}, timeEnd: function () {}, assert: function () {}, dir: function () {},
  };

  const storage = {
    getItem: function () { return null; },
    setItem: function () {},
    removeItem: function () {},
    clear: function () {},
    key: function () { return null; },
    length: 0,
  };

  const FakeDate = new Proxy(Date, {
    apply: function () { return new Date(0).toString(); },
    construct: function (target, args) {
      return args.length ? new target(...args) : new target(0);
    },
    get: function (target, key) {
      if (key === "now") return function () { return now; };
      const v = target[key];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });

  const FakeMath = Object.create(Math);
  FakeMath.random = seededRandom;

  const sandbox = {
    console: fakeConsole,
    document: doc,
    Math: FakeMath,
    Date: FakeDate,
    performance: { now: function () { return now; }, mark: function () {}, measure: function () {} },
    requestAnimationFrame: requestAnimationFrameStub,
    cancelAnimationFrame: cancelAnimationFrameStub,
    webkitRequestAnimationFrame: requestAnimationFrameStub,
    requestIdleCallback: setTimeoutStub,
    cancelIdleCallback: clearTimerStub,
    setTimeout: setTimeoutStub,
    clearTimeout: clearTimerStub,
    setInterval: setIntervalStub,
    clearInterval: clearTimerStub,
    queueMicrotask: function (fn) { safeCall(fn); },
    addEventListener: function (type, fn) { addListener(windowListeners, type, fn); },
    removeEventListener: function () {},
    dispatchEvent: function () { return true; },
    innerWidth: 1024,
    innerHeight: 640,
    outerWidth: 1024,
    outerHeight: 640,
    devicePixelRatio: 1,
    scrollX: 0,
    scrollY: 0,
    scrollTo: function () {},
    alert: function () {},
    confirm: function () { return true; },
    prompt: function () { return null; },
    localStorage: storage,
    sessionStorage: storage,
    navigator: {
      userAgent: "RevolverPreview/1.0",
      language: "en-US",
      languages: ["en-US"],
      platform: "linux",
      maxTouchPoints: 0,
      vibrate: function () {},
      getGamepads: function () { return []; },
    },
    location: { href: "about:preview", search: "", hash: "", protocol: "about:", reload: function () {} },
    history: { pushState: function () {}, replaceState: function () {}, back: function () {} },
    screen: { width: 1920, height: 1080, availWidth: 1920, availHeight: 1080 },
    matchMedia: function () {
      return { matches: false, addEventListener: function () {}, removeEventListener: function () {}, addListener: function () {} };
    },
    getComputedStyle: function () { return makeStyle(); },
    Event: EventCtor,
    CustomEvent: EventCtor,
    KeyboardEvent: EventCtor,
    MouseEvent: EventCtor,
    PointerEvent: EventCtor,
    TouchEvent: EventCtor,
    WheelEvent: EventCtor,
    Image: function () { return makeElement("img", ""); },
    Audio: function () { return makeElement("audio", ""); },
    AudioContext: function () {
      return {
        createOscillator: function () {
          return { connect: function () {}, start: function () {}, stop: function () {}, frequency: { value: 0, setValueAtTime: function () {} }, type: "sine" };
        },
        createGain: function () {
          return { connect: function () {}, gain: { value: 1, setValueAtTime: function () {}, exponentialRampToValueAtTime: function () {}, linearRampToValueAtTime: function () {} } };
        },
        createBuffer: function () { return {}; },
        createBufferSource: function () { return { connect: function () {}, start: function () {}, stop: function () {} }; },
        destination: {},
        currentTime: 0,
        resume: function () { return { then: function () {}, catch: function () {} }; },
        close: function () {},
        state: "running",
      };
    },
    Path2D: function () { return { addPath: function () {}, moveTo: function () {}, lineTo: function () {}, rect: function () {}, arc: function () {}, closePath: function () {} }; },
    OffscreenCanvas: function () { return makeElement("canvas", ""); },
    ResizeObserver: noopClass(),
    IntersectionObserver: noopClass(),
    MutationObserver: noopClass(),
    fetch: function () { return Promise.reject(new Error("network disabled in preview check")); },
    XMLHttpRequest: function () {
      return { open: function () {}, send: function () {}, setRequestHeader: function () {}, addEventListener: function () {} };
    },
    structuredClone: function (v) { return JSON.parse(JSON.stringify(v)); },
    crypto: {
      getRandomValues: function (arr) {
        for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(seededRandom() * 256);
        return arr;
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.top = sandbox;
  sandbox.parent = sandbox;
  sandbox.frames = sandbox;
  sandbox.webkitAudioContext = sandbox.AudioContext;
  sandbox.onload = null;
  sandbox.onkeydown = null;
  sandbox.onkeyup = null;
  sandbox.onresize = null;

  const context = vm.createContext(sandbox);

  // ---------- run ----------
  phase = "script";
  for (let i = 0; i < SCRIPTS.length; i++) {
    try {
      vm.runInContext(SCRIPTS[i], context, {
        timeout: SCRIPT_TIMEOUT_MS,
        filename: "page-script-" + (i + 1) + ".js",
      });
    } catch (e) {
      recordError(e);
    }
  }

  phase = "load";
  doc.readyState = "interactive";
  dispatch("DOMContentLoaded", EventCtor("DOMContentLoaded"), [doc, sandbox]);
  doc.readyState = "complete";
  dispatch("load", EventCtor("load"), [sandbox, body, doc]);

  phase = "frame";
  const before = [];
  for (let i = 0; i < FRAMES_BEFORE; i++) before.push(runFrame());

  phase = "input";
  const keyListeners = countKeyListeners();
  const after = [];
  if (withInput) {
    dispatchKey("keydown", "ArrowRight", "ArrowRight", 39);
    dispatchKey("keydown", "d", "KeyD", 68);
  }
  const half = Math.floor(FRAMES_AFTER / 2);
  for (let i = 0; i < half; i++) after.push(runFrame());
  if (withInput) {
    dispatchKey("keydown", " ", "Space", 32);
    dispatchKey("keydown", "ArrowUp", "ArrowUp", 38);
    dispatchKey("keydown", "w", "KeyW", 87);
  }
  for (let i = half; i < FRAMES_AFTER; i++) after.push(runFrame());
  if (withInput) {
    dispatchKey("keyup", "ArrowRight", "ArrowRight", 39);
    dispatchKey("keyup", "d", "KeyD", 68);
    dispatchKey("keyup", " ", "Space", 32);
    dispatchKey("keyup", "ArrowUp", "ArrowUp", 38);
    dispatchKey("keyup", "w", "KeyW", 87);
  }

  const frames = before.concat(after);
  return {
    scripts: SCRIPTS.length,
    contextRequests: contextRequests,
    drawOps: drawOps,
    framesRendered: frames.filter(function (f) { return f.rendered; }).length,
    frameCallbacks: frameCallbacks,
    keyListeners: keyListeners,
    errors: errors,
    beforeSignatures: before.map(function (f) { return f.signature; }),
    afterSignatures: after.map(function (f) { return f.signature; }),
  };
}

function sameSignatures(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

let stats;
try {
  const idle = runSession(false);
  const played = runSession(true);
  const deterministic = sameSignatures(idle.beforeSignatures, played.beforeSignatures);
  let responded;
  if (deterministic) {
    responded = !sameSignatures(idle.afterSignatures, played.afterSignatures);
  } else {
    // Nondeterministic page: fall back to "did anything change after the keypress".
    const baseline = played.beforeSignatures[played.beforeSignatures.length - 1];
    responded = played.afterSignatures.some(function (s) { return s !== baseline; });
  }
  stats = {
    scripts: played.scripts,
    contextRequests: played.contextRequests,
    drawOps: played.drawOps,
    framesRendered: played.framesRendered,
    frameCallbacks: played.frameCallbacks,
    keyListeners: played.keyListeners,
    respondedToInput: responded,
    deterministic: deterministic,
    errors: idle.errors.concat(played.errors).slice(0, 20),
  };
} catch (e) {
  stats = {
    scripts: 0, contextRequests: 0, drawOps: 0, framesRendered: 0, frameCallbacks: 0,
    keyListeners: 0, respondedToInput: false, deterministic: false,
    errors: [{ phase: "harness", message: (e && e.message ? e.message : String(e)).slice(0, 200) }],
  };
}
console.log(SENTINEL + JSON.stringify(stats));
`;

const CHECK_IDS = ["preview-loads", "preview-canvas", "preview-animates", "preview-input"] as const;

function failAll(detail: string): BenchmarkCheckResult[] {
  const labels: Record<(typeof CHECK_IDS)[number], string> = {
    "preview-loads": "Preview: page script runs without errors",
    "preview-canvas": "Preview: canvas is drawn to",
    "preview-animates": "Preview: animation loop keeps running",
    "preview-input": "Preview: responds to keyboard input",
  };
  return CHECK_IDS.map((id) => ({ id, label: labels[id], passed: false, detail, weight: 2 }));
}

function firstMessage(stats: PreviewStats, phases: string[]): string | undefined {
  const hit = stats.errors.find((e) => phases.includes(e.phase));
  return hit ? `${hit.phase}: ${hit.message}` : undefined;
}

/** Turn raw harness stats into scoreable checks. Exported for testing. */
export function derivePreviewChecks(stats: PreviewStats): BenchmarkCheckResult[] {
  const loadErrors = stats.errors.filter((e) => ["script", "load", "harness"].includes(e.phase));
  const runtimeErrors = stats.errors.filter((e) => ["frame", "input"].includes(e.phase));
  const minFrames = Math.floor(FRAMES_BEFORE_INPUT / 2);

  return [
    {
      id: "preview-loads",
      label: "Preview: page script runs without errors",
      passed: stats.scripts > 0 && loadErrors.length === 0,
      weight: 2,
      detail:
        stats.scripts === 0
          ? "No inline <script> found — nothing would run in the preview"
          : loadErrors.length > 0
            ? firstMessage(stats, ["script", "load", "harness"])
            : undefined,
    },
    {
      id: "preview-canvas",
      label: "Preview: canvas is drawn to",
      passed: stats.contextRequests > 0 && stats.drawOps > 0,
      weight: 2,
      detail:
        stats.contextRequests === 0
          ? "getContext() was never called"
          : stats.drawOps === 0
            ? "Canvas context acquired but nothing was ever drawn"
            : undefined,
    },
    {
      id: "preview-animates",
      label: "Preview: animation loop keeps running",
      passed:
        stats.frameCallbacks >= minFrames &&
        stats.framesRendered >= minFrames &&
        runtimeErrors.length === 0,
      weight: 2,
      detail:
        runtimeErrors.length > 0
          ? firstMessage(stats, ["frame", "input"])
          : stats.frameCallbacks < minFrames
            ? `Loop stopped after ${stats.frameCallbacks} frame callback(s); expected at least ${minFrames}`
            : stats.framesRendered < minFrames
              ? `Only ${stats.framesRendered} frame(s) produced output; expected at least ${minFrames}`
              : undefined,
    },
    {
      id: "preview-input",
      label: "Preview: responds to keyboard input",
      passed: stats.keyListeners > 0 && stats.respondedToInput,
      weight: 2,
      detail:
        stats.keyListeners === 0
          ? "No keydown/keyup listeners were registered at runtime"
          : !stats.respondedToInput
            ? `Holding right/jump keys changed nothing on screen${stats.deterministic ? "" : " (page is nondeterministic, comparison is approximate)"}`
            : undefined,
    },
  ];
}

export interface PreviewCheckResult {
  checks: BenchmarkCheckResult[];
  /** Raw harness output, stored as a run artifact for debugging. */
  log: string;
}

/**
 * Run the generated page headlessly to confirm it actually works when opened
 * in the preview pane. Executes model-authored JavaScript in a child process
 * (killed after a timeout) — acceptable for a local, user-invoked benchmark.
 */
export async function runPreviewSmokeCheck(html: string): Promise<PreviewCheckResult> {
  const dir = mkdtempSync(join(tmpdir(), "revolver-preview-"));
  try {
    writeFileSync(join(dir, "page.html"), html, "utf8");
    const harnessPath = join(dir, "harness.cjs");
    writeFileSync(harnessPath, HARNESS_SOURCE, "utf8");

    const { stdout, stderr, timedOut, code } = await runChild(process.execPath, [harnessPath], dir);
    const log = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");

    if (timedOut) {
      return {
        checks: failAll(
          `page hung — no result within ${PREVIEW_TIMEOUT_MS / 1000}s (likely an infinite loop)`,
        ),
        log,
      };
    }

    const line = stdout.split("\n").find((l) => l.startsWith(STATS_SENTINEL));
    if (!line) {
      const reason = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 200);
      return {
        checks: failAll(`preview harness produced no result (exit ${code})${reason ? `: ${reason}` : ""}`),
        log,
      };
    }

    const stats = JSON.parse(line.slice(STATS_SENTINEL.length)) as PreviewStats;
    return { checks: derivePreviewChecks(stats), log: `${log}\n\n${JSON.stringify(stats, null, 2)}` };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { checks: failAll(`preview check error: ${message}`), log: message };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runChild(
  cmd: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; stderr: string; timedOut: boolean; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        // Makes Electron's binary behave as plain node; harmless for real node.
        ELECTRON_RUN_AS_NODE: "1",
        NODE_OPTIONS: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({ stdout, stderr, timedOut: true, code: null });
    }, PREVIEW_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += String(d)));
    child.stderr.on("data", (d) => (stderr += String(d)));
    child.on("error", (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + "\n" + e.message, timedOut: false, code: null });
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut: false, code });
    });
  });
}
