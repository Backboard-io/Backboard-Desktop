// A deliberately tiny syntax highlighter for the demo's editor. It only has to
// look right for the handful of files in data.ts, using Dark Modern colours.

export type Tok = [cls: string, text: string];

const RULES: Record<string, [RegExp, string[]]> = {
  ts: [
    /(\/\/.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b(?:import|from|export|default|const|let|return|async|await|function|if|else|new|type|as|keyof|typeof)\b)|(\b(?:true|false|null|undefined)\b)|(\b\d+(?:\.\d+)?\b)|(<\/?[A-Za-z][\w.]*|\/?>)|(\b[A-Z][A-Za-z0-9]*\b)|(\b[a-zA-Z_$][\w$]*(?=\())|(\b[a-zA-Z_$][\w$]*\b)/g,
    ["c", "s", "k", "k2", "n", "tag", "ty", "f", "v"],
  ],
  css: [
    /(\/\*.*?\*\/)|(^\s*[.#:]?[\w-][\w\s.#:>-]*(?=\s*\{))|([\w-]+(?=\s*:))|(#[0-9a-fA-F]{3,8}\b)|(\b\d+(?:\.\d+)?(?:px|rem|em|%|s|vw|vh)?\b)|("[^"]*")|(\b[a-z-]+(?=\())/g,
    ["c", "sel", "prop", "n", "n", "s", "f"],
  ],
  json: [/("(?:[^"\\]|\\.)*"(?=\s*:))|("(?:[^"\\]|\\.)*")|(\b\d+(?:\.\d+)?\b)|(\b(?:true|false|null)\b)/g, ["v", "s", "n", "k"]],
  yml: [/(#.*$)|(^\s*-?\s*[\w-]+(?=:))|("[^"]*"|'[^']*')|(\b\d+\b)/g, ["c", "v", "s", "n"]],
  md: [/(^#+ .*$)|(\*\*[^*]+\*\*)|(`[^`]+`)|(^ {4}.*$)/g, ["k", "b", "s", "s"]],
};

export function langOf(path: string) {
  if (/\.(tsx?|jsx?)$/.test(path)) return "ts";
  if (path.endsWith(".css")) return "css";
  if (path.endsWith(".json")) return "json";
  if (/\.ya?ml$/.test(path)) return "yml";
  if (path.endsWith(".md")) return "md";
  return "txt";
}

export function highlight(line: string, lang: string): Tok[] {
  const rule = RULES[lang];
  if (!rule) return [["", line]];
  const [re, names] = rule;
  const out: Tok[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(["", line.slice(last, m.index)]);
    const g = m.slice(1).findIndex((x) => x !== undefined);
    out.push([names[g] ?? "", m[0]]);
    last = m.index + m[0].length;
  }
  if (last < line.length) out.push(["", line.slice(last)]);
  return out;
}
