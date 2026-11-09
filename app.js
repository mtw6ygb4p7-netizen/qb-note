// 間違えた問題ノート（PC・iPad・iPhone 共通のアプリ。ホーム画面に置くと電波が無くても開ける）
// データの置き場所は1か所：GitHub の非公開リポジトリ qb-note-data（Anki でいう AnkiWeb の役）。
//   data.json          … 最新の問題と記録（PCの拡張機能 ghsync.js が、QBで記録した分と全端末の記録をまとめて置く）
//   records/<端末>.json … その端末で解いた記録（attempts）と操作（ops：タグ・削除・一覧に戻す）。端末ごとに1ファイルなので、書き込みがぶつからない
// どの端末も「data.json ＋ 全端末の records」を key でまとめて表示する（PCが止まっていても、iPad と iPhone の記録は互いに見える）。
// 食い違いの決め方（Anki と同じ考え方）：解いた記録は消さずに足すだけ（key で1つにまとまる）。タグなどは後から変えた方が勝つ（lib.js の QB.applyOps）。
// 同期できないときは、ファイルで受け渡しもできる（PCの tools/qb_mobile.py data で作った「iPad用データ」／「記録を書き出す」）。
// 出す日の計算は拡張機能と同じ lib.js（QB）を使う。
"use strict";
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const jc = j => j === "×" ? "x" : j === "△" ? "t" : "o";
const ld = iso => QB.localDate(iso);
const today = () => QB.dayKey(new Date().toISOString());
const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };

// ---- 端末の保存（IndexedDB の kv に data・images・local・others・gh） ----
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
// local：{attempts: [{qid, key, at, judge, src, chosen, result}], ops: [{key, qid, op, tags, at}], exported: [key], sentSig}（この端末の分）
// others：{<ファイル名>: {sha, attempts, ops}}（ほかの端末の分。records/ から受け取る）
let data = { items: {}, examItems: {} }, images = {}, local = { attempts: [], ops: [], exported: [] }, others = {}, ready = false;
const dev = () => String(gh.device || "app").split("-")[0];

function allItems() {
  const add = new Map(), ops = new Map();
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  for (const src of [...Object.values(others), local]) { // 自分の分を最後に（同じ key なら自分の判定が勝つ）
    for (const t of src.attempts || []) push(add, t.qid, t);
    for (const o of src.ops || []) push(ops, o.qid, o);
  }
  const out = [];
  for (const [store, exam] of [[data.items, false], [data.examItems, true]]) {
    for (const it of Object.values(store || {})) {
      let attempts = it.attempts || [];
      const extra = add.get(it.id);
      if (extra) {
        const m = new Map(attempts.map(t => [t.key, t]));
        for (const t of extra) m.set(t.key, { key: t.key, at: t.at, judge: t.judge, src: t.src, chosen: t.chosen, result: t.result });
        attempts = [...m.values()];
      }
      const got = QB.applyOps({ ...it, attempts }, ops.get(it.id));
      if (got) out.push({ ...got, exam });
    }
  }
  return out;
}

// ---- 一覧 ----
const TABS = ["review", "due", "today", "subject", "exam", "date", "tag", "leech", "cleared"];
let tab = lsGet("qb_tab", "due");
if (!TABS.includes(tab)) tab = "due";
let curTag = lsGet("qb_tag", "");
const setTab = t => { tab = t; lsSet("qb_tab", t); render(); };

const SORTS = { miss: (a, b) => b.d.miss - a.d.miss || (a.d.lastMissAt < b.d.lastMissAt ? 1 : -1),
                recent: (a, b) => a.d.lastMissAt < b.d.lastMissAt ? 1 : -1,
                first: (a, b) => (a.it.firstMissAt || "") < (b.it.firstMissAt || "") ? -1 : 1 };
// 国試の回（114A91 → 114）。QBオリジナルなど回の無い問題は ""
const examNo = it => { const v = Number(it.examVersion || (String(it.label || "").match(/^改?(\d{2,3})[A-Z追]/) || [])[1]); return v >= 80 && v <= 130 ? String(v) : ""; };
// タブごとの問題（今日の復習・総復習・今日間違えた・克服済みは拡張機能のルールと同じ分け方）
const pickTab = (t, all, day) => t === "review" ? all.filter(r => r.d.missToday)
  : t === "due" ? all.filter(r => r.d.inToday && !r.d.missToday)
  : t === "cleared" ? all.filter(r => r.d.cleared)
  : t === "tag" ? all.filter(r => curTag && (r.it.tags || []).includes(curTag))
  // 苦手＝×・△にした日数が QB.LEECH 日に達した問題（克服したものは克服済みへ）
  : t === "leech" ? all.filter(r => r.d.leech && !r.d.cleared)
  // 科目別＝QBの科目別（分野別）から解いた問題だけ。年度別＝QBの回数別から解いた、科目別に無い問題だけ（拡張機能の分け方と同じ）
  : t === "subject" ? all.filter(r => !r.d.cleared && !r.it.exam)
  : t === "exam" ? all.filter(r => !r.d.cleared && r.it.exam)
  : t === "date" ? all.filter(r => !r.d.cleared)
  : all.filter(r => !r.d.cleared && r.d.lastMissAt && ld(r.d.lastMissAt) === day);
const tabName = t => ({ review: "今日の復習", due: "総復習", today: "今日間違えた", subject: "科目別", exam: "年度別", date: "日付別", tag: "タグ「" + curTag + "」", leech: "苦手", cleared: "克服済み" }[t] || "");

const subNo = it => Number((String(it.label || "").match(/(\d+)$/) || [])[1] || 0);
function view() {
  const every = allItems().map(it => ({ it, d: QB.derive(it) }));
  // 連問のまとまり（○の小問＝companion も含む）
  const byKey = new Map();
  for (const r of every) { const k = QB.seriesKey(r.it); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(r); }
  for (const g of byKey.values()) g.sort((a, b) => subNo(a.it) - subNo(b.it));
  const all = every.filter(r => r.d.miss > 0);
  const pick = pickTab(tab, all, ld(new Date().toISOString()));
  // 総復習の並び：まだ解いていない → 遅れが長い → 直近が× → 必修
  if (tab === "due") pick.sort((a, b) => a.d.doneToday - b.d.doneToday || (a.d.dueBefore < b.d.dueBefore ? -1 : a.d.dueBefore > b.d.dueBefore ? 1 : 0)
    || (b.d.lastMissJudge === "×") - (a.d.lastMissJudge === "×") || !!b.it.required - !!a.it.required);
  else pick.sort(SORTS[$("sort").value]);
  return { all, pick, byKey };
}
// 一覧の問題 → ページ（連問は1ページにまとめる。小問は全部入れる）
function pagesOf(rows, byKey) {
  const seen = new Map(), pages = [];
  for (const r of rows) {
    const k = QB.seriesKey(r.it);
    if (seen.has(k)) { seen.get(k).picked.push(r); continue; }
    const p = { key: k, lead: r, picked: [r], members: byKey.get(k) || [r] };
    seen.set(k, p); pages.push(p);
  }
  return pages;
}
const pageLabel = p => p.members.length > 1
  ? p.members[0].it.label + "〜" + String(p.members[p.members.length - 1].it.label).replace(/^.*?(\d+)$/, "$1") : p.lead.it.label;
const tagsOfPage = p => [...new Set(p.members.flatMap(m => m.it.tags || []))];

function imgTags(list) {
  return (list || []).map(u => images[u] ? `<img class="qimg" src="${esc(images[u])}" alt="">`
    : navigator.onLine ? `<img class="qimg" src="${esc(u)}" alt="">` : `<div class="noimg">（画像はオフラインでは表示できません）</div>`).join("");
}
function badges(d) {
  if (d.cleared) return '<span class="pill prog">克服</span>';
  return (d.doneToday ? `<span class="pill done">今日 ${esc(d.todayFirst)}</span>` : "")
    + `<span class="pill prog">段階 ${Math.max(d.step, 0) + 1}/${QB.LADDER.length}</span>`
    + (d.due ? `<span class="pill ${d.due < today() ? "late" : "due"}">次 ${esc(QB.dueText(d.due))}</span>` : "");
}
const leechPill = d => d.leech ? `<span class="pill leech" title="×・△にした日が${d.missDays}日">苦手</span>` : "";
const statusPills = r => r.d.miss > 0 ? `${leechPill(r.d)}<span class="pill miss">${r.d.miss}回間違い</span>${badges(r.d)}` : '<span class="pill ok">○ QBで正解</span>';
const tagChips = tags => tags.map(t => `<span class="chip">#${esc(t)}</span>`).join("");
// 連問の小問の文。以前の記録（114A91）は小問の文の代わりに前文が入っているので、その旨を出す（PCの取り込みで読み直すと直る）
const subBody = (it, series) => { if (!series) return it.text; const x = QB.splitText(it.text);
  return x.body.trim() === x.pre.trim() ? "（この小問の文がまだ正しく取れていません。PCの拡張機能が次の取り込みでQBから読み直します）" : x.body; };
const answersOf = it => String(it.answer || "").split(/[,、\s]+/).filter(Boolean);

// 一覧のカード（連問は前文1回＋小問ごと）
function card(p) {
  const series = p.members.length > 1;
  const pre = series ? QB.splitText(p.members[0].it.text).pre : "";
  const qImgs = [...new Set(p.members.flatMap(m => QB.imagesOf(m.it).q))];
  const subs = p.members.map(m => {
    const { it, d } = m, ans = answersOf(it), im = QB.imagesOf(it);
    const ch = (it.choices || []).map(c => `<div class="choice${ans.includes(c.n) ? " ans" : ""}">${esc(c.n)}　${esc(c.text)}${ans.includes(c.n) ? "　← 正解" : ""}</div>`).join("");
    const h = d.attempts.filter(t => t.judge).map(t => `<span>${ld(t.at)} <b class="${jc(t.judge)}">${esc(t.judge)}</b></span>`).join("");
    const body = subBody(it, series);
    return `<div class="${series ? "subq" : ""}">${series ? `<div class="top"><span class="qid">${esc(it.label)}</span>${statusPills(m)}</div>` : ""}
      <div class="q">${esc(body)}</div>
      <details><summary>選択肢・正解・解説</summary>${ch}<div class="exp">${esc(it.explanation)}</div>${imgTags(im.exp)}</details>
      ${h ? `<div class="hist">${h}</div>` : ""}</div>`;
  }).join("");
  const lead = p.lead;
  return `<article class="item" data-key="${esc(p.key)}"><div class="top"><span class="qid">${esc(pageLabel(p))}</span>
    ${lead.it.required ? '<span class="pill due">必修</span>' : ""}${series ? '<span class="pill">連問</span>' : statusPills(lead)}
    ${series ? "" : `<span>最終 ${lead.d.lastMissAt ? ld(lead.d.lastMissAt) : "-"}</span>`}${tagChips(tagsOfPage(p))}</div>
    ${series ? `<div class="q">${esc(pre)}</div>` : ""}${imgTags(qImgs)}${subs}
    <div class="acts"><button data-act="del">削除</button>${p.members.some(m => m.d.cleared) ? '<button data-act="back">一覧に戻す</button>' : ""}${p.members.some(m => m.d.leech) ? '<button data-act="unleech">苦手から外す</button>' : ""}</div></article>`;
}

// まとめ方：科目別（QBの分野順 → 年度別 → 未分類）／回数別（新しい回から）／日付別（最後に間違えた日、新しい順）
let openGroups = new Set(lsGet("qb_open_groups", []));
function grouped(pages) {
  const g = new Map(), byDate = tab === "date", byExam = tab === "exam";
  const keyOf = p => { const it = p.lead.it;
    return byDate ? (p.lead.d.lastMissAt ? ld(p.lead.d.lastMissAt) : "-")
      : byExam ? "回" + (examNo(it) || "-")
      : it.exam ? "回" + (examNo(it) || "-")
      : (QB_SUBJECTS[it.subjectCode] ? it.subjectCode : ""); };
  for (const p of pages) { const k = keyOf(p); if (!g.has(k)) g.set(k, []); g.get(k).push(p); }
  const keys = byDate ? [...g.keys()].sort().reverse()
    : [...QB_SUBJECT_ORDER.filter(k => g.has(k)), ...[...g.keys()].filter(k => k.startsWith("回")).sort((a, b) => b.slice(1) - a.slice(1)), ...(g.has("") ? [""] : [])];
  const label = k => byDate ? k : k.startsWith("回") ? (byExam ? "" : "年度別 ") + "第" + k.slice(1) + "回" : QB.subjectLabel(k);
  const one = keys.length === 1;
  return keys.map(k => { const gk = tab + ":" + k, n = g.get(k).reduce((s, p) => s + p.picked.length, 0);
    return `<details class="grp" data-gk="${esc(gk)}"${one || openGroups.has(gk) ? " open" : ""}><summary class="subj">${esc(label(k))}<span>${n}問</span></summary>`
      + g.get(k).map(card).join("") + `</details>`; }).join("");
}

const sigOf = () => JSON.stringify([local.attempts, local.ops]);
function syncLines() {
  const n = Object.keys(data.items || {}).length + Object.keys(data.examItems || {}).length;
  $("dataLine").textContent = !ready ? "読み込み中…" : data.exportedAt
    ? `問題データ：${new Date(data.exportedAt).toLocaleString("ja-JP")} にPCで作成（${n}問）` + (navigator.onLine === false ? "・オフライン" : "")
    : "問題データがまだありません。「同期」を押してください。";
  const ex = new Set(local.exported), notYet = local.attempts.filter(t => !ex.has(t.key)).length + local.ops.filter(o => !ex.has(o.key)).length;
  $("recLine").innerHTML = notYet ? `<span class="pend">まだ送っていない記録 ${notYet}件</span>（ネットのあるときに自動で送ります）`
    : local.dirty ? '<span class="pend">まだ送っていない変更があります</span>' : "";
  $("syncLine").textContent = syncing ? "同期中…" : !gh.token ? "同期の設定がまだです（下の「同期の設定」）"
    : gh.lastAt ? "最後の同期 " + new Date(gh.lastAt).toLocaleString("ja-JP") + (gh.lastError ? "（失敗：" + gh.lastError + "）" : "") : "";
}

function renderTagBar(all) {
  const bar = $("tagBar");
  if (tab !== "tag") { bar.hidden = true; return; }
  const count = new Map();
  for (const r of all) for (const t of r.it.tags || []) count.set(t, (count.get(t) || 0) + 1);
  if (curTag && !count.has(curTag)) curTag = "";
  if (!curTag && count.size) { curTag = [...count.keys()].sort()[0]; lsSet("qb_tag", curTag); }
  bar.hidden = false;
  bar.innerHTML = count.size ? [...count].sort((a, b) => a[0] < b[0] ? -1 : 1).map(([t, n]) =>
    `<button class="chip pick" data-tag="${esc(t)}" aria-pressed="${t === curTag}">#${esc(t)} <small>${n}</small></button>`).join("")
    : '<span class="note">タグはまだありません。1問ずつ解く画面で付けられます。</span>';
}

function render() {
  syncLines();
  renderResume();
  let v = view();
  renderTagBar(v.all); // タグの表示では、選んでいるタグが決まってから一覧を作り直す
  if (tab === "tag") v = view();
  const { all, pick: picked, byKey } = v;
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
  // タブの下の小さな字：問題数（未演習＝登録してから一度も復習していない数）。タグはタグの数
  document.querySelectorAll("#tabs button, #tabs2 button").forEach(b => {
    b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
    const sm = b.querySelector("small");
    if (b.dataset.tab === "tag") { sm.textContent = `${new Set(all.flatMap(r => r.it.tags || [])).size}種類`; return; }
    const got = pickTab(b.dataset.tab, all, ldToday), un = got.filter(r => r.d.unreviewed).length;
    const unText = b.dataset.tab === "cleared" ? "" : `未演習${un}`;
    if (b.closest("#tabs")) sm.innerHTML = `${got.length}問<br>${unText}`; else sm.textContent = `${got.length}問` + (unText ? `（${unText}）` : "");
  });
  const pages = pagesOf(picked, byKey);
  $("list").innerHTML = pages.length ? grouped(pages)
    : `<div class="empty"><b>${all.length ? (tab === "review" ? "今日登録した問題はありません" : tab === "due" ? "今日の総復習はありません（終わりました）" : tab === "tag" ? "タグの付いた問題はありません" : tab === "leech" ? `苦手の問題はありません（×・△が${QB.LEECH}日になると入ります）` : "この表示に該当する問題はありません") : ready ? "問題がまだありません" : "読み込み中…"}</b>${all.length || !ready ? "" : "「同期の設定」で合鍵を保存してから「同期」を押してください。"}</div>`;
}

// ---- 1問ずつ解く ----
// 連問は1ページにまとめる。QBで○だった小問（companion）は答えを選んだ状態で出し、×・△の小問だけ解く。
// 「答え合わせ」で記録する（自己判定の初期値は正解→○、不正解→×。押して変えたら同じ記録を上書き）。
// 途中の状態は端末に残すので、閉じても「続きから」で同じ問題から再開できる。前の問題・次の問題で行き来できる。
// ses：{id, name, tab, keys:[ページのkey], pos, st:{qid:{chosen:[], judge}}, shown:{ページのkey: true}, open}
let ses = lsGet("qb_session", null);
const saveSes = () => lsSet("qb_session", ses);
let pageCache = null; // 今のセッションのページ（データが変わったら作り直す）
function sesPages() {
  const { byKey } = view();
  const pages = [];
  for (const k of ses.keys) {
    const members = byKey.get(k);
    if (members && members.length) pages.push({ key: k, members, lead: members.find(m => m.d.miss > 0) || members[0] });
  }
  return pages;
}
function renderResume() {
  const el = $("resume");
  if (!ses || ses.open) { el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<span>途中の演習：<b>${esc(ses.name)}</b> ${Math.min(ses.pos + 1, ses.keys.length)} / ${ses.keys.length}問目</span>
    <button class="go" id="resumeGo">続きから</button><button id="resumeDrop">やめる</button>`;
  $("resumeGo").onclick = () => openSession();
  $("resumeDrop").onclick = () => { if (confirm("途中の演習をやめますか？（解いた記録は残ります）")) { ses = null; saveSes(); render(); } };
}
function startSession() {
  const { pick, byKey } = view();
  const pages = pagesOf(pick, byKey);
  if (!pages.length) return;
  if (ses && !confirm(`途中の演習（${ses.name} ${ses.pos + 1}/${ses.keys.length}）があります。やめて新しく始めますか？`)) return;
  ses = { id: Date.now().toString(36), name: tabName(tab), tab, keys: pages.map(p => p.key), pos: 0, st: {}, shown: {}, open: true };
  saveSes();
  openSession();
}
function openSession() {
  ses.open = true; saveSes();
  $("listView").hidden = true; $("reviewView").hidden = false;
  showReview(true);
}
function closeSession(finished) {
  if (finished) ses = null; else if (ses) ses.open = false;
  saveSes();
  $("reviewView").hidden = true; $("listView").hidden = false; render();
  if (navigator.serviceWorker && navigator.serviceWorker.controller && window.__swChanged) location.reload();
}
const stOf = qid => (ses.st[qid] = ses.st[qid] || { chosen: [], judge: null });

function judgeBtns(qid, judge) {
  return ["◎", "○", "△", "×"].map(j => `<button class="jbtn j-${jc(j)}${judge === j ? " on" : ""}" data-j="${j}" data-q="${esc(qid)}">${j}</button>`).join("");
}
function showReview(top) {
  const pages = sesPages();
  if (!pages.length) { toast("この演習の問題が見つかりません（削除された可能性）"); closeSession(!ses.keys.length); return; }
  if (ses.pos >= pages.length) ses.pos = pages.length - 1;
  const p = pages[ses.pos];
  pageCache = { pages, p };
  const shown = !!ses.shown[p.key];
  const series = p.members.length > 1;
  const pre = series ? QB.splitText(p.members[0].it.text).pre : "";
  // 答える前は問題の画像だけ。解説の画像は答え合わせのあと
  const qImgs = [...new Set(p.members.flatMap(m => QB.imagesOf(m.it).q))];
  const subs = p.members.map(m => {
    const { it, d } = m, ans = answersOf(it), solve = d.miss > 0, st = stOf(it.id), im = QB.imagesOf(it);
    const chosen = solve ? new Set(st.chosen) : new Set(ans);
    const ch = (it.choices || []).map(c => {
      const picked = chosen.has(c.n), isAns = (shown || !solve) && ans.includes(c.n);
      const cls = ["choice", solve && !shown ? "pickable" : "", picked ? "picked" : "", isAns ? "ans" : "", shown && picked && !isAns ? "ng" : ""].join(" ");
      return `<div class="${cls}" data-n="${esc(c.n)}" data-q="${esc(it.id)}"${solve && !shown ? ' role="button" tabindex="0"' : ""}>${esc(c.n)}　${esc(c.text)}${isAns ? "　← 正解" : shown && picked ? "　← あなたの答え" : ""}</div>`;
    }).join("");
    const body = subBody(it, series);
    return `<div class="${series ? "subq" : ""}${solve ? "" : " done"}">
      ${series ? `<div class="top"><span class="qid">${esc(it.label)}</span>${leechPill(d)}${solve ? `<span class="pill miss">✖ ${d.miss}回間違い・解く</span>` : '<span class="pill ok">○ QBで正解（答えは選択済み）</span>'}${ans.length > 1 && solve ? `<span>（${ans.length}つ選ぶ）</span>` : ""}</div>` : ""}
      <div class="q">${esc(body)}</div><div class="choices">${ch}</div>
      ${shown ? `<div class="exp">正解：${esc(it.answer)}\n\n${esc(it.explanation)}</div>${imgTags(im.exp)}
        ${solve ? `<div class="judge">自己判定：${judgeBtns(it.id, st.judge)}<span class="note">${st.judge ? "この判定で記録しました" : "判定を選ぶと記録します"}</span></div>` : ""}` : ""}</div>`;
  }).join("");
  const tags = tagsOfPage(p);
  const known = [...new Set(allItems().flatMap(it => it.tags || []))].filter(t => !tags.includes(t)).sort();
  const nAns = !series ? answersOf(p.lead.it).length : 0;
  const last = ses.pos + 1 >= pages.length;
  const y = window.scrollY;
  $("reviewView").innerHTML = `<div class="meta">${esc(ses.name)} ${ses.pos + 1} / ${pages.length}${nAns > 1 ? "　（" + nAns + "つ選ぶ）" : ""}</div>
    <article class="item"><div class="top"><span class="qid">${esc(pageLabel(p))}</span>${p.lead.it.required ? '<span class="pill due">必修</span>' : ""}
      ${series ? '<span class="pill">連問</span>' : `${leechPill(p.lead.d)}<span class="pill miss">${p.lead.d.miss}回間違い</span>`}</div>
    <div class="tags">${tags.map(t => `<span class="chip">#${esc(t)}<button class="x" data-untag="${esc(t)}" aria-label="タグ ${esc(t)} を外す">×</button></span>`).join("")}
      <input id="tagIn" list="tagList" placeholder="タグを追加" enterkeyhint="done" autocomplete="off"><button id="tagAdd">追加</button>
      <datalist id="tagList">${known.map(t => `<option value="${esc(t)}">`).join("")}</datalist>
      ${known.slice(0, 8).map(t => `<button class="chip pick" data-addtag="${esc(t)}">+#${esc(t)}</button>`).join("")}</div>
    ${series ? `<div class="q">${esc(pre)}</div>` : ""}${imgTags(qImgs)}${subs}</article>
    <div class="nav"><button id="rvPrev"${ses.pos ? "" : " disabled"}>← 前の問題</button>
      ${shown ? `<button class="go" id="rvNext">${last ? "終わる" : "次の問題 →"}</button>` : `<button class="go" id="rvShow">答え合わせ</button>`}
      ${shown || last ? "" : '<button id="rvSkip">次の問題 →</button>'}</div>
    <div class="nav"><button id="rvEnd">終了（あとで続きから）</button></div>`;
  window.scrollTo(0, top ? 0 : y); // 選んだだけでは画面を動かさない
}
const go = d => { ses.pos += d; saveSes(); showReview(true); };
$("reviewView").addEventListener("click", e => {
  if (!ses || !pageCache) return;
  const p = pageCache.p, shown = !!ses.shown[p.key];
  const t = e.target;
  if (t.closest("#rvPrev")) { if (ses.pos > 0) go(-1); return; }
  if (t.closest("#rvSkip")) { go(1); return; }
  if (t.closest("#rvNext")) { if (ses.pos + 1 >= pageCache.pages.length) closeSession(true); else go(1); return; }
  if (t.closest("#rvEnd")) { closeSession(false); return; }
  if (t.closest("#rvShow")) {
    ses.shown[p.key] = true;
    for (const m of p.members) {
      if (m.d.miss <= 0) continue;
      const st = stOf(m.it.id), ans = answersOf(m.it);
      // 初期の判定：選んだ答えが正解と一致→○、違う→×（選んでいなければ未判定）
      if (!st.judge && st.chosen.length && ans.length) st.judge = ans.length === st.chosen.length && ans.every(n => st.chosen.includes(n)) ? "○" : "×";
      if (st.judge) recordAttempt(m.it, st);
    }
    saveSes(); showReview(false); return;
  }
  const j = t.closest(".jbtn");
  if (j) { const it = p.members.find(m => m.it.id === j.dataset.q).it, st = stOf(it.id); st.judge = j.dataset.j; recordAttempt(it, st); saveSes(); showReview(false); return; }
  const un = t.closest("[data-untag]");
  if (un) { setTags(p, tagsOfPage(p).filter(x => x !== un.dataset.untag)); return; }
  const ad = t.closest("[data-addtag]");
  if (ad) { setTags(p, [...tagsOfPage(p), ad.dataset.addtag]); return; }
  if (t.closest("#tagAdd")) { addTagFromInput(p); return; }
  const c = t.closest(".pickable");
  if (!c || shown) return;
  const it = p.members.find(m => m.it.id === c.dataset.q).it, st = stOf(it.id), n = c.dataset.n, multi = answersOf(it).length > 1;
  if (st.chosen.includes(n)) st.chosen = st.chosen.filter(x => x !== n);
  else st.chosen = multi ? [...st.chosen, n] : [n];
  saveSes(); showReview(false);
});
$("reviewView").addEventListener("keydown", e => {
  if (e.target.id === "tagIn" && e.key === "Enter" && !e.isComposing) { e.preventDefault(); addTagFromInput(pageCache.p); }
  else if (e.target.classList && e.target.classList.contains("pickable") && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); e.target.click(); }
});
function addTagFromInput(p) {
  const v = $("tagIn").value.trim().replace(/^#/, "");
  if (v) setTags(p, [...tagsOfPage(p), v]);
}
// その問題（連問は全部の小問）のタグを、この内容にする
function setTags(p, tags) {
  const now = new Date().toISOString(), uniq = [...new Set(tags)];
  for (const m of p.members) {
    local.ops = local.ops.filter(o => !(o.op === "tags" && o.qid === m.it.id)); // 同じ問題のタグは最後の1つだけ残す
    local.ops.push({ key: dev() + ":tags:" + m.it.id + ":" + now, qid: m.it.id, op: "tags", tags: uniq, at: now });
  }
  persistLocal();
  showReview(false);
}
function addOps(qids, op) {
  const now = new Date().toISOString();
  for (const qid of qids) local.ops.push({ key: dev() + ":" + op + ":" + qid + ":" + now, qid, op, at: now });
  persistLocal();
}
// 解いた記録（このセッションのこの問題は1件。判定を変えたら上書き）
// ×・△で苦手の日数に達したら知らせる（Anki のリーチの知らせと同じ）。判定を○に戻せば、苦手からも外れる（記録から計算し直すため）
const leechOf = qid => { const x = allItems().find(i => i.id === qid); return x ? QB.derive(x) : null; };
function recordAttempt(it, st) {
  const was = leechOf(it.id);
  const key = dev() + ":" + ses.id + ":" + it.id;
  const ans = answersOf(it), chosen = st.chosen;
  const result = !chosen.length || !ans.length ? null : ans.length === chosen.length && ans.every(n => chosen.includes(n)) ? "正解" : "不正解";
  const ex = local.attempts.find(t => t.key === key);
  if (ex) Object.assign(ex, { judge: st.judge, chosen: chosen.join(","), result });
  else local.attempts.push({ qid: it.id, key, at: new Date().toISOString(), judge: st.judge, src: dev(), chosen: chosen.join(","), result });
  const now = leechOf(it.id);
  if (now && now.leech && !(was && was.leech)) toast(`${it.label}：×・△が${now.missDays}日目です。定着しにくい問題として「苦手」に入れました`);
  persistLocal();
}
let syncSoon = 0;
function persistLocal() {
  local.dirty = true;
  kvSet({ local }).catch(e => toast("記録を保存できませんでした（" + (e && e.message || e) + "）"));
  clearTimeout(syncSoon); syncSoon = setTimeout(() => sync(true), 20000); // 解いたら20秒後に送る（続けて解いている間はまとめる）
}

// ---- 読み込み・書き出し ----
let toastTimer = 0;
function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4000); }

async function importData(obj) {
  if (!obj || obj.kind !== "qb-mobile-data") throw new Error("iPad用データのファイルではありません");
  // PCに入った記録（同じ key・同じ判定が問題データにある）は端末の記録から外す。まだのもの・判定を変えたものは残す
  const known = new Map();
  for (const st of [obj.items, obj.examItems]) for (const it of Object.values(st || {})) for (const t of it.attempts || []) known.set(t.key, t.judge);
  const byId = id => (obj.items || {})[id] || (obj.examItems || {})[id];
  const ids = new Set([...Object.keys(obj.items || {}), ...Object.keys(obj.examItems || {})]);
  const keep = local.attempts.filter(t => known.get(t.key) !== t.judge);
  const lost = keep.filter(t => !ids.has(t.qid)).length;
  // 操作も、PCに入ったもの（当てても変わらない）は外す。問題が無くなったものも外す
  const ops = (local.ops || []).filter(o => { const it = byId(o.qid); if (!it) return false; const a = QB.applyOps(it, [o]); return a === null || JSON.stringify(a) !== JSON.stringify(it); });
  data = { exportedAt: obj.exportedAt, importedAt: new Date().toISOString(), items: obj.items || {}, examItems: obj.examItems || {} };
  if (obj.images) images = obj.images; // 同期の data.json には画像が入らない（images/ から別に受け取る）
  const keys = new Set([...keep.map(t => t.key), ...ops.map(o => o.key)]);
  local = { ...local, attempts: keep, ops, exported: local.exported.filter(k => keys.has(k)) };
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
  const name = `QB記録_${dev()}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.json`;
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
  toast("書き出しました。PCの拡張機能の設定画面で「読み込み」からこのファイルを選んでください");
  render();
};

// ---- 同期（GitHub の非公開リポジトリ）----
// gh：{token, repo, device, lastAt, lastError}（端末の中だけに保存）
let gh = {}, syncing = false;
const b64 = text => { const b = new TextEncoder().encode(text); let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
async function ghApi(path, opts = {}) {
  const r = await fetch(`https://api.github.com/repos/${gh.repo}/contents/${path}`, { ...opts, cache: "no-store",
    headers: { Authorization: "Bearer " + gh.token, Accept: opts.raw ? "application/vnd.github.raw+json" : "application/vnd.github+json", ...(opts.headers || {}) } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(r.status === 401 ? "合鍵（トークン）が違うか期限切れです" : r.status === 403 ? "合鍵にこのリポジトリの読み書きの許可がありません" : "GitHub " + r.status);
  return opts.raw ? r : r.json();
}
const blobToDataUrl = b => new Promise((ok, no) => { const fr = new FileReader(); fr.onload = () => ok(fr.result); fr.onerror = () => no(fr.error); fr.readAsDataURL(b); });
const inPractice = () => !$("reviewView").hidden;
async function sync(quiet) {
  if (syncing) return;
  if (!gh.token || !gh.repo) { if (!quiet) { $("syncSet").open = true; toast("先に「同期の設定」で合鍵を保存してください"); } return; }
  if (navigator.onLine === false) { if (!quiet) toast("オフラインのため同期できません（解いた記録は端末に残っています）"); return; }
  syncing = true; if (!inPractice()) render();
  try {
    // 1. この端末の記録と操作を送る（端末ごとに1ファイル。PCに入った分は、次に問題を受け取ったとき端末から外れる）
    let sent = 0;
    const path = "records/" + gh.device + ".json", sig = sigOf();
    if (sig !== local.sentSig) {
      const cur = await ghApi(path);
      await ghApi(path, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
        message: "記録 " + gh.device, ...(cur && cur.sha ? { sha: cur.sha } : {}),
        content: b64(JSON.stringify({ device: gh.device, updatedAt: new Date().toISOString(), attempts: local.attempts, ops: local.ops })) }) });
      const ex = new Set(local.exported); sent = local.attempts.filter(t => !ex.has(t.key)).length + local.ops.filter(o => !ex.has(o.key)).length;
      local.exported = [...local.attempts.map(t => t.key), ...local.ops.map(o => o.key)];
      local.sentSig = sig; local.dirty = false;
      await kvSet({ local });
    }
    // 2. 最新の問題を受け取る
    let got = 0;
    const r = await ghApi("data.json", { raw: true });
    if (r) {
      const obj = await r.json();
      if (obj.exportedAt !== data.exportedAt) got = (await importData(obj)).n;
    }
    // 3. ほかの端末の記録を受け取る（PCがまだまとめていない分も、すぐ見えるように）
    const list = await ghApi("records");
    if (Array.isArray(list)) {
      const names = new Set();
      for (const f of list.filter(f => f.type === "file" && f.name.endsWith(".json") && f.name !== gh.device + ".json")) {
        names.add(f.name);
        if (others[f.name] && others[f.name].sha === f.sha) continue;
        const o = await (await ghApi("records/" + f.name, { raw: true })).json();
        others[f.name] = { sha: f.sha, attempts: o.attempts || [], ops: o.ops || [] };
      }
      for (const k of Object.keys(others)) if (!names.has(k)) delete others[k];
      await kvSet({ others });
    }
    // 4. まだ端末に無い画像を受け取る（問題の画像と解説の画像）
    let imgs = 0;
    for (const it of allItems()) for (const u of [...(it.images || []), ...(it.expImages || [])]) {
      if (images[u]) continue;
      const ir = await ghApi("images/" + u.split("/").pop(), { raw: true });
      if (!ir) continue; // PCがまだ置いていない
      images[u] = await blobToDataUrl(await ir.blob()); imgs++;
    }
    if (imgs) await kvSet({ images });
    gh.lastAt = Date.now(); gh.lastError = "";
    if (!quiet || sent || got) toast("同期しました" + (got ? `（最新の問題を受け取りました：${got}問` : "（問題は最新") + (sent ? `・記録${sent}件を送信）` : "）") + (imgs ? ` 画像${imgs}枚` : ""));
  } catch (e) {
    gh.lastAt = Date.now(); gh.lastError = String(e && e.message || e);
    if (!quiet) toast("同期できませんでした：" + gh.lastError);
  } finally {
    syncing = false;
    try { await kvSet({ gh }); } catch (e) {}
    if (!inPractice()) render();
  }
}
$("syncBtn").onclick = () => sync(false);

// ---- QBから取り込み（PCのEdgeで拡張機能が入っているときだけ。拡張機能の notebridge.js が取り次ぐ）----
// iPad・スマホで解いた分は、拡張機能が3時間ごとにQBのサーバーから読む。これを今すぐ行う。
// 流れ：取り込み → 拡張機能が data.json を置く → アプリが同期して受け取る
let catchupReq = 0; // 押した時刻（待っていないときは0）
const extPost = m => window.postMessage({ qbApp: true, ...m }, location.origin);
function onExtStatus(c, g) {
  const btn = $("catchupBtn"), line = $("catchupLine");
  btn.hidden = line.hidden = false;
  line.textContent = c.running ? "QBから取り込み中…（1〜2分）"
    : c.finishedAt ? "QBからの取り込み：" + new Date(c.finishedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      + (c.error ? "（失敗：" + c.error + "）" : `（${c.recorded || 0}件）`) + "　自動は3時間ごと" : "";
  if (catchupReq && Date.now() - catchupReq > 16 * 60 * 1000) catchupReq = 0; // 時間切れ
  btn.disabled = !!(c.running || catchupReq);
  if (!catchupReq || c.running || !(c.finishedAt >= catchupReq)) return;
  if (c.error) { catchupReq = 0; btn.disabled = false; toast("取り込めませんでした：" + c.error); return; }
  if (!c.recorded) { catchupReq = 0; btn.disabled = false; toast("QBに新しい解答はありませんでした"); return; }
  if (!(g.at >= c.finishedAt)) { line.textContent = `QBから${c.recorded}件取り込みました。アプリへ送っています…`; return; }
  // 送るのに失敗したとき：拡張機能が1分後にやり直すので、そのまま待つ（次の状態の知らせでもう一度ここに来る）
  if (g.ok === false) { line.textContent = `QBから${c.recorded}件取り込みました。アプリへの送信に失敗（${g.error}）。1分後にやり直します…`; return; }
  catchupReq = 0; btn.disabled = false;
  const go = () => syncing ? setTimeout(go, 2000) : sync(false);
  go();
}
window.addEventListener("message", e => {
  const m = e.data;
  if (e.source !== window || !m || m.qbExt !== true) return;
  if (m.type === "ready") extPost({ type: "hello" });
  else if (m.type === "status") onExtStatus(m.catchup || {}, m.gh || {});
  else if (m.type === "catchupStarted" && !m.ok && m.reason !== "実行中") { catchupReq = 0; $("catchupBtn").disabled = false; toast("取り込みを始められませんでした：" + (m.reason || "")); }
});
extPost({ type: "hello" });
$("catchupBtn").onclick = () => { catchupReq = Date.now(); $("catchupBtn").disabled = true; toast("QBから取り込みます（1〜2分）。終わったら自動で同期します"); extPost({ type: "catchup" }); };
$("ghSave").onclick = async () => {
  const token = $("ghToken").value.trim() || gh.token, repo = $("ghRepo").value.trim();
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast("リポジトリ（ユーザー名/名前）と合鍵を入れてください"); return; }
  gh = { ...gh, token, repo };
  await kvSet({ gh });
  $("ghToken").value = ""; $("syncSet").open = false;
  sync(false);
};
function showGhForm() {
  $("ghRepo").value = gh.repo || "mtw6ygb4p7-netizen/qb-note-data";
  $("ghToken").placeholder = gh.token ? "合鍵は保存済み（変えるときだけ貼り付け）" : "合鍵（トークン）を貼り付け";
}

// ---- 操作 ----
$("tabs").onclick = $("tabs2").onclick = e => { const t = e.target.closest("button"); if (t && t.dataset.tab) setTab(t.dataset.tab); };
$("tagBar").onclick = e => { const b = e.target.closest("[data-tag]"); if (b) { curTag = b.dataset.tag; lsSet("qb_tag", curTag); render(); } };
$("sort").onchange = render;
$("list").addEventListener("toggle", e => {
  const g = e.target;
  if (!g.classList || !g.classList.contains("grp")) return;
  if (g.open) openGroups.add(g.dataset.gk); else openGroups.delete(g.dataset.gk);
  lsSet("qb_open_groups", [...openGroups]);
}, true);
$("list").addEventListener("click", e => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const key = b.closest(".item").dataset.key, members = view().byKey.get(key) || [];
  if (b.dataset.act === "del") {
    if (!confirm("この問題を記録から削除しますか？（このあとQBでまた間違えると、もう一度登録されます）")) return;
    addOps(members.map(m => m.it.id), "delete");
  } else if (b.dataset.act === "unleech") {
    if (!confirm(`「苦手」から外しますか？（今日までの間違いは数えなくなります。また${QB.LEECH}日間違えると苦手に戻ります）`)) return;
    addOps(members.filter(m => m.d.leech).map(m => m.it.id), "unleech");
  } else if (b.dataset.act === "back") {
    addOps(members.filter(m => m.d.cleared).map(m => m.it.id), "reset");
  }
  render();
});
$("openAll").onclick = () => document.querySelectorAll("#list details.grp").forEach(g => { g.open = true; });
$("closeAll").onclick = () => document.querySelectorAll("#list details.grp").forEach(g => { g.open = false; });
$("dueTab").onclick = () => setTab("due");
$("reviewTab").onclick = () => setTab("review");
// いま表示している一覧を1問ずつ（解き直して○でも、今日の復習の記録は今日のいちばん悪い評価のまま）
$("start").onclick = startSession;
addEventListener("online", () => { if (!inPractice()) render(); sync(true); });
addEventListener("offline", () => { if (!inPractice()) render(); });
// 日をまたいで開きっぱなしでも、今日の分を出し直す。画面に戻ったら同期する
let lastDay = today();
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (today() !== lastDay) { lastDay = today(); if (!inPractice()) render(); }
  sync(true);
});
setInterval(() => { if (!document.hidden) sync(true); }, 3 * 60 * 1000); // 開いている間は3分ごとに同期

// ---- 起動 ----
(async () => {
  try {
    const [d, im, lc, ot] = await Promise.all([kvGet("data"), kvGet("images"), kvGet("local"), kvGet("others")]);
    if (d) data = d;
    if (im) images = im;
    if (lc) local = { attempts: lc.attempts || [], ops: lc.ops || [], exported: lc.exported || [], sentSig: lc.sentSig, dirty: lc.dirty };
    if (ot) others = ot;
    gh = (await kvGet("gh")) || {};
    if (!gh.device) { // 端末ごとの名前（記録のファイル名になる）
      const ua = navigator.userAgent;
      gh.device = (/iPad|Macintosh/.test(ua) && navigator.maxTouchPoints > 1 ? "ipad" : /iPhone/.test(ua) ? "iphone" : /Windows|Macintosh|Linux x86/.test(ua) ? "pc" : "web")
        + "-" + Math.random().toString(36).slice(2, 8);
      await kvSet({ gh });
    }
  } catch (e) { toast("端末の保存領域を開けませんでした（" + (e && e.message || e) + "）"); }
  ready = true;
  showGhForm();
  if (ses && ses.open) openSession(); else render(); // 解いている途中で閉じたなら、その問題から
  sync(true); // 開いたら、つながっていれば自動で同期する
  // 端末の保存を消されにくくする（ホーム画面に置いたアプリは通常消されない）
  try { if (navigator.storage && navigator.storage.persist) await navigator.storage.persist(); } catch (e) {}
})();
render();
if ("serviceWorker" in navigator) {
  // 新しい版が入ったら、1回だけ開き直して新しい版にする（解いている途中なら、一覧に戻ったときに。途中の状態は残る）
  const hadController = !!navigator.serviceWorker.controller;
  let reloaded = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController || reloaded) return;
    const goReload = () => { if (!reloaded) { reloaded = true; location.reload(); } };
    window.__swChanged = true;
    if (!inPractice()) goReload(); else toast("新しい版があります。一覧に戻ると入れ替わります");
  });
  navigator.serviceWorker.register("sw.js").then(r => r.update()).catch(() => {});
}
