// Renames and moves (a cut pasted elsewhere), so open file tabs follow their file.
// Both maps are shared state, keyed "<machine>|<path>" ("" for this computer):
//   OPEN_TABS: which tab shows which file (the panel goes back to it on a click).
//   MOVED:     old path -> new path; a file tab resolves its file through it, also
//              after a restart, and a moved folder carries the files inside it.
import { run, shared, setShared } from "herdr";

export const OPEN_TABS = "files-tabs.open";
export const MOVED = "files-tabs.moved";
const KEEP = 100; // newest moves kept

const key = (on, path) => `${on ?? ""}|${path}`;
const under = (path, folder) => path === folder || path.startsWith(`${folder}/`);

/** Where a file is now, following recorded moves (of the file or a folder above it). */
export function resolveMove(on, file) {
  const moved = shared(MOVED) ?? {}, prefix = `${on ?? ""}|`;
  let now = file;
  for (let step = 0; step < 20; step++) {
    let best = null;
    for (const [k, to] of Object.entries(moved)) {
      if (!k.startsWith(prefix)) continue;
      const from = k.slice(prefix.length);
      if (under(now, from) && (!best || from.length > best.from.length)) best = { from, to };
    }
    if (!best || best.to === best.from) break;
    now = best.to + now.slice(best.from.length);
  }
  return now;
}

/** Records a rename or move: tabs showing the file (or files inside the folder) follow it. */
export function recordMove(on, from, to) {
  if (from === to) return;
  const moved = { ...(shared(MOVED) ?? {}) };
  // Something lives at `to` now: older moves away from there (or from inside it) no
  // longer apply, or a rename back (a → b → a) would send tabs round in circles.
  const prefix0 = `${on ?? ""}|`;
  for (const k of Object.keys(moved)) if (k.startsWith(prefix0) && under(k.slice(prefix0.length), to)) delete moved[k];
  delete moved[key(on, from)]; // re-added last, as the newest
  moved[key(on, from)] = to;
  const keys = Object.keys(moved);
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP))) delete moved[k];
  setShared(MOVED, moved);

  const prefix = `${on ?? ""}|`, open = { ...(shared(OPEN_TABS) ?? {}) };
  let changed = false;
  for (const [k, tab] of Object.entries(open)) {
    if (!k.startsWith(prefix)) continue;
    const path = k.slice(prefix.length);
    if (!under(path, from)) continue;
    const now = to + path.slice(from.length);
    delete open[k];
    open[key(on, now)] = tab;
    changed = true;
    // The tab is named after its file: a renamed file renames its tab.
    if (path === from) run("tab.rename", { id: tab, name: now.split("/").pop() });
  }
  if (changed) setShared(OPEN_TABS, open);
}
