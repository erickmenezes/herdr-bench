// Buttons after Herdr's own tab bar, in a block of their own so the tab bar stays
// Herdr's (no clone). The note opens a new scratchpad.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run } from "herdr";

export default class TabBarExtras extends View {
  render(_cx) {
    const t = theme();
    return h_flex().id("root").size_full().pr(10).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(div().id("new-scratchpad").size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
        .hover(s => s.bg(t.hover).text_color(t.foreground))
        .tooltip("New scratchpad (⌘⇧N)")
        .on_click(() => run("mod.open", { name: "scratchpad" }))
        .child(svg("mods/tab-bar-extras/note.svg").size(15)));
  }
}
