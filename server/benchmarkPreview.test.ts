import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { derivePreviewChecks, runPreviewSmokeCheck, type PreviewStats } from "./benchmarkPreview";
import type { BenchmarkCheckResult } from "../shared/benchmarks/types";

function byId(checks: BenchmarkCheckResult[], id: string): BenchmarkCheckResult {
  const c = checks.find((c) => c.id === id);
  assert.ok(c, `missing check ${id}`);
  return c!;
}

/** Minimal but genuinely playable platformer used as the "known good" fixture. */
const WORKING_GAME = `<!DOCTYPE html>
<html><head><style>canvas { background: #6ac; }</style></head>
<body><canvas id="game" width="640" height="360"></canvas>
<script>
const canvas = document.getElementById("game");
const ctx = canvas.getContext("2d");
const GRAVITY = 0.6;
const player = { x: 20, y: 100, vx: 0, vy: 0, width: 24, height: 32, onGround: false };
const platforms = [
  { x: 0, y: 330, width: 2000, height: 30 },
  { x: 200, y: 260, width: 120, height: 16 },
  { x: 420, y: 200, width: 120, height: 16 },
];
let score = 0;
let lives = 3;
let camera = 0;
const keys = {};
document.addEventListener("keydown", function (e) { keys[e.code] = true; });
document.addEventListener("keyup", function (e) { keys[e.code] = false; });
function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function frame() {
  if (keys.ArrowRight || keys.KeyD) player.vx = 3;
  else if (keys.ArrowLeft || keys.KeyA) player.vx = -3;
  else player.vx = 0;
  if ((keys.Space || keys.ArrowUp) && player.onGround) { player.vy = -12; player.onGround = false; }
  player.vy += GRAVITY;
  player.x += player.vx;
  player.y += player.vy;
  player.onGround = false;
  for (const p of platforms) {
    if (overlaps(player, p) && player.vy >= 0) {
      player.y = p.y - player.height;
      player.vy = 0;
      player.onGround = true;
    }
  }
  camera = Math.max(0, player.x - 200);
  ctx.clearRect(0, 0, 640, 360);
  for (const p of platforms) ctx.fillRect(p.x - camera, p.y, p.width, p.height);
  ctx.fillRect(player.x - camera, player.y, player.width, player.height);
  ctx.fillText("Score: " + score + " Lives: " + lives, 10, 20);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script></body></html>`;

describe("runPreviewSmokeCheck", () => {
  it("passes a working canvas platformer", async () => {
    const { checks } = await runPreviewSmokeCheck(WORKING_GAME);
    assert.equal(checks.length, 4);
    for (const c of checks) assert.equal(c.passed, true, `${c.id}: ${c.detail}`);
  });

  it("fails when the page throws while loading", async () => {
    const broken = `<!DOCTYPE html><html><body><canvas id="c"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
notDefinedAnywhere();
requestAnimationFrame(function loop() { ctx.fillRect(0, 0, 10, 10); requestAnimationFrame(loop); });
</script></body></html>`;
    const { checks } = await runPreviewSmokeCheck(broken);
    const loads = byId(checks, "preview-loads");
    assert.equal(loads.passed, false);
    assert.match(loads.detail ?? "", /notDefinedAnywhere/);
  });

  it("fails when there is no animation loop", async () => {
    const staticPage = `<!DOCTYPE html><html><body><canvas id="c"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
document.addEventListener("keydown", function () {});
ctx.fillRect(0, 0, 100, 100);
</script></body></html>`;
    const { checks } = await runPreviewSmokeCheck(staticPage);
    assert.equal(byId(checks, "preview-loads").passed, true);
    assert.equal(byId(checks, "preview-canvas").passed, true);
    assert.equal(byId(checks, "preview-animates").passed, false);
  });

  it("fails when input is registered but ignored", async () => {
    const deaf = `<!DOCTYPE html><html><body><canvas id="c"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
let x = 0;
document.addEventListener("keydown", function () {});
function loop() {
  x = (x + 1) % 100;
  ctx.clearRect(0, 0, 640, 360);
  ctx.fillRect(x, 50, 20, 20);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
</script></body></html>`;
    const { checks } = await runPreviewSmokeCheck(deaf);
    assert.equal(byId(checks, "preview-animates").passed, true);
    const input = byId(checks, "preview-input");
    assert.equal(input.passed, false);
    assert.match(input.detail ?? "", /changed nothing/);
  });

  it("fails when the loop crashes after a few frames", async () => {
    const crashes = `<!DOCTYPE html><html><body><canvas id="c"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
document.addEventListener("keydown", function () {});
let n = 0;
function loop() {
  n++;
  ctx.fillRect(n, 0, 5, 5);
  if (n === 4) { null.explode(); }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
</script></body></html>`;
    const { checks } = await runPreviewSmokeCheck(crashes);
    assert.equal(byId(checks, "preview-loads").passed, true);
    assert.equal(byId(checks, "preview-animates").passed, false);
  });

  it("fails a page with no script at all", async () => {
    const { checks } = await runPreviewSmokeCheck(
      `<!DOCTYPE html><html><body><canvas id="c"></canvas></body></html>`,
    );
    for (const c of checks) assert.equal(c.passed, false);
    assert.match(byId(checks, "preview-loads").detail ?? "", /No inline <script>/);
  });
});

describe("derivePreviewChecks", () => {
  const healthy: PreviewStats = {
    scripts: 1,
    contextRequests: 1,
    drawOps: 200,
    framesRendered: 24,
    frameCallbacks: 24,
    keyListeners: 2,
    respondedToInput: true,
    deterministic: true,
    errors: [],
  };

  it("passes healthy stats with weighted checks", () => {
    const checks = derivePreviewChecks(healthy);
    for (const c of checks) {
      assert.equal(c.passed, true);
      assert.equal(c.weight, 2);
    }
  });

  it("reports the canvas failure mode precisely", () => {
    const acquired = derivePreviewChecks({ ...healthy, drawOps: 0 });
    assert.match(byId(acquired, "preview-canvas").detail ?? "", /nothing was ever drawn/);
    const missing = derivePreviewChecks({ ...healthy, contextRequests: 0, drawOps: 0 });
    assert.match(byId(missing, "preview-canvas").detail ?? "", /getContext\(\) was never called/);
  });

  it("treats runtime errors as an animation failure, not a load failure", () => {
    const checks = derivePreviewChecks({
      ...healthy,
      errors: [{ phase: "frame", message: "x is not a function" }],
    });
    assert.equal(byId(checks, "preview-loads").passed, true);
    assert.equal(byId(checks, "preview-animates").passed, false);
    assert.match(byId(checks, "preview-animates").detail ?? "", /x is not a function/);
  });

  it("notes when the input comparison was approximate", () => {
    const checks = derivePreviewChecks({ ...healthy, respondedToInput: false, deterministic: false });
    assert.match(byId(checks, "preview-input").detail ?? "", /nondeterministic/);
  });
});
