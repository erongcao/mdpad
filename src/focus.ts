import { Compartment } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { view } from "./main";

const dimLine = Decoration.line({ class: "cm-dim" });

// 当前段落 = 光标所在行向上下扩展到空行为止
function activeRange(v: EditorView): [number, number] {
  const doc = v.state.doc;
  const ln = doc.lineAt(v.state.selection.main.head).number;
  let start = ln, end = ln;
  const nonEmpty = (n: number) => doc.line(n).text.trim() !== "";
  while (start > 1 && nonEmpty(start - 1)) start--;
  while (end < doc.lines && nonEmpty(end + 1)) end++;
  return [start, end];
}

const focusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(v: EditorView) { this.decorations = this.compute(v); }
    update(u: ViewUpdate) {
      if (u.selectionSet || u.docChanged || u.viewportChanged) {
        this.decorations = this.compute(u.view);
      }
    }
    compute(v: EditorView) {
      const doc = v.state.doc;
      if (doc.lines > 20000) return Decoration.none; // 超大文档不做，保性能
      const [start, end] = activeRange(v);
      const deco = [];
      for (let n = 1; n <= doc.lines; n++) {
        if (n < start || n > end) deco.push(dimLine.range(doc.line(n).from));
      }
      return Decoration.set(deco, true);
    }
  },
  { decorations: (v) => v.decorations },
);

export const focusCompartment = new Compartment();

let enabled = window.localStorage.getItem("mdpad-focus") === "1";

export function initialFocusExtension() {
  return enabled ? focusPlugin : [];
}

export function toggleFocus() {
  enabled = !enabled;
  window.localStorage.setItem("mdpad-focus", enabled ? "1" : "0");
  view.dispatch({
    effects: focusCompartment.reconfigure(enabled ? focusPlugin : []),
  });
  view.focus();
}
