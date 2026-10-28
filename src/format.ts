import { EditorSelection } from "@codemirror/state";
import { view } from "./main";

/* ---------------- 行内标记 toggle（加粗/斜体/删除线/行内代码） ---------------- */

export function toggleInline(mark: string) {
  view.dispatch(
    view.state.changeByRange((range) => {
      const doc = view.state.doc;
      const before = doc.sliceString(Math.max(0, range.from - mark.length), range.from);
      const after = doc.sliceString(range.to, Math.min(doc.length, range.to + mark.length));
      const isWrapped =
        before === mark &&
        after === mark &&
        (mark !== "*" ||
          (doc.sliceString(Math.max(0, range.from - 2), range.from) !== "**" &&
            doc.sliceString(range.to, Math.min(doc.length, range.to + 2)) !== "**"));

      if (isWrapped && !range.empty) {
        return {
          changes: [
            { from: range.from - mark.length, to: range.from },
            { from: range.to, to: range.to + mark.length },
          ],
          range: EditorSelection.range(range.from - mark.length, range.to - mark.length),
        };
      }
      const selected = doc.sliceString(range.from, range.to);
      const insert = mark + selected + mark;
      return {
        changes: { from: range.from, to: range.to, insert },
        range: selected
          ? EditorSelection.range(range.from + mark.length, range.from + mark.length + selected.length)
          : EditorSelection.cursor(range.from + mark.length),
      };
    }),
  );
  view.focus();
}

/* ---------------- 行级前缀 toggle（标题/引用/列表） ---------------- */

function eachSelectedLine(fn: (line: { from: number; text: string }) => void) {
  const { from, to } = view.state.selection.main;
  const start = view.state.doc.lineAt(from);
  const end = view.state.doc.lineAt(to);
  for (let n = start.number; n <= end.number; n++) {
    const line = view.state.doc.line(n);
    fn({ from: line.from, text: line.text });
  }
}

function togglePrefix(prefix: string, stripRe: RegExp) {
  const changes: { from: number; to: number; insert?: string }[] = [];
  eachSelectedLine((line) => {
    if (line.text.startsWith(prefix)) {
      changes.push({ from: line.from, to: line.from + prefix.length });
    } else {
      const stripped = line.text.replace(stripRe, "");
      const oldLen = line.text.length - stripped.length;
      changes.push({ from: line.from, to: line.from + oldLen, insert: prefix });
    }
  });
  view.dispatch({ changes });
  view.focus();
}

export function toggleHeading(level: number) {
  togglePrefix("#".repeat(level) + " ", /^#{1,6}\s+/);
}

export function toggleQuote() {
  togglePrefix("> ", /^>\s+/);
}

export function toggleList(kind: "ul" | "todo") {
  const prefix = kind === "ul" ? "- " : "- [ ] ";
  togglePrefix(prefix, /^(- \[ \]|- |\d+\.)\s+/);
}

export function toggleOrderedList() {
  let allOrdered = true;
  eachSelectedLine((line) => {
    if (!/^\d+\.\s+/.test(line.text)) allOrdered = false;
  });
  const changes: { from: number; to: number; insert?: string }[] = [];
  let i = 0;
  eachSelectedLine((line) => {
    i++;
    if (allOrdered) {
      const m = line.text.match(/^\d+\.\s+/);
      if (m) changes.push({ from: line.from, to: line.from + m[0].length });
    } else {
      const stripped = line.text.replace(/^(- \[ \]|- |\d+\.)\s+/, "");
      const oldLen = line.text.length - stripped.length;
      changes.push({ from: line.from, to: line.from + oldLen, insert: String(i) + ". " });
    }
  });
  view.dispatch({ changes });
  view.focus();
}

/* ---------------- 代码块 toggle ---------------- */

export function toggleCodeBlock() {
  const fence = String.fromCharCode(96).repeat(3);
  const { from, to } = view.state.selection.main;
  const start = view.state.doc.lineAt(from);
  const end = view.state.doc.lineAt(to);
  const doc = view.state.doc;

  const lineBefore = start.number > 1 ? doc.line(start.number - 1).text.trim() : "";
  const lineAfter = end.number < doc.lines ? doc.line(end.number + 1).text.trim() : "";
  if (lineBefore.startsWith(fence) && lineAfter === fence) {
    const lb = doc.line(start.number - 1);
    const la = doc.line(end.number + 1);
    view.dispatch({
      changes: [
        { from: lb.from, to: start.from },
        { from: end.to, to: la.to },
      ],
    });
  } else {
    view.dispatch({
      changes: [
        { from: start.from, insert: fence + "\n" },
        { from: end.to, insert: "\n" + fence },
      ],
    });
  }
  view.focus();
}

/* ---------------- 插入类 ---------------- */

function ensureBlockStart(): number {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  if (line.text.trim() !== "") {
    view.dispatch({ changes: { from: line.to, insert: "\n\n" } });
    return line.to + 2;
  }
  return line.from;
}

export function insertLink() {
  const range = view.state.selection.main;
  const selected = view.state.doc.sliceString(range.from, range.to);
  const text = selected || "链接文字";
  const insert = "[" + text + "](url)";
  const urlStart = range.from + text.length + 3;
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.range(urlStart, urlStart + 3),
  });
  view.focus();
}

export function insertImage() {
  const range = view.state.selection.main;
  const insert = "![描述](路径)";
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: EditorSelection.range(range.from + 2, range.from + 4),
  });
  view.focus();
}

export function insertTable() {
  const at = ensureBlockStart();
  const table = "| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n";
  view.dispatch({
    changes: { from: at, insert: table },
    selection: EditorSelection.cursor(at + 2),
  });
  view.focus();
}

export function insertFootnote() {
  const docText = view.state.doc.toString();
  let max = 0;
  for (const m of docText.matchAll(/\[\^(\d+)\]/g)) {
    max = Math.max(max, Number(m[1]));
  }
  const n = max + 1;
  const pos = view.state.selection.main.head;
  const mark = "[^" + n + "]";
  view.dispatch({
    changes: [
      { from: pos, insert: mark },
      { from: view.state.doc.length, insert: "\n\n" + mark + ": " },
    ],
  });
  view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length) });
  view.focus();
}

export function insertRule() {
  const at = ensureBlockStart();
  view.dispatch({ changes: { from: at, insert: "---\n" } });
  view.focus();
}

/* ---------------- 分发 ---------------- */

export function runFormat(id: string) {
  const bt = String.fromCharCode(96);
  switch (id) {
    case "fmt_h1": return toggleHeading(1);
    case "fmt_h2": return toggleHeading(2);
    case "fmt_h3": return toggleHeading(3);
    case "fmt_bold": return toggleInline("**");
    case "fmt_italic": return toggleInline("*");
    case "fmt_strike": return toggleInline("~~");
    case "fmt_code": return toggleInline(bt);
    case "fmt_quote": return toggleQuote();
    case "fmt_codeblock": return toggleCodeBlock();
    case "fmt_ul": return toggleList("ul");
    case "fmt_ol": return toggleOrderedList();
    case "fmt_todo": return toggleList("todo");
    case "fmt_link": return insertLink();
    case "fmt_image": return insertImage();
    case "fmt_table": return insertTable();
    case "fmt_footnote": return insertFootnote();
    case "fmt_hr": return insertRule();
  }
}
