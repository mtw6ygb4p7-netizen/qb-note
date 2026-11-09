// iPad・iPhone用「間違えた問題ノート」（ホーム画面に置くと電波が無くても開ける）
// データ：PCで作った「iPad用データ」（tools/qb_mobile.py data）を読み込んで端末（IndexedDB）に保存する。
// 解いた記録も端末に保存し、「記録を書き出す」で拡張機能の「読み込み」にそのまま入るファイルにする。
// 出す日の計算は拡張機能と同じ lib.js（QB）を使う。
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const jc = j => j === "×" ? "x" : j === "△" ? "t" : "o";
const ld = iso => QB.localDate(iso);
const today = () => QB.dayKey(new Date().toISOString());

// ---- 端末の保存（IndexedDB の kv に data・images・local の3つ） ----
const idb = new Promise((ok, no) => {
  const r = indexedDB.open("qb-note", 1);
  r.onupgradeneeded = () => r.result.createObjectStore("kv");
  r.onsuccess = () => ok(r.result);
  r.onerror = () => no(r.error);
});
async function kvGet(k) {
  const db = await idb;
  return new Promise((ok, no) => { const r = db.transaction("kv").objectStore("kv").get(k); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
}
async function kvSet(entries) {
  const db = await idb;
  return new Promise((ok, no) => {
    const tx = db.transaction("kv", "readwrite"), st = tx.objectStore("kv");
    for (const [k, v] of Object.entries(entries)) st.put(v, k);
    tx.oncomplete = () => ok(); tx.onerror = () => no(tx.error);
  });
}

// data：{exportedAt, importedAt, items, examItems}（PCから来た問題と、そのときまでの記録）
// local：{attempts: [{qid, key, at, judge, src, chosen, result}], exported: [key]}（この端末で解いた記録）
let data = { items: {}, examItems: {} }, images = {}, local = { attempts: [], exported: [] }, ready = false;

function allItems() {
  const add = new Map();
  for (const t of local.attempts) { if (!add.has(t.qid)) add.set(t.qid, []); add.get(t.qid).push(t); }
  const out = [];
  for (const [store, exam] of [[data.items, false], [data.examItems, true]]) {
    for (const it of Object.values(store || {})) {
      const extra = add.get(it.id);
      let attempts = it.attempts || [];
      if (extra) {
        const m = new Map(attempts.map(t => [t.key, t]));
        for (const t of extra) if (!m.has(t.key)) m.set(t.key, { key: t.key, at: t.at, judge: t.judge, src: t.src, chosen: t.chosen, result: t.result });
        attempts = [...m.values()];
      }
      out.push({ ...it, attempts, exam });
    }
  }
  return out;
}

// ---- 一覧 ----
let tab = "due";
try { tab = localStorage.getItem("qb_tab") || "due"; } catch (e) {}
if (!["review", "due", "today", "subject", "date", "cleared"].includes(tab)) tab = "due";
const setTab = t => { tab = t; try { localStorage.setItem("qb_tab", t); } catch (e) {} render(); };

const SORTS = { miss: (a, b) => b.d.miss - a.d.miss || (a.d.lastMissAt < b.d.lastMissAt ? 1 : -1),
                recent: (a, b) => a.d.lastMissAt < b.d.lastMissAt ? 1 : -1,
                first: (a, b) => (a.it.firstMissAt || "") < (b.it.firstMissAt || "") ? -1 : 1 };
// タブごとの問題（拡張機能のノート・クラウドのページと同じ分け方）
const pickTab = (t, all, day) => t === "review" ? all.filter(r => r.d.missToday)
  : t === "due" ? all.filter(r => r.d.inToday && !r.d.missToday)
  : t === "cleared" ? all.filter(r => r.d.cleared)
  : (t === "subject" || t === "date") ? all.filter(r => !r.d.cleared)
  : all.filter(r => !r.d.cleared && r.d.lastMissAt && ld(r.d.lastMissAt) === day);

function view() {
  const all = allItems().map(it => ({ it, d: QB.derive(it) })).filter(r => r.d.miss > 0);
  const pick = pickTab(tab, all, ld(new Date().toISOString()));
  // 総復習の並び：まだ解いていない → 遅れが長い → 直近が× → 必修
  if (tab === "due") pick.sort((a, b) => a.d.doneToday - b.d.doneToday || (a.d.dueBefore < b.d.dueBefore ? -1 : a.d.dueBefore > b.d.dueBefore ? 1 : 0)
    || (b.d.lastMissJudge === "×") - (a.d.lastMissJudge === "×") || !!b.it.required - !!a.it.required);
  else pick.sort(SORTS[$("sort").value]);
  return { all, pick };
}

function imgs(it) {
  return (it.images || []).map(u => images[u] ? `<img class="qimg" src="${esc(images[u])}" alt="">`
    : navigator.onLine ? `<img class="qimg" src="${esc(u)}" alt="">` : `<div class="noimg">（画像はオフラインでは表示できません）</div>`).join("");
}
function badges(d) {
  if (d.cleared) return '<span class="pill prog">克服</span>';
  return (d.doneToday ? `<span class="pill done">今日 ${esc(d.todayFirst)}</span>` : "")
    + `<span class="pill prog">段階 ${Math.max(d.step, 0) + 1}/${QB.LADDER.length}</span>`
    + (d.due ? `<span class="pill ${d.due < today() ? "late" : "due"}">次 ${esc(QB.dueText(d.due))}</span>` : "");
}
function card(r) {
  const { it, d } = r;
  const ans = String(it.answer || "").split(/[,、\s]+/);
  const ch = (it.choices || []).map(c => `<div class="choice${ans.includes(c.n) ? " ans" : ""}">${esc(c.n)}　${esc(c.text)}${ans.includes(c.n) ? "　← 正解" : ""}</div>`).join("");
  const h = d.attempts.map(t => `<span>${ld(t.at)} <b class="${jc(t.judge)}">${esc(t.judge)}</b></span>`).join("");
  return `<article class="item"><div class="top"><span class="qid">${esc(it.label)}</span>
    ${it.required ? '<span class="pill due">必修</span>' : ""}<span class="pill miss">${d.miss}回間違い</span>
    ${badges(d)}<span>最終 ${d.lastMissAt ? ld(d.lastMissAt) : "-"}</span></div>
    <div class="q">${esc(it.text)}</div>${imgs(it)}
    <details><summary>選択肢・正解・解説</summary>${ch}<div class="exp">${esc(it.explanation)}</div></details>
    <div class="hist">${h}</div></article>`;
}

// まとめ方：日付別は最後に間違えた日（新しい順）、それ以外は科目別（QBの分野順）→ 年度別 → 未分類
let openGroups = new Set();
try { openGroups = new Set(JSON.parse(localStorage.getItem("qb_open_groups") || "[]")); } catch (e) {}
function grouped(rows) {
  const g = new Map(), byDate = tab === "date";
  const keyOf = r => byDate ? (r.d.lastMissAt ? ld(r.d.lastMissAt) : "-")
    : r.it.exam ? "回" + (r.it.examVersion || (String(r.it.label || "").match(/^\d*/)[0]) || "-")
    : (QB_SUBJECTS[r.it.subjectCode] ? r.it.subjectCode : "");
  for (const r of rows) { const k = keyOf(r); if (!g.has(k)) g.set(k, []); g.get(k).push(r); }
  const keys = byDate ? [...g.keys()].sort().reverse()
    : [...QB_SUBJECT_ORDER.filter(k => g.has(k)), ...[...g.keys()].filter(k => k.startsWith("回")).sort((a, b) => b.slice(1) - a.slice(1)), ...(g.has("") ? [""] : [])];
  const label = k => byDate ? k : k.startsWith("回") ? "年度別 第" + k.slice(1) + "回" : QB.subjectLabel(k);
  const one = keys.length === 1;
  return keys.map(k => { const gk = tab + ":" + k;
    return `<details class="grp" data-gk="${esc(gk)}"${one || openGroups.has(gk) ? " open" : ""}><summary class="subj">${esc(label(k))}<span>${g.get(k).length}問</span></summary>`
      + g.get(k).map(card).join("") + `</details>`; }).join("");
}

function syncLines() {
  const n = Object.keys(data.items || {}).length + Object.keys(data.examItems || {}).length;
  $("dataLine").textContent = !ready ? "読み込み中…" : data.exportedAt
    ? `問題データ：${new Date(data.exportedAt).toLocaleString("ja-JP")} にPCで作成（${n}問）` + (navigator.onLine === false ? "・オフライン" : "")
    : "問題データがまだありません。PCで作った「iPad用データ」を読み込んでください。";
  const ex = new Set(local.exported), notYet = local.attempts.filter(t => !ex.has(t.key)).length;
  $("recLine").innerHTML = notYet ? `<span class="pend">書き出していない記録 ${notYet}件</span>（ネットのあるときに「記録を書き出す」）`
    : local.attempts.length ? `この端末の記録 ${local.attempts.length}件（すべて書き出し済み）` : "";
}

function render() {
  syncLines();
  const { all, pick } = view();
  const day = today();
  const active = all.filter(r => !r.d.cleared).length;
  const set = all.filter(r => r.d.inToday && !r.d.missToday), done = set.filter(r => r.d.doneToday).length;
  const newToday = all.filter(r => r.d.missToday).length;
  const soon = n => all.filter(r => !r.d.cleared && r.d.due && r.d.due > day && r.d.due <= QB.addDays(day, n)).length;
  $("stats").innerHTML = `<span><b>${newToday}</b>問 今日の復習</span><span><b>${set.length - done}</b>問 総復習の残り（済み${done}）</span><span><b>${soon(1)}</b>問 明日</span><span><b>${soon(7)}</b>問 7日以内</span><span><b>${active}</b>問 要復習</span><span><b>${all.length - active}</b>問 克服済み</span>`;
  $("reviewTab").setAttribute("aria-pressed", String(tab === "review"));
  $("dueTab").setAttribute("aria-pressed", String(tab === "due"));
  $("reviewTab").textContent = `今日の復習（${newToday}問）`;
  $("dueTab").textContent = `総復習を始める（残り${set.length - done}問）`;
  const ldToday = ld(new Date().toISOString());
  document.querySelectorAll("#tabs button").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
    b.dataset.label = b.dataset.label || b.textContent;
    const got = pickTab(b.dataset.tab, all, ldToday), un = got.filter(r => r.d.unreviewed).length;
    b.textContent = `${b.dataset.label} ${got.length}` + (b.dataset.tab === "cleared" ? "" : `（未演習${un}）`);
  });
  $("list").innerHTML = pick.length ? grouped(pick)
    : `<div class="empty"><b>${all.length ? (tab === "review" ? "今日登録した問題はありません" : tab === "due" ? "今日の総復習はありません（終わりました）" : "この表示に該当する問題はありません") : ready ? "問題がまだありません" : "読み込み中…"}</b>${all.length || !ready ? "" : "PCで「iPad用データを作って」と言い、できたファイルを「問題データを読み込む」で選んでください。"}</div>`;
}

// ---- 1問ずつ解く（PCのノートと同じ：選んで答え合わせ → 自己判定 ◎○△× → 次へで記録） ----
let queue = [], pos = 0, rv = null;
const answersOf = it => String(it.answer || "").split(/[,、\s]+/).filter(Boolean);
const jcls = j => j === "×" ? "j-x" : j === "△" ? "j-t" : "j-o";
function showReview() {
  const r = queue[pos];
  if (!r) { endReview(); return; }
  const { it, d } = r;
  const ans = answersOf(it);
  const ch = (it.choices || []).map(c => {
    const picked = rv.chosen.has(c.n), isAns = rv.reveal && ans.includes(c.n);
    const cls = ["choice", "pickable", picked ? "picked" : "", isAns ? "ans" : "", rv.reveal && picked && !isAns ? "ng" : ""].join(" ");
    return `<div class="${cls}" data-n="${esc(c.n)}" role="button" tabindex="0">${esc(c.n)}　${esc(c.text)}${isAns ? "　← 正解" : rv.reveal && picked ? "　← あなたの答え" : ""}</div>`;
  }).join("");
  const judges = ["◎", "○", "△", "×"].map(j => `<button class="jbtn ${jcls(j)}${rv.judge === j ? " on" : ""}" data-j="${j}">${j}</button>`).join("");
  $("reviewView").innerHTML = `<div class="meta">${tab === "review" ? "今日の復習" : tab === "due" ? "総復習" : "1問ずつ"} ${pos + 1} / ${queue.length}${ans.length > 1 ? "　（" + ans.length + "つ選ぶ）" : ""}</div>
    <article class="item"><div class="top"><span class="qid">${esc(it.label)}</span>${it.required ? '<span class="pill due">必修</span>' : ""}<span class="pill miss">${d.miss}回間違い</span></div>
    <div class="q">${esc(it.text)}</div>${imgs(it)}<div style="margin-top:8px">${ch}</div>
    ${rv.reveal ? `<div class="exp">正解：${esc(it.answer)}\n\n${esc(it.explanation)}</div>
      <div class="judge">自己判定：${judges}<span class="note">${rv.judge ? "この判定で記録します" : "判定を選ぶと記録します（選ばずに次へ進むと記録しません）"}</span></div>` : ""}</article>
    <div class="nav"><button id="rvEnd">終了</button>${rv.reveal ? `<button class="go" id="rvNext">${pos + 1 < queue.length ? "次へ" : "記録して終わる"}</button>` : '<button class="go" id="rvShow">答え合わせ</button>'}</div>`;
  $("rvEnd").onclick = async () => { if (rv.reveal) await recordReview(); endReview(); };
  if (rv.reveal) $("rvNext").onclick = async () => { await recordReview(); pos++; rv = { chosen: new Set(), reveal: false, judge: null }; showReview(); };
  else $("rvShow").onclick = () => {
    // 初期の判定：選んだ答えが正解と一致→○、違う→×（選んでいなければ未判定）
    if (rv.chosen.size && ans.length) rv.judge = ans.length === rv.chosen.size && ans.every(n => rv.chosen.has(n)) ? "○" : "×";
    rv.reveal = true; showReview();
  };
  window.scrollTo(0, 0);
}
$("reviewView").addEventListener("click", e => {
  if (!rv) return;
  const j = e.target.closest(".jbtn");
  if (j) { rv.judge = j.dataset.j; showReview(); return; }
  const c = e.target.closest(".pickable");
  if (!c || rv.reveal) return;
  const n = c.dataset.n, multi = answersOf(queue[pos].it).length > 1;
  if (rv.chosen.has(n)) rv.chosen.delete(n);
  else { if (!multi) rv.chosen.clear(); rv.chosen.add(n); }
  showReview();
});
async function recordReview() {
  const r = queue[pos];
  if (!r || !rv || !rv.judge) return;
  const now = new Date().toISOString();
  const ans = answersOf(r.it), chosen = [...rv.chosen];
  const result = !chosen.length || !ans.length ? null : ans.length === chosen.length && ans.every(n => chosen.includes(n)) ? "正解" : "不正解";
  local.attempts.push({ qid: r.it.id, key: "ipad:" + now, at: now, judge: rv.judge, src: "ipad", chosen: chosen.join(","), result });
  try { await kvSet({ local }); } catch (e) { toast("記録を保存できませんでした（" + (e && e.message || e) + "）"); }
}
function endReview() { $("reviewView").hidden = true; $("listView").hidden = false; rv = null; render(); }

// ---- 読み込み・書き出し ----
let toastTimer = 0;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000); }

async function importData(obj) {
  if (!obj || obj.kind !== "qb-mobile-data") throw new Error("iPad用データのファイルではありません");
  // PCに入った記録（key が問題データにある）は端末の記録から外す。まだのものは残す
  const known = new Set();
  for (const st of [obj.items, obj.examItems]) for (const it of Object.values(st || {})) for (const t of it.attempts || []) known.add(t.key);
  const ids = new Set([...Object.keys(obj.items || {}), ...Object.keys(obj.examItems || {})]);
  const keep = local.attempts.filter(t => !known.has(t.key));
  const lost = keep.filter(t => !ids.has(t.qid)).length;
  data = { exportedAt: obj.exportedAt, importedAt: new Date().toISOString(), items: obj.items || {}, examItems: obj.examItems || {} };
  images = obj.images || {};
  local = { attempts: keep, exported: local.exported.filter(k => keep.some(t => t.key === k)) };
  await kvSet({ data, images, local });
  return { n: ids.size, lost };
}
$("importBtn").onclick = () => $("file").click();
$("file").onchange = async e => {
  const f = e.target.files[0]; e.target.value = "";
  if (!f) return;
  try {
    const r = await importData(JSON.parse(await f.text()));
    toast(`読み込みました（${r.n}問）` + (r.lost ? `。PCに無い問題の記録が${r.lost}件あります（書き出しには入ります）` : ""));
  } catch (err) { toast("読み込めませんでした：" + (err && err.message || err)); }
  render();
};

// 拡張機能のノートの「読み込み」にそのまま入る形（{items: {id: {id, attempts}}, examItems}）。中身はPCのものを残すため id と attempts だけ
function exportBody() {
  const items = {}, examItems = {};
  for (const t of local.attempts) {
    const st = data.examItems && data.examItems[t.qid] && !(data.items && data.items[t.qid]) ? examItems : items;
    if (!st[t.qid]) st[t.qid] = { id: t.qid, attempts: [] };
    st[t.qid].attempts.push({ key: t.key, at: t.at, judge: t.judge, src: t.src, chosen: t.chosen, result: t.result });
  }
  return { version: 1, exportedAt: new Date().toISOString(), from: "qb-mobile", items, examItems };
}
$("exportBtn").onclick = async () => {
  if (!local.attempts.length) { toast("書き出す記録はまだありません"); return; }
  const d = new Date(), p = n => String(n).padStart(2, "0");
  const name = `QB記録_iPad_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
  const blob = new Blob([JSON.stringify(exportBody(), null, 1)], { type: "application/json" });
  const file = new File([blob], name, { type: "application/json" });
  let ok = false;
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file] }); ok = true; }
  } catch (e) { if (e && e.name === "AbortError") return; }
  if (!ok) { // 共有できない環境はダウンロード
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000); ok = true;
  }
  local.exported = local.attempts.map(t => t.key);
  await kvSet({ local });
  toast("書き出しました。PCの拡張機能のノートで「読み込み」からこのファイルを選んでください");
  render();
};

// ---- 操作 ----
$("tabs").onclick = e => { const t = e.target.dataset.tab; if (t) setTab(t); };
$("sort").onchange = render;
$("list").addEventListener("toggle", e => {
  const g = e.target;
  if (!g.classList || !g.classList.contains("grp")) return;
  if (g.open) openGroups.add(g.dataset.gk); else openGroups.delete(g.dataset.gk);
  try { localStorage.setItem("qb_open_groups", JSON.stringify([...openGroups])); } catch (x) {}
}, true);
$("openAll").onclick = () => document.querySelectorAll("#list details.grp").forEach(g => { g.open = true; });
$("closeAll").onclick = () => document.querySelectorAll("#list details.grp").forEach(g => { g.open = false; });
$("dueTab").onclick = () => setTab("due");
$("reviewTab").onclick = () => setTab("review");
// いま表示している一覧を1問ずつ（解き直して○でも記録は今日のいちばん悪い評価のまま）
$("start").onclick = () => { queue = view().pick; if (!queue.length) return; pos = 0; rv = { chosen: new Set(), reveal: false, judge: null }; $("listView").hidden = true; $("reviewView").hidden = false; showReview(); };
addEventListener("online", () => { if ($("reviewView").hidden) render(); });
addEventListener("offline", () => { if ($("reviewView").hidden) render(); });
// 日をまたいで開きっぱなしでも、今日の分を出し直す
let lastDay = today();
document.addEventListener("visibilitychange", () => { if (!document.hidden && today() !== lastDay) { lastDay = today(); if ($("reviewView").hidden) render(); } });

// ---- 起動 ----
(async () => {
  try {
    const [d, im, lc] = await Promise.all([kvGet("data"), kvGet("images"), kvGet("local")]);
    if (d) data = d;
    if (im) images = im;
    if (lc) local = { attempts: lc.attempts || [], exported: lc.exported || [] };
  } catch (e) { toast("端末の保存領域を開けませんでした（" + (e && e.message || e) + "）"); }
  ready = true;
  render();
  // 端末の保存を消されにくくする（ホーム画面に置いたアプリは通常消されない）
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
})();
render();
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
