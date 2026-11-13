// Claude's session (5-hour) and weekly limits, one block per Claude config folder.
// The numbers come from the status line: save-limits.sh writes ~/.cache/herdr-claude-limits/<account>.json.
import { View, div, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { exec, watchFolder, home, theme } from "herdr";

const WINDOWS = [["five_hour", "Session"], ["seven_day", "Weekly"]];
const STALE = 30 * 60; // older than this, the row says when a session last saw it

// claude -> Claude, claude-personal -> Personal, anything else as it is.
const label = (a) => (a === "claude" ? "Claude" : a.replace(/^claude-/, "").replace(/^./, (c) => c.toUpperCase()));

function span(s) {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(m, 1)}m`;
}

export default class Limits extends View {
  init(_props, cx) {
    this.dir = `${home()}/.cache/herdr-claude-limits`;
    this.accounts = null;
    this.load(cx);
    // The timer also moves the reset countdowns along.
    cx.timer.every(30000, (cx) => this.load(cx));
    cx.spawn(async (cx) => {
      try { for (;;) { await watchFolder(this.dir); this.load(cx); } } catch { /* no folder yet: the timer finds it */ }
    });
  }

  load(cx) {
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", 'for f in "$1"/*.json; do [ -f "$f" ] && cat "$f" && echo; done', "limits", this.dir]);
        const list = [];
        for (const line of r.stdout.split("\n")) {
          try { const s = JSON.parse(line); if (s?.account && s.rate_limits) list.push(s); } catch { /* half-written or empty line */ }
        }
        this.accounts = list.sort((a, b) => a.account.localeCompare(b.account));
      } catch {
        this.accounts = [];
      } finally { cx.notify(); }
    });
  }

  meter(t, id, name, w, now) {
    // A window that has reset since the snapshot starts over at 0%.
    const over = !w || (w.resets_at && w.resets_at <= now);
    const pct = over ? 0 : Math.max(0, Math.min(100, Math.round(w.used_percentage ?? 0)));
    const color = pct >= 80 ? t.blocked : pct >= 50 ? t.ansi3 : t.accent;
    const reset = over ? (w ? "reset" : "") : w.resets_at ? `resets in ${span(w.resets_at - now)}` : "";
    return v_flex().id(id).gap(4)
      .child(h_flex().items_center().gap(6).text_size(11.5)
        .child(div().text_color(t.muted).child(name))
        .child(div().text_color(pct >= 50 ? color : t.foreground).font_medium().child(w ? `${pct}%` : "–"))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(reset)))
      .child(div().h(4).w_full().rounded(2).bg(t.raised).overflow_hidden()
        .child(div().h_full().rounded(2).bg(color).w(`${pct}%`)));
  }

  render(_cx) {
    const t = theme();
    const now = Date.now() / 1000;
    const accounts = this.accounts ?? [];
    return v_flex().id("limits").size_full().min_h(0).bg(t.chrome).border_t(1).border_color(t.border).text_size(13).text_color(t.foreground)
      .child(h_flex().px(16).h(41).pt(14).pb(5).flex_none().items_center()
        .child(div().text_size(11.5).font_medium().text_color(t.dim).child("Limits")))
      .when(this.accounts !== null && accounts.length === 0, (el) => el.child(
        div().px(16).text_size(12).text_color(t.dim).child("No limits yet. They show up once a Claude session's status line runs save-limits.sh.")))
      .child(v_flex().id("limits-list").flex_1().min_h(0).overflow_y_scrollbar().px(16).pb(10).gap(12)
        .children(accounts.map((a) => {
          const age = now - (a.updated ?? 0);
          return v_flex().id(`limits-${a.account}`).gap(8)
            .child(h_flex().items_center().gap(6).text_size(11)
              .child(image("icons/claude.svg").w(13).h(13).flex_none())
              .child(div().font_medium().text_color(t.muted).child(label(a.account)))
              .when(Boolean(a.plan), (el) => el.child(div().flex_none().px(5).h(16).rounded(4).bg(t.raised)
                .text_size(10).font_medium().text_color(t.muted).flex().items_center().child(a.plan)))
              .when(age > STALE, (el) => el.child(div().flex_1().min_w(0).truncate().text_right().text_color(t.dim).child(`as of ${span(age)} ago`))))
            .children(WINDOWS.map(([key, name]) => this.meter(t, `limits-${a.account}-${key}`, name, a.rate_limits[key], now)));
        })));
  }
}
