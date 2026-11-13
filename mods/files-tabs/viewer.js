// The tab side of files-tabs: one file in its own tab, editable when it is a text file
// on this computer (⌘S saves; a file changed on disk since is never overwritten
// without asking). Unsaved edits are kept as a draft in this copy's localStorage
// (keyed by its props), so they survive a restart, and come back if the tab is reopened.
// props: { file: absolute path, on: machine name or null (this computer) }
import { div, svg, image } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, TextView } from "gpui-base";
import { readTextFile, writeTextFile, watchFolder, theme, settings, home, appHome, exec, window, notify } from "herdr";
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
const DRAFT = "draft";
// A picture's own size in pixels, to fit it: sips on macOS, else `file` ("PNG image
// data, 16 x 16", JPEG's "…, 1920x1080, components 3": the last "W x H" is the size).
// An SVG's comes from its width/height, else its viewBox.
async function pictureSize(path, ext, text) {
  if (ext === "svg") {
    const head = (text ?? "").match(/<svg\b[^>]*>/i)?.[0] ?? "";
    const num = (name) => Number(head.match(new RegExp(`\\s${name}\\s*=\\s*["']\\s*([\\d.]+)(px)?\\s*["']`))?.[1]);
    const box = head.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    const w = num("width") || Number(box?.[1]), h = num("height") || Number(box?.[2]);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  const r = window()?.platform === "macos"
    ? await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path])
    : await exec("file", ["-b", path]);
  if (r.code !== 0) return null;
  if (window()?.platform === "macos") {
    const w = Number(r.stdout.match(/pixelWidth:\s*(\d+)/)?.[1]), h = Number(r.stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
    return w > 0 && h > 0 ? { w, h } : null;
  }
  const all = [...r.stdout.matchAll(/(\d+)\s*x\s*(\d+)/g)].pop();
  return all ? { w: Number(all[1]), h: Number(all[2]) } : null;
} // { base: the file's text the edits started from, text }

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
    this.text = null;   // what the tab first showed (truncated past LIMIT)
    this.disk = null;   // the file's text as last read or written
    this.base = null;   // that text as the editor holds it: edits are what differs
    this.editable = false; this.conflict = false; this.saving = false;
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
    if (extension(now) !== ext) {
      // Another type: the editor is rebuilt for its language, edits kept.
      const value = this.code?.value();
      this.kind();
      if (this.code && value !== undefined) { this.build(value); return; }
      this.text = null;
    }
    this.error = null;
    this.load(cx);
  }

  load(cx) {
    if (this.image) this.loadImage(cx);
    if (this.raster) return;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(this.file, { on: this.on });
        // Gone with edits in the tab: keep them (Overwrite writes the file again).
        if (text === null && this.dirty()) { this.conflict = true; return; }
        if (text === null) { this.error = "This file is no longer available"; return; }
        if (text.includes("\0")) { this.error = "Binary file · no text preview"; return; }
        if (text === this.disk && this.code && !this.error) return;
        this.error = null;
        if (this.code && this.editable) {
          // Changed on disk: follow it, unless there are edits (then Save asks first).
          if (this.dirty()) { this.conflict = true; return; }
          this.disk = text; this.setValue(text); return;
        }
        if (this.ext === "svg") this.natural = await pictureSize(this.file, "svg", text);
        const truncated = text.length > LIMIT;
        this.text = truncated ? text.slice(0, LIMIT) + "\n… (file truncated)" : text;
        this.disk = text;
        this.editable = !this.on && !truncated;
        this.readonlyWhy = this.on ? `On ${this.on}: read-only` : truncated ? "Larger than 400 KB: read-only" : null;
        let draft = null;
        try { draft = this.editable ? JSON.parse(localStorage.getItem(DRAFT) ?? "null") : null; } catch {}
        this.build(draft?.text ?? this.text);
        // A draft is kept edits: they stay, and if the file changed since, Save asks first.
        if (draft) this.conflict = draft.base !== text;
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
        // SVG: from its text, read just after (load); a raster from the file.
        this.natural = this.ext === "svg" ? this.natural : await pictureSize(this.file, this.ext).catch(() => null);
        if (old) exec("rm", ["-f", `${dir}/${old}`]).catch(() => {});
      } catch {
        this.imageError = "Cannot show this picture";
      } finally { cx.notify(); }
    });
  }

  dirty() { return Boolean(this.code && this.editable && this.code.value() !== this.base); }

  // Replaces the text with the file's (a reload); the edits, if any, are gone.
  setValue(text) {
    this.quiet = true; this.code.set_value(text); this.quiet = false;
    this.base = this.code.value(); this.conflict = false;
    localStorage.removeItem(DRAFT);
  }

  // The picture scaled to the measured area (up or down), keeping its proportions.
  fitted() {
    const file = `${COPIES}/${this.copy}`;
    // The size comes unzoomed; w()/h() are zoomed with the rest of the mod.
    const z = Number(settings().zoom) || 1, bw = Math.max(1, this.box.width / z - 32), bh = Math.max(1, this.box.height / z - 32);
    const n = this.natural;
    if (!n) return image(file).max_w("100%").max_h("100%");
    const scale = Math.min(bw / n.w, bh / n.h);
    return image(file).flex_none().w(n.w * scale).h(n.h * scale);
  }

  build(value) {
    this.code?.release();
    const t = theme();
    const draft = value !== this.text;
    this.code = EditorState.new({ language: LANG[this.ext] ?? this.ext, readonly: !this.editable, value: draft ? this.disk : value,
      font_family: settings().font_family, font_size: 12,
      syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
    // The file's text as the editor holds it (line endings and all), for telling edits apart.
    this.base = this.code.value();
    if (!this.editable) return;
    if (draft) { this.quiet = true; this.code.set_value(value); this.quiet = false; }
    this.code.on("change", (_e, cx) => {
      if (this.quiet) return;
      if (this.code.value() === this.base) { localStorage.removeItem(DRAFT); this.conflict = false; }
      else localStorage.setItem(DRAFT, JSON.stringify({ base: this.disk, text: this.code.value() }));
      cx.notify();
    });
  }

  // Writes the edits. The file is read first: if it changed since this tab last read it,
  // nothing is written (Reload or Overwrite then); `force` is Overwrite.
  save(cx, force = false) {
    if (!this.dirty() || this.saving) return;
    this.saving = true; cx.notify();
    const file = this.file, text = this.code.value();
    cx.spawn(async (cx) => {
      try {
        const now = await readTextFile(file);
        if (now !== this.disk && !force) { this.conflict = true; return; }
        await writeTextFile(file, text, now);
        if (file !== this.file || !this.code) return;
        this.disk = text; this.conflict = false;
        if (this.code.value() === text) { this.base = text; localStorage.removeItem(DRAFT); }
      } catch (e) {
        notify({ title: `Couldn't save ${file.split("/").pop()}`, body: String(e?.message ?? e), level: "error" });
      } finally { this.saving = false; cx.notify(); }
    });
  }

  // Throws the edits away for the file as it is on disk now.
  reload(cx) {
    cx.spawn(async (cx) => {
      const now = await readTextFile(this.file).catch(() => null);
      if (now !== null && this.code) { this.disk = now; this.setValue(now); }
      cx.notify();
    });
  }

  async close() {
    // A quit also closes: the draft stays for the next start.
    await localStorage.flush();
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
              // Herdr's image() doesn't fit itself to a box (it takes the width and follows its
              // proportions), so the fitted size is worked out from the area measured here.
              .on_size_change((size, cx) => {
                if (this.box?.width === size.width && this.box?.height === size.height) return;
                this.box = size; cx.notify();
              })
              .child(this.actual || !this.box
                ? image(`${COPIES}/${this.copy}`).max_w("100%").max_h("100%") // its own size, at most the tab's
                : this.fitted()))
      : this.error
      ? div().p(12).text_color(t.dim).child(this.error)
      : this.text === null
        ? div().p(12).text_color(t.dim).child("Loading file…")
        : this.source || this.image
          ? (this.code ? Editor.new(this.code).flex_1().min_h(0) : div())
          : v_flex().id("md-scroll").flex_1().min_h(0).overflow_y_scrollbar().px(20).py(14)
              .child(TextView.markdown("md", (this.code?.value() ?? this.text).replace(FRONT_MATTER, "")).selectable(true));
    const dirty = this.dirty(), save = window()?.platform === "macos" ? "cmd-s" : "ctrl-s";
    const button = (id, label, tip, action, strong) => div().id(id).flex_none().px(8).py(2).rounded(5).cursor_pointer().text_size(11)
      .text_color(strong ? t.foreground : t.muted).when(Boolean(strong), el => el.bg(t.hover)).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip).on_click((_e, cx) => action(cx)).child(label);
    return v_flex().id("root").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => { if (e.keystroke === save) { this.save(cx); cx.stop_propagation(); } })
      .child(h_flex().h(30).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child((icon => icon ? image(icon).w(13).h(13).flex_none() : svg("mods/files-tabs/file.svg").size(13).flex_none().text_color(t.muted))(
          fileIcon(this.fileIcons, this.file, { light: isLight(t.background) })))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child((this.on ? `${this.on}:` : "") + shown))
        .when(Boolean(this.readonlyWhy) && !this.error, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(this.readonlyWhy)))
        .when(this.conflict && dirty, (el) => el
          .child(div().flex_none().text_size(11).text_color(t.blocked).child("Changed on disk"))
          .child(button("reload", "Reload", "Throw your edits away for the file on disk", (cx) => this.reload(cx)))
          .child(button("overwrite", "Overwrite", "Save your edits over the file on disk", (cx) => this.save(cx, true))))
        .when(dirty && !this.conflict, (el) => el
          .child(div().flex_none().text_size(11).text_color(t.dim).child(this.saving ? "Saving…" : "Edited"))
          .child(button("revert", "Revert", "Go back to the file on disk", (cx) => this.reload(cx)))
          .child(button("save", "Save", `Save (${save === "cmd-s" ? "⌘S" : "Ctrl+S"})`, (cx) => this.save(cx), true)))
        .when(picture && Boolean(this.copy) && !this.imageError, (el) => el.child(
          div().id("toggle-fit").px(8).py(2).rounded(5).cursor_pointer().text_size(11).text_color(t.muted)
            .hover((s) => s.bg(t.hover))
            .tooltip(this.actual ? "Fit the picture to the tab" : "Show the picture at its own size")
            .on_click((_e, cx) => { this.actual = !this.actual; cx.notify(); })
            .child(this.actual ? "Fit" : "Actual Size")))
        .when((this.markdown || (this.image && !this.raster)) && this.text !== null && !this.error, (el) => el.child(
          div().id("toggle-source").px(8).py(2).rounded(5).cursor_pointer().text_size(11).text_color(t.muted)
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => { this.source = !this.source; cx.notify(); })
            .child(this.source ? "Preview" : "Source"))))
      .child(body);
  }
}
