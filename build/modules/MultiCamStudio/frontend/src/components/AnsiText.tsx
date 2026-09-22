import type { CSSProperties, ReactNode } from "react";

const standardColors = [
  "#202521", "#d86159", "#62ad7d", "#d6a75f",
  "#6695cf", "#b783ce", "#56aeb5", "#d7ded9",
];

const brightColors = [
  "#737d76", "#ff7b70", "#7bd99d", "#f0c878",
  "#83b7f2", "#d4a4eb", "#72d2db", "#ffffff",
];

function ansi256(index: number): string {
  if (index < 8) return standardColors[index];
  if (index < 16) return brightColors[index - 8];
  if (index < 232) {
    const value = index - 16;
    const levels = [0, 95, 135, 175, 215, 255];
    const red = levels[Math.floor(value / 36)];
    const green = levels[Math.floor((value % 36) / 6)];
    const blue = levels[value % 6];
    return `rgb(${red}, ${green}, ${blue})`;
  }
  const gray = 8 + (index - 232) * 10;
  return `rgb(${gray}, ${gray}, ${gray})`;
}

function applyCodes(style: CSSProperties, codes: number[]): CSSProperties {
  let next = { ...style };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) next = {};
    else if (code === 1) next.fontWeight = 600;
    else if (code === 2) next.opacity = 0.68;
    else if (code === 3) next.fontStyle = "italic";
    else if (code === 4) next.textDecoration = "underline";
    else if (code === 22) { delete next.fontWeight; delete next.opacity; }
    else if (code === 23) delete next.fontStyle;
    else if (code === 24) delete next.textDecoration;
    else if (code >= 30 && code <= 37) next.color = standardColors[code - 30];
    else if (code >= 90 && code <= 97) next.color = brightColors[code - 90];
    else if (code >= 40 && code <= 47) next.backgroundColor = standardColors[code - 40];
    else if (code >= 100 && code <= 107) next.backgroundColor = brightColors[code - 100];
    else if (code === 39) delete next.color;
    else if (code === 49) delete next.backgroundColor;
    else if ((code === 38 || code === 48) && codes[index + 1] === 5) {
      const color = ansi256(codes[index + 2] ?? 0);
      if (code === 38) next.color = color;
      else next.backgroundColor = color;
      index += 2;
    } else if ((code === 38 || code === 48) && codes[index + 1] === 2) {
      const color = `rgb(${codes[index + 2] ?? 0}, ${codes[index + 3] ?? 0}, ${codes[index + 4] ?? 0})`;
      if (code === 38) next.color = color;
      else next.backgroundColor = color;
      index += 4;
    }
  }
  return next;
}

export default function AnsiText({ text }: { text: string }) {
  const cleanText = text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "");
  const controlSequence = /\x1b\[([0-?]*)([ -/]*)([@-~])/g;
  const output: ReactNode[] = [];
  let style: CSSProperties = {};
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = controlSequence.exec(cleanText)) !== null) {
    if (match.index > cursor) {
      output.push(<span style={{ ...style }} key={output.length}>{cleanText.slice(cursor, match.index)}</span>);
    }
    if (match[3] === "m") {
      const codes = match[1] === "" ? [0] : match[1].split(";").map((value) => Number(value) || 0);
      style = applyCodes(style, codes);
    }
    cursor = controlSequence.lastIndex;
  }

  if (cursor < cleanText.length) {
    output.push(<span style={{ ...style }} key={output.length}>{cleanText.slice(cursor)}</span>);
  }
  return <>{output}</>;
}
