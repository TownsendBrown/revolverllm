import type { BenchmarkCategory, BenchmarkCheckResult } from "./types";

export function stripMarkdownFences(text: string): string {
  return text
    .replace(/^```(?:html|typescript|ts|tsx|javascript|js)?\s*\n?/im, "")
    .replace(/\n?```\s*$/im, "")
    .trim();
}

export function scoreFromChecks(checks: BenchmarkCheckResult[]): { score: number; max: number } {
  let score = 0;
  let max = 0;
  for (const c of checks) {
    const w = c.weight ?? 1;
    max += w;
    if (c.passed) score += w;
  }
  return { score, max };
}

function check(
  id: string,
  label: string,
  passed: boolean,
  opts?: { detail?: string; weight?: number },
): BenchmarkCheckResult {
  const result: BenchmarkCheckResult = { id, label, passed };
  if (opts?.weight != null) result.weight = opts.weight;
  if (opts?.detail && !passed) result.detail = opts.detail;
  return result;
}

/** True when output is bare code — no markdown fences and no leading prose. */
function isCleanCodeOutput(raw: string, expectedStart: RegExp): boolean {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) return false;
  return expectedStart.test(trimmed);
}

/** No external stylesheets, scripts, images, or fonts — must be self-contained. */
function isSelfContained(html: string): { passed: boolean; detail?: string } {
  const external =
    html.match(/<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=\s*["']?(?:https?:)?\/\//gi) ??
    [];
  if (external.length === 0) return { passed: true };
  return {
    passed: false,
    detail: `Found ${external.length} external resource reference(s), e.g. ${external[0]?.slice(0, 80)}`,
  };
}

function countMatches(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

function evalWebsiteGeneration(output: string): BenchmarkCheckResult[] {
  const html = stripMarkdownFences(output);
  const lower = html.toLowerCase();
  const selfContained = isSelfContained(html);
  const priceCount = countMatches(html, /(?:[$€£]\s?\d+(?:[.,]\d{1,2})?)|(?:\d+(?:[.,]\d{1,2})?\s?(?:USD|EUR|kr|€|£|\$))/g);
  const navLinks = ["home", "menu", "contact"].filter((l) => {
    const navSection = lower.match(/<nav[\s>][\s\S]*?<\/nav>/)?.[0] ?? lower;
    return navSection.includes(l);
  });

  return [
    check(
      "clean-output",
      "Bare HTML output (no fences or prose)",
      isCleanCodeOutput(output, /^<!doctype\s+html/i),
      { detail: "Output should start with <!DOCTYPE html> and contain no markdown fences" },
    ),
    check("structure", "Valid document structure (doctype, html, head, body)",
      /<!doctype\s+html/i.test(html) &&
        /<html[\s>]/i.test(html) &&
        /<head[\s>]/i.test(html) &&
        /<body[\s>]/i.test(html),
      { detail: "Missing one of: <!DOCTYPE html>, <html>, <head>, <body>" },
    ),
    check("css", "Embedded CSS via <style>", /<style[\s>]/i.test(html), {
      detail: "No <style> block found",
    }),
    check("nav-links", "Navigation with Home, Menu, and Contact links", navLinks.length === 3, {
      detail: `Found ${navLinks.length}/3 required nav links (${navLinks.join(", ") || "none"})`,
      weight: 2,
    }),
    check("shop-name", "Shop name \"Revolver Roasters\" present",
      lower.includes("revolver roasters") ||
        (lower.includes("revolver") && lower.includes("roaster")),
    ),
    check("menu-prices", "Menu lists at least 3 priced drinks", priceCount >= 3, {
      detail: `Found ${priceCount} price(s); expected at least 3`,
      weight: 2,
    }),
    check("contact", "Contact section with address and hours",
      (lower.includes("address") || /\d+\s+\w+\s+(?:st|street|ave|avenue|rd|road|blvd|lane|ln|way)\b/i.test(html)) &&
        (/\b\d{1,2}\s*(?:am|pm)\b/i.test(html) || lower.includes("hours") || lower.includes("open")),
      { detail: "Expected both an address and opening hours" },
    ),
    check("layout", "Flexbox or grid layout", /display\s*:\s*(?:flex|grid)/i.test(html), {
      detail: "No display:flex or display:grid rule found",
    }),
    check("self-contained", "Self-contained (no external resources)", selfContained.passed, {
      detail: selfContained.detail,
    }),
  ];
}

function evalPlatformerGame(output: string): BenchmarkCheckResult[] {
  const html = stripMarkdownFences(output);
  const lower = html.toLowerCase();
  const selfContained = isSelfContained(html);
  const velocityUpdate = /(?:vy|dy|vel(?:ocity)?Y|ySpeed|speedY)\s*(?:\+=|=\s*[\w.]+\s*\+)/i;

  return [
    check(
      "clean-output",
      "Bare HTML output (no fences or prose)",
      isCleanCodeOutput(output, /^<!doctype\s+html|^<html[\s>]/i),
      { detail: "Output should start with the HTML document, no markdown fences" },
    ),
    check("canvas", "Canvas element with rendering context",
      /<canvas[\s>]/i.test(html) && /getContext\s*\(\s*['"](?:2d|webgl2?)['"]/i.test(html),
      { detail: "Expected a <canvas> plus a getContext('2d'/'webgl') call", weight: 2 },
    ),
    check("game-loop", "requestAnimationFrame game loop",
      lower.includes("requestanimationframe"),
      { detail: "No requestAnimationFrame call found" },
    ),
    check("keyboard", "Keyboard event listeners wired up",
      /addEventListener\s*\(\s*['"]key(?:down|up)['"]/i.test(html) ||
        /onkey(?:down|up)\s*=/i.test(html),
      { detail: "No keydown/keyup listeners found", weight: 2 },
    ),
    check("movement-keys", "Left/right movement on arrows or A/D",
      /Arrow(?:Left|Right)/.test(html) || /Key[AD]\b/.test(html) || /['"][ad]['"]/.test(html),
      { detail: "No ArrowLeft/ArrowRight or A/D key handling found" },
    ),
    check("gravity", "Gravity applied to vertical velocity",
      /gravity/i.test(html) && velocityUpdate.test(html),
      {
        detail: "Expected a gravity constant plus a vertical velocity accumulation (e.g. vy += gravity)",
        weight: 2,
      },
    ),
    check("jump", "Jump triggered by a jump key",
      (/Space|ArrowUp|Key[WX]|keyCode\s*===?\s*32/.test(html) || /\bjump\b/i.test(html)) &&
        (/\.vy\s*=\s*-|\.vel(?:ocity)?Y\s*=\s*-|ySpeed\s*=\s*-/i.test(html) ||
          /\bjump\s*\(/i.test(html)),
      { detail: "No jump (upward velocity on Space/ArrowUp/W) found" },
    ),
    check("platforms", "Platform collection with at least 3 entries",
      /platforms?\s*(?:[:=]|\.push)/i.test(html) &&
        (countMatches(html, /\{\s*x\s*:/g) >= 3 || countMatches(html, /new\s+Platform\s*\(/g) >= 3),
      {
        detail: "Expected a platforms array/collection defining at least 3 rectangles",
        weight: 2,
      },
    ),
    check("collision", "Axis-aligned rectangle collision test",
      /\.x\s*[<>+]/.test(html) && /\.y\s*[<>+]/.test(html) &&
        (/width/i.test(html) && /height/i.test(html)),
      { detail: "No AABB-style overlap test on x/y plus width/height found", weight: 2 },
    ),
    check("enemy", "Patrolling enemy present",
      /enem(?:y|ies)|goomba/i.test(html),
      { detail: "No enemy found" },
    ),
    check("coins-score", "Collectible coins that increase a score",
      /coin/i.test(html) && /score\s*(?:\+=|\+\+|=\s*score\s*\+)/i.test(html),
      { detail: "Expected coins plus a score increment" },
    ),
    check("lives", "Life counter",
      /liv(?:es)|lives|health/i.test(html),
      { detail: "No lives/health counter found" },
    ),
    check("hud", "HUD rendering score on screen",
      /fillText\s*\(/i.test(html) || /(?:innerText|textContent|innerHTML)\s*=/.test(html),
      { detail: "Expected score/lives actually rendered (fillText or DOM update)" },
    ),
    check("camera", "Scrolling camera for a level wider than the canvas",
      /camera|scrollX|offsetX|viewport|translate\s*\(/i.test(html),
      { detail: "No camera/scroll offset found — level appears fixed to the canvas" },
    ),
    check("self-contained", "Self-contained (no external resources)", selfContained.passed, {
      detail: selfContained.detail,
    }),
  ];
}

function evalFrontendDesign(output: string): BenchmarkCheckResult[] {
  const html = stripMarkdownFences(output);
  const lower = html.toLowerCase();
  const selfContained = isSelfContained(html);
  const cardCount = countMatches(html, /class\s*=\s*["'][^"']*(?:card|metric|stat)[^"']*["']/gi);

  return [
    check(
      "clean-output",
      "Bare HTML output (no fences or prose)",
      isCleanCodeOutput(output, /^<!doctype\s+html/i),
      { detail: "Output should start with <!DOCTYPE html>, no markdown fences" },
    ),
    check("structure", "Valid document with embedded CSS",
      /<!doctype\s+html/i.test(html) && /<style[\s>]/i.test(html),
      { detail: "Missing doctype or <style> block" },
    ),
    check("grid", "CSS grid or flex layout for cards",
      /display\s*:\s*grid/i.test(html) || /display\s*:\s*flex/i.test(html),
      { detail: "No grid/flex layout rule found" },
    ),
    check("cards", "At least 4 metric card elements", cardCount >= 4, {
      detail: `Found ${cardCount} card-like element(s); expected at least 4`,
      weight: 2,
    }),
    check("trend", "Trend indicators on cards",
      /[▲▼↑↓⬆⬇]|trend|[+-]\s?\d+(?:\.\d+)?\s?%/.test(html),
      { detail: "No trend arrows or percentage-change indicators found" },
    ),
    check("sidebar", "Sidebar navigation",
      /<aside[\s>]/i.test(html) || /class\s*=\s*["'][^"']*sidebar/i.test(html),
      { detail: "No <aside> or sidebar element found" },
    ),
    check("header", "Header bar with title and avatar",
      /<header[\s>]/i.test(html) && lower.includes("avatar"),
      { detail: "Expected a <header> containing an avatar placeholder" },
    ),
    check("polish", "Visual polish (shadows and rounded corners)",
      /box-shadow/i.test(html) && /border-radius/i.test(html),
      { detail: "Expected both box-shadow and border-radius rules" },
    ),
    check("self-contained", "Self-contained (no external resources)", selfContained.passed, {
      detail: selfContained.detail,
    }),
  ];
}

export function evaluateBenchmarkOutput(
  testId: BenchmarkCategory,
  output: string,
): { checks: BenchmarkCheckResult[]; automatedScore: number; automatedMaxScore: number } {
  let checks: BenchmarkCheckResult[];
  switch (testId) {
    case "website-generation":
      checks = evalWebsiteGeneration(output);
      break;
    case "platformer-game":
      checks = evalPlatformerGame(output);
      break;
    case "frontend-design":
      checks = evalFrontendDesign(output);
      break;
    default:
      checks = [{ id: "unknown", label: "Unknown test", passed: false }];
  }
  const { score, max } = scoreFromChecks(checks);
  return { checks, automatedScore: score, automatedMaxScore: max };
}
