// 記録ルール（content.js と review.js で共有）
// QBの分野別（問題画面の「掲載頁：QB2027 C-3」の C が分野の記号）
const QB_SUBJECTS = {
  "医": "基礎医学", "基": "基礎看護学", "成": "成人看護学総論",
  A: "消化管疾患", B: "肝・胆・膵疾患", C: "循環器疾患", D: "内分泌・代謝疾患", E: "腎・泌尿器疾患",
  F: "免疫・アレルギー／膠原病", G: "血液・造血器疾患", H: "感染症", I: "呼吸器疾患", J: "脳・神経疾患",
  K: "運動器疾患", L: "眼疾患", M: "耳鼻咽喉疾患", N: "歯・口腔疾患", O: "皮膚疾患", P: "女性生殖器疾患",
  "老": "老年看護学", "小": "小児看護学", "母": "母性看護学", "精": "精神看護学",
  "在": "地域・在宅看護論", "統": "看護の統合と実践", "社": "健康支援と社会保障制度",
};
const QB_SUBJECT_ORDER = Object.keys(QB_SUBJECTS);

const QB = {
  KEY: "qb_items",
  KEY_EXAM: "qb_items_exam", // 回数別（年度別）から解いた問題のうち、科目別にないもの
  // 分野の記号 → 「C 循環器疾患」の形。不明なら「未分類」
  subjectLabel: (code) => (QB_SUBJECTS[code] ? code + " " + QB_SUBJECTS[code] : "未分類"),
  isMiss: (j) => j === "×" || j === "△",
  isCorrect: (j) => j === "○" || j === "◎",
  // 復習の予定（はしご・間違い回数・苦手）に数える記録か。アプリの臨時の演習（科目別などの見出しから・総復習以外の「1問ずつ解く」）は
  // free: true で、履歴に残すだけで数えない（2026-11-10〜。数えるのはQBで解いた記録と、アプリの「総復習を始める」から解いた記録）
  counts: (t) => !(t && t.free),

  // ---- 出す日（はしご）：1日→3日→7日→14日→30日→克服 ----
  // 1日1回として数え、その日のいちばん悪い評価を使う（最初が○でも後で×なら×）。×＝一番下（翌日）、△＝2段下がる、○＝1段上、◎＝2段上。
  // 出す日より前に解いて正解したときは、段も出す日も変えない（間違えたときは数える）。
  LADDER: [1, 3, 7, 14, 30],
  EXAM_DATE: "2027-02-14", // 国家試験の日（要確認）。この3日前より後には出さない
  EXAM_MARGIN: 3,
  LEECH: 3, // 苦手にする「×・△にした日数」（Anki のリーチのしきい値。Anki は8回だが、国試まで短いので3日）
  dayKey(iso) {
    const d = new Date(iso);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  },
  addDays(day, n) {
    const d = new Date(day + "T00:00:00");
    d.setDate(d.getDate() + n);
    return QB.dayKey(d.toISOString());
  },
  diffDays: (a, b) => Math.round((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 86400000),
  // 評価の良さ（小さいほど悪い）
  RANK: { "×": 0, "△": 1, "○": 2, "◎": 3 },
  // 日ごとのいちばん悪い自己評価 [{day, judge}]（日付の古い順）
  firstOfDays(attempts) {
    const map = new Map();
    for (const t of attempts) {
      if (!QB.isMiss(t.judge) && !QB.isCorrect(t.judge)) continue;
      const day = QB.dayKey(t.at);
      if (!map.has(day) || QB.RANK[t.judge] < QB.RANK[map.get(day)]) map.set(day, t.judge);
    }
    return [...map].map(([day, judge]) => ({ day, judge }));
  },
  schedule(days) {
    let step = -1, due = null;
    const cap = QB.addDays(QB.EXAM_DATE, -QB.EXAM_MARGIN);
    for (const { day, judge } of days) {
      const early = due && day < due;
      if (judge === "×") step = 0;
      else if (judge === "△") step = Math.max(0, step - 2);
      else if (early) continue;
      else step += judge === "◎" ? 2 : 1;
      if (step >= QB.LADDER.length) { step = QB.LADDER.length; due = null; continue; } // 克服
      due = QB.addDays(day, QB.LADDER[step]);
      if (due > cap && day < cap) due = cap;
    }
    return { step, due, cleared: step >= QB.LADDER.length };
  },

  // attempts（解いた記録）から、間違い回数・段・出す日・状態を毎回計算し直す
  derive(item, today = QB.dayKey(new Date().toISOString())) {
    const attempts = [...item.attempts].sort((a, b) => (a.at < b.at ? -1 : 1));
    const counted = attempts.filter(QB.counts); // 臨時の演習（free）は数えない。attempts（返す方）は履歴の表示用に全部
    let miss = 0, lastMissAt = null, lastMissJudge = null;
    for (const t of counted) {
      if (QB.isMiss(t.judge)) { miss++; lastMissAt = t.at; lastMissJudge = t.judge; }
    }
    const days = QB.firstOfDays(counted);
    const now = QB.schedule(days);
    const before = QB.schedule(days.filter((x) => x.day < today)); // 今日の朝の時点
    const todayFirst = (days.find((x) => x.day === today) || {}).judge || null;
    // 総復習：今朝の時点で出す日が今日以前だった問題（今日×・△にしたものは今日の復習へ）
    // 今日の復習：今日のいちばん悪い評価が×・△の問題（todayFirst は今日のいちばん悪い評価）。解き直して○でも記録は変わらない
    const inToday = !before.cleared && !!before.due && before.due <= today;
    const missToday = !!todayFirst && QB.isMiss(todayFirst);
    const cleared = miss > 0 && now.cleared;
    // 苦手（定着しにくい問題。Anki のリーチと同じ考え方）：×・△にした日数が LEECH 日に達した問題。
    // 同じ日に何回間違えても1日。QBで間違えた日も数える。「苦手から外す」（leechResetAt）より前の日は数えない
    const missDays = days.filter((x) => QB.isMiss(x.judge) && (!item.leechResetAt || x.day > QB.dayKey(item.leechResetAt))).length;
    const leech = missDays >= QB.LEECH;
    return { miss, lastMissAt, lastMissJudge, cleared, attempts, step: now.step, due: now.due, missDays, leech,
             dueBefore: before.due, inToday, missToday, unreviewed: !now.cleared && days.length <= 1, doneToday: !!todayFirst, todayFirst };
  },
  // 「次 11/12（3日後）」の形
  dueText(due, today = QB.dayKey(new Date().toISOString())) {
    if (!due) return "";
    const n = QB.diffDays(due, today);
    const md = Number(due.slice(5, 7)) + "/" + Number(due.slice(8));
    return n < 0 ? `${md}（${-n}日遅れ）` : n === 0 ? `${md}（今日）` : `${md}（${n}日後）`;
  },

  // 連問の小問IDの手直し：「_A093」→「_A93」（以前は画面からの記録だけ0が付き、取り込み分と2つに分かれていた）。
  // まとめるとき、同じ日に画面の記録（何回目の解答かのキー）があれば、取り込みの記録（日付キー :d…）は同じ解答なので外す
  fixSubIds(store) {
    let changed = false;
    for (const id of Object.keys(store)) {
      const m = id.match(/^(.*_[A-Z]+)0+(\d+)$/);
      if (!m) continue;
      const nid = m[1] + m[2];
      const old = store[id];
      const it = { ...old, id: nid, label: String(old.label || "").replace(/([A-Z])0+(\d+)$/, "$1$2"),
                   attempts: (old.attempts || []).map((t) => ({ ...t, key: String(t.key || "").replace(id, nid) })) };
      const merged = store[nid] ? QB.merge(it, store[nid]) : it;
      const screenDays = new Set(merged.attempts.filter((t) => !/:d\d/.test(t.key)).map((t) => QB.dayKey(t.at)));
      merged.attempts = merged.attempts.filter((t) => !/:d\d/.test(t.key) || !screenDays.has(QB.dayKey(t.at)));
      merged.text = it.text || merged.text; // 画面から読んだ問題文を優先
      store[nid] = merged;
      delete store[id];
      changed = true;
    }
    return changed;
  },

  // 同じ問題が両方にあるときは attempts を key でまとめる（読み込み用）
  merge(a, b) {
    const out = { ...a, ...b };
    const map = new Map();
    for (const t of [...(a.attempts || []), ...(b.attempts || [])]) map.set(t.key, t);
    out.attempts = [...map.values()];
    out.firstMissAt = [a.firstMissAt, b.firstMissAt].filter(Boolean).sort()[0] || null;
    return out;
  },

  // 必修の見分け：分野の記号が「必小」「必母」のように「必」で始まる、または国試の回数の問題で午前・午後の1〜25番（例 101A5）
  isRequiredLabel: (label) => {
    const m = String(label || "").match(/^\d{2,3}[AP](\d+)$/);
    return !!m && Number(m[1]) <= 25;
  },
  // 「必小」→ { code: "小", required: true }
  splitSubject: (raw) => (String(raw || "").startsWith("必") ? { code: raw.slice(1), required: true } : { code: raw || "", required: false }),

  // ---- 連問（1つの前文に小問が複数）----
  // 小問のIDは「<親id>_A93」。同じ親の小問は1つのまとまりとして、1ページにまとめて出す
  seriesKey: (it) => it.seriesId || (String(it.id || "").match(/^(.+)_[A-Z]+\d+$/) || [])[1] || it.id,
  isSeries: (it) => !!it.seriesId || /_[A-Z]+\d+$/.test(String(it.id || "")),
  // 「前文\n\n[A93] 小問の文」→ { pre, tag, body }（連問でなければ pre は空）
  splitText(text) {
    const m = String(text || "").match(/^([\s\S]*?)\n\n\[([A-Z]+\d+)\] ([\s\S]*)$/);
    return m ? { pre: m[1], tag: m[2], body: m[3] } : { pre: "", tag: "", body: String(text || "") };
  },
  // 問題の画像と解説の画像。以前の記録（cv が無い）は両方が images に入っているので、
  // 問題文が図・写真などを指していなければ解説の画像とみなす（取り込み時に QB から読み直すと正しく分かれる）
  imagesOf(it) {
    if (it.cv >= 2 || it.expImages) return { q: it.images || [], exp: it.expImages || [] };
    const refers = /図|写真|画像|グラフ|表|心電図|波形|示す|別に示|エックス線|X線|CT|MRI|エコー|超音波/.test(it.text || "");
    return refers ? { q: it.images || [], exp: [] } : { q: [], exp: it.images || [] };
  },

  // ---- 同期の操作（タグ・削除・一覧に戻す）----
  // 端末ごとの記録ファイル（records/<端末>.json）に ops として残し、PCの拡張機能が取り込む。
  // Anki と同じく、項目ごとに「後から変えた方が勝つ」（at の新しい方）。解いた記録（attempts）は key でまとめるだけなので食い違わない。
  //   {key, qid, op: "tags", tags: [..], at}   タグをこの内容にする（tagsAt より新しいときだけ）
  //   {key, qid, op: "reset", at}             at までの○・◎を「−」にして、克服済みから一覧に戻す
  //   {key, qid, op: "delete", at}            削除（at より後にまた解いた記録があれば消さない）
  //   {key, qid, op: "unleech", at}           苦手から外す（at の日までの×・△を苦手の日数に数えない。また LEECH 日間違えると苦手に戻る）
  applyOps(it, ops) {
    let out = it;
    for (const o of [...(ops || [])].sort((a, b) => (a.at < b.at ? -1 : 1))) {
      if (!out) break;
      if (o.op === "tags") {
        if (!out.tagsAt || o.at > out.tagsAt) out = { ...out, tags: [...(o.tags || [])], tagsAt: o.at };
      } else if (o.op === "reset") {
        if ((out.attempts || []).some((t) => t.at <= o.at && QB.isCorrect(t.judge)))
          out = { ...out, attempts: out.attempts.map((t) => (t.at <= o.at && QB.isCorrect(t.judge) ? { ...t, judge: "−" } : t)) };
      } else if (o.op === "unleech") {
        if (!out.leechResetAt || o.at > out.leechResetAt) out = { ...out, leechResetAt: o.at };
      } else if (o.op === "delete") {
        if (!(out.attempts || []).some((t) => t.at > o.at)) out = null;
      }
    }
    return out;
  },

  // 保存済みの記録の手直し（以前はノート画面を開いたときに行っていたもの。今は同期の前に background で行う）
  //  ・「_A093」→「_A93」にまとめ直す／科目別にもある問題は回数別から科目別へ合流
  //  ・科目の記号が無い問題を overrides（{id: 記号}）で補う
  //  ・「必小」→ 科目「小」＋必修の印／科目の無い国試の問題（取り込みで科目別に入った分）は年度別へ
  maintain(items, examItems, overrides = {}) {
    let changed = QB.fixSubIds(items) | QB.fixSubIds(examItems);
    for (const id of Object.keys(examItems)) {
      if (items[id]) { items[id] = QB.merge(examItems[id], items[id]); delete examItems[id]; changed = true; }
    }
    for (const [id, code] of Object.entries(overrides)) {
      if (items[id] && !items[id].subjectCode) { items[id].subjectCode = code; changed = true; }
    }
    for (const store of [items, examItems]) {
      for (const it of Object.values(store)) {
        const sp = QB.splitSubject(it.subjectCode);
        if (sp.required && it.subjectCode !== sp.code) { it.subjectCode = sp.code; changed = true; }
        if (!it.required && (sp.required || QB.isRequiredLabel(it.label))) { it.required = true; changed = true; }
      }
    }
    for (const [id, it] of Object.entries(items)) {
      const no = (String(it.label || "").match(/^(\d{2,3})[AP]\d+$/) || [])[1];
      if (QB_SUBJECTS[it.subjectCode] || !no) continue;
      examItems[id] = examItems[id] ? QB.merge(examItems[id], it) : { ...it, examVersion: it.examVersion || no };
      delete items[id];
      changed = true;
    }
    return !!changed;
  },

  localDate(iso) {
    const d = new Date(iso);
    return d.getFullYear() + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0");
  },
};
