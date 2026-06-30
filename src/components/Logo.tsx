import logoText from "../../img/logo.txt?raw";

function cropAsciiArt(raw: string): string {
  const lines = raw.split("\n").map((line) => line.trimEnd());
  while (lines.length && !lines[0].trim()) lines.shift();
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return "";

  let minCol = Infinity;
  let maxCol = -1;
  for (const line of lines) {
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== " ") {
        minCol = Math.min(minCol, i);
        maxCol = Math.max(maxCol, i);
      }
    }
  }
  if (minCol === Infinity) return "";

  return lines.map((line) => line.slice(minCol, maxCol + 1)).join("\n");
}

const logoArt = cropAsciiArt(logoText);

export default function Logo() {
  return (
    <div className="brand-logo" aria-label="Revolver">
      <pre className="brand-logo-art">{logoArt}</pre>
    </div>
  );
}
