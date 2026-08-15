import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateBenchmarkOutput, scoreFromChecks } from "./evaluators";

function checkById(result: ReturnType<typeof evaluateBenchmarkOutput>, id: string) {
  const c = result.checks.find((c) => c.id === id);
  assert.ok(c, `missing check ${id}`);
  return c!;
}

describe("scoreFromChecks", () => {
  it("sums weights", () => {
    const { score, max } = scoreFromChecks([
      { id: "a", label: "a", passed: true, weight: 2 },
      { id: "b", label: "b", passed: false, weight: 2 },
      { id: "c", label: "c", passed: true },
    ]);
    assert.equal(score, 3);
    assert.equal(max, 5);
  });
});

describe("website-generation", () => {
  const good = `<!DOCTYPE html>
<html><head><style>main { display: flex; }</style></head>
<body>
<nav><a>Home</a><a>Menu</a><a>Contact</a></nav>
<h1>Revolver Roasters</h1>
<section id="menu">
  <li>Espresso — $3.00</li><li>Latte — $4.50</li><li>Cold Brew — $4.00</li>
</section>
<section id="contact">123 Bean Street. Open 7am–5pm daily.</section>
</body></html>`;

  it("passes a complete page", () => {
    const result = evaluateBenchmarkOutput("website-generation", good);
    assert.equal(result.automatedScore, result.automatedMaxScore);
  });

  it("fails price check with fewer than 3 prices", () => {
    const result = evaluateBenchmarkOutput(
      "website-generation",
      good.replace("$4.50", "four fifty").replace("$4.00", "four"),
    );
    const c = checkById(result, "menu-prices");
    assert.equal(c.passed, false);
    assert.match(c.detail ?? "", /Found 1 price/);
  });

  it("fails clean-output when wrapped in fences", () => {
    const result = evaluateBenchmarkOutput("website-generation", "```html\n" + good + "\n```");
    assert.equal(checkById(result, "clean-output").passed, false);
    // Content checks still pass after fence stripping.
    assert.equal(checkById(result, "structure").passed, true);
  });

  it("fails self-contained when external resources referenced", () => {
    const withCdn = good.replace(
      "<head>",
      `<head><script src="https://cdn.example.com/lib.js"></script>`,
    );
    assert.equal(
      checkById(evaluateBenchmarkOutput("website-generation", withCdn), "self-contained").passed,
      false,
    );
  });
});

describe("platformer-game", () => {
  it("requires real listeners and physics, not keywords", () => {
    const keywordStuffing = `<html><body><canvas></canvas><script>
// keydown keyup gravity jump platforms enemy coin score lives camera collision
</script></body></html>`;
    const result = evaluateBenchmarkOutput("platformer-game", keywordStuffing);
    assert.equal(checkById(result, "canvas").passed, false); // no getContext
    assert.equal(checkById(result, "keyboard").passed, false); // no addEventListener
    assert.equal(checkById(result, "gravity").passed, false); // no velocity accumulation
    assert.equal(checkById(result, "platforms").passed, false); // no platform rectangles
  });

  it("passes a real implementation", () => {
    const game = `<!DOCTYPE html><html><body><canvas id="c" width="640" height="360"></canvas><script>
const ctx = document.getElementById("c").getContext("2d");
const GRAVITY = 0.6;
const player = { x: 20, y: 0, vx: 0, vy: 0, width: 24, height: 32, lives: 3 };
const platforms = [
  { x: 0, y: 330, width: 2000, height: 30 },
  { x: 200, y: 260, width: 120, height: 16 },
  { x: 420, y: 200, width: 120, height: 16 },
];
const coins = [{ x: 240, y: 230, width: 12, height: 12 }];
const enemies = [{ x: 500, y: 300, width: 24, height: 24, dir: 1 }];
let score = 0;
let camera = 0;
const keys = {};
document.addEventListener("keydown", (e) => { keys[e.code] = true; });
document.addEventListener("keyup", (e) => { keys[e.code] = false; });
function overlaps(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}
function loop(dt) {
  if (keys.ArrowRight || keys.KeyD) player.vx = 3;
  else if (keys.ArrowLeft || keys.KeyA) player.vx = -3;
  else player.vx = 0;
  if ((keys.Space || keys.ArrowUp) && player.onGround) { player.vy = -12; player.onGround = false; }
  player.vy += GRAVITY;
  player.x += player.vx;
  player.y += player.vy;
  for (const p of platforms) {
    if (overlaps(player, p) && player.vy >= 0) { player.y = p.y - player.height; player.vy = 0; player.onGround = true; }
  }
  for (const e of enemies) { e.x += e.dir; if (overlaps(player, e)) { player.lives--; player.x = 20; } }
  for (const c of coins) { if (overlaps(player, c)) { score += 1; c.x = -999; } }
  camera = player.x - 200;
  ctx.clearRect(0, 0, 640, 360);
  ctx.fillText("Score: " + score + "  Lives: " + player.lives, 10, 20);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);
</script></body></html>`;
    const result = evaluateBenchmarkOutput("platformer-game", game);
    assert.equal(result.automatedScore, result.automatedMaxScore);
  });
});

describe("frontend-design", () => {
  it("counts card elements from class attributes", () => {
    const html = `<!DOCTYPE html><html><head><style>
.grid { display: grid; } .card { box-shadow: 0 1px 2px #0002; border-radius: 8px; }
</style></head><body>
<header><span class="avatar"></span></header>
<aside class="sidebar">nav</aside>
<div class="grid">
  <div class="card">Revenue ↑ +12%</div><div class="card">Users</div>
  <div class="card">Churn</div><div class="card">MRR</div>
</div></body></html>`;
    const result = evaluateBenchmarkOutput("frontend-design", html);
    assert.equal(result.automatedScore, result.automatedMaxScore);
  });

  it("fails card count when only prose mentions cards", () => {
    const html = `<!DOCTYPE html><html><head><style>div{display:flex}</style></head>
<body><p>cards cards cards cards</p></body></html>`;
    const result = evaluateBenchmarkOutput("frontend-design", html);
    assert.equal(checkById(result, "cards").passed, false);
  });
});
