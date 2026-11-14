// Buttons after Herdr's own tab bar, in a block of their own so the tab bar stays
// Herdr's (no clone). The graph opens the Git Graph of the focused terminal's
// repository; the note opens a new scratchpad.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, run, spaces, panes, focused, exec, shared, setShared, notify } from "herdr";

// Git Graph tabs by repository ("<machine>|<root>" → tab id), so a second click
// goes back to the open one.
const GRAPH_TABS = "git-graph.open";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { space: space?.id, cwd: pane?.cwd || f?.cwd || space?.folder, on };
}

export default class TabBarExtras extends View {
  openGraph(cx) {
    const { space, cwd, on } = location();
    if (!space || !cwd) return;
    cx.spawn(async (cx) => {
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
      if (top?.code !== 0) { notify({ title: "Git Graph", body: "This folder isn't in a git repository.", level: "info" }); return; }
      const root = top.stdout.trim(), id = `${on ?? ""}|${root}`;
      const tabs = spaces().find((s) => s.id === space)?.tabs ?? [];
      const known = (shared(GRAPH_TABS) ?? {})[id];
      if (known && tabs.some((t) => t.id === known)) { run("tab.select", { id: known }); return; }
      const name = `Graph · ${root.split("/").pop()}`;
      this.opening = { id, space, name, before: new Set(tabs.map((t) => t.id)) };
      run("tab.new", { name, space, mod: "git-graph", props: { root, on } });
      cx.notify();
    });
  }

  // tab.new doesn't hand back the new tab: find it when it shows up and remember it.
  remember() {
    const o = this.opening;
    if (!o) return;
    const tab = spaces().find((s) => s.id === o.space)?.tabs.find((t) => !o.before.has(t.id) && t.name === o.name);
    if (!tab) return;
    this.opening = null;
    const alive = new Set(spaces().flatMap((s) => s.tabs.map((t) => t.id)));
    const open = Object.fromEntries(Object.entries(shared(GRAPH_TABS) ?? {}).filter(([, t]) => alive.has(t)));
    open[o.id] = tab.id;
    setShared(GRAPH_TABS, open);
  }

  render(_cx) {
    this.remember();
    const t = theme();
    const button = (id, icon, tip, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .tooltip(tip)
      .on_click((_e, cx) => action(cx))
      .child(svg(icon).size(15));
    return h_flex().id("root").size_full().pr(10).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .child(button("git-graph", "mods/tab-bar-extras/graph.svg", "Git Graph", (cx) => this.openGraph(cx)))
      .child(button("new-scratchpad", "mods/tab-bar-extras/note.svg", "New scratchpad (⌘⇧N)", () => run("mod.open", { name: "scratchpad" })));
  }
}
