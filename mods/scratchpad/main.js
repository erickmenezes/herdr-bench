// Scratchpad: an empty plain-text tab for quick notes, like Zed's scratch buffers.
// As a tab, props are { id } (a new one per tab). The text is kept in this mod's
// localStorage under "note:<id>" on every change; Herdr keys that storage by the
// copy's props, which are saved with the tab, so the text survives a restart or
// an update while the tab stays open.
// "Save as…" (or ⌘S the first time) asks for a file with the system's save dialog
// and writes the note there; the tab takes the file's name and later ⌘S saves to
// the same file ("file:<id>"), refusing if the file was changed by something else.
// Opened as an overlay (`mod.open:scratchpad`, e.g. bound to cmd-shift-n), it
// opens a new scratchpad tab in the shown space and closes itself.
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState } from "gpui-base";
import { props, theme, settings, spaces, run, closeOverlay, window, exec, home, readTextFile, writeTextFile, notify } from "herdr";

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const openNew = () => run("tab.new", { name: "Scratchpad", space: spaces().find(s => s.active)?.id, mod: "scratchpad", props: { id: newId() } });
const nameOf = path => path.split("/").pop();
const parentOf = path => path.slice(0, path.lastIndexOf("/")) || "/";

// The system's save dialog (it asks before replacing a file). Resolves with the
// chosen path, null if cancelled; rejects when there is no dialog to show.
async function askForFile(folder, name) {
  const wait = { timeout: 600_000 };
  if (window()?.platform === "macos") {
    const q = s => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    const r = await exec("osascript", ["-e",
      `POSIX path of (choose file name with prompt "Save the note as" default name ${q(name)} default location (POSIX file ${q(folder)}))`], wait);
    return r.code === 0 ? r.stdout.trim() || null : null; // 1: cancelled (-128)
  }
  const pickers = [
    ["zenity", ["--file-selection", "--save", "--confirm-overwrite", `--filename=${folder}/${name}`]],
    ["kdialog", ["--getsavefilename", `${folder}/${name}`]],
  ];
  for (const [cmd, args] of pickers) {
    let r;
    try { r = await exec(cmd, args, wait); } catch { continue; } // not installed
    return r.code === 0 ? r.stdout.trim() || null : null;
  }
  throw new Error(window()?.platform === "windows" ? "Save as… isn't available on Windows yet." : "No save dialog found (install zenity or kdialog).");
}

export default class Scratchpad extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.overlay) {
      closeOverlay(p.overlay);
      openNew();
      return;
    }
    this.id = p.id ?? null;
    if (!this.id) return;
    this.key = `note:${this.id}`;
    this.fileKey = `file:${this.id}`;
    this.file = localStorage.getItem(this.fileKey) || null;
    this.saved = null; // the text last written to this.file, while this copy runs
    this.saving = false;
    this.state = EditorState.new({
      value: localStorage.getItem(this.key) ?? "",
      font_family: settings().font_family, font_size: 13,
      line_numbers: false, folding: false, soft_wrap: true,
    });
    this.state.on("change", () => { localStorage.setItem(this.key, this.state.value()); cx.notify(); });
  }

  async close() {
    // Called when the tab closes and also when Herdr quits, so the text is not
    // deleted here: it must still be there on the next start.
    if (this.state) localStorage.setItem(this.key, this.state.value());
    await localStorage.flush();
    this.state?.release(); this.state = null;
  }

  /** Writes the note to its file; asks for one first when it has none (or `again`). */
  save(again, cx) {
    if (this.saving || !this.state) return;
    this.saving = true; cx.notify();
    cx.spawn(async cx => {
      try {
        let path = this.file;
        if (!path || again) {
          const space = spaces().find(s => s.active);
          const folder = path ? parentOf(path) : (!space?.machine && space?.folder) || home();
          const text = this.state.value(), first = text.split("\n").find(l => l.trim()) ?? "";
          const name = path ? nameOf(path) : `${first.replace(/^#+\s*/, "").replace(/[\/\\:*?"<>|]/g, "").trim().slice(0, 40) || "Note"}.md`;
          path = await askForFile(folder, name);
          if (!path) return;
        }
        // The file as it is now: a new file is created, an existing one is replaced only
        // if it still holds what this note last wrote (or what the dialog agreed to replace).
        const now = await readTextFile(path);
        const expected = path === this.file && this.saved !== null && now !== this.saved ? this.saved : now;
        const text = this.state.value();
        await writeTextFile(path, text, expected);
        const renamed = path !== this.file;
        this.file = path; this.saved = text;
        localStorage.setItem(this.fileKey, path);
        if (renamed) run("tab.rename", { name: nameOf(path) });
      } catch (e) {
        notify({ title: "Couldn't save the note", body: /stale|match/i.test(String(e?.message ?? e))
          ? `${nameOf(this.file)} was changed by something else. Use Save as… to write it elsewhere.`
          : String(e?.message ?? e), level: "error" });
      } finally {
        this.saving = false; cx.notify();
      }
    });
  }

  render(cx) {
    const t = theme();
    if (props()?.overlay) return div();
    if (!this.state) return v_flex().id("root").size_full().bg(t.background).text_color(t.foreground)
      .child(div().p(12).text_size(13).text_color(t.dim).child("No note here. Open a scratchpad tab with mod.open:scratchpad (cmd-shift-n)."));
    const dirty = this.file && this.saved !== null ? this.state.value() !== this.saved : false;
    const button = (id, label, tip, again) => div().id(id).flex_none().px(8).py(2).rounded(6).cursor_pointer().text_size(12)
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip)
      .on_click((_e, cx) => this.save(again, cx)).child(label);
    return v_flex().id("root").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground)
      .on_key_down((e, cx) => {
        if (e.keystroke === "cmd-s") this.save(false, cx);
        else if (e.keystroke === "cmd-shift-s") this.save(true, cx);
      })
      .child(h_flex().flex_none().items_center().gap(4).px(8).h(30).border_b_1().border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim)
          .child(this.saving ? "Saving…" : this.file ? `${this.file.replace(home(), "~")}${dirty ? " · edited" : ""}` : "Not saved to a file"))
        .when(Boolean(this.file), el => el.child(button("save", "Save", "Save to this file (⌘S)", false)))
        .child(button("save-as", "Save as…", "Save the note as a file (⌘⇧S)", true)))
      .child(v_flex().flex_1().min_h(0).px(6).pt(6).child(Editor.new(this.state).flex_1().min_h(0)));
  }
}
