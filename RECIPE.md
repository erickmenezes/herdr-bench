# Files in Tabs

Herdr's own window (the `main` layout), except that in the Files panel
clicking a file opens it in its own tab instead of a preview squeezed into
the panel. The tab is named after the file
and shows it read-only: code with syntax colors and line numbers, Markdown
rendered (with a Source button to see the raw text). Clicking the same file
again goes back to its tab instead of opening another. The panel keeps showing
the project's folder while a file tab is in front.

![Files in Tabs](preview.png)

## What you see

- **The panel** (in the right-hand side panel, where Herdr's Files is): looks
  like Herdr's Files. A 42px header with "Files" (semibold) on the left and
  the folder's name on the right (12px, `dim`). Below, a scrolling tree with
  6px padding: rows 28px high, indented `8 + 18 × depth` px, rounded 7px,
  `hover` background on hover. Each row: a 12px chevron for folders (right
  when closed, down when open; files get a 12px gap instead), a 14px folder
  or file icon in `muted`, the name (truncated), and a git mark on the right
  for changed files (11px): `A` in `ansi2` (added or untracked), `D` or `U`
  in `ansi1` (deleted, conflicted), `M` in `blocked` (modified). Folders come
  first, then files, each sorted by name; `.git` is hidden. The panel card
  has a 1px `border` and 10px corners on the `background` color.
- **A file tab**: a tab named after the file (`README.md`), with one mod pane
  filling it. At the top, a 30px bar with a 13px file icon, the file's path
  (12px, `dim`, with your home folder shown as `~`; `machine:` in front for a
  file on another machine) and, for Markdown files only, a small 11px
  "Source" / "Preview" button on the right. Under it, the file:
  - Code and text: a read-only editor with line numbers, folding and syntax
    colors in your theme (keywords `ansi5`, strings `ansi2`, comments `dim`,
    functions `ansi4`, types `ansi3`, numbers `ansi1`, constants `ansi6`),
    12px in your terminal font.
  - Markdown (`.md`, `.markdown`, `.mdx`): rendered, selectable, with 20px
    side and 14px top/bottom padding. A YAML front matter block (`---` …
    `---` at the top) is hidden in the rendered view and shown in Source.
  - Messages instead of content: "Loading file…", "Binary file · no text
    preview", "This file is no longer available", or "Cannot open this file
    (binary, larger than 1 MiB, or unreadable)".
- **The Limits panel** (in the left sidebar, between Spaces and Agents, 160px
  high, `chrome` background, 1px `border` on top): a header "Limits" styled
  like Agents' (11.5px, medium, `dim`, 16px side padding, 41px high). Per
  account, two meters, "Session" (the 5-hour window) and "Weekly": the name
  in `muted`, the percentage (medium; `foreground` under 50%, else the bar's
  color) and "resets in 1h 12m" on the right (11px, `dim`); under them a 4px
  bar on `raised`, filled to the percentage in `accent` under 50%, `ansi3`
  under 80%, `blocked` from 80%. With more than one account, each gets its
  name above its meters, after Herdr's 13px Claude icon
  (`image("icons/claude.svg")`, sized with `.w()`/`.h()`) (`~/.claude` → "Claude", `~/.claude-personal` →
  "Personal"). With no saved limits: "No limits yet. They show up once a
  Claude session's status line runs save-limits.sh."

## How it behaves

- Click a folder: it opens or closes in place. Click a file: a new tab opens
  in the shown space, named after the file, and becomes the shown tab.
- Click a file that already has a tab: that tab is shown again; no second tab.
  This works across restarts as long as the tab is still open.
- The panel follows the focused terminal's folder, like Herdr's Files. When the
  focused pane is a file tab (which has no folder of its own), the panel stays
  on the last terminal folder seen in that space, or the folder of any
  terminal in that space, instead of jumping to the home folder.
- The tree refreshes when anything in the folder changes (and every 10 s); git
  marks refresh with it.
- A file tab reloads by itself when the file changes on disk (local files are
  watched; files on another machine are re-read every 10 s). "Source" /
  "Preview" switches a Markdown tab between raw text and rendered text.
- Close a file tab like any tab. Agent statuses play no part in this mod.
- Limits update within a second of a Claude session's status line running
  (the panel watches the folder), and every 30 s the countdowns move on. A
  window whose reset time has passed shows 0% and "reset". A snapshot older
  than 30 minutes says "as of 2h 5m ago" above its meters.

## Built from

- One layout file, `layouts/Files-Tabs.json`: a clone of Herdr's
  `main` layout (`cloned_from: {name: "main", version: "0.1.13"}`) with
  one change: the block with id `files` (in the right panel's stack
  `panel-body`) has `content.mod` set to `files-tabs` instead of `files`.
  Keep that id, because the tab bar's Files button selects it. The root also
  has `"preview": "layouts/Files-Tabs.svg"`, the picture Settings shows.
  It also adds a block `limits` (`size: {px: 160}`, `min: 80`, mod
  `claude-limits`) in `sidebar-lists` between `spaces` and `agents`.
- One mod folder, `mods/claude-limits/`: `main.js`, `mod.json`
  (`"place": "none"`, `"title": "Limits"`) and `save-limits.sh`.
  - `save-limits.sh` reads the status line's JSON on stdin and, with `jq`,
    writes `{account, updated, rate_limits}` on one line to
    `~/.cache/herdr-claude-limits/<account>.json`, where the account is the
    basename of `CLAUDE_CONFIG_DIR` (default `~/.claude`) without its dot. It
    rewrites only when `rate_limits` changed or the file is a minute old,
    through a temp file and `mv`. `rate_limits` is what Claude Code passes:
    `five_hour` and `seven_day`, each `{used_percentage, resets_at}` (Unix
    seconds).
  - `main.js` default-exports a `View`: it reads every snapshot with one
    `exec("sh", ["-c", 'for f in "$1"/*.json; do [ -f "$f" ] && cat "$f" && echo; done', "limits", dir])`,
    sorted by account; reloads on `watchFolder(dir)` and `cx.timer.every(30000)`.
- One mod folder, `mods/files-tabs/`: `main.js`, `viewer.js`, `mod.json`
  (`"place": "none"`: it shows only where the layout puts it), and four
  icons (`chevron-down.svg`, `chevron-right.svg`, `file.svg`, `folder.svg`).
- `main.js` default-exports one `View` with two roles, chosen by `props()`:
  - **No props → the panel.** A lazy tree of `location().cwd`. Folders are
    listed with `exec("sh", ["-c", <script>, "files", path], { on })`, at
    most 500 entries per folder and 5,000 in all; git marks come from
    `git rev-parse --show-toplevel` and
    `git --no-optional-locks -c core.fsmonitor=false status --porcelain=v1 -z --no-renames --untracked-files=all`.
    Refresh on `watchFolder(cwd)` (local) and `cx.timer.every(10000)`.
    Opened folders are remembered per location.
  - **`{ file, on }` → a file tab**, drawn by `viewer.js`: `readTextFile(file, { on })`,
    `EditorState.new({ language, readonly: true, … })` + `Editor.new(state)`
    for code, `TextView.markdown(id, text).selectable(true)` for Markdown;
    `watchFolder(parent folder)` locally, a 10 s timer remotely. The
    `EditorState` is released on reload and in `close()`.
- Opening a file: `run("tab.new", { name: <file name>, space: <shown space id>, mod: "files-tabs", props: { file: <absolute path>, on: <machine or null> } })`;
  going back: `run("tab.select", { id })`.
- Which tab shows which file: shared value `"files-tabs.open"`, an object
  from `"<machine>|<absolute path>"` to tab id. Ids of tabs that no longer
  exist are dropped whenever an entry is added.
- The panel's folder (`location()`): `focused()`, `panes()`, `spaces()`. A
  focused pane with `terminal: null` is a mod pane, so the last terminal
  location of that space is used (kept in a module-level `Map`).
- Derived from the Files mod shipped with Herdr 0.1.13 (Apache-2.0, see
  `LICENSE`). Changed: a file click opens a tab instead of an in-panel
  preview (the preview, its back arrow and the remembered previewed file are
  removed); the panel's location falls back for mod panes; `viewer.js` added.

## Watch out

- Claude Code gives the session and weekly limits only to its status line,
  so the panel can't know them unless a status line saves them. Asking
  Anthropic's usage endpoint would mean reading the Claude login from the
  Keychain and going online; this layout doesn't.
- Limits are only as new as the last status line run. With no Claude session
  open, the numbers stay where they were (and say how old they are after 30
  minutes); a passed reset time still shows as 0%.

- Settings → Look labels a layout you add with its file name, exactly as
  written, and names may only use letters, digits, `-` and `_`. That's why
  the file is `Files-Tabs.json`: "Files Tabs" with a space isn't allowed.
- It has to ship as a layout. Herdr's own layouts are read-only: a mod with
  `"place": "right"` is never docked into `main` (Herdr doesn't even mark
  it seen), so on stock Herdr a mod alone shows nothing.
- In a mod, `run()` returns `null`, so `tab.new` doesn't tell you the new
  tab's id. Record the space's tab ids before calling it, then on the next
  `render` look for a new tab with the file's name and store its id.
- `panes()` doesn't expose a mod pane's props, so you can't find a file's tab
  by looking at panes: keep the shared map.
- A mod pane has no `cwd`. Without the fallback, focusing a file tab sends
  the panel to the space's folder, which is often the home folder.
- `readTextFile` reads at most 1 MiB; the editor gets at most 400,000
  characters, then "… (file truncated)".
- `watchFolder` only works on this computer. A remote file must be polled.
- Two files with the same name in different folders get tabs with the same
  name. The map uses full paths, so going back still finds the right tab.
- The mod reaches no network. It runs `sh` (to list folders) and `git`, and
  reads the files you click, anywhere the panel can show.
- If you install it under another name, change the `mods/files-tabs/` icon
  paths in both files, `mod: "files-tabs"` in `tab.new`, and the shared key.

## Done when

- `herdr-app check ~/.config/herdr-app/mods/files-tabs` and
  `herdr-app check ~/.config/herdr-app/mods/claude-limits` pass.
- With the status line line added, `~/.cache/herdr-claude-limits/` has one
  file per account, and the Limits panel shows the same session and weekly
  percentages as Claude Code's own `/usage`.
- Settings → Look shows "Files-Tabs" with its preview; with it chosen
  (or after `layout.switch {"name":"Files-Tabs"}`), the tab bar's Files
  button opens the panel and it lists the focused terminal's folder with git marks.
- Clicking a `.js` file opens a tab named after it, with line numbers and
  syntax colors; clicking it again in the panel shows that same tab.
- Clicking a `.md` file shows it rendered without its front matter;
  "Source" shows the raw text and "Preview" goes back.
- With a file tab in front, the panel still lists the project's folder, not
  the home folder.
- Editing the open file on disk updates the tab within a second or two.
