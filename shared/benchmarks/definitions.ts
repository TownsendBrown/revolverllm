import type { BenchmarkDefinition } from "./types";

export const BENCHMARK_DEFINITIONS: BenchmarkDefinition[] = [
  {
    id: "website-generation",
    version: "1.1.0",
    kind: "generation",
    name: "Website Generation",
    description: "Generate a complete single-page website from a brief.",
    supportsHumanEval: true,
    prompt: `Create a complete, self-contained HTML page for a small coffee shop called "Revolver Roasters".

Requirements:
- Valid HTML5 with inline CSS (no external dependencies)
- Header with shop name and navigation links (Home, Menu, Contact)
- Hero section with a tagline
- Menu section listing at least 3 drinks with prices
- Contact section with address and hours
- Responsive-friendly layout using flexbox or grid
- Pleasant color scheme

Return ONLY the HTML document, starting with <!DOCTYPE html>. No markdown fences or explanation.`,
  },
  {
    id: "platformer-game",
    version: "1.0.0",
    kind: "generation",
    name: "Platformer Game",
    description: "Generate a browser-based 2D side-scrolling platformer in the style of Mario.",
    supportsHumanEval: true,
    prompt: `Create a self-contained HTML file with inline CSS and JavaScript that implements a simple 2D side-scrolling platformer game in the style of classic Mario.

Requirements:
- Use HTML5 canvas for rendering
- A player character viewed from the side that runs left and right with the arrow keys or A/D
- Jumping with gravity: the player accelerates downward, lands on solid ground, and cannot jump again mid-air
- At least 3 platforms the player can stand on, using axis-aligned rectangle collision (land on top, never fall through)
- At least one patrolling enemy — colliding with it costs a life and resets the player
- Collectible coins that increase a score when touched
- An on-screen HUD showing score and lives
- A level wider than the canvas, with the camera scrolling to follow the player
- Game loop using requestAnimationFrame, with movement scaled by elapsed time
- The game must start running as soon as the page loads, with no external files and no build step

Return ONLY the HTML document, starting with <!DOCTYPE html>. No markdown fences or explanation.`,
  },
  {
    id: "livecodebench",
    version: "1.0.0",
    kind: "suite",
    name: "LiveCodeBench",
    description:
      "Contamination-free coding eval (LeetCode/AtCoder/CodeForces) via Docker. Default: debug slice (15 problems), release_v1, n=1. Set REVOLVER_LCB_FULL=1 for the full release. Requires Docker.",
    supportsHumanEval: false,
  },
  {
    id: "evalplus",
    version: "1.0.0",
    kind: "suite",
    name: "EvalPlus (HumanEval+)",
    description:
      "Rigorous HumanEval+/MBPP+ code evaluation via Docker (ganler/evalplus-compatible image). Default: humaneval mini, greedy decoding against the loaded OpenAI-compatible server. Requires Docker.",
    supportsHumanEval: false,
  },
  {
    id: "frontend-design",
    version: "1.1.0",
    kind: "generation",
    name: "Frontend Design",
    description: "Design a polished dashboard UI component.",
    supportsHumanEval: true,
    prompt: `Create a self-contained HTML page showcasing a modern analytics dashboard card layout.

Requirements:
- Valid HTML5 with inline CSS (no external dependencies)
- A grid of at least 4 metric cards (title, value, trend indicator)
- A sidebar navigation with icons (can be Unicode symbols)
- Consistent typography and spacing
- Subtle shadows, rounded corners, and a cohesive color palette
- A header bar with a page title and user avatar placeholder
- Dark or light theme applied consistently

Return ONLY the HTML document. No markdown fences or explanation.`,
  },
  {
    id: "performance",
    version: "1.0.0",
    kind: "suite",
    name: "Performance (Prefill / Decode)",
    description:
      "Measure prefill and decode tokens/sec at 5 increasing context sizes. 1 warmup + 3 trials per scenario, median reported. Temperature 0, seed 42, prompt caching disabled.",
    supportsHumanEval: false,
  },
  {
    id: "context-retrieval",
    version: "1.0.0",
    kind: "suite",
    name: "Long Context Retrieval",
    description:
      "Needle-in-a-haystack: fill the context window, hide a passphrase at 0/25/50/75/100% depth, ask the model to retrieve it. 3 trials per depth, 15 total. Temperature 0, seed 42.",
    supportsHumanEval: false,
  },
  {
    id: "agency",
    version: "1.0.0",
    kind: "suite",
    name: "Agency (Tool Use)",
    description:
      "Multi-step tool-calling scenarios against the simulated MiniCorp environment (8 tools). Pass/fail scoring of tool selection, argument accuracy, chains, and restraint. Temperature 0, seed 42, max 8 tool rounds, fixed sandbox clock.",
    supportsHumanEval: false,
  },
];

export function getBenchmarkDefinition(id: string): BenchmarkDefinition | undefined {
  return BENCHMARK_DEFINITIONS.find((d) => d.id === id);
}

export function allBenchmarkIds(): BenchmarkDefinition["id"][] {
  return BENCHMARK_DEFINITIONS.map((d) => d.id);
}
