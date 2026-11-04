# Files in Tabs

A [Herdr](https://herdr.dev) mod: click a file in the Files panel and it opens
in its own tab. Code shows with syntax colors and line numbers, and Markdown
shows rendered. Clicking the same file again goes back to its tab.

![Files in Tabs](preview.png)

## Install

Give your agent this line:

```
Add the Herdr mod at github.com/erickmenezes/herdr-files-tabs
```

Or copy `mods/files-tabs/` into `~/.config/herdr-app/mods/`. Then clone the
`main` layout and point its Files block at `files-tabs` (see "Built from" in
[RECIPE.md](RECIPE.md)).

What it touches: it runs `sh` (to list folders) and `git status`, reads the
files you click, and reaches no network.

## License

Apache-2.0. Based on the Files mod that ships with Herdr; the changes are
listed in [RECIPE.md](RECIPE.md).
