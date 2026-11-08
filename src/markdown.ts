import MarkdownIt, { type MarkdownIt as Markdown } from "markdown-it";

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isRemote(src: string): boolean {
  return /^https?:\/\//i.test(src) || src.startsWith("//");
}

/** html 关闭，远程图片不发请求。文档里的外链图只显示地址。 */
export function createMarkdown(options?: { typographer?: boolean }): Markdown {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: options?.typographer ?? false,
  });
  md.renderer.rules.image = (tokens, idx, opts, _env, self) => {
    const raw = tokens[idx].attrGet("src");
    const src = raw == null ? "" : String(raw);
    if (!isRemote(src)) return self.renderToken(tokens, idx, opts);
    const label = escapeHtml(src);
    return `<span class="remote-img" title="远程图片不会自动加载">${label}</span>`;
  };
  return md;
}
