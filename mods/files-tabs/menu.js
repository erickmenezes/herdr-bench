// The row menu of the Files panel: a popup copy of this mod with props { menu }.
// menu: { path, relative, dir, on, location, background }; background is a right-click
// on the tree's empty space (path is then the panel's root). Opening a file, Show as
// Root and reloading are the panel's to do, so those go to it through shared state
// (REQUEST in main.js); the rest runs here. ↑/↓ move, Enter runs, Esc closes.
import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, exec, window, notify, shared, setShared } from "herdr";

const REQUEST = "files-tabs.request";
// What Cut or Copy picked: { path, on, mode: "cut" | "copy", dir }. The files' own
// clipboard, separate from the text one, shared by every copy of the mod.
export const CLIPBOARD = "files-tabs.clipboard";
const mac = () => window()?.platform === "macos";
const nameOf = (path) => path.split("/").pop();
const parentOf = (path) => path.replace(/\/[^/]*$/, "") || "/";
// The folder a new folder or a paste goes into: the folder clicked, or the file's.
const folderOf = (m) => (m.dir ? m.path : parentOf(m.path));

// Copy: a free name like Finder's ("a copy.txt", "a copy 2.txt"). Cut: never over
// something (exit 3), and a cut pasted where it already is changes nothing. A folder
// can't go inside itself (exit 5).
const PASTE = [
  'src=$1; dir=$2; mode=$3; name=${src##*/}',
  'case "$dir/" in "$src"/*) exit 5;; esac',
  '[ -e "$src" ] || [ -L "$src" ] || exit 4',
  'dest="$dir/$name"',
  'if [ "$mode" = cut ]; then [ "$dest" = "$src" ] && exit 0; if [ -e "$dest" ] || [ -L "$dest" ]; then exit 3; fi; exec mv -n -- "$src" "$dest"; fi',
  'stem=$name; ext=; case "$name" in ?*.*) if [ ! -d "$src" ]; then stem=${name%.*}; ext=.${name##*.}; fi;; esac',
  'n=1; while [ -e "$dest" ] || [ -L "$dest" ]; do if [ "$n" -eq 1 ]; then dest="$dir/$stem copy$ext"; else dest="$dir/$stem copy $n$ext"; fi; n=$((n+1)); done',
  'cp -R -p -- "$src" "$dest"',
].join("\n");

// [label, action]; "-" is a divider. Finder and the default app only for files on this Mac.
// New Folder…, Rename… and Move to Trash… open a dialog (dialog.js) that asks first.
export function menuItems(m) {
  const here = !m.on && mac(), unix = window()?.platform !== "windows";
  const clip = shared(CLIPBOARD);
  const paste = clip ? [[m.dir && !m.background ? `Paste into “${nameOf(m.path)}”` : "Paste", "paste"]] : [];
  if (m.background) return [
    ...(unix ? [["New Folder…", "mkdir"], ...paste, ["-"]] : []),
    ...(here ? [["Reveal in Finder", "reveal"]] : []),
    ...(unix ? [["Copy Path", "path"]] : []),
  ];
  return [
    ...(m.dir ? [["Show as Root", "root"], ["New Terminal Here", "terminal"]] : [["Open", "open"]]),
    ...(!m.dir && here ? [["Open with Default App", "default"]] : []),
    ...(here ? [["Reveal in Finder", "reveal"]] : []),
    ...(unix ? [["-"], ["Cut", "cut"], ["Copy", "copy"], ...paste,
      ["-"], ["Copy Path", "path"], ["Copy Relative Path", "relative"],
      ["-"], ["New Folder…", "mkdir"], ["Rename…", "rename"], ["Move to Trash…", "trash"]] : []),
  ];
}

// Copies text to this computer's clipboard (macOS, else Wayland or X11 tools).
async function copyText(text) {
  const r = await exec("sh", ["-c", 'printf %s "$1" | { pbcopy || wl-copy || xclip -selection clipboard || xsel -b; } 2>/dev/null', "copy", text]);
  if (r.code !== 0) throw new Error("No clipboard tool");
}

export function ask(location, kind, path) {
  setShared(REQUEST, { id: `${Date.now()}-${Math.random()}`, at: Date.now(), location, kind, path });
}

async function paste(m) {
  const clip = shared(CLIPBOARD), into = folderOf(m);
  if (!clip) return;
  if ((clip.on ?? null) !== (m.on ?? null)) {
    notify({ title: "Can't paste between machines yet", body: `${nameOf(clip.path)} is on ${clip.on ?? "this computer"}, this folder on ${m.on ?? "this computer"}.`, level: "warning" });
    return;
  }
  const r = await exec("sh", ["-c", PASTE, "paste", clip.path, into, clip.mode], { on: m.on }).catch((e) => ({ code: -1, stderr: String(e) }));
  const what = nameOf(clip.path);
  const errors = { 3: `“${what}” already exists in “${nameOf(into)}”.`, 4: `“${what}” is no longer there.`, 5: "A folder can't go inside itself." };
  if (r.code !== 0) { notify({ title: "Couldn't paste", body: errors[r.code] ?? (r.stderr?.trim().split("\n").pop() || ""), level: "error" }); return; }
  if (clip.mode === "cut") setShared(CLIPBOARD, null);
  ask(m.location, m.background || !m.dir ? "refresh" : "expand", into);
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
    const fail = (what) => () => notify({ title: `Couldn't ${what}`, level: "error" });
    const dialog = (kind, height) => openOverlay({ mod: "files-tabs", kind: "dialog", width: 440, height,
      props: { dialog: { kind, path: kind === "mkdir" ? folderOf(m) : m.path, dir: m.dir, on: m.on, location: m.location, expand: kind === "mkdir" && m.dir && !m.background } } });
    switch (action) {
      case "open": ask(m.location, "open", m.path); break;
      case "root": ask(m.location, "root", m.path); break;
      case "terminal": run("terminal.open", { folder: m.path, place: "tab" }); break;
      case "default": exec("open", [m.path]).catch(fail("open it")); break;
      case "reveal": exec("open", m.background ? [m.path] : ["-R", m.path]).catch(fail("show it in Finder")); break;
      case "cut": case "copy": setShared(CLIPBOARD, { path: m.path, on: m.on ?? null, mode: action, dir: m.dir }); break;
      case "paste": paste(m); break;
      case "path": copyText(m.path).then(() => notify({ title: "Path copied", body: m.path, timeout: 2000 })).catch(fail("copy the path")); break;
      case "relative": copyText(m.relative).then(() => notify({ title: "Relative path copied", body: m.relative, timeout: 2000 })).catch(fail("copy the path")); break;
      case "mkdir": dialog("mkdir", 196); break;
      case "rename": dialog("rename", 196); break;
      case "trash": dialog("trash", 176); break;
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
