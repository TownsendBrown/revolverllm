/** Normalize common LLM math/markdown quirks into GFM + $/$$ math that
 * remark-math + rehype-katex can render. Fenced/inline code is left untouched. */
export function preprocessMath(content: string): string {
  const fenceParts = content.split(/(```[\s\S]*?```)/g);
  return fenceParts
    .map((part, index) => (index % 2 === 1 ? part : normalizeOutsideFences(part)))
    .join("");
}

function normalizeOutsideFences(text: string): string {
  const codeParts = text.split(/(`[^`\n]*`)/g);
  return codeParts
    .map((part, index) => (index % 2 === 1 ? part : normalizeMathDelimiters(part)))
    .join("");
}

function normalizeMathDelimiters(text: string): string {
  let out = text;

  // Display math: \[ ... \] -> $$ ... $$ (own lines so remark treats as block)
  out = out.replace(/\\\[([\s\S]*?)\\\]/g, (_m, expr: string) => `\n\n$$\n${expr.trim()}\n$$\n\n`);

  // Inline math: \( ... \) -> $ ... $
  out = out.replace(/\\\(([\s\S]*?)\\\)/g, (_m, expr: string) => `$${expr.trim()}$`);

  // Escaped dollars used as delimiters by some models: \$ -> $
  out = out.replace(/\\\$/g, "$");

  // Trailing "$...$ $$" junk emitted by some models
  out = out.replace(/(\$[^$\n]+?\$)\s*\$\$/g, "$1");

  // Orphan $$ / $ left on their own line
  out = out.replace(/^\s*\$\$\s*$/gm, "");
  out = out.replace(/^\s*\$\s*$/gm, "");

  // \Bigl / \bigl without an opening paren before sqrt/frac/number
  out = out.replace(/\\Bigl(?![(\[])(\\sqrt|\\frac)/g, "\\Bigl($1");
  out = out.replace(/\\Bigl(?![(\[])([0-9])/g, "\\Bigl($1");
  out = out.replace(/\\bigl(?![(\[])(\\sqrt|\\frac)/g, "\\bigl($1");
  out = out.replace(/\\bigl(?![(\[])([0-9])/g, "\\bigl($1");

  // \Bigr / \bigr without a closing paren (common LLM typo)
  out = out.replace(/\\Bigr(?!\))/g, "\\Bigr)");
  out = out.replace(/\\bigr(?!\))/g, "\\bigr)");

  // Wrap bare, delimiter-less display-math lines in $$ ... $$
  out = wrapBareMathLines(out);

  return out;
}

/** Commands that strongly signal a line is standalone display math, not prose. */
const MATH_TRIGGER =
  /\\(frac|dfrac|tfrac|sqrt|Delta|nabla|partial|sum|prod|int|oint|left|right|boxed|begin|hat|vec|bar|ddot|dot|mathbf|mathrm|mathcal|cdot|times|leq|geq|neq|approx|equiv|infty|propto|alpha|beta|gamma|delta|theta|lambda|mu|nu|rho|sigma|tau|phi|chi|psi|omega|Omega|Gamma|Sigma|Phi|Psi|displaystyle|quad|qquad|overline|underline)\b/;

function isBareDisplayMath(line: string): boolean {
  const t = line.trim();
  if (!t) return false;
  if (t.includes("$")) return false;
  // Skip markdown block markers (headings, lists, quotes, tables, fences, refs).
  if (/^([#>|]|[-*+]\s|\d+[.)]\s|```|:::|\[)/.test(t)) return false;
  if (t.includes("](")) return false;
  if (!/\\[a-zA-Z]+/.test(t)) return false;
  // Either a recognizable math command, or an equation of the form "lhs = rhs"
  // whose right side carries LaTeX.
  return MATH_TRIGGER.test(t) || (/=/.test(t) && /\\[a-zA-Z]+/.test(t) && !/[a-z]{4,}\s+[a-z]{4,}/.test(t));
}

function wrapBareMathLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let inDisplayBlock = false;

  for (const line of lines) {
    const doubleDollars = (line.match(/\$\$/g) || []).length;

    if (inDisplayBlock) {
      out.push(line);
      if (doubleDollars % 2 === 1) inDisplayBlock = false;
      continue;
    }

    if (doubleDollars % 2 === 1) {
      inDisplayBlock = true;
      out.push(line);
      continue;
    }

    if (doubleDollars === 0 && isBareDisplayMath(line)) {
      out.push(`\n$$\n${line.trim()}\n$$\n`);
    } else {
      out.push(line);
    }
  }

  return out.join("\n");
}
