// The tab side of files-tabs: one file, read-only, in its own tab.
// props: { file: absolute path, on: machine name or null (this computer) }
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { readTextFile, watchFolder, theme, settings, home, appHome, exec } from "herdr";
import { followFileIcons, fileIcon, isLight } from "./file-icons.js";
import { resolveMove } from "./moves.js";

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const MARKDOWN = new Set(["md", "markdown", "mdx"]);
const IMAGES = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg"]);
// image() only loads files inside Herdr's folder, so a picture is shown from a copy here.
const COPIES = "data/files-tabs/images";
let swept = false;
const LIMIT = 400000;
const FRONT_MATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

const extension = (file) => {
  const name = file.split(/[\\/]/).pop() ?? "";
  return name.includes(".") ? name.split(".").pop().toLowerCase() : "txt";
};
const parent = (file) => file.replace(/[\\/][^\\/]*$/, "") || "/";

export default class Viewer {
  constructor(p, cx) {
    this.on = p.on ?? null;
    // The tab's props keep the path it was opened with; a rename or move since then
    // (moves.js) tells where the file is now, also after a restart.
    this.file = resolveMove(this.on, p.file);
    this.kind();
    this.copy = null;
    if (!swept) {
      // Copies a crash or a quit left behind.
      swept = true;
      exec("sh", ["-c", '[ -d "$1" ] && find "$1" -type f -mtime +1 -exec rm -f {} + ; true', "sweep", `${appHome()}/${COPIES}`]).catch(() => {});
    }
    this.text = null;
    this.error = null;
    followFileIcons(this, cx);
    this.load(cx);
    if (this.on) {
      // A file on another machine can't be watched: check now and then.
      cx.timer.every(10000, (cx) => this.load(cx));
    } else {
      cx.spawn(async (cx) => {
        try {
          for (;;) {
            // The folder of the file as it is now: a move changes it.
            const dir = parent(this.file);
            const changed = await watchFolder(dir);
            if (changed.some((p) => p === this.file || p === dir)) this.load(cx);
          }
        } catch { /* folder gone: keep the last text */ }
      });
    }
  }

  // What the file is, from its extension; a rename to another type changes it.
  kind() {
    this.ext = extension(this.file);
    this.markdown = MARKDOWN.has(this.ext);
    this.image = IMAGES.has(this.ext);
    this.raster = this.image && this.ext !== "svg"; // no text to show
    this.source = !(this.markdown || this.image);
  }

  // Follows a rename or move recorded since the last look.
  follow(cx) {
    const now = resolveMove(this.on, this.file);
    if (now === this.file) return;
    const ext = this.ext;
    this.file = now;
    if (extension(now) !== ext) { this.kind(); this.text = null; this.code?.release(); this.code = null; }
    this.error = null;
    this.load(cx);
  }

  load(cx) {
    if (this.image) this.loadImage(cx);
    if (this.raster) return;
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

  // A fresh copy for every change, so Herdr doesn't show a cached old picture.
  loadImage(cx) {
    if (this.on) { this.imageError = "Picture preview works for files on this computer only"; cx.notify(); return; }
    cx.spawn(async (cx) => {
      try {
        const dir = `${appHome()}/${COPIES}`, name = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.${this.ext}`;
        const r = await exec("sh", ["-c", '[ -f "$2" ] || exit 3; mkdir -p "$1" && cp -f "$2" "$1/$3"', "copy", dir, this.file, name]);
        if (r.code !== 0) { this.imageError = r.code === 3 ? "This file is no longer available" : "Cannot show this picture"; return; }
        const old = this.copy;
        this.copy = name; this.imageError = null;
        if (old) exec("rm", ["-f", `${dir}/${old}`]).catch(() => {});
      } catch {
        this.imageError = "Cannot show this picture";
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

  close() {
    this.code?.release(); this.code = null;
    if (this.copy) exec("rm", ["-f", `${appHome()}/${COPIES}/${this.copy}`]).catch(() => {});
    this.copy = null;
  }

  render(cx) {
    this.follow(cx);
    const t = theme();
    const h = home();
    const shown = this.file.startsWith(h + "/") ? "~" + this.file.slice(h.length) : this.file;
    const picture = this.image && !this.source;
    const body = picture
      ? (this.imageError || !this.copy
          ? div().p(12).text_color(t.dim).child(this.imageError ?? "Loading picture…")
          : div().id("picture").flex_1().min_h(0).p(16).flex().items_center().justify_center().overflow_hidden()
              // Its own size, at most the tab's: Herdr's image() doesn't scale a picture up.
              .child(image(`${COPIES}/${this.copy}`).max_w("100%").max_h("100%")))
      : this.error
      ? div().p(12).text_color(t.dim).child(this.error)
      : this.text === null
        ? div().p(12).text_color(t.dim).child("Loading file…")
        : this.source || this.image
          ? (this.code ? Editor.new(this.code).flex_1().min_h(0) : div())
          : v_flex().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14)
              .child(TextView.markdown("md", this.text.replace(FRONT_MATTER, "")).selectable(true));
    return v_flex().id("root").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child((icon => icon ? image(icon).w(13).h(13).flex_none() : svg("mods/files-tabs/file.svg").size(13).flex_none().text_color(t.muted))(
          fileIcon(this.fileIcons, this.file, { light: isLight(t.background) })))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child((this.on ? `${this.on}:` : "") + shown))
        .when((this.markdown || (this.image && !this.raster)) && this.text !== null && !this.error, (el) => el.child(
          div().id("toggle-source").px(8).py(2).rounded(5).cursor_pointer().text_size(11).text_color(t.muted)
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.source = !this.source; cx.notify(); })
            .child(this.source ? "Preview" : "Source"))))
      .child(body);
  }
}
