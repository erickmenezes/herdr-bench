// New Folder, Rename and Move to Trash, asked from the row menu: a dialog copy of this
// mod with props { dialog: { kind: "mkdir" | "rename" | "trash", path, paths, dir, on,
// location, expand } }; for mkdir, path is the folder it goes in (expand: open it in the
// panel); for trash, paths are every selected item.
// Rename never overwrites; Move to Trash only ever moves to a Trash, never deletes.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { props, closeOverlay, theme, exec, window, setShared } from "herdr";
import { recordMove } from "./moves.js";

const REQUEST = "files-tabs.request";
const nameOf = (path) => path.split("/").pop();
const parentOf = (path) => path.replace(/\/[^/]*$/, "") || "/";

// Every path given ("$@"). macOS: its trash command (macOS 15+), else Finder one by one.
// Linux and SSH machines: gio or trash-put.
const MAC_TRASH = 'if [ -x /usr/bin/trash ]; then /usr/bin/trash "$@"; else for p in "$@"; do osascript -e "on run argv" -e "tell application \\"Finder\\" to delete (POSIX file (item 1 of argv) as alias)" -e "end run" "$p" >/dev/null || exit 1; done; fi';
const UNIX_TRASH = 'if command -v gio >/dev/null 2>&1; then gio trash -- "$@"; elif command -v trash-put >/dev/null 2>&1; then trash-put -- "$@"; else exit 4; fi';

export class DialogView {
  constructor(p, cx) {
    this.d = p.dialog;
    this.error = null;
    this.busy = false;
    this.handle = cx.focus_handle();
    if (this.d.kind === "rename" || this.d.kind === "mkdir") {
      const name = this.d.kind === "mkdir" ? "untitled folder" : nameOf(this.d.path);
      this.input = InputState.new({ value: name });
      // The name without its extension, as Finder does; a folder or a dotfile whole.
      const dot = this.d.dir || this.d.kind === "mkdir" ? -1 : name.lastIndexOf(".");
      this.input.set_selected_range({ start: 0, end: dot > 0 ? dot : name.length });
      this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
      this.input.on("submit", (_e, cx) => this.confirm(cx));
      this.input.focus();
      cx.timer.after(300, () => this.input.focus());
    } else {
      this.handle.focus();
    }
  }

  close() { closeOverlay(props()?.overlay); }

  done() {
    const d = this.d;
    setShared(REQUEST, { id: `${Date.now()}-${Math.random()}`, at: Date.now(), location: d.location, kind: d.expand ? "expand" : "refresh", path: d.path });
    this.close();
  }

  confirm(cx) {
    if (this.busy) return;
    const d = this.d;
    if (d.kind === "mkdir") {
      const name = this.input.value().trim();
      if (!name || name === "." || name === ".." || name.includes("/")) { this.error = "Use a name without “/”."; cx.notify(); return; }
      this.run(cx, ["-c", 'cd "$1" || exit 2; if [ -e "$2" ] || [ -L "$2" ]; then exit 3; fi; mkdir -- "$2"', "mkdir", d.path, name],
        { 3: `“${name}” already exists here.` });
    } else if (d.kind === "rename") {
      const next = this.input.value().trim(), old = nameOf(d.path);
      if (next === old) return this.close();
      if (!next || next === "." || next === ".." || next.includes("/")) { this.error = "Use a name without “/”."; cx.notify(); return; }
      this.run(cx, ["-c", 'cd "$1" || exit 2; if [ -e "$3" ] || [ -L "$3" ]; then exit 3; fi; mv -n -- "$2" "$3" && [ -e "$3" -o -L "$3" ]', "rename", parentOf(d.path), old, next],
        { 3: `“${next}” already exists here.` }, () => recordMove(d.on, d.path, `${parentOf(d.path)}/${next}`));
    } else {
      const mac = !d.on && window()?.platform === "macos";
      this.run(cx, ["-c", mac ? MAC_TRASH : UNIX_TRASH, "trash", ...(d.paths ?? [d.path])],
        { 4: `There's no Trash on ${d.on ?? "this computer"} (gio or trash-put): nothing was deleted.` });
    }
  }

  run(cx, args, messages, after) {
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", args, { on: this.d.on });
        if (r.code === 0) { after?.(); return this.done(); }
        this.error = messages[r.code] ?? (r.stderr.trim().split("\n").pop() || "It didn't work.");
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally { this.busy = false; cx.notify(); }
    });
  }

  render(_cx) {
    const t = theme();
    const d = this.d, rename = d.kind === "rename" || d.kind === "mkdir", mkdir = d.kind === "mkdir";
    const button = (id, text, primary, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8)
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12.5).font_medium().cursor_pointer()
      .when(this.busy, el => el.opacity(0.6)).hover(s => s.opacity(0.88)).on_click(action).child(text);
    const many = (d.paths?.length ?? 1) > 1;
    const title = mkdir ? "New folder" : rename ? `Rename ${d.dir ? "folder" : "file"}` : many ? `Move ${d.paths.length} items to the Trash?` : `Move “${nameOf(d.path)}” to the Trash?`;
    return v_flex().id("files-dialog").track_focus(this.handle).size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "enter" && !rename) this.confirm(cx);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(6).text_size(11.5).text_color(t.dim).truncate().child((d.on ? `${d.on}:` : "") + (mkdir ? d.path : rename || many ? parentOf(d.path) : d.path)))
      .when(rename, el => el.child(div().pt(12).child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))))
      .when(!rename && many, el => el.child(div().pt(10).text_color(t.muted).child(`${d.paths.map(nameOf).join(", ")}. You can put them back from the Trash.`)))
      .when(!rename && !many, el => el.child(div().pt(10).text_color(t.muted).child(d.dir ? "The folder and everything in it go to the Trash. You can put them back from there." : "You can put it back from the Trash.")))
      .when(Boolean(this.error), el => el.child(div().pt(8).text_size(12).text_color(t.blocked).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().pt(16).gap(8).justify_end()
        .child(button("fd-cancel", "Cancel", false, () => this.close()))
        .child(button("fd-ok", mkdir ? "Create" : rename ? "Rename" : "Move to Trash", true, (_e, cx) => this.confirm(cx))));
  }
}
