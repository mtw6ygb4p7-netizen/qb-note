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

  // ---- 出す日（はしご）：1日→3日→7日→14日→30日→克服 ----
  // 1日1回として数え、その日のいちばん悪い評価を使う（最初が○でも後で×なら×）。×＝一番下（翌日）、△＝2段下がる、○＝1段上、◎＝2段上。
  // 出す日より前に解いて正解したときは、段も出す日も変えない（間違えたときは数える）。
  LADDER: [1, 3, 7, 14, 30],
  EXAM_DATE: "2027-02-14", // 国家試験の日（要確認）。この3日前より後には出さない
  EXAM_MARGIN: 3,
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
    let miss = 0, lastMissAt = null, lastMissJudge = null;
    for (const t of attempts) {
      if (QB.isMiss(t.judge)) { miss++; lastMissAt = t.at; lastMissJudge = t.judge; }
    }
    const days = QB.firstOfDays(attempts);
    const now = QB.schedule(days);
    const before = QB.schedule(days.filter((x) => x.day < today)); // 今日の朝の時点
    const todayFirst = (days.find((x) => x.day === today) || {}).judge || null;
    // 総復習：今朝の時点で出す日が今日以前だった問題（今日×・△にしたものは今日の復習へ）
    // 今日の復習：今日のいちばん悪い評価が×・△の問題（todayFirst は今日のいちばん悪い評価）。解き直して○でも記録は変わらない
    const inToday = !before.cleared && !!before.due && before.due <= today;
    const missToday = !!todayFirst && QB.isMiss(todayFirst);
    const cleared = miss > 0 && now.cleared;
    return { miss, lastMissAt, lastMissJudge, cleared, attempts, step: now.step, due: now.due,
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

  localDate(iso) {
    const d = new Date(iso);
    return d.getFullYear() + "/" + String(d.getMonth() + 1).padStart(2, "0") + "/" + String(d.getDate()).padStart(2, "0");
  },
};
