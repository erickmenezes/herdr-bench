// The tab side of files-tabs: one file, read-only, in its own tab.
// props: { file: absolute path, on: machine name or null (this computer) }
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { readTextFile, watchFolder, theme, settings, home } from "herdr";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const LIMIT = 400000;
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

const extension = (file) => {
  const name = file.split(/[\\/]/).pop() ?? "";
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "txt";
};
const parent = (file) => file.replace(/[\\/][^\\/]*$/, "") || "/";

export default class Viewer {
  constructor(p, cx) {
    this.file = p.file;
    this.on = p.on ?? null;
    this.ext = extension(this.file);
    this.markdown = MARKDOWN.has(this.ext);
    this.source = !this.markdown;
    this.text = null;
    this.error = null;
    this.load(cx);
    if (this.on) {
      // A file on another machine can't be watched: check now and then.
      cx.timer.every(10000, (cx) => this.load(cx));
    } else {
      const dir = parent(this.file);
      cx.spawn(async (cx) => {
        try {
          for (;;) {
            const changed = await watchFolder(dir);
            if (changed.some((p) => p === this.file || p === dir)) this.load(cx);
          }
        } catch { /* folder gone: keep the last text */ }
      });
    }
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.file, { on: this.on });
        if (text === null) { this.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.error = "Binary file · no text preview"; return; }
        const value = text.length > LIMIT ? text.slice(0, LIMIT) + "\n… (file truncated)" : text;
        if (value === this.text && !this.error) return;
        this.text = value; this.error = null;
        this.build();
      } catch {
        this.error = "Cannot open this file (binary, larger than 1 MiB, or unreadable)";
      } finally { cx.notify(); }
    });
  }

  build() {
    this.code?.release();
    const t = theme();
    this.code = EditorState.new({ language: LANG[this.ext] ?? this.ext, readonly: true, value: this.text,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
  }

  close() { this.code?.release(); this.code = null; }

  render(_cx) {
    const t = theme();
    const h = home();
    const shown = this.file.startsWith(h + "/") ? "~" + this.file.slice(h.length) : this.file;
    const body = this.error
      ? div().p(12).text_color(t.dim).child(this.error)
      : this.text === null
        ? div().p(12).text_color(t.dim).child("Loading file…")
        : this.source
          ? (this.code ? Editor.new(this.code).flex_1().min_h(0) : div())
          : v_flex().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14)
              .child(TextView.markdown("md", this.text.replace(FRONT_MATTER, "")).selectable(true));
    return v_flex().id("root").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/files-tabs/file.svg").size(13).flex_none().text_color(t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child((this.on ? `${this.on}:` : "") + shown))
        .when(this.markdown && this.text !== null && !this.error, (el) => el.child(
          div().id("toggle-source").px(8).py(2).rounded(5).cursor_pointer().text_size(11).text_color(t.muted)
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.source = !this.source; cx.notify(); })
            .child(this.source ? "Preview" : "Source"))))
      .child(body);
  }
}
