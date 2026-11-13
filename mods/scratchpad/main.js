// Scratchpad: an empty plain-text tab for quick notes, like Zed's scratch buffers.
// As a tab, props are { id } (a new one per tab). The text is kept in this mod's
// localStorage under "note:<id>" on every change; Herdr keys that storage by the
// copy's props, which are saved with the tab, so the text survives a restart or
// an update while the tab stays open. There are no files.
// Opened as an overlay (`mod.open:scratchpad`, e.g. bound to cmd-shift-n), it
// opens a new scratchpad tab in the shown space and closes itself.
// In a layout block (no props), it is a button beside the tab bar that does the same.
import { View, div, svg } from "gpui-kit";
import { v_flex, Editor, EditorState } from "gpui-base";
import { props, theme, settings, spaces, run, closeOverlay } from "herdr";

const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const openNew = () => run("tab.new", { name: "Scratchpad", space: spaces().find(s => s.active)?.id, mod: "scratchpad", props: { id: newId() } });

export default class Scratchpad extends View {
  init(_props, cx) {
    const p = props() ?? {};
    if (p.overlay) {
      closeOverlay(p.overlay);
      openNew();
      return;
    }
    this.id = p.id ?? null;
    if (!this.id) { this.button = true; return; }
    this.key = `note:${this.id}`;
    this.state = EditorState.new({
      value: localStorage.getItem(this.key) ?? "",
      font_family: settings().font_family, font_size: 13,
      line_numbers: false, folding: false, soft_wrap: true,
    });
    this.state.on("change", () => localStorage.setItem(this.key, this.state.value()));
  }

  async close() {
    // Called when the tab closes and also when Herdr quits, so the text is not
    // deleted here: it must still be there on the next start.
    if (this.state) localStorage.setItem(this.key, this.state.value());
    await localStorage.flush();
    this.state?.release(); this.state = null;
  }

  render(_cx) {
    const t = theme();
    // Matches the tab bar beside it: chrome background, bottom border, 26px dim button.
    if (this.button) return div().id("root").size_full().flex().items_center().pr(10).bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().id("new-scratchpad").size(26).flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip("New scratchpad (⌘⇧N)")
        .on_click(() => openNew())
        .child(svg("mods/scratchpad/note.svg").size(15)));
    return v_flex().id("root").size_full().min_h(0).overflow_hidden().bg(t.background).text_color(t.foreground)
      .child(props()?.overlay ? div() : this.state
        ? v_flex().flex_1().min_h(0).px(6).pt(6).child(Editor.new(this.state).flex_1().min_h(0))
        : div().p(12).text_size(13).text_color(t.dim).child("No note here. Open a scratchpad tab with mod.open:scratchpad (cmd-shift-n)."));
  }
}
