import { view, md } from "./main";

// 公众号编辑器会剥掉外部 CSS，必须全部内联
const STYLES: Record<string, string> = {
  h1: "font-size:22px;font-weight:700;margin:28px 0 14px;line-height:1.4;color:#000;",
  h2: "font-size:19px;font-weight:700;margin:26px 0 12px;padding-bottom:6px;border-bottom:1px solid #e5e5e5;color:#000;",
  h3: "font-size:17px;font-weight:600;margin:20px 0 10px;color:#000;",
  h4: "font-size:16px;font-weight:600;margin:18px 0 8px;color:#000;",
  p: "font-size:15px;line-height:1.9;margin:0 0 14px;color:#3f3f3f;letter-spacing:0.02em;",
  blockquote: "margin:14px 0;padding:10px 16px;border-left:3px solid #d0d0d0;background:#f7f7f7;color:#666;font-size:14px;",
  ul: "margin:0 0 14px;padding-left:26px;",
  ol: "margin:0 0 14px;padding-left:26px;",
  li: "font-size:15px;line-height:1.9;margin:4px 0;color:#3f3f3f;",
  code: "font-family:Menlo,Consolas,monospace;font-size:13px;background:#f3f3f3;padding:2px 6px;border-radius:3px;color:#c0341d;",
  pre: "background:#f6f6f6;padding:12px 14px;border-radius:6px;margin:0 0 14px;line-height:1.6;",
  table: "border-collapse:collapse;width:100%;margin:0 0 14px;",
  th: "border:1px solid #ddd;padding:8px 10px;background:#f6f6f6;font-size:14px;font-weight:600;",
  td: "border:1px solid #ddd;padding:8px 10px;font-size:14px;color:#3f3f3f;",
  a: "color:#576b95;text-decoration:none;",
  img: "max-width:100%;border-radius:4px;",
  hr: "border:none;border-top:1px solid #e5e5e5;margin:24px 0;",
  strong: "font-weight:700;color:#000;",
};

function buildStyledHtml(): string {
  const html = md.render(view.state.doc.toString());
  const div = document.createElement("div");
  div.innerHTML = html;
  div.querySelectorAll("*").forEach((elm) => {
    const s = STYLES[elm.tagName.toLowerCase()];
    if (s) elm.setAttribute("style", s);
  });
  // pre 里的 code 去掉背景色（pre 自己有）
  div.querySelectorAll("pre code").forEach((elm) => {
    elm.setAttribute("style", "background:none;padding:0;font-family:Menlo,Consolas,monospace;font-size:13px;");
  });
  return '<section style="font-family:-apple-system,PingFang SC,Helvetica Neue,sans-serif;">' + div.innerHTML + "</section>";
}

function flash(msg: string) {
  const meta = document.querySelector("#meta");
  if (!meta) return;
  const old = meta.textContent;
  meta.textContent = msg;
  window.setTimeout(() => { if (meta.textContent === msg) meta.textContent = old; }, 2500);
}

export async function copyForWeChat(): Promise<void> {
  const html = buildStyledHtml();
  const plain = view.state.doc.toString();
  try {
    const item = new ClipboardItem({
      "text/html": new Blob([html], { type: "text/html" }),
      "text/plain": new Blob([plain], { type: "text/plain" }),
    });
    await navigator.clipboard.write([item]);
    flash("已复制为公众号格式");
  } catch {
    // 退路：execCommand（对旧 WebView 更稳）
    const div = document.createElement("div");
    div.contentEditable = "true";
    div.style.cssText = "position:fixed;left:-9999px;top:0;";
    div.innerHTML = html;
    document.body.appendChild(div);
    const range = document.createRange();
    range.selectNodeContents(div);
    const sel = window.getSelection();
    if (sel) { sel.removeAllRanges(); sel.addRange(range); }
    document.execCommand("copy");
    if (sel) sel.removeAllRanges();
    div.remove();
    flash("已复制为公众号格式");
  }
}
