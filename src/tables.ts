import { EditorSelection, Prec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { view, inTauri } from "./main";

/* ================= 表格解析 ================= */

interface TableInfo {
  startLine: number; // 1 起始行号
  endLine: number;
  sepLine: number;   // 分隔行行号
  header: string[];
  aligns: string[]; // none | left | center | right
  rows: string[][];
  cols: number;
}

function isTableLine(text: string): boolean {
  const t = text.trim();
  return t.startsWith("|") && t.length > 1;
}

function isSepLine(text: string): boolean {
  const t = text.trim();
  return /^\|?[\s:|-]+\|?$/.test(t) && t.includes("-");
}

function parseCells(text: string): string[] {
  let t = text.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|")) t = t.slice(0, -1);
  return t.split("|").map((c) => c.trim());
}

function parseAligns(cells: string[]): string[] {
  return cells.map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : l ? "left" : r ? "right" : "none";
  });
}

// 代码围栏内的竖线不算表格
function inCodeFence(lineNumber: number): boolean {
  const doc = view.state.doc;
  let fences = 0;
  for (let n = 1; n < lineNumber; n++) {
    if (/^\s*```/.test(doc.line(n).text)) fences++;
  }
  return fences % 2 === 1;
}

export function getTableAt(pos: number): TableInfo | null {
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  if (!isTableLine(line.text) || inCodeFence(line.number)) return null;
  let start = line.number;
  while (start > 1 && isTableLine(doc.line(start - 1).text)) start--;
  let end = line.number;
  while (end < doc.lines && isTableLine(doc.line(end + 1).text)) end++;
  if (end - start < 1) return null;
  let sep = -1;
  for (let n = start; n <= end; n++) {
    if (isSepLine(doc.line(n).text)) { sep = n; break; }
  }
  if (sep < 0 || sep === start || sep === end) return null;
  const header = parseCells(doc.line(start).text);
  const aligns = parseAligns(parseCells(doc.line(sep).text));
  const rows: string[][] = [];
  for (let n = sep + 1; n <= end; n++) rows.push(parseCells(doc.line(n).text));
  const cols = Math.max(header.length, aligns.length, ...rows.map((r) => r.length), 1);
  const norm = (arr: string[]) => { while (arr.length < cols) arr.push(""); return arr; };
  const normAlign = (arr: string[]) => { while (arr.length < cols) arr.push("none"); return arr; };
  return { startLine: start, endLine: end, sepLine: sep, header: norm(header), aligns: normAlign(aligns), rows: rows.map(norm), cols };
}

/* ================= 重建与格式化 ================= */

// 显示宽度：中日韩等宽字符按 2 算
function dw(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) || 0;
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6);
    w += wide ? 2 : 1;
  }
  return w;
}

function pad(s: string, w: number): string {
  const d = w - dw(s);
  return d > 0 ? s + " ".repeat(d) : s;
}

function sepCell(align: string, w: number): string {
  const base = "-".repeat(Math.max(3, w));
  if (align === "left") return ":" + base.slice(1);
  if (align === "right") return base.slice(0, -1) + ":";
  if (align === "center") return ":" + base.slice(2) + ":";
  return base;
}

function buildLines(t: TableInfo): string[] {
  const widths: number[] = [];
  for (let c = 0; c < t.cols; c++) {
    widths[c] = Math.max(3, dw(t.header[c]), ...t.rows.map((r) => dw(r[c])));
  }
  const lineOf = (cells: string[]) => "| " + cells.map((c, i) => pad(c, widths[i])).join(" | ") + " |";
  const sep = "|" + t.aligns.map((a, i) => " " + sepCell(a, widths[i]) + " ").join("|") + "|";
  return [lineOf(t.header), sep, ...t.rows.map(lineOf)];
}

function rebuild(t: TableInfo) {
  const doc = view.state.doc;
  const from = doc.line(t.startLine).from;
  const to = doc.line(t.endLine).to;
  view.dispatch({ changes: { from, to, insert: buildLines(t).join("\n") } });
}

function flash(msg: string) {
  const meta = document.querySelector("#meta");
  if (!meta) return;
  const old = meta.textContent;
  meta.textContent = msg;
  window.setTimeout(() => { if (meta.textContent === msg) meta.textContent = old; }, 2000);
}

export function formatTable(): void {
  const t = getTableAt(view.state.selection.main.head);
  if (!t) return flash("光标不在表格内");
  rebuild(t);
  view.focus();
}

/* ================= 行列操作 ================= */

// 当前光标所在行是数据行下标（-1 表头，-2 分隔行）
function cursorRow(t: TableInfo): number {
  const ln = view.state.doc.lineAt(view.state.selection.main.head).number;
  if (ln === t.startLine) return -1;
  if (ln === t.sepLine) return -2;
  return ln - t.sepLine - 1;
}

function cursorCol(): number {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, Math.max(0, pos - line.from));
  const pipes = (before.match(/\|/g) || []).length;
  return Math.max(0, pipes - 1);
}

export function insertRow(above: boolean): void {
  const t = getTableAt(view.state.selection.main.head);
  if (!t) return flash("光标不在表格内");
  let r = cursorRow(t);
  if (r === -2) r = -1; // 分隔行按表头算
  const empty = Array(t.cols).fill("");
  if (r === -1) {
    if (above) { t.header = empty; } else { t.rows.unshift(Array(t.cols).fill("")); }
  } else {
    t.rows.splice(above ? r : r + 1, 0, empty);
  }
  rebuild(t);
  view.focus();
}

export function deleteRow(): void {
  const t = getTableAt(view.state.selection.main.head);
  if (!t) return flash("光标不在表格内");
  const r = cursorRow(t);
  if (r === -2) return flash("分隔行不能删");
  if (r === -1) {
    t.header = t.rows.shift() ?? Array(t.cols).fill("");
  } else {
    t.rows.splice(r, 1);
  }
  rebuild(t);
  view.focus();
}

export function insertCol(left: boolean): void {
  const t = getTableAt(view.state.selection.main.head);
  if (!t) return flash("光标不在表格内");
  const c = Math.min(cursorCol(), t.cols - 1);
  const idx = left ? c : c + 1;
  t.header.splice(idx, 0, "");
  t.aligns.splice(idx, 0, "none");
  t.rows.forEach((r) => r.splice(idx, 0, ""));
  t.cols++;
  rebuild(t);
  view.focus();
}

export function deleteCol(): void {
  const t = getTableAt(view.state.selection.main.head);
  if (!t) return flash("光标不在表格内");
  if (t.cols <= 1) return flash("只剩一列，不能删");
  const c = Math.min(cursorCol(), t.cols - 1);
  t.header.splice(c, 1);
  t.aligns.splice(c, 1);
  t.rows.forEach((r) => r.splice(c, 1));
  t.cols--;
  rebuild(t);
  view.focus();
}

export function setAlign(align: string): void {
  const t = getTableAt(view.state.selection.main.head);
  if (!t) return flash("光标不在表格内");
  const c = Math.min(cursorCol(), t.cols - 1);
  t.aligns[c] = t.aligns[c] === align ? "none" : align;
  rebuild(t);
  view.focus();
}


/* ================= Tab 单元格导航 ================= */

// 一行内每个单元格内容的文档范围
function cellRanges(lineText: string, lineFrom: number): { from: number; to: number }[] {
  const pipes: number[] = [];
  for (let i = 0; i < lineText.length; i++) {
    if (lineText[i] === "|") pipes.push(i);
  }
  const ranges: { from: number; to: number }[] = [];
  for (let i = 0; i < pipes.length - 1; i++) {
    let a = pipes[i] + 1;
    let b = pipes[i + 1];
    while (a < b && lineText[a] === " ") a++;
    while (b > a && lineText[b - 1] === " ") b--;
    ranges.push({ from: lineFrom + a, to: lineFrom + b });
  }
  return ranges;
}

function selectCell(from: number, to: number) {
  view.dispatch({
    selection: from === to ? EditorSelection.cursor(from) : EditorSelection.range(from, to),
    scrollIntoView: true,
  });
  view.focus();
}

function navCell(dir: 1 | -1): boolean {
  const pos = view.state.selection.main.head;
  const doc = view.state.doc;
  const line = doc.lineAt(pos);
  if (!isTableLine(line.text)) return false;
  const t = getTableAt(pos);
  if (!t) return false;

  // 分隔行：前进到首个数据行第一格，后退到表头最后一格
  if (line.number === t.sepLine) {
    const targetLine = dir === 1 ? t.sepLine + 1 : t.startLine;
    const tl = doc.line(targetLine);
    const rs = cellRanges(tl.text, tl.from);
    if (!rs.length) return true;
    const cell = dir === 1 ? rs[0] : rs[rs.length - 1];
    selectCell(cell.from, cell.to);
    return true;
  }

  const ranges = cellRanges(line.text, line.from);
  if (!ranges.length) return false;
  // 当前格：光标落在哪个格范围内，或在哪个格之前
  let cur = ranges.findIndex((r) => pos <= r.to);
  if (cur < 0) cur = ranges.length - 1;

  if (dir === 1) {
    if (cur < ranges.length - 1) {
      selectCell(ranges[cur + 1].from, ranges[cur + 1].to);
      return true;
    }
    // 行尾：找下一个非分隔行，没有就自动加一行
    let next = line.number + 1;
    if (next === t.sepLine) next++;
    if (next > t.endLine) {
      t.rows.push(Array(t.cols).fill(""));
      rebuild(t);
      const last = view.state.doc.line(view.state.doc.lines);
      const rs = cellRanges(last.text, last.from);
      if (rs.length) selectCell(rs[0].from, rs[0].to);
      return true;
    }
    const nl = doc.line(next);
    const rs = cellRanges(nl.text, nl.from);
    if (rs.length) selectCell(rs[0].from, rs[0].to);
    return true;
  }

  // 后退
  if (cur > 0) {
    selectCell(ranges[cur - 1].from, ranges[cur - 1].to);
    return true;
  }
  let prev = line.number - 1;
  if (prev === t.sepLine) prev--;
  if (prev < t.startLine) return true; // 表头第一格再退就不动
  const pl = doc.line(prev);
  const rs = cellRanges(pl.text, pl.from);
  if (rs.length) selectCell(rs[rs.length - 1].from, rs[rs.length - 1].to);
  return true;
}

export const tableKeymap = Prec.highest(
  keymap.of([
    { key: "Tab", run: () => navCell(1) },
    { key: "Shift-Tab", run: () => navCell(-1) },
  ]),
);

/* ================= 插入表格对话框 ================= */

function el<T extends HTMLElement>(selector: string): T {
  return document.querySelector<T>(selector)!;
}

function openTblDialog() {
  el<HTMLElement>("#tbl-dialog-overlay").hidden = false;
  el<HTMLInputElement>("#tbl-cols").focus();
}

function closeTblDialog() {
  el<HTMLElement>("#tbl-dialog-overlay").hidden = true;
  view.focus();
}

function doInsertTable() {
  const cols = Math.min(12, Math.max(1, Number(el<HTMLInputElement>("#tbl-cols").value) || 2));
  const rows = Math.min(50, Math.max(1, Number(el<HTMLInputElement>("#tbl-rows").value) || 2));
  const t: TableInfo = {
    startLine: 0, endLine: 0, sepLine: 0,
    header: Array.from({ length: cols }, (_, i) => "标题 " + (i + 1)),
    aligns: Array(cols).fill("none"),
    rows: Array.from({ length: rows }, () => Array(cols).fill("")),
    cols,
  };
  // 插到光标处（当前行非空则先起新段）
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  let at = line.from;
  let prefix = "";
  if (line.text.trim() !== "") { at = line.to; prefix = "\n\n"; }
  const lines = buildLines(t).join("\n");
  view.dispatch({ changes: { from: at, insert: prefix + lines + "\n" } });
  // 光标落到表头第一格
  const newLineStart = at + prefix.length;
  const firstLine = view.state.doc.lineAt(newLineStart);
  const rs = cellRanges(firstLine.text, firstLine.from);
  if (rs.length) selectCell(rs[0].from, rs[0].to);
  closeTblDialog();
}

/* ================= 浮动工具条 ================= */

const bar = () => el<HTMLElement>("#tbl-bar");
let barTimer: number | undefined;

function hideBar() { bar().hidden = true; }

function maybeShowBar() {
  window.clearTimeout(barTimer);
  barTimer = window.setTimeout(() => {
    const pos = view.state.selection.main.head;
    if (!view.hasFocus || !getTableAt(pos)) { hideBar(); return; }
    const coords = view.coordsAtPos(pos);
    if (!coords) return hideBar();
    const b = bar();
    b.hidden = false;
    const left = Math.min(Math.max(8, coords.left), window.innerWidth - b.offsetWidth - 8);
    const top = Math.max(52, coords.bottom + 8);
    b.style.left = left + "px";
    b.style.top = top + "px";
  }, 150);
}

/* ================= 分发与入口 ================= */

export function runTable(id: string): void {
  switch (id) {
    case "tbl_insert": return openTblDialog();
    case "tbl_row_above": return insertRow(true);
    case "tbl_row_below": return insertRow(false);
    case "tbl_col_left": return insertCol(true);
    case "tbl_col_right": return insertCol(false);
    case "tbl_row_del": return deleteRow();
    case "tbl_col_del": return deleteCol();
    case "tbl_align_left": return setAlign("left");
    case "tbl_align_center": return setAlign("center");
    case "tbl_align_right": return setAlign("right");
    case "tbl_format": return formatTable();
  }
}

export function initTables() {
  if (!inTauri) return;
  document.querySelectorAll<HTMLButtonElement>("#tbl-bar button").forEach((btn) => {
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      runTable(btn.dataset.tbl || "");
    });
  });
  view.dom.addEventListener("mouseup", maybeShowBar);
  view.dom.addEventListener("keyup", maybeShowBar);
  view.dom.addEventListener("blur", () => window.setTimeout(hideBar, 200));
  window.addEventListener("mousedown", (e) => {
    if (!bar().hidden && !bar().contains(e.target as Node) && !view.dom.contains(e.target as Node)) {
      hideBar();
    }
  });

  el("#tbl-ok").addEventListener("click", doInsertTable);
  el("#tbl-cancel").addEventListener("click", closeTblDialog);
  el<HTMLElement>("#tbl-dialog-overlay").addEventListener("mousedown", (e) => {
    if (e.target === e.currentTarget) closeTblDialog();
  });
  el<HTMLElement>("#tbl-dialog").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); doInsertTable(); }
    if (e.key === "Escape") closeTblDialog();
  });
}
