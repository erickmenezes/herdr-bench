// Git Graph: a repository's history as a VS Code-style graph, in a tab of its own.
// props: { root, on } (the repository's top folder, and the machine it's on).
import { View, div, svg, PathBuilder } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, v_virtual_list, VirtualListScrollHandle, InputState, Input } from "gpui-base";
import { exec, readTextFile, watchFolder, theme, settings, props, nextCommand } from "herdr";

const ROW = 26, LANE = 14, PAGE = 500, MAX_LANES = 24;
const WORKTREE = "*";
// Every git call is read-only and leaves .git untouched: a lock file, a refreshed
// index or an fsmonitor cookie would wake our own watch and loop the refresh.
const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // what an unborn HEAD is compared to
const MAX_DIFF_ROWS = 2000, MAX_LINE = 2000, MAX_FILES = 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const pad = (n) => String(n).padStart(2, "0");
const formatDate = (seconds) => {
  const d = new Date(seconds * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// Tabs have no width when drawn, so turn each into spaces up to the next stop.
function expandTabs(line, stop = 4) {
  if (!line.includes("\t")) return line;
  let out = "";
  for (const ch of line) out += ch === "\t" ? " ".repeat(stop - (out.length % stop)) : ch;
  return out;
}

const clip = (text) => {
  const plain = expandTabs(text);
  return plain.length > MAX_LINE ? plain.slice(0, MAX_LINE) + " …" : plain;
};

// A unified diff as rows to draw: hunk separators, and lines with both their old
// and new line numbers (VS Code's inline view). Everything before the first hunk
// (the diff --git / index / --- / +++ header) is skipped.
function parsePatch(patch) {
  const rows = [];
  let a = 0, b = 0, inHunk = false;
  for (const line of patch.split("\n")) {
    if (rows.length >= MAX_DIFF_ROWS) { rows.push({ type: "note", text: `Showing the first ${MAX_DIFF_ROWS} lines` }); break; }
    const hunk = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/);
    if (hunk) {
      a = Number(hunk[1]); b = Number(hunk[3]); inHunk = true;
      // Name the hunk by git's function context, else by its lines on the new side
      // (the old side when it only deletes).
      const newCount = Number(hunk[4] ?? 1), [from, n] = newCount ? [b, newCount] : [a, Number(hunk[2] ?? 1)];
      rows.push({ type: "hunk", text: hunk[5] || (n > 1 ? `Lines ${from}–${from + n - 1}` : `Line ${from}`) });
      continue;
    }
    if (!inHunk || line === "") continue;
    switch (line[0]) {
      case "+": rows.push({ type: "add", b: b++, text: clip(line.slice(1)) }); break;
      case "-": rows.push({ type: "del", a: a++, text: clip(line.slice(1)) }); break;
      case " ": rows.push({ type: "ctx", a: a++, b: b++, text: clip(line.slice(1)) }); break;
      case "\\": rows.push({ type: "note", text: line.slice(2) }); break; // "\ No newline at end of file"
      default: inHunk = false; // the next file's header
    }
  }
  return rows;
}

// A file git doesn't know yet, shown as entirely added.
function addedFile(text) {
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  const rows = [{ type: "hunk", text: "New file" }];
  for (let i = 0; i < lines.length && i < MAX_DIFF_ROWS; i++) rows.push({ type: "add", b: i + 1, text: clip(lines[i]) });
  if (lines.length > MAX_DIFF_ROWS) rows.push({ type: "note", text: `Showing the first ${MAX_DIFF_ROWS} lines` });
  return { rows, added: text === "" ? 0 : lines.length };
}

// Gives every commit a lane, top to bottom. `lanes[j]` is the commit lane j is
// waiting for. Per row it records what to draw: lanes passing by (before and after
// the row), the lanes that end in this commit (`into`) and the ones its other
// parents continue in (`out`).
function layoutGraph(commits) {
  const lanes = [];
  let width = 1;
  for (const c of commits) {
    const before = lanes.slice();
    let lane = lanes.indexOf(c.hash);
    const hasChild = lane >= 0, into = [];
    if (hasChild) lanes.forEach((h, j) => { if (h === c.hash && j !== lane) into.push(j); });
    else { lane = lanes.indexOf(null); if (lane < 0) { lane = lanes.length; lanes.push(null); } }
    for (const j of into) lanes[j] = null;
    lanes[lane] = c.parents[0] ?? null;
    const out = [];
    for (const p of c.parents.slice(1)) {
      let k = lanes.indexOf(p);
      if (k < 0) { k = lanes.indexOf(null); if (k < 0) { k = lanes.length; lanes.push(null); } lanes[k] = p; }
      out.push(k);
    }
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    c.graph = { lane, hasChild, into, out, before, after: lanes.slice() };
    width = Math.max(width, before.length, lanes.length, lane + 1);
  }
  return width;
}

// `%(upstream:track,nobracket)`: "ahead 2, behind 3", "gone", or nothing.
function parseTrack(upstream, text) {
  if (!upstream) return null;
  const n = (word) => Number(new RegExp(`${word} (\\d+)`).exec(text)?.[1] ?? 0);
  return { upstream, gone: text === "gone", ahead: n("ahead"), behind: n("behind") };
}

// Branches, remote branches and tags by the commit they point at. A remote branch
// at the same commit as the local one of the same name rides in its label. Local
// branches carry how far they are from their upstream.
function parseRefs(text) {
  const byHash = new Map(), remotes = [];
  const add = (hash, ref) => { if (!byHash.has(hash)) byHash.set(hash, []); byHash.get(hash).push(ref); };
  for (const line of text.split("\n")) {
    const [hash, peeled, name, upstream, track] = line.split("\0");
    if (!name) continue;
    if (name.startsWith("refs/heads/")) add(hash, { kind: "branch", name: name.slice(11), remotes: [], track: parseTrack(upstream, track ?? "") });
    else if (name.startsWith("refs/tags/")) add(peeled || hash, { kind: "tag", name: name.slice(10) });
    else if (name.startsWith("refs/remotes/") && !name.endsWith("/HEAD")) remotes.push({ hash, name: name.slice(13) });
  }
  for (const r of remotes) {
    const slash = r.name.indexOf("/"), remote = r.name.slice(0, slash), short = r.name.slice(slash + 1);
    const local = (byHash.get(r.hash) ?? []).find((x) => x.kind === "branch" && x.name === short);
    if (local) local.remotes.push(remote);
    else add(r.hash, { kind: "remote", name: r.name });
  }
  const order = { branch: 0, remote: 1, tag: 2 };
  for (const list of byHash.values()) list.sort((a, b) => order[a.kind] - order[b.kind]);
  return byHash;
}

// `--name-status -z`: a status letter and a path, each NUL-terminated.
function nameStatus(text) {
  const tokens = text.split("\0"), files = [];
  for (let i = 0; i + 1 < tokens.length && files.length < MAX_FILES; i += 2) {
    if (!tokens[i] || !tokens[i + 1]) continue;
    const letter = tokens[i][0];
    files.push({ path: tokens[i + 1], status: "ADU".includes(letter) ? letter : "M", add: 0, del: 0 });
  }
  return files;
}

// `--numstat -z`: "added<TAB>deleted<TAB>path"; a binary file has "-" for both.
function lineCounts(text) {
  const counts = new Map();
  for (const record of text.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (m) counts.set(m[3], { add: m[1] === "-" ? 0 : Number(m[1]), del: m[2] === "-" ? 0 : Number(m[2]), binary: m[1] === "-" });
  }
  return counts;
}

// Whether a commit matches every word of a search: in its subject, author, email
// or ref names, or as the start of its hash.
function matches(c, words, refs) {
  if (c.hash === WORKTREE) return false;
  const text = [c.subject, c.author, c.email, ...(refs.get(c.hash) ?? []).map((r) => r.name)].join("\n").toLowerCase();
  return words.every((w) => text.includes(w) || c.hash.startsWith(w));
}

export default class GitGraph extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.limit = PAGE; this.raw = []; this.commits = []; this.width = 1; this.refs = new Map();
    this.dirty = 0; this.selected = null; this.detail = null; this.files = []; this.open = null; this.diff = []; this.diffChars = 0;
    this.size = { width: 1000, height: 700 };
    // Search: the loaded commits narrow to the ones matching every word typed.
    this.query = ""; this.only = false; this.merged = new Set(); this.track = null;
    this.search = InputState.new({ placeholder: "Search commits" });
    this.search.on("change", (_e, cx) => this.setQuery(this.search.value(), cx));
    this.search.on("submit", (_e, cx) => { this.handle.focus(); if (this.commits.length) this.select(this.commits[0].hash, cx); });
    cx.spawn(async (cx) => {
      const p = props() ?? {};
      this.on = p.on ?? null;
      if (p.root) this.root = p.root;
      else if (p.folder) {
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: p.folder, on: this.on }).catch(() => null);
        if (top?.code === 0) this.root = top.stdout.trim();
      }
      if (!this.root) { this.error = "Not a git repository"; cx.notify(); return; }
      this.refresh(cx, true);
      this.watch(cx);
    });
    cx.timer.every(10000, (cx) => this.refresh(cx));
    cx.spawn(async (cx) => { for (;;) { if (await nextCommand() === "focus") { this.handle.focus(); cx.notify(); } } });
  }

  watch(cx) {
    if (this.on) return; // another machine: the 10-second timer only
    const root = this.root;
    cx.spawn(async (cx) => {
      try { for (;;) { await watchFolder(root); this.refresh(cx); } } catch {}
    });
  }

  git(args) { return exec("git", [...READ, ...args], { cwd: this.root, on: this.on, timeout: 60000 }); }

  // The log is read again only when HEAD or a ref moved (or `force`); the
  // uncommitted-changes row follows `git status` on every refresh.
  refresh(cx, force = false) {
    if (!this.root) return;
    if (this.loading) { this.again = this.again || (force ? "force" : true); return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const [head, branch, refs, status, merged] = await Promise.all([
          this.git(["rev-parse", "--verify", "-q", "HEAD"]),
          this.git(["symbolic-ref", "-q", "--short", "HEAD"]),
          this.git(["for-each-ref", "--format=%(objectname)%00%(*objectname)%00%(refname)%00%(upstream:short)%00%(upstream:track,nobracket)", "refs/heads", "refs/remotes", "refs/tags"]),
          this.git(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"]),
          // Remote branches already in HEAD's history, drawn faded (fails, harmlessly, on an unborn HEAD).
          this.git(["for-each-ref", "--merged=HEAD", "--format=%(refname:lstrip=2)", "refs/remotes"]),
        ]);
        if (status.code !== 0) throw new Error(status.stderr.trim() || "git status failed");
        this.head = head.code === 0 ? head.stdout.trim() : null;
        this.branch = branch.code === 0 ? branch.stdout.trim() : null;
        this.merged = new Set(merged.code === 0 ? merged.stdout.split("\n").filter(Boolean) : []);
        const key = `${this.head}\n${this.branch}\n${refs.stdout}\n${this.limit}\n${this.only}`;
        if (force || key !== this.key) {
          this.key = key;
          this.refs = parseRefs(refs.stdout);
          const starts = this.only && this.head ? ["HEAD"] : ["--branches", "--remotes", "--tags", ...(this.head ? ["HEAD"] : [])];
          const log = this.head || this.refs.size
            ? await this.git(["log", "--date-order", `-n${this.limit + 1}`, "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1e", ...starts])
            : { code: 0, stdout: "" };
          if (log.code !== 0) throw new Error(log.stderr.trim() || "git log failed");
          const records = log.stdout.split("\x1e").map((r) => r.replace(/^\n/, "")).filter(Boolean);
          this.more = records.length > this.limit;
          this.raw = records.slice(0, this.limit).map((r) => {
            const [hash, parents, author, email, at, subject] = r.split("\x1f");
            return { hash, parents: parents ? parents.split(" ") : [], author, email, at: Number(at), subject };
          });
        }
        this.track = this.branch ? [...this.refs.values()].flat().find((r) => r.kind === "branch" && r.name === this.branch)?.track ?? null : null;
        this.dirty = status.stdout.split("\0").filter(Boolean).length;
        this.build();
        this.error = null;
        if (this.selected === WORKTREE && !this.dirty) this.select(null, cx);
        else if (this.selected && !this.allIndex.has(this.selected)) this.select(null, cx);
        else if (this.selected === WORKTREE) this.loadDetail(WORKTREE, cx, true);
      } catch (e) { this.error = String(e.message ?? e); }
      finally {
        this.loading = false; cx.notify();
        const again = this.again; this.again = false;
        if (again) this.refresh(cx, again === "force");
      }
    });
  }

  build() {
    const list = this.raw.map((c) => ({ ...c }));
    if (this.dirty) list.unshift({ hash: WORKTREE, parents: this.head ? [this.head] : [], author: "", at: 0, subject: `Uncommitted Changes (${this.dirty})` });
    this.width = layoutGraph(list);
    this.all = list;
    this.allIndex = new Map(list.map((c, i) => [c.hash, i]));
    // While searching, the list holds only the matches (drawn without lines).
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    this.commits = words.length ? list.filter((c) => matches(c, words, this.refs)) : list;
    this.index = new Map(this.commits.map((c, i) => [c.hash, i]));
  }

  // Any loaded commit, shown or not: a selection outlives the search that found it.
  commit(hash) { return this.all?.[this.allIndex.get(hash)]; }

  setQuery(text, cx) {
    if (text === this.query) return;
    this.query = text;
    this.build();
    this.scroll.scroll_to_item(0);
    cx.notify();
  }

  clearSearch(cx) { this.search.set_value(""); this.setQuery("", cx); this.handle.focus(); }

  toggleOnly(cx) { this.only = !this.only; this.refresh(cx, true); }

  select(hash, cx) {
    this.selected = hash; this.detail = null; this.files = []; this.open = null; this.showDiff([]); this.note = null;
    if (hash) {
      const i = this.index.get(hash);
      if (i !== undefined) this.scroll.scroll_to_item(i);
      this.loadDetail(hash, cx);
    }
    cx.notify();
  }

  move(by, cx) {
    if (!this.commits.length) return;
    const i = this.selected ? this.index.get(this.selected) ?? -1 : -1;
    const next = Math.max(0, Math.min(this.commits.length - 1, i < 0 ? 0 : i + by));
    this.select(this.commits[next].hash, cx);
  }

  loadDetail(hash, cx, quiet = false) {
    const c = this.commit(hash);
    if (!c) return;
    cx.spawn(async (cx) => {
      try {
        let info = null;
        const range = this.range(c), flags = ["-z", "--no-renames"];
        const [names, nums, show, others] = await Promise.all([
          this.git([...range, "--name-status", ...flags]),
          this.git([...range, "--numstat", ...flags]),
          hash === WORKTREE ? null : this.git(["show", "-s", "--format=%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%B", hash]),
          // Untracked files, which no diff lists.
          hash === WORKTREE ? this.git(["ls-files", "--others", "--exclude-standard", "-z"]) : null,
        ]);
        if (names.code !== 0) throw new Error(names.stderr.trim());
        const files = nameStatus(names.stdout), counts = lineCounts(nums.stdout);
        for (const f of files) Object.assign(f, counts.get(f.path));
        if (others) for (const path of others.stdout.split("\0").filter(Boolean).slice(0, MAX_FILES - files.length))
          files.push({ path, status: "A", untracked: true, add: 0, del: 0 });
        files.sort((x, y) => x.path.localeCompare(y.path));
        if (show) {
          const [author, email, at, committer, cemail, ct, ...body] = show.stdout.split("\x1f");
          info = { author, email, at: Number(at), committer, cemail, ct: Number(ct), message: body.join("\x1f").trim() };
        }
        if (this.selected !== hash) return;
        this.detail = info; this.files = files;
        if (this.open && !files.some((f) => f.path === this.open)) { this.open = null; this.showDiff([]); }
        if (!this.open && files.length && !quiet) this.open = files[0].path;
        if (this.open) await this.loadDiff(hash, this.open);
      } catch (e) { if (this.selected === hash) this.note = String(e.message ?? e); }
      cx.notify();
    });
  }

  // What a row's files and diffs compare: a commit against its first parent (a root
  // commit against nothing), the working tree against HEAD.
  range(c) {
    if (c.hash === WORKTREE) return ["diff", this.head ?? EMPTY_TREE];
    return c.parents[0] ? ["diff", c.parents[0], c.hash] : ["diff", EMPTY_TREE, c.hash];
  }

  async loadDiff(hash, path) {
    const c = this.commit(hash), file = this.files.find((f) => f.path === path);
    if (!c || !file) return;
    let rows;
    if (file.untracked) {
      const text = await readTextFile(`${this.root}/${path}`, { on: this.on }).catch(() => null);
      if (text === null) rows = [{ type: "note", text: "Can't show this file (binary, over 1 MiB, or unreadable)" }];
      else if (text.includes("\0")) rows = [{ type: "note", text: "Binary file" }];
      else { const made = addedFile(text); rows = made.rows; file.add = made.added; }
    } else {
      const r = await this.git([...this.range(c), "--no-color", "--no-ext-diff", "--no-textconv", "--", path]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) rows = [{ type: "note", text: `Can't show this diff: ${r.stderr.trim()}` }];
      else {
        rows = parsePatch(r.stdout);
        if (!rows.length) rows = [{ type: "note", text: file.binary ? "Binary file" : "No changes to show (mode or empty file)" }];
      }
    }
    if (this.selected === hash && this.open === path) this.showDiff(rows);
  }

  pick(path, cx) {
    const hash = this.selected;
    this.open = path; this.showDiff([]);
    cx.spawn(async (cx) => { await this.loadDiff(hash, path); cx.notify(); });
    cx.notify();
  }

  showDiff(rows) {
    this.diff = rows;
    this.diffChars = rows.reduce((n, r) => Math.max(n, r.text.length), 0);
  }

  // --- drawing ---

  palette(t) { return [t.ansi4, t.ansi2, t.ansi5, t.ansi3, t.ansi6, t.ansi1, t.ansi12, t.ansi10, t.ansi13, t.ansi11]; }

  graphCell(c, t, pal) {
    const g = c.graph, cy = ROW / 2, x = (j) => 9 + j * LANE;
    const color = (j) => pal[j % pal.length];
    const wt = this.commits[0]?.hash === WORKTREE ? this.commits[0].graph.lane : -1;
    // The worktree's line down to HEAD is dashed.
    const dashed = (j, waiting) => j === wt && waiting === this.head && this.head !== null;
    const stroke = (dash) => dash ? PathBuilder.stroke(1.5).dash_array([3, 3]) : PathBuilder.stroke(1.5);
    const paths = [];
    const draw = (builder, j) => paths.push(window.paint_path(builder.build(), color(j)).absolute().inset_0());
    const curve = (b, x1, y1, x2, y2) => b.move_to(x1, y1).cubic_bezier_to(x2, y2, x1, (y1 + y2) / 2, x2, (y1 + y2) / 2);
    // Search results aren't neighbours, so their lines would lie: only the dots.
    const n = this.query.trim() ? 0 : Math.min(MAX_LANES, Math.max(g.before.length, g.after.length));
    for (let j = 0; j < n; j++) {
      if (j !== g.lane && !g.into.includes(j) && g.before[j] != null && g.after[j] === g.before[j])
        draw(stroke(dashed(j, g.before[j])).move_to(x(j), 0).line_to(x(j), ROW), j);
    }
    if (g.lane < MAX_LANES && n > 0) {
      if (g.hasChild) draw(stroke(dashed(g.lane, g.before[g.lane])).move_to(x(g.lane), 0).line_to(x(g.lane), cy), g.lane);
      if (c.parents.length) draw(stroke(c.hash === WORKTREE).move_to(x(g.lane), cy).line_to(x(g.lane), ROW), g.lane);
    }
    if (n > 0) for (const j of g.into) if (j < MAX_LANES) draw(curve(stroke(dashed(j, g.before[j])), x(j), 0, x(g.lane), cy), j);
    if (n > 0) for (const k of g.out) if (k < MAX_LANES) draw(curve(stroke(false), x(g.lane), cy, x(k), ROW), k);
    const head = c.hash === this.head, worktree = c.hash === WORKTREE, col = color(g.lane);
    const dot = div().absolute().left(x(g.lane) - 4).top(cy - 4).size(8).rounded(4)
      .when(worktree, (e) => e.border_1().border_color(t.muted).bg(t.background))
      .when(head, (e) => e.border_2().border_color(col).bg(t.background))
      .when(!head && !worktree, (e) => e.bg(col));
    return div().relative().h(ROW).w(this.graphWidth()).flex_none().overflow_hidden().children(paths).when(g.lane < MAX_LANES, (e) => e.child(dot));
  }

  graphWidth() { return Math.max(48, 18 + (Math.min(this.width, MAX_LANES) - 1) * LANE); }

  label(ref, col, t) {
    const base = h_flex().h(18).px(5).gap(4).flex_none().items_center().rounded(4).text_size(11);
    if (ref.kind === "tag")
      return base.bg(t.raised).text_color(t.muted).child(svg("mods/git-graph/tag.svg").size(10).flex_none()).child(ref.name);
    if (ref.kind === "remote") {
      // Already merged into HEAD (and not this branch's own upstream): faded.
      const done = this.merged.has(ref.name) && ref.name !== this.track?.upstream;
      return base.border_1().border_color(t.border).text_color(t.muted).when(done, (e) => e.opacity(0.45)).child(ref.name);
    }
    const current = ref.name === this.branch, side = current ? t.background : t.dim;
    return base.border_1().border_color(col)
      .when(current, (e) => e.bg(col).text_color(t.background).font_semibold())
      .child(ref.name)
      .children(ref.remotes.map((r) => div().text_color(side).opacity(current ? 0.75 : 1).child(r)))
      .children(this.trackMarks(ref.track, current ? t.background : t.muted));
  }

  // "↑2 ↓3": commits to push and to pull, against the upstream as last fetched.
  trackMarks(track, color) {
    if (!track || track.gone) return [];
    return [track.ahead ? `↑${track.ahead}` : null, track.behind ? `↓${track.behind}` : null]
      .filter(Boolean).map((text) => div().text_color(color).font_family(this.mono()).text_size(10).child(text));
  }

  trackTip(track) {
    if (!this.branch) return "Detached HEAD";
    if (!track) return `${this.branch} has no upstream branch`;
    if (track.gone) return `${track.upstream} no longer exists`;
    const count = (n, what) => `${n} commit${n === 1 ? "" : "s"} ${what}`;
    const parts = [track.ahead ? count(track.ahead, "to push") : null, track.behind ? count(track.behind, "to pull") : null].filter(Boolean);
    return `${parts.length ? parts.join(", ") : "Up to date"} with ${track.upstream} (as of the last fetch)`;
  }

  row(c, i, t, pal, cols) {
    if (c === "more") {
      return h_flex().id("load-more").h(ROW).w_full().px(12).items_center().cursor_pointer().text_color(t.accent).hover((s) => s.bg(t.hover))
        .child(this.loading ? "Loading…" : `Load ${PAGE} more commits`);
    }
    const selected = this.selected === c.hash, worktree = c.hash === WORKTREE, col = pal[c.graph.lane % pal.length];
    const refs = this.refs.get(c.hash) ?? [];
    const detached = c.hash === this.head && !this.branch;
    return h_flex().id(`commit-${i}`).h(ROW).w_full().items_center().cursor_pointer()
      .when(selected, (e) => e.bg(t.selected)).when(!selected, (e) => e.hover((s) => s.bg(t.hover)))
      .child(this.graphCell(c, t, pal))
      .child(h_flex().flex_1().min_w(0).pl(4).pr(10).gap(5).items_center()
        .when(detached, (e) => e.child(this.label({ kind: "branch", name: "HEAD", remotes: [] }, col, t)))
        .children(refs.map((r) => this.label(r, col, t)))
        .child(div().flex_1().min_w(0).truncate().when(worktree, (e) => e.text_color(t.muted).italic()).child(c.subject || " ")))
      .when(cols.date, (e) => e.child(div().w(140).flex_none().pr(10).truncate().text_color(t.muted).child(worktree ? "" : formatDate(c.at))))
      .when(cols.author, (e) => e.child(div().w(150).flex_none().pr(10).truncate().text_color(t.muted).child(c.author)))
      .child(div().w(76).flex_none().pr(12).font_family(this.mono()).text_size(11).text_color(t.dim).child(worktree ? "*" : c.hash.slice(0, 7)));
  }

  mono() { return settings().font_family ?? "JetBrains Mono"; }

  // One diff row: old and new line numbers, a +/− marker, the text. Added and
  // removed lines get a faint wash of green or red, and a stronger one in the gutter.
  diffLine(row, t) {
    const DIFF_ROW = 19;
    if (row.type === "hunk")
      return h_flex().h(DIFF_ROW).w_full().flex_none().items_center().gap(8).px(10).bg(t.surface).border_t(1).border_color(t.border).text_color(t.accent)
        .child(div().text_color(t.dim).child("⋯")).child(div().truncate().child(row.text));
    if (row.type === "note")
      return h_flex().h(DIFF_ROW).w_full().flex_none().items_center().px(10).italic().text_color(t.dim).child(row.text);
    const tint = row.type === "add" ? t.ansi2 : row.type === "del" ? t.ansi1 : null;
    const number = (n) => div().w(38).flex_none().pr(6).text_right().text_color(t.dim).child(n === undefined ? "" : String(n));
    return h_flex().h(DIFF_ROW).w_full().flex_none().items_center().when(tint !== null, (e) => e.bg(tint + "14"))
      .child(h_flex().h_full().flex_none().items_center().when(tint !== null, (e) => e.bg(tint + "22")).child(number(row.a)).child(number(row.b)))
      .child(div().w(18).flex_none().text_center().text_color(tint ?? t.dim).child(row.type === "add" ? "+" : row.type === "del" ? "−" : ""))
      .child(div().flex_1().min_w(0).whitespace_nowrap().child(row.text || " "));
  }

  // A changed file: its name, then its folder (dim), the line counts, and a
  // status badge (Added, Modified, Deleted, Unmerged; untracked counts as added).
  fileRow(f, t) {
    const slash = f.path.lastIndexOf("/"), name = f.path.slice(slash + 1), folder = slash < 0 ? "" : f.path.slice(0, slash);
    const tone = { A: t.ansi2, D: t.ansi1, U: t.ansi3, M: t.ansi4 }[f.status];
    const open = this.open === f.path;
    return h_flex().id(`file-${f.path}`).h(24).flex_none().pl(8).pr(4).gap(6).items_center().rounded(5).cursor_pointer()
      .bg(open ? t.selected : t.background).hover((s) => s.bg(open ? t.selected : t.hover))
      .on_click((_e, cx) => this.pick(f.path, cx))
      .child(div().flex_none().max_w(220).truncate().when(f.status === "D", (e) => e.line_through().text_color(t.muted)).child(name))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(folder))
      .child(h_flex().flex_none().gap(4).text_size(10).font_family(this.mono())
        .when(f.add > 0, (e) => e.child(div().text_color(t.ansi2).child(`+${f.add}`)))
        .when(f.del > 0, (e) => e.child(div().text_color(t.ansi1).child(`-${f.del}`))))
      .child(div().id(`status-${f.path}`).w(16).h(16).flex_none().flex().items_center().justify_center().rounded(3).bg(tone + "26").text_color(tone).text_size(10).font_semibold()
        .tooltip(f.untracked ? "Untracked" : { A: "Added", D: "Deleted", U: "Unmerged", M: "Modified" }[f.status]).child(f.status));
  }

  details(t) {
    const c = this.commit(this.selected);
    if (!c) return div();
    const d = this.detail, worktree = c.hash === WORKTREE;
    const height = Math.max(200, Math.min(560, Math.round(this.size.height * 0.48)));
    const field = (name, value) => h_flex().gap(8).items_start().child(div().w(64).flex_none().text_color(t.dim).child(name)).child(div().flex_1().min_w(0).child(value));
    const shortLink = (hash) => div().id(`parent-${hash}`).font_family(this.mono()).text_size(11).text_color(t.accent).cursor_pointer()
      .on_click((_e, cx) => this.select(hash, cx)).child(hash.slice(0, 7));
    const body = d ? d.message.split("\n").slice(1).join("\n").trim() : "";
    const info = worktree ? [] : [
      field("Commit", div().font_family(this.mono()).text_size(11).child(c.hash)),
      field("Parents", c.parents.length ? h_flex().gap(8).children(c.parents.map(shortLink)) : div().text_color(t.dim).child("none")),
      ...(d ? [
        field("Author", div().truncate().child(`${d.author} <${d.email}>`)),
        field("Date", div().child(formatDate(d.at))),
        ...(d.committer !== d.author || d.ct !== d.at ? [field("Committer", div().truncate().child(`${d.committer}, ${formatDate(d.ct)}`))] : []),
      ] : []),
    ];
    const add = this.files.reduce((n, f) => n + (f.add || 0), 0), del = this.files.reduce((n, f) => n + (f.del || 0), 0);
    return v_flex().h(height).flex_none().border_t(1).border_color(t.border).bg(t.background)
      .child(h_flex().h(36).flex_none().px(14).gap(10).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().min_w(0).truncate().font_semibold().child(c.subject))
        .child(div().text_size(11).text_color(t.muted).child(`${this.files.length} file${this.files.length === 1 ? "" : "s"}`))
        .child(div().text_size(11).text_color(t.ansi2).child(`+${add}`)).child(div().text_size(11).text_color(t.ansi1).child(`−${del}`))
        .child(div().id("close-details").size(22).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Close (Esc)")
          .on_click((_e, cx) => this.select(null, cx)).child(svg("mods/pane/close.svg").size(12))))
      .child(h_flex().flex_1().min_h(0)
        .child(div().w(Math.min(420, Math.round(this.size.width * 0.38))).flex_none().h_full().relative().border_r(1).border_color(t.border)
          .child(v_flex().id("detail-side").absolute().inset_0().overflow_y_scroll().p(10).gap(4).text_size(12)
            .children(info)
            .when(Boolean(body), (e) => e.child(div().mt(6).text_color(t.muted).child(body)))
            .when(!worktree, (e) => e.child(div().h(1).my(8).bg(t.border)))
            .children(this.files.map((f) => this.fileRow(f, t)))
            .when(Boolean(this.note), (e) => e.child(div().text_color(t.ansi1).child(this.note)))
            .when(!this.files.length && !this.note, (e) => e.child(div().text_color(t.dim).child("Loading…"))))
          .child(Scrollbar.vertical("detail-side").absolute().inset_0()))
        .child(div().flex_1().min_w(0).h_full().relative().font_family(this.mono()).text_size(11)
          .child(div().id("graph-diff-scroll").absolute().inset_0().overflow_x_scrollbar()
            .child(div().h_full().w_full().min_w(this.diffChars * 7 + 120).relative()
              .child(v_virtual_list("graph-diff", this.diff.length, 19, (i) => `${this.open}:${i}`,
                (range) => this.diff.slice(range.start, range.end).map((row) => this.diffLine(row, t))).absolute().inset_0())))
          .child(Scrollbar.vertical("graph-diff").viewport_from_layout().absolute().inset_0())
          .when(!this.open && this.files.length > 0, (e) => e.child(div().absolute().top(8).px(12).text_color(t.dim).child("Pick a file to see its diff")))));
  }

  render(_cx) {
    const t = theme(), pal = this.palette(t);
    const cols = { date: this.size.width > 640, author: this.size.width > 800 };
    const items = this.more ? [...this.commits, "more"] : this.commits;
    const repo = this.root ? this.root.split("/").pop() : "";
    const header = (text, w) => div().when(w, (e) => e.w(w).flex_none()).when(!w, (e) => e.flex_1().min_w(0)).pr(10).truncate().child(text);
    return v_flex().id("root").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(12)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        // In the search box: Esc clears it, ↓ goes down into the results.
        if (!this.handle.is_focused()) {
          if (k === "escape") { this.clearSearch(cx); cx.stop_propagation(); }
          else if (k === "down") { this.handle.focus(); this.move(1, cx); cx.stop_propagation(); }
          return;
        }
        if (k === "up" || k === "k") { this.move(-1, cx); cx.stop_propagation(); }
        else if (k === "down" || k === "j") { this.move(1, cx); cx.stop_propagation(); }
        else if (k === "/" || k === "cmd-f" || k === "ctrl-f") { this.search.focus(); cx.stop_propagation(); }
        else if (k === "escape" && this.selected) { this.select(null, cx); cx.stop_propagation(); }
        else if (k === "escape" && this.query) { this.clearSearch(cx); cx.stop_propagation(); }
      })
      .child(h_flex().h(40).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(svg("mods/git-graph/graph.svg").size(15).flex_none().text_color(t.muted))
        .child(div().font_semibold().child("Git Graph"))
        .child(div().text_color(t.muted).truncate().child(repo))
        .when(Boolean(this.branch), (e) => e.child(h_flex().id("branch").px(6).py(1).gap(5).flex_none().items_center().rounded(4).border_1().border_color(t.border).text_size(11).text_color(t.muted)
          .tooltip(this.trackTip(this.track))
          .child(this.branch)
          .children(this.trackMarks(this.track, t.foreground))
          .when(Boolean(this.track?.gone), (e) => e.child(div().text_color(t.dim).child("gone")))))
        .child(div().flex_1())
        .child(h_flex().w(cols.author ? 240 : 170).h(26).flex_none().px(8).gap(6).items_center().rounded(6).border_1()
          .border_color(this.query ? t.accent : t.border).bg(t.background)
          .child(svg("mods/git-graph/search.svg").size(13).flex_none().text_color(t.dim))
          .child(Input.new(this.search).flex_1().min_w(0).h_full().text_size(12).text_color(t.foreground))
          .when(Boolean(this.query), (e) => e.child(div().id("clear-search").size(16).flex_none().flex().items_center().justify_center().rounded(4).cursor_pointer().text_color(t.dim)
            .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Clear (Esc)")
            .on_click((_e, cx) => this.clearSearch(cx)).child(svg("mods/pane/close.svg").size(10)))))
        .child(div().id("only-branch").size(24).flex().flex_none().items_center().justify_center().rounded(5).cursor_pointer()
          .when(this.only, (e) => e.bg(t.selected).text_color(t.foreground)).when(!this.only, (e) => e.text_color(t.dim))
          .hover((s) => s.bg(t.hover).text_color(t.foreground))
          .tooltip(this.only ? "Showing the current branch only: show all branches" : "Show the current branch only")
          .on_click((_e, cx) => this.toggleOnly(cx)).child(svg("mods/git-graph/branch.svg").size(13)))
        .when(this.loading, (e) => e.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.dim).spin(900)))
        .child(div().text_size(11).text_color(t.dim).flex_none()
          .child(this.query.trim() ? `${this.commits.length} of ${this.raw.length}${this.more ? "+" : ""}` : `${this.raw.length}${this.more ? "+" : ""} commits`))
        .child(div().id("refresh").size(24).flex().items_center().justify_center().rounded(5).cursor_pointer().text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Refresh")
          .on_click((_e, cx) => this.refresh(cx, true)).child(svg("mods/git-graph/refresh.svg").size(13))))
      .child(h_flex().h(26).flex_none().items_center().border_b(1).border_color(t.border).text_size(11).text_color(t.dim)
        .child(div().w(this.graphWidth()).flex_none().pl(8).child("Graph"))
        .child(header("Description").pl(4))
        .when(cols.date, (e) => e.child(header("Date", 140)))
        .when(cols.author, (e) => e.child(header("Author", 150)))
        .child(header("Commit", 76)))
      .child(div().flex_1().min_h(0).relative()
        .when(items.length > 0, (e) => e
          .child(v_virtual_list("graph-list", items.length, ROW, (i) => (items[i] === "more" ? "more" : items[i].hash),
            (range) => items.slice(range.start, range.end).map((c, k) => this.row(c, range.start + k, t, pal, cols)))
            // Rows are rebuilt every frame, so clicks go to the list, by row key.
            .on_item_click((key, cx) => {
              this.handle.focus();
              if (key === "more") { this.limit += PAGE; this.refresh(cx, true); }
              else this.select(this.selected === key ? null : key, cx);
            })
            .track_scroll(this.scroll).absolute().inset_0())
          .child(Scrollbar.vertical("graph-list").absolute().inset_0()))
        .when(!items.length, (e) => e.child(div().p(14).text_color(t.dim)
          .child(this.error || (this.loading || !this.root ? "Loading history…"
            : this.query.trim() ? `No loaded commit matches “${this.query.trim()}”` : "No commits yet")))))
      .when(Boolean(this.error) && items.length > 0, (e) => e.child(div().px(14).py(4).text_size(11).text_color(t.ansi1).child(this.error)))
      .when(Boolean(this.selected), (e) => e.child(this.details(t)));
  }
}
