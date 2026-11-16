// What a right-click on a commit offers, and the dialogs that ask before anything
// that moves HEAD away from a branch, writes a commit, deletes or pushes. Both are
// copies of this mod opened as overlays: props { menu } (a popup) or { dialog } (a
// dialog), each with the commit's facts:
//   { root, on, hash, subject, merge, isHead, branch, dirty, branches, remotes }
// branches: local branches at the commit, { name, current, upstream, ahead, behind, gone };
// remotes: remote branches at it that no local branch of the same name rides with.
// When git has run, REQUEST tells the graph of that repository to look again.
import { div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { closeOverlay, openOverlay, theme, exec, notify, setShared } from "herdr";

export const REQUEST = "git-graph.request";
const short = (hash) => hash.slice(0, 7);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// git in the repository. Network commands never stop to ask for a password: with
// no credentials at hand they fail, and the error says so.
function git(m, args, timeout = 60000) {
  return exec("sh", ["-c", 'GIT_TERMINAL_PROMPT=0 exec git "$@"', "git", ...args], { cwd: m.root, on: m.on, timeout })
    .catch((e) => ({ code: -1, stdout: "", stderr: String(e?.message ?? e) }));
}

const lastLine = (r) => (r.stderr || r.stdout || "").trim().split("\n").filter(Boolean).pop() || "git failed";

function changed(m) { setShared(REQUEST, { id: `${Date.now()}-${Math.random()}`, at: Date.now(), root: m.root, on: m.on ?? null }); }

// Copies text to this computer's clipboard (macOS, else Wayland or X11 tools).
async function copyText(text) {
  const r = await exec("sh", ["-c", 'printf %s "$1" | { pbcopy || wl-copy || xclip -selection clipboard || xsel -b; } 2>/dev/null', "copy", text]);
  if (r.code !== 0) throw new Error("No clipboard tool");
}

// [label, action, arg] rows; "-" divides, ["#", text] is a section heading.
export function menuItems(m) {
  const items = [];
  if (!m.isHead) items.push(["Check Out This Commit…", "detach"]);
  items.push(["New Branch Here…", "branch"]);
  // A merge would need a parent picked: not offered.
  if (!m.merge && !m.isHead) items.push(["-"], [`Cherry-pick onto ${m.branch ?? "HEAD"}…`, "cherry"]);
  if (!m.merge) items.push(...(m.isHead ? [["-"]] : []), ["Revert…", "revert"]);
  items.push(["-"], ["Copy Hash", "copy-hash"], ["Copy Subject", "copy-subject"]);
  for (const b of m.branches) {
    items.push(["-"], ["#", b.current ? `${b.name} (current)` : b.name]);
    if (!b.current) items.push([`Check Out ${b.name}`, "switch", b.name]);
    if (b.current && b.upstream && !b.gone && b.behind) items.push([`Pull (${plural(b.behind, "commit")})`, "pull", b.name]);
    if (!b.upstream || b.gone || b.ahead) items.push([b.upstream && !b.gone ? `Push (${plural(b.ahead, "commit")})…` : "Publish…", "push", b.name]);
    items.push(["Rename…", "rename", b.name]);
    if (!b.current) items.push(["Delete…", "delete", b.name]);
  }
  for (const r of m.remotes) items.push(["-"], ["#", r], ["Check Out as a Local Branch", "track", r]);
  return items;
}

export function menuHeight(m) {
  return menuItems(m).reduce((h, it) => h + (it[0] === "-" ? 9 : it[0] === "#" ? 24 : 31), 10);
}

// Runs a menu row: at once for the copies, a branch switch and a fast-forward
// pull; through a dialog for the rest.
export function act(m, action, arg) {
  const fail = (title) => (r) => notify({ title, body: lastLine(r), level: "error" });
  const dialog = (kind, height) => openOverlay({ mod: "git-graph", kind: "dialog", width: 460, height, props: { dialog: { ...m, kind, arg } } });
  switch (action) {
    case "copy-hash": copyText(m.hash).then(() => notify({ title: "Hash copied", body: m.hash, timeout: 2000 })).catch(() => notify({ title: "Couldn't copy", level: "error" })); break;
    case "copy-subject": copyText(m.subject).then(() => notify({ title: "Subject copied", body: m.subject, timeout: 2000 })).catch(() => notify({ title: "Couldn't copy", level: "error" })); break;
    case "switch":
      git(m, ["switch", arg]).then((r) => { changed(m); if (r.code !== 0) fail(`Couldn't check out ${arg}`)(r); });
      break;
    case "track":
      git(m, ["switch", "--track", arg]).then((r) => { changed(m); if (r.code !== 0) fail(`Couldn't check out ${arg}`)(r); });
      break;
    case "pull":
      notify({ title: `Pulling ${arg}…`, timeout: 2000 });
      git(m, ["pull", "--ff-only"], 120000).then((r) => {
        changed(m);
        if (r.code === 0) notify({ title: `${arg} is up to date`, timeout: 2500 });
        else notify({ title: "Couldn't pull", body: /fast-forward/i.test(r.stderr) ? `${arg} and its upstream have both moved on: merge or rebase in a terminal.` : lastLine(r), level: "error" });
      });
      break;
    case "branch": case "rename": dialog(action, 214); break;
    default: dialog(action, 200); break;
  }
}

export class MenuView {
  constructor(p, cx) {
    this.m = p.menu;
    this.id = p.overlay; // kept: props() is the frame's, and a menu can act after it
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(it) { closeOverlay(this.id); act(this.m, it[1], it[2]); }

  render(_cx) {
    const t = theme(), list = menuItems(this.m), actions = list.filter((it) => it[0] !== "-" && it[0] !== "#");
    let n = -1;
    return v_flex().id("graph-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % actions.length;
        else if (e.key === "up") this.at = (this.at + actions.length - 1) % actions.length;
        else if (e.key === "enter") this.choose(actions[this.at]);
        else if (e.key === "escape") closeOverlay(this.id);
        else return;
        cx.stop_propagation(); cx.notify();
      })
      .children(list.map((it, i) => {
        if (it[0] === "-") return div().id(`gm-sep-${i}`).mx(7).my(4).h(1).bg(t.border);
        if (it[0] === "#") return h_flex().id(`gm-head-${i}`).h(24).px(8).items_center().text_size(11).text_color(t.dim).child(div().truncate().child(it[1]));
        const k = ++n;
        return h_flex().id(`gm-${i}`).h(31).px(8).rounded(7).items_center().text_color(t.foreground)
          .when(k === this.at, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click(() => this.choose(it))
          .child(div().flex_1().truncate().child(it[0]));
      }));
  }
}

// What each dialog says and does. `name`: it asks for a branch name.
function plan(d) {
  const b = d.branches.find((x) => x.name === d.arg);
  const commit = `${short(d.hash)} “${d.subject}”`;
  switch (d.kind) {
    case "detach": return {
      title: `Check out ${short(d.hash)}?`,
      text: `HEAD will point at ${commit} and no branch${d.branch ? `; ${d.branch} stays where it is` : ""}. Commits made from here belong to no branch until you make one.`
        + (d.dirty ? " Your uncommitted changes come along, unless they clash: then nothing happens." : ""),
      ok: "Check Out", args: () => ["switch", "--detach", d.hash] };
    case "branch": return {
      title: "New branch", text: `Starts at ${commit}.`, name: "", ok: "Create", alt: "Create and Check Out",
      args: (name, alt) => alt ? ["switch", "-c", name, d.hash] : ["branch", name, d.hash] };
    case "rename": return {
      title: `Rename ${d.arg}`, text: b?.upstream ? `Only the local branch: ${b.upstream} keeps its name.` : "The local branch.", name: d.arg, ok: "Rename",
      args: (name) => ["branch", "-m", d.arg, name] };
    case "cherry": return {
      title: `Cherry-pick ${short(d.hash)}?`,
      text: `Applies ${commit} on top of ${d.branch ?? "HEAD"} as a new commit.` + (d.dirty ? " You have uncommitted changes: if they clash, git stops before touching them." : ""),
      ok: "Cherry-pick", args: () => ["cherry-pick", d.hash], undo: "cherry-pick" };
    case "revert": return {
      title: `Revert ${short(d.hash)}?`,
      text: `Adds a commit on ${d.branch ?? "HEAD"} that undoes ${commit}. History is kept: nothing is rewritten.`,
      ok: "Revert", args: () => ["revert", "--no-edit", d.hash], undo: "revert" };
    case "push": {
      const remote = b?.upstream && !b.gone ? b.upstream.split("/")[0] : "origin";
      return {
        title: b?.upstream && !b.gone ? `Push ${d.arg}?` : `Publish ${d.arg}?`,
        text: b?.upstream && !b.gone
          ? `Sends ${plural(b.ahead, "commit")} to ${b.upstream}.${b.behind ? ` It also has ${plural(b.behind, "commit")} you don't: git will refuse until you pull.` : ""} Never forced.`
          : `Creates ${d.arg} on ${remote} and sets it as the upstream.`,
        ok: b?.upstream && !b.gone ? "Push" : "Publish", network: true,
        args: () => b?.upstream && !b.gone ? ["push", remote, `${d.arg}:${b.upstream.slice(remote.length + 1)}`] : ["push", "-u", remote, d.arg] };
    }
    case "delete": return {
      title: `Delete ${d.arg}?`,
      text: `Removes the local branch only${b?.upstream && !b.gone ? `; ${b.upstream} stays` : ""}. git refuses if its commits aren't merged anywhere yet.`,
      ok: "Delete", danger: true, args: () => ["branch", "-d", d.arg],
      // Not merged: the commits would be lost, so it asks again, plainly.
      force: { test: /not fully merged/, text: `${d.arg} has commits that aren't in any other branch. Deleting it anyway loses track of them (git keeps them about two weeks in its reflog).`, ok: "Delete Anyway", args: () => ["branch", "-D", d.arg] } };
  }
}

export class DialogView {
  constructor(p, cx) {
    this.d = p.dialog;
    this.id = p.overlay;
    this.p = plan(this.d);
    this.error = null; this.busy = false; this.stuck = null; this.forcing = false;
    this.handle = cx.focus_handle();
    if (this.p.name !== undefined) {
      this.input = InputState.new({ value: this.p.name, placeholder: "branch-name" });
      this.input.set_selected_range({ start: 0, end: this.p.name.length });
      this.input.on("change", (_e, cx) => { this.error = null; cx.notify(); });
      this.input.on("submit", (_e, cx) => this.confirm(cx, false));
      this.input.focus();
      cx.timer.after(300, () => this.input.focus());
    } else this.handle.focus();
  }

  close() { closeOverlay(this.id); }

  confirm(cx, alt) {
    if (this.busy) return;
    const d = this.d, p = this.p;
    let args;
    if (this.forcing) args = p.force.args();
    else if (p.name !== undefined) {
      const name = this.input.value().trim();
      if (name === p.name && d.kind === "rename") return this.close();
      if (!name) { this.error = "Give it a name."; cx.notify(); return; }
      args = p.args(name, alt);
    } else args = p.args();
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      // git's own rules for a branch name, before anything runs.
      if (p.name !== undefined) {
        const ok = await git(d, ["check-ref-format", "--branch", this.input.value().trim()]);
        if (ok.code !== 0) { this.busy = false; this.error = "That isn't a valid branch name."; cx.notify(); return; }
      }
      const r = await git(d, args, p.network ? 120000 : 60000);
      changed(d);
      this.busy = false;
      if (r.code === 0) { this.close(); return; }
      if (p.force && !this.forcing && p.force.test.test(r.stderr)) { this.forcing = true; cx.notify(); return; }
      // A cherry-pick or revert that stopped on conflicts leaves the repository
      // mid-way: say so and offer the way back.
      if (p.undo) {
        const mid = await git(d, ["rev-parse", "-q", "--verify", p.undo === "revert" ? "REVERT_HEAD" : "CHERRY_PICK_HEAD"]);
        // Nothing to add (the change is already there): put it back and say so.
        if (mid.code === 0 && /now empty|nothing to commit/.test(`${r.stdout}\n${r.stderr}`)) {
          await git(d, [p.undo, "--abort"]);
          changed(d);
          this.error = p.undo === "revert" ? "Nothing to revert: those changes are already undone here." : `Nothing to add: that change is already on ${d.branch ?? "HEAD"}.`;
          cx.notify(); return;
        }
        if (mid.code === 0) { this.stuck = p.undo; this.error = "It stopped on conflicts. Resolve them in a terminal and commit, or put everything back as it was."; cx.notify(); return; }
      }
      this.error = lastLine(r);
      cx.notify();
    });
  }

  abort(cx) {
    if (this.busy) return;
    this.busy = true; cx.notify();
    cx.spawn(async (cx) => {
      const r = await git(this.d, [this.stuck, "--abort"]);
      changed(this.d);
      this.busy = false;
      if (r.code === 0) this.close(); else { this.error = lastLine(r); cx.notify(); }
    });
  }

  render(_cx) {
    const t = theme(), d = this.d, p = this.p, asking = p.name !== undefined;
    const button = (id, text, kind, action) => h_flex().id(id).h(32).px(14).items_center().rounded(8).border_1()
      .border_color(kind === "danger" ? t.ansi1 : kind === "primary" ? t.solid : t.input)
      .bg(kind === "danger" ? t.ansi1 : kind === "primary" ? t.solid : t.raised)
      .text_color(kind === "danger" ? t.background : kind === "primary" ? t.solid_foreground : t.foreground)
      .text_size(12.5).font_medium().cursor_pointer().when(this.busy, (e) => e.opacity(0.6)).hover((s) => s.opacity(0.88))
      .on_click(action).child(text);
    const text = this.forcing ? p.force.text : p.text;
    return v_flex().id("graph-dialog").track_focus(this.handle).size_full().min_h(0).p(18).bg(t.popover).text_color(t.foreground).text_size(13)
      .on_key_down((e, cx) => {
        if (e.key === "escape") this.close();
        else if (e.key === "enter" && !asking && !this.stuck) this.confirm(cx, false);
        else return;
        cx.stop_propagation();
      })
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().min_w(0).truncate().text_size(15).font_semibold().child(this.forcing ? `${d.arg} isn't merged` : p.title))
        .child(div().text_size(11).text_color(t.dim).child("Esc")))
      .child(div().pt(4).text_size(11.5).text_color(t.dim).truncate().child(`${d.on ? `${d.on}: ` : ""}${d.root.split("/").pop()}`))
      .child(div().pt(10).text_color(t.muted).child(text))
      .when(asking, (e) => e.child(div().pt(12).child(Input.new(this.input).h(36).px(10).rounded(9).border_1().border_color(t.accent).bg(t.background).text_size(12.8).text_color(t.foreground))))
      .when(Boolean(this.error), (e) => e.child(div().pt(8).text_size(12).text_color(t.ansi1).child(this.error)))
      .child(div().flex_1())
      .child(h_flex().pt(16).gap(8).justify_end()
        .when(Boolean(this.stuck), (e) => e
          .child(button("gd-keep", "Leave It", "plain", () => this.close()))
          .child(button("gd-abort", `Abort ${this.stuck === "revert" ? "Revert" : "Cherry-pick"}`, "primary", (_e, cx) => this.abort(cx))))
        .when(!this.stuck, (e) => e
          .child(button("gd-cancel", "Cancel", "plain", () => this.close()))
          .when(Boolean(p.alt) && !this.forcing, (e) => e.child(button("gd-alt", p.alt, "plain", (_e, cx) => this.confirm(cx, true))))
          .child(button("gd-ok", this.forcing ? p.force.ok : this.busy ? "Working…" : p.ok, p.danger || this.forcing ? "danger" : "primary", (_e, cx) => this.confirm(cx, false)))));
  }
}
