# Files in Tabs

A [Herdr](https://herdr.dev) layout: Herdr's own window, except that clicking
a file in the Files panel opens it in its own tab. Code shows with syntax
colors and line numbers, Markdown shows rendered, and pictures (PNG, JPEG,
GIF, WebP, SVG…) show as pictures. Clicking the same file again goes back to
its tab. The panel shows each file's size, and a double-click on a folder
shows it as the root, with buttons for up one level and back to the
terminal's folder. Right-click a row for Open, Show as Root, New Terminal
Here, Open with Default App, Reveal in Finder, Cut, Copy, Paste, Copy Path,
Copy Relative Path, New Folder…, Rename… and Move to Trash… (never a plain
delete); right-click the empty space for New Folder… and Paste at the top. Files and folders get colour icons (VS Code's
Material Icon Theme, through the bundled Better Icons mod). Above Agents, a
Limits panel shows how much of Claude's session (5-hour) and weekly limits
you've used, per account. And a note button after Files in the tab bar (or
`cmd-shift-n`) opens a Scratchpad: an empty tab for quick plain-text notes
that stays until you close it.

![Files in Tabs](preview.png)

## Install

Give your agent this line:

```
Add the Herdr layout at github.com/erickmenezes/herdr-files-tabs
```

Or copy `layouts/Files-Tabs.json` and `layouts/Files-Tabs.svg` into
`~/.config/herdr-app/layouts/`, and the five folders in `mods/`
(`files-tabs`, `better-icons`, `claude-limits`, `scratchpad`, `tab-bar-extras`)
into `~/.config/herdr-app/mods/`. If you already have Better Icons installed,
keep yours: other mods find it by the same name. Add the key in
`keys.json` (`cmd-shift-n`, a new scratchpad) to your own `keys.json`, unless
you already use that key. Then pick "Files-Tabs" in Settings → Look.
`ctrl-shift-l` switches back to your usual layout.

The Limits panel gets its numbers from Claude Code's status line, which is
the only place Claude Code shares them. Add this line to your status line
script, right after it reads its input into `$input`:

```sh
printf '%s' "$input" | bash ~/.config/herdr-app/mods/claude-limits/save-limits.sh
```

It needs `jq`. Each Claude config folder (`~/.claude`, or whatever
`CLAUDE_CONFIG_DIR` points to) gets its own row. Without a status line, the
panel says so and stays empty.

What it touches: the Files panel runs `sh` (to list folders), `stat` and
`git status`, reads the files you click, and, only from its right-click
menu, `open`, `pbcopy` (or `wl-copy`/`xclip`/`xsel`), `mkdir`, `cp -R -p` to
paste a copy, `mv -n` to rename or paste a cut, and
`/usr/bin/trash` (else Finder via `osascript`; `gio trash` or `trash-put` on
Linux and SSH machines) to move to the Trash. The Limits panel runs `sh` to read
`~/.cache/herdr-claude-limits/`, which `save-limits.sh` writes. Those
don't reach the network or read your Claude login. Scratchpad notes are kept
in Herdr's own storage for that mod, not in files. Better Icons (about 5 MB of
icons) only reads its own folder.

## License

Apache-2.0. Based on the `main` layout and the Files mod that ship with
Herdr; the changes are listed in [RECIPE.md](RECIPE.md). Bundles
[Better Icons](https://github.com/munza/herdr-mods/tree/main/better-icons)
(Apache-2.0) with its Material Icon Theme icons (MIT); see [NOTICE](NOTICE).
