// The row menu of the Files panel: a popup copy of this mod with props { menu }.
// menu: { path, relative, dir, on, location }. Opening a file and Show as Root are the
// panel's to do, so those go to it through shared state (REQUEST in main.js); the rest
// runs here. ↑/↓ move, Enter runs, Esc closes, like Herdr's own menus.
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, exec, window, notify, setShared } from "herdr";

const REQUEST = "files-tabs.request";
const mac = () => window()?.platform === "macos";

// [label, action]; "-" is a divider. Finder and the default app only for files on this Mac.
// Rename… and Move to Trash… open a dialog (dialog.js) that asks first.
export function menuItems(m) {
  const here = !m.on && mac();
  return [
    ...(m.dir ? [["Show as Root", "root"], ["New Terminal Here", "terminal"]] : [["Open", "open"]]),
    ...(!m.dir && here ? [["Open with Default App", "default"]] : []),
    ...(here ? [["Reveal in Finder", "reveal"]] : []),
    ...(window()?.platform === "windows" ? [] : [["-"], ["Copy Path", "path"], ["Copy Relative Path", "relative"],
      ["-"], ["Rename…", "rename"], ["Move to Trash…", "trash"]]),
  ];
}

// Copies text to this computer's clipboard (macOS, else Wayland or X11 tools).
async function copy(text) {
  const r = await exec("sh", ["-c", 'printf %s "$1" | { pbcopy || wl-copy || xclip -selection clipboard || xsel -b; } 2>/dev/null', "copy", text]);
  if (r.code !== 0) throw new Error("No clipboard tool");
}

export class MenuView {
  constructor(p, cx) {
    this.m = p.menu;
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(action) {
    const m = this.m;
    closeOverlay(props()?.overlay);
    const ask = (kind) => setShared(REQUEST, { id: `${Date.now()}-${Math.random()}`, at: Date.now(), location: m.location, kind, path: m.path });
    const fail = (what) => () => notify({ title: `Couldn't ${what}`, level: "error" });
    switch (action) {
      case "open": ask("open"); break;
      case "root": ask("root"); break;
      case "terminal": run("terminal.open", { folder: m.path, place: "tab" }); break;
      case "default": exec("open", [m.path]).catch(fail("open it")); break;
      case "reveal": exec("open", ["-R", m.path]).catch(fail("show it in Finder")); break;
      case "path": copy(m.path).then(() => notify({ title: "Path copied", body: m.path, timeout: 2000 })).catch(fail("copy the path")); break;
      case "rename": case "trash":
        openOverlay({ mod: "files-tabs", kind: "dialog", width: 440, height: action === "rename" ? 196 : 176, props: { dialog: { kind: action, path: m.path, dir: m.dir, on: m.on, location: m.location } } });
        break;
      case "relative": copy(m.relative).then(() => notify({ title: "Relative path copied", body: m.relative, timeout: 2000 })).catch(fail("copy the path")); break;
    }
  }

  render(_cx) {
    const t = theme();
    const list = menuItems(this.m);
    const actions = list.filter(it => it[0] !== "-");
    let n = -1;
    return v_flex().id("files-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % actions.length;
        else if (e.key === "up") this.at = (this.at + actions.length - 1) % actions.length;
        else if (e.key === "enter") this.choose(actions[this.at][1]);
        else if (e.key === "escape") closeOverlay(props()?.overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => {
        if (it[0] === "-") return div().id(`fm-sep-${i}`).mx(7).my(4).h(1).bg(t.border);
        const k = ++n;
        return h_flex().id(`fm-${i}`).h(31).px(8).rounded(7).items_center().text_color(t.foreground)
          .when(k === this.at, el => el.bg(t.selected))
          .hover(s => s.bg(t.hover))
          .on_click(() => this.choose(it[1]))
          .child(div().flex_1().truncate().child(it[0]));
      }));
  }
}
