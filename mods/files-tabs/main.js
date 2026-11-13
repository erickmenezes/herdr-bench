// Files in Tabs: Herdr's Files panel, except a double-click on a file opens it in its own tab.
// Without props it is the panel (a lazy tree of the focused pane's folder); with
// props { file, on } it is that tab, a read-only viewer (./viewer.js).
// Based on the Files mod shipped with Herdr (Apache-2.0); changes listed in RECIPE.md.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, focused, exec, watchFolder, theme, window, run, shared, setShared, props, openOverlay, nextCommand } from "herdr";
import Viewer from "./viewer.js";
import { menuItems, MenuView, CLIPBOARD, clipPaths, act } from "./menu.js";
import { DialogView } from "./dialog.js";
import { OPEN_TABS } from "./moves.js";
// Colour icons from the Better Icons mod when it is installed; else the plain ones below.
import { followFileIcons, fileIcon, isLight } from "./file-icons.js";

// The last terminal folder seen in each space, so a file tab (a mod pane, no folder of
// its own) keeps showing the folder the file came from instead of falling back to home.
const lastBySpace = new Map();

function location() {
  const space = spaces().find(s => s.active), f = focused();
  const pane = f?.pane ? panes().find(p => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  if (pane && !pane.terminal) {
    const last = lastBySpace.get(space?.id);
    if (last) return last;
    const tabs = new Set(space?.tabs.map(t => t.id));
    const other = panes().find(p => p.terminal && p.cwd && tabs.has(p.tab));
    return { cwd: other?.cwd || space?.folder, on, space: space?.id };
  }
  const here = { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
  if (space && (pane?.cwd || f?.cwd)) lastBySpace.set(space.id, here);
  return here;
}
// Show as Root: a folder pinned in place of the terminal's, per terminal location
// (space, machine, folder), until Back to the terminal's folder.
const pinned = new Map();
function effective() {
  const here = location(), root = pinned.get(JSON.stringify(here));
  return root ? { ...here, cwd: root, base: here.cwd } : here;
}
const key = () => JSON.stringify(effective());
const parentOf = (path) => path.replace(/[\\/][^\\/]*$/, "") || "/";

// 1023 B, 4.2 KB, 18 KB, 3.1 MB: one decimal below 10.
function formatSize(n) {
  if (!Number.isFinite(n)) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return i === 0 ? `${n} B` : `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

const headerButton = (id, icon, tip, action) => {
  const t = theme();
  return div().id(id).size(24).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.dim)
    .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip(tip).on_click((_e, cx) => action(cx))
    .child(svg(icon).size(14));
};
const PER_FOLDER = 500, TOTAL = 5000, FOUND = 300;
const mac = () => window()?.platform === "macos";

// The filter's search: names containing the text anywhere below the root (not in
// .git or node_modules), as "kind\0path\0" pairs; at most FOUND.
const SEARCH = [
  'root=$1; pat=$2; max=$3',
  'find "$root" -mindepth 1 \\( -name .git -o -name node_modules \\) -prune -o -iname "$pat" -print 2>/dev/null | head -n "$max" |',
  'while IFS= read -r p; do if [ -d "$p" ]; then printf "d\\0%s\\0" "$p"; else printf "f\\0%s\\0" "$p"; fi; done',
].join("\n");
async function search(root, text, on) {
  const pat = `*${text.replace(/[[\]*?\\]/g, c => `\\${c}`)}*`;
  const r = await exec("sh", ["-c", SEARCH, "search", root, pat, String(FOUND)], { on, timeout: 15000 });
  const parts = r.stdout.split("\0"), found = [];
  for (let i = 0; i + 1 < parts.length; i += 2) if (parts[i + 1].startsWith(`${root}/`))
    found.push({ path: parts[i + 1].slice(root.length + 1), dir: parts[i] === "d" });
  const t = text.toLowerCase(), name = p => p.split("/").pop().toLowerCase();
  // Names that start with the text first, then the shallower ones.
  return found.sort((a, b) => Number(!name(a.path).startsWith(t)) - Number(!name(b.path).startsWith(t))
    || a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
}
// The row menu is another copy of this mod (a popup): what it asks of the panel comes
// through shared state, { id, at, location, kind: "root" | "open" | "refresh" | "expand", path },
// acted on once. "expand" reloads with that folder (and the ones above it) open.
const REQUEST = "files-tabs.request";

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && window()?.platform === "windows") return windowsDirectory();
  // Each entry as kind\0name\0; then the pair z\0z\0 and one stat call for every file's size, as
  // "<bytes> <path>" lines (GNU stat on Linux, BSD stat on macOS).
  const script = 'd=$1; shift; n=0; for p in "$d"/* "$d"/.[!.]* "$d"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; set -- "$@" "$p"; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; printf "z\\0z\\0"; if [ "$#" -gt 0 ]; then if stat -c %s / >/dev/null 2>&1; then stat -L -c "%s %n" -- "$@" 2>/dev/null; else stat -L -f "%z %N" -- "$@" 2>/dev/null; fi; fi; test -d "$d"';
  let r;
  try { r = await exec("sh", ["-c", script, "files", path], { on }); }
  catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  // Read in pairs: a name can be "z", a kind (d or f) never is.
  const fields = r.stdout.split("\0"), list = [], sizes = new Map();
  let i = 0;
  for (; i + 1 < fields.length && fields[i] !== "z"; i += 2) list.push({ name: fields[i + 1], dir: fields[i] === "d" });
  for (const line of (fields[i] === "z" ? fields.slice(i + 2).join("") : "").split("\n")) {
    const space = line.indexOf(" ");
    if (space > 0) sizes.set(line.slice(space + 1).split("/").pop(), Number(line.slice(0, space)));
  }
  return list.map(e => e.dir ? e : { ...e, size: sizes.get(e.name) });
}

export default class FilesTabs extends View {
  init(_props, cx) {
    const p = props();
    if (p?.file) { this.viewer = new Viewer(p, cx); return; }
    if (p?.menu) { this.menu = new MenuView(p, cx); return; }
    if (p?.dialog) { this.dialog = new DialogView(p, cx); return; }
    followFileIcons(this, cx);
    this.saved = new Map();
    this.entries = new Map(); this.folders = new Set(); this.pending = new Set(); this.marks = {};
    // Selected rows (paths below the root): a click picks one, ⌘-click adds or removes,
    // ⇧-click picks the range from the last clicked row (the anchor).
    this.selected = new Set(); this.anchor = null; this.visible = []; this.kinds = new Map();
    // Keyboard: the row the arrows are on (cursor), and the filter typed into the panel,
    // whose matches (found) replace the tree while it isn't empty.
    this.cursor = null; this.filter = ""; this.found = null; this.searching = false;
    this.handle = cx.focus_handle(); this.scroll = ScrollHandle.new(); this.reveal = null;
    cx.spawn(async cx => { for (;;) { if (await nextCommand() === "focus") { this.handle.focus(); cx.notify(); } } });
    this.refresh(cx);
    cx.timer.every(10000, cx => this.refresh(cx));
  }

  watch(root, cx) {
    if (this.on || this.watched === root) return;
    this.watched = root;
    const context = this.context;
    cx.spawn(async cx => {
      try { while (this.context === context) { await watchFolder(root); if (this.current(context)) this.refresh(cx); } }
      catch { if (this.context === context) this.watched = null; }
    });
  }

  current(context) {
    return this.context === context && key() === context.key;
  }

  async loadFolder(path, context) {
    const { on, cwd: root } = context;
    const entries = await directory(path ? `${root}/${path}` : root, on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    const { cwd, on, base } = effective(), next = key();
    if (next !== this.context?.key) {
      if (this.context) this.saved.set(this.context.key, { folders: this.folders });
      const saved = this.saved.get(next);
      this.context = { key: next, cwd, on }; this.root = cwd; this.on = on; this.base = base ?? null; this.entries = new Map(); this.folders = new Set(saved?.folders);
      this.pending = new Set(); this.marks = {}; this.watched = null; this.error = null; this.limited = false;
      this.selected = new Set(); this.anchor = null; this.cursor = null;
      this.filter = ""; this.found = null;
      this.loading = false;
    }
    if (!cwd || this.loading) return;
    const context = this.context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async cx => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0) for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
            const xy = entry.slice(0, 2);
            marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
          }
        }
        if (!this.current(context)) return;
        this.marks = marks; this.error = null; this.watch(cwd, cx);
      } catch (e) { if (this.current(context)) this.error = String(e); }
      finally { if (this.context === context) this.loading = false; cx.notify(); }
    });
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders]) if (folder === path || folder.startsWith(path + "/")) {
        this.folders.delete(folder);
        this.entries.delete(folder);
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async cx => {
          try { await this.loadFolder(path, context); }
          catch (e) { if (this.current(context)) this.error = String(e); }
          finally { if (this.context === context) this.pending.delete(path); cx.notify(); }
        });
      }
    }
    cx.notify();
  }

  open(path) { this.openFile(`${this.root}/${path}`); }

  openFile(file) {
    const { space } = location();
    if (!space) return;
    const id = `${this.on ?? ""}|${file}`;
    const tabs = spaces().find(s => s.id === space)?.tabs ?? [];
    const known = (shared(OPEN_TABS) ?? {})[id];
    if (known && tabs.some(t => t.id === known)) { run("tab.select", { id: known }); return; }
    const name = file.split("/").pop();
    this.opening = { id, space, name, before: new Set(tabs.map(t => t.id)) };
    run("tab.new", { name, space, mod: "files-tabs", props: { file, on: this.on } });
  }

  // tab.new doesn't return the new tab: find it when it shows up and remember it.
  remember() {
    const o = this.opening;
    if (!o) return;
    const tab = spaces().find(s => s.id === o.space)?.tabs.find(t => !o.before.has(t.id) && t.name === o.name);
    if (!tab) return;
    this.opening = null;
    const alive = new Set(spaces().flatMap(s => s.tabs.map(t => t.id)));
    const open = Object.fromEntries(Object.entries(shared(OPEN_TABS) ?? {}).filter(([, t]) => alive.has(t)));
    open[o.id] = tab.id;
    setShared(OPEN_TABS, open);
  }

  rows(prefix, depth, out, t, light = isLight(t.background), clip = shared(CLIPBOARD)) {
    if (out.length >= TOTAL || depth > 40) return out;
    const cut = new Set(clip?.mode === "cut" && (clip.on ?? null) === (this.on ?? null) ? clipPaths(clip) : []);
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name, open = this.folders.has(path), mark = this.marks[`${this.root}/${path}`];
      this.visible.push(path); this.kinds.set(path, entry.dir);
      out.push(h_flex().id(`file-${path}`).h(28).flex_none().pl(8 + depth * 18).pr(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(this.selected.has(path), el => el.bg(t.selected))
        .hover(s => s.bg(t.hover))
        .when(cut.has(`${this.root}/${path}`), el => el.opacity(0.5)) // cut, waiting for a paste
        .on_click((e, cx) => this.click(path, entry, e, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.rightClick(path, entry, cx); })
        .child(entry.dir ? svg(`mods/files-tabs/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none().text_color(t.dim) : div().w(12).flex_none())
        .child((icon => icon ? image(icon).w(14).h(14).flex_none() : svg(`mods/files-tabs/${entry.dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))(
          fileIcon(this.fileIcons, `${this.root}/${path}`, { dir: entry.dir, open, light })))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(!entry.dir && Number.isFinite(entry.size), el => el.child(div().flex_none().text_size(11).text_color(t.dim).child(formatSize(entry.size))))
        .when(Boolean(mark), el => el.child(div().text_size(11).text_color(mark === "A" ? t.ansi2 : mark === "D" || mark === "U" ? t.ansi1 : t.blocked).child(mark))));
      if (entry.dir && open) this.rows(path, depth + 1, out, t, light, clip);
    }
    return out;
  }

  // The filter's matches, a flat list: the name, then the folder it is in.
  foundRows(t, light = isLight(t.background)) {
    return this.found.map(({ path, dir }) => {
      const entry = { name: path.split("/").pop(), dir }, folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      this.visible.push(path); this.kinds.set(path, dir);
      return h_flex().id(`found-${path}`).h(28).flex_none().px(8).gap(7).items_center().rounded(7).cursor_pointer()
        .when(this.selected.has(path), el => el.bg(t.selected))
        .hover(s => s.bg(t.hover))
        .on_click((e, cx) => this.click(path, entry, e, cx))
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.rightClick(path, entry, cx); })
        .child((icon => icon ? image(icon).w(14).h(14).flex_none() : svg(`mods/files-tabs/${dir ? "folder" : "file"}.svg`).size(14).flex_none().text_color(t.muted))(
          fileIcon(this.fileIcons, `${this.root}/${path}`, { dir, open: false, light })))
        .child(div().flex_none().max_w_full().truncate().child(entry.name))
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(folder));
    });
  }

  click(path, entry, e, cx) {
    const m = e.modifiers ?? {};
    this.handle.focus(); this.cursor = path;
    if (m.platform) {
      if (this.selected.has(path)) this.selected.delete(path); else this.selected.add(path);
      this.anchor = path; cx.notify(); return;
    }
    if (m.shift && this.anchor && this.visible.includes(this.anchor)) {
      const a = this.visible.indexOf(this.anchor), b = this.visible.indexOf(path);
      this.selected = new Set(this.visible.slice(Math.min(a, b), Math.max(a, b) + 1));
      cx.notify(); return;
    }
    this.selected = new Set([path]); this.anchor = path;
    if (this.found && entry.dir) { this.showInTree(path, cx); return; }
    // A click selects a file and a double-click opens it (its tab takes the keyboard).
    if (!entry.dir) { if (e.click_count >= 2) this.open(path); }
    else if (e.click_count >= 2) this.showAsRoot(`${this.root}/${path}`, cx);
    else this.toggle(path, cx);
    cx.notify();
  }

  // On a selected row the menu acts on every selected row; elsewhere it picks that row.
  rightClick(path, entry, cx) {
    this.handle.focus();
    if (!this.selected.has(path)) { this.selected = new Set([path]); this.anchor = path; this.cursor = path; }
    const menu = this.menuFor(path, entry.dir);
    openOverlay({ mod: "files-tabs", kind: "popup", width: 230, height: 32 * menuItems(menu).length + 24, props: { menu } });
    cx.notify();
  }

  // What the row menu (and the keys) act on: the row, or every selected row when it is one.
  menuFor(path, dir) {
    const items = this.visible.filter(p => this.selected.has(p)).map(p => ({ path: `${this.root}/${p}`, relative: p, dir: this.kinds.get(p) }));
    return { path: `${this.root}/${path}`, relative: path, dir, on: this.on, location: JSON.stringify(location()),
      items: items.length > 1 ? items : undefined };
  }

  // Leaves the filter and shows a found row in the tree: the folders above it open.
  showInTree(path, cx) {
    const parts = path.split("/");
    parts.slice(0, -1).forEach((_, i) => this.folders.add(parts.slice(0, i + 1).join("/")));
    this.filter = ""; this.found = null;
    this.selected = new Set([path]); this.anchor = this.cursor = this.reveal = path;
    this.refresh(cx);
    cx.notify();
  }

  setFilter(text, cx) {
    this.filter = text;
    if (!text) { this.found = null; cx.notify(); return; }
    const context = this.context, asked = text;
    this.searching = true; cx.notify();
    cx.spawn(async cx => {
      await cx.sleep(120); // typing on: only the last one searches
      if (this.filter !== asked || !this.current(context)) return;
      let found;
      if (window()?.platform === "windows" && !this.on) {
        // No find: the open folders only.
        const t = asked.toLowerCase();
        found = [...this.entries.entries()].flatMap(([prefix, list]) => list.map(e => ({ path: prefix ? `${prefix}/${e.name}` : e.name, dir: e.dir })))
          .filter(e => e.path.split("/").pop().toLowerCase().includes(t)).slice(0, FOUND);
      } else found = await search(this.root, asked, this.on).catch(() => []);
      if (this.filter !== asked || !this.current(context)) return;
      this.found = found; this.searching = false;
      const first = found[0]?.path ?? null;
      this.selected = new Set(first ? [first] : []); this.anchor = this.cursor = first;
      this.scroll.scroll_to_item(0);
      cx.notify();
    });
  }

  // Moves the cursor to a row; with shift, the selection runs from the anchor to it.
  moveTo(path, extend, cx) {
    if (!path) return;
    this.cursor = path;
    if (extend && this.anchor && this.visible.includes(this.anchor)) {
      const a = this.visible.indexOf(this.anchor), b = this.visible.indexOf(path);
      this.selected = new Set(this.visible.slice(Math.min(a, b), Math.max(a, b) + 1));
    } else { this.selected = new Set([path]); this.anchor = path; }
    this.scroll.scroll_to_item(this.visible.indexOf(path));
    cx.notify();
  }

  // Finder's keys on macOS (Enter renames, ⌘↓ opens, ⌘⌫ to the Trash, ⌘↑ up a level),
  // the usual ones elsewhere (Enter opens, F2 renames, Delete, Alt+↑). Typing filters.
  keyDown(e, cx) {
    const k = e.keystroke, m = e.modifiers ?? {}, onMac = mac(), cmd = onMac ? "cmd" : "ctrl";
    const at = this.cursor && this.visible.includes(this.cursor) ? this.cursor : null, i = this.visible.indexOf(at);
    const dir = at ? Boolean(this.kinds.get(at)) : false;
    const many = this.visible.filter(p => this.selected.has(p)).length > 1;
    const unix = window()?.platform !== "windows";
    const open = () => { if (!at) return; if (this.found) dir ? this.showInTree(at, cx) : this.open(at); else if (!dir) this.open(at); else if (onMac) this.showAsRoot(`${this.root}/${at}`, cx); else this.toggle(at, cx); };
    const menu = (action) => { if (at && unix) act(this.menuFor(at, dir), action); };
    const handled = (() => {
      switch (k) {
        case "down": case "shift-down": this.moveTo(this.visible[at ? Math.min(i + 1, this.visible.length - 1) : 0], m.shift, cx); return true;
        case "up": case "shift-up": this.moveTo(this.visible[at ? Math.max(i - 1, 0) : this.visible.length - 1], m.shift, cx); return true;
        case "home": this.moveTo(this.visible[0], false, cx); return true;
        case "end": this.moveTo(this.visible[this.visible.length - 1], false, cx); return true;
        case "right":
          if (!at || !dir || this.found) return true;
          if (!this.folders.has(at)) this.toggle(at, cx); else if (this.visible[i + 1]?.startsWith(`${at}/`)) this.moveTo(this.visible[i + 1], false, cx);
          return true;
        case "left":
          if (!at || this.found) return true;
          if (dir && this.folders.has(at)) this.toggle(at, cx);
          else if (at.includes("/")) this.moveTo(at.slice(0, at.lastIndexOf("/")), false, cx);
          return true;
        case "escape":
          if (this.filter) this.setFilter("", cx); else { this.selected = new Set(); this.anchor = this.cursor = null; cx.notify(); }
          return true;
        case "backspace": if (this.filter) { this.setFilter(this.filter.slice(0, -1), cx); return true; } break;
        case `${cmd}-a`: this.selected = new Set(this.visible); cx.notify(); return true;
        case `${cmd}-c`: menu("copy"); return true;
        case `${cmd}-x`: menu("cut"); return true;
        case `${cmd}-alt-c`: menu("path"); return true;
        case `${cmd}-v`: {
          if (!unix || !this.root) return true;
          // Into the selected folder, the selected file's folder, or the root.
          const into = at && !many ? this.menuFor(at, dir) : { path: this.root, relative: "", dir: true, on: this.on, location: JSON.stringify(location()), background: true };
          act(into, "paste"); return true;
        }
      }
      if (onMac) switch (k) {
        case "enter": if (this.found) open(); else if (at && !many && unix) menu("rename"); return true;
        case "cmd-down": case "cmd-o": open(); return true;
        case "cmd-up": if (this.root && this.root !== "/") this.showAsRoot(parentOf(this.root), cx); return true;
        case "cmd-backspace": menu("trash"); return true;
      } else switch (k) {
        case "enter": open(); return true;
        case "f2": if (at && !many && unix) menu("rename"); return true;
        case "delete": menu("trash"); return true;
        case "alt-up": if (this.root && this.root !== "/") this.showAsRoot(parentOf(this.root), cx); return true;
      }
      // Anything else that types a character filters (not with ⌘ or Ctrl).
      const ch = e.key_char;
      if (ch && ch.length === 1 && ch >= " " && !m.platform && !m.control && !(ch === " " && !this.filter)) { this.setFilter(this.filter + ch, cx); return true; }
      return false;
    })();
    if (handled) cx.stop_propagation();
  }

  // Pins a folder in place of the terminal's; null goes back to the terminal's folder.
  showAsRoot(folder, cx) {
    const here = JSON.stringify(location());
    if (!folder || folder === location().cwd) pinned.delete(here);
    else pinned.set(here, folder);
    this.refresh(cx);
    cx.notify();
  }

  // A request from the row menu, for this terminal location, made in the last few seconds.
  answer(cx) {
    const r = shared(REQUEST);
    if (!r || r.id === this.answered || Date.now() - (r.at ?? 0) > 5000 || r.location !== JSON.stringify(location())) return;
    this.answered = r.id;
    if (r.kind === "root") this.showAsRoot(r.path, cx);
    else if (r.kind === "open") this.openFile(r.path);
    else if (r.kind === "refresh") this.refresh(cx); // after a rename, a paste or a move to the Trash
    else if (r.kind === "expand") {
      // A new folder or a paste inside a folder: open it so the result shows.
      if (r.path.startsWith(`${this.root}/`)) {
        const parts = r.path.slice(this.root.length + 1).split("/");
        parts.forEach((_, i) => this.folders.add(parts.slice(0, i + 1).join("/")));
      }
      this.refresh(cx);
    }
  }

  async close() { this.viewer?.close(); }

  render(cx) {
    if (this.viewer) return this.viewer.render(cx);
    if (this.menu) return this.menu.render(cx);
    if (this.dialog) return this.dialog.render(cx);
    if (key() !== this.context?.key) this.refresh(cx);
    this.remember();
    this.answer(cx);
    const t = theme();
    if (this.reveal && this.visible.includes(this.reveal)) { this.scroll.scroll_to_item(this.visible.indexOf(this.reveal)); this.reveal = null; }
    return v_flex().id("files").track_focus(this.handle).on_key_down((e, cx) => this.keyDown(e, cx)).size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Files"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(this.base ? t.foreground : t.dim).child(this.root?.split(/[\\/]/).pop() || this.root || ""))
        .when(Boolean(this.root) && this.root !== "/", el => el.child(headerButton("files-up", "mods/files-tabs/up.svg", "Up one level", cx => this.showAsRoot(parentOf(this.root), cx))))
        .when(Boolean(this.base), el => el.child(headerButton("files-back", "mods/files-tabs/home.svg", "Back to the terminal's folder", cx => this.showAsRoot(null, cx)))))
      .when(Boolean(this.filter), el => el.child(h_flex().h(30).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border).text_size(12)
        .child(div().text_color(t.dim).child("Filter"))
        .child(div().flex_1().min_w(0).truncate().child(`${this.filter}▏`))
        .child(div().flex_none().text_color(t.dim).child(this.searching ? "…" : `${this.found?.length ?? 0}${this.found?.length >= FOUND ? "+" : ""}`))
        .child(div().id("files-filter-clear").flex_none().px(4).rounded(4).cursor_pointer().text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip("Clear (Esc)").on_click((_e, cx) => this.setFilter("", cx)).child("esc"))))
      .child(v_flex().id("files-tree").track_scroll(this.scroll).flex_1().min_h(0).overflow_y_scrollbar().p(6)
        // The tree's empty space: New Folder… and Paste for the panel's root (rows stop this).
        .on_mouse_down("right", (_e, cx) => {
          if (!this.root) return;
          this.handle.focus();
          const menu = { path: this.root, relative: "", dir: true, on: this.on, location: JSON.stringify(location()), background: true };
          openOverlay({ mod: "files-tabs", kind: "popup", width: 230, height: 32 * menuItems(menu).length + 24, props: { menu } });
        })
        .children((this.visible = [], this.kinds = new Map(), this.found ? this.foundRows(t) : this.filter ? [] : this.rows("", 0, [], t)))
        .when(Boolean(this.found) && !this.found.length && !this.searching, el => el.child(div().p(8).text_size(12).text_color(t.dim).child(`Nothing named like “${this.filter}”`)))
        .when(!this.filter && (Boolean(this.error) || !this.entries.get("")?.length), el => el.child(div().p(8).text_size(12).text_color(t.dim).child(this.error || (this.loading ? "Loading files…" : this.root ? "No files" : "No folder"))))
        .when(this.limited, el => el.child(div().p(8).text_size(11).text_color(t.dim).child("File list limited to 500 entries per folder and 5,000 total"))));
  }
}
