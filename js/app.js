import * as db from './db.js';
import { recognize } from './ocr.js';
import { parseStatement } from './parser.js';
import {
  uid, toISODate, monthKey, shiftMonth, monthTitle, dayTitle, formatRub, parseMoneyInput, kopToInput,
  monthSummary, limitState, goalSaved, totalSaved, goalMonthly, merchantKey, markDuplicates, guessCategory, validateBackup,
  cardBalance, monthTotals, isTransfer,
} from './logic.js';

const BACKUP_REMIND_DAYS = 30;

const S = {
  tab: 'home',
  month: monthKey(toISODate(new Date())),
  transactions: [],
  categories: [],
  goals: [],
  rules: {},
  anchor: null,
  lastBackup: null,
  query: '',
  historyCat: null,
  sheet: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const today = () => toISODate(new Date());
const catById = (id) => S.categories.find((c) => c.id === id);
const catsOf = (type) => S.categories.filter((c) => c.type === type && !c.archived);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* ---------- Экраны ---------- */

function homeView() {
  const sum = monthSummary(S.transactions, S.goals, S.month);
  const isCurrent = S.month === monthKey(today());
  const limited = S.categories.filter((c) => c.type === 'expense' && c.limit > 0 && !c.archived);
  const spent = [...sum.byCategory.entries()].map(([id, amount]) => ({ cat: catById(id), id, amount })).sort((a, b) => b.amount - a.amount);
  const max = spent[0]?.amount || 1;
  const balance = cardBalance(S.anchor, S.transactions, S.goals);
  const saved = totalSaved(S.goals);
  const daysSinceBackup = S.lastBackup ? (Date.now() - S.lastBackup) / 864e5 : Infinity;

  return `
    ${S.transactions.length && daysSinceBackup > BACKUP_REMIND_DAYS ? `
      <div class="banner"><span>${S.lastBackup ? 'Давно не было резервной копии' : 'Резервной копии ещё нет'}</span><button data-act="export">Сохранить</button></div>` : ''}
    <div class="month-nav">
      <button data-act="month" data-d="-1" aria-label="Предыдущий месяц">‹</button>
      <strong>${monthTitle(S.month)}</strong>
      <button data-act="month" data-d="1" aria-label="Следующий месяц" ${isCurrent ? 'disabled' : ''}>›</button>
    </div>
    <section class="card hero">
      <button class="hero-balance" data-act="balance-edit">
        <span class="label">На карте ✎</span>
        <span class="big ${balance < 0 ? 'neg' : ''}">${balance === null ? 'Указать баланс' : formatRub(balance)}</span>
      </button>
      <div class="note">Отложено ${formatRub(saved)}${balance === null ? '' : ` · всего ${formatRub(balance + saved)}`}</div>
      <div class="stats">
        <div><b>${formatRub(sum.income)}</b><span>Доходы</span></div>
        <div><b>${formatRub(sum.expense)}</b><span>Расходы</span></div>
        <div><b>${formatRub(sum.net, { sign: sum.net > 0 })}</b><span>Итог месяца</span></div>
      </div>
    </section>
    <div class="row-btns">
      <label class="btn primary">📷 Скриншоты<input type="file" accept="image/*" multiple data-change="shots"></label>
      <button class="btn" data-act="add">✏️ Вручную</button>
    </div>
    ${limited.length ? `
      <section class="card">
        <h2 class="section-title">Лимиты</h2>
        ${limited.map((c) => limitRow(c, sum.byCategory.get(c.id) || 0)).join('')}
      </section>` : ''}
    <section class="card">
      <h2 class="section-title">Куда ушли деньги</h2>
      ${spent.length ? spent.map(({ cat, id, amount }) => `
        <button class="meter-row" data-act="cat-history" data-id="${esc(id)}">
          <div class="meter-top"><span class="nm">${esc(cat?.emoji || '❔')} ${esc(cat?.name || 'Без категории')}</span><span class="val">${formatRub(amount)}</span></div>
          <div class="bar"><i style="width:${(amount / max) * 100}%"></i></div>
        </button>`).join('') : '<div class="empty">В этом месяце расходов нет</div>'}
    </section>`;
}

function limitRow(c, spent) {
  const { ratio, state, left } = limitState(spent, c.limit);
  const note = state === 'over' ? `⚠️ Превышен на ${formatRub(-left)}`
    : state === 'warn' ? `⚠️ Почти исчерпан, осталось ${formatRub(left)}`
      : `Осталось ${formatRub(left)}`;
  return `
    <button class="meter-row" data-act="cat-history" data-id="${esc(c.id)}">
      <div class="meter-top"><span class="nm">${esc(c.emoji)} ${esc(c.name)}</span><span class="val">${formatRub(spent)} из ${formatRub(c.limit)}</span></div>
      <div class="bar"><i class="${state}" style="width:${Math.min(ratio, 1) * 100}%"></i></div>
      <div class="note ${state === 'ok' ? '' : state}">${note}</div>
    </button>`;
}

function historyRows() {
  const q = merchantKey(S.query);
  const rows = S.transactions
    .filter((t) => !S.historyCat || t.categoryId === S.historyCat)
    .filter((t) => {
      if (!q) return true;
      const cat = catById(t.categoryId);
      return `${merchantKey(t.merchant)} ${merchantKey(cat?.name)} ${String(t.amount / 100)}`.includes(q);
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
  if (!rows.length) return `<div class="empty">${S.transactions.length ? 'Ничего не найдено' : 'Операций пока нет. Нажми + или загрузи скриншоты из банка.'}</div>`;

  const LIMIT = 300;
  const days = new Map();
  for (const t of rows.slice(0, LIMIT)) (days.get(t.date) || days.set(t.date, []).get(t.date)).push(t);
  return [...days.entries()].map(([date, list]) => {
    const dayExpense = list.reduce((s, t) => s + (t.type === 'expense' ? t.amount : 0), 0);
    return `
      <div>
        <div class="day"><span>${esc(dayTitle(date, today()))}</span>${dayExpense ? `<span>${formatRub(-dayExpense)}</span>` : ''}</div>
        <div class="tx-list">${list.map(txRow).join('')}</div>
      </div>`;
  }).join('') + (rows.length > LIMIT ? `<div class="empty small">Показаны последние ${LIMIT} из ${rows.length}. Уточни поиск.</div>` : '');
}

function txRow(t) {
  const c = catById(t.categoryId);
  const plus = t.type === 'income' || t.type === 'transferIn';
  const label = isTransfer(t) ? 'Перевод себе' : c?.name || 'Без категории';
  return `
    <button class="tx" data-act="edit" data-id="${esc(t.id)}">
      <span class="em">${isTransfer(t) ? '🔁' : esc(c?.emoji || '❔')}</span>
      <span class="mid"><div>${esc(t.merchant || label)}</div><div class="sub">${esc(label)}</div></span>
      <span class="amt ${t.type === 'income' ? 'in' : ''}">${formatRub(plus ? t.amount : -t.amount, { sign: plus })}</span>
    </button>`;
}

function historyView() {
  const cat = S.historyCat && catById(S.historyCat);
  return `
    <h1 class="title">История</h1>
    <input class="search" type="search" placeholder="Поиск по магазину, категории, сумме" value="${esc(S.query)}" data-input="search" aria-label="Поиск">
    ${cat ? `<button class="filter-chip" data-act="clear-cat">${esc(cat.emoji)} ${esc(cat.name)} ✕</button>` : ''}
    <div id="history-list" style="display:flex;flex-direction:column;gap:10px">${historyRows()}</div>`;
}

function goalsView() {
  return `
    <h1 class="title">Цели</h1>
    ${S.goals.length ? S.goals.map((g) => {
      const saved = goalSaved(g);
      const pct = Math.min(saved / g.target, 1) * 100;
      const monthly = goalMonthly(g, today());
      return `
        <section class="card goal">
          <div class="top"><span class="nm">${esc(g.emoji || '🎯')} ${esc(g.name)}</span><span class="small muted">${Math.floor(pct)} %</span></div>
          <div class="bar"><i style="width:${pct}%"></i></div>
          <div class="note">${formatRub(saved)} из ${formatRub(g.target)}${saved >= g.target ? ' — цель достигнута 🎉' : ''}${monthly ? ` · по ${formatRub(monthly)} в месяц до срока` : ''}</div>
          <div class="acts">
            <button class="btn" data-act="goal-add" data-id="${esc(g.id)}">Пополнить</button>
            <button class="btn ghost" data-act="goal-edit" data-id="${esc(g.id)}">Изменить</button>
          </div>
        </section>`;
    }).join('') : '<div class="empty">Целей пока нет</div>'}
    <button class="btn primary" data-act="goal-new">Новая цель</button>`;
}

function moreView() {
  const list = (type) => catsOf(type).map((c) => `
    <button class="list-row" data-act="cat-edit" data-id="${esc(c.id)}">
      <span>${esc(c.emoji)} ${esc(c.name)}</span>
      <span class="muted small">${c.limit ? `лимит ${formatRub(c.limit)}` : ''} ›</span>
    </button>`).join('');
  return `
    <h1 class="title">Ещё</h1>
    <section class="card">
      <h2 class="section-title">Расходы</h2>${list('expense')}
    </section>
    <section class="card">
      <h2 class="section-title">Доходы</h2>${list('income')}
    </section>
    <button class="btn" data-act="cat-new">Новая категория</button>
    <section class="card">
      <h2 class="section-title">Резервная копия</h2>
      <p class="small muted" style="margin-bottom:12px">Данные хранятся только на этом телефоне. Если удалить иконку приложения, они пропадут, поэтому сохраняй копию в «Файлы» или iCloud Drive.${S.lastBackup ? ` Последняя копия: ${esc(dayTitle(toISODate(new Date(S.lastBackup)), today()))}.` : ''}</p>
      <div class="row-btns">
        <button class="btn" data-act="export">Сохранить</button>
        <label class="btn">Восстановить<input type="file" accept=".json,application/json" data-change="restore"></label>
      </div>
    </section>
    <button class="btn danger" data-act="wipe-tx">Удалить все операции</button>
    <p class="small muted" style="text-align:center">Операций: ${S.transactions.length}</p>`;
}

function render() {
  const view = { home: homeView, history: historyView, goals: goalsView, more: moreView }[S.tab]();
  const main = $('#view');
  main.innerHTML = view;
  document.querySelectorAll('#tabs [data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === S.tab));
}

/* ---------- Шторки ---------- */

function openSheet(sheet) {
  S.sheet = sheet;
  renderSheet();
}

function closeSheet() {
  S.sheet = null;
  $('#sheet-root').innerHTML = '';
}

function renderSheet() {
  const s = S.sheet;
  if (!s) return closeSheet();
  const html = { tx: txSheet, goal: goalSheet, goalAdd: goalAddSheet, cat: catSheet, import: importSheet, balance: balanceSheet }[s.kind](s);
  const full = s.kind === 'import';
  $('#sheet-root').innerHTML = `<div class="overlay" data-overlay><div class="sheet ${full ? 'full' : ''}" role="dialog" aria-modal="true">${html}</div></div>`;
}

const head = (title) => `<div class="sheet-head"><h2>${esc(title)}</h2><button class="close" data-act="close" aria-label="Закрыть">✕</button></div>`;

function balanceSheet(s) {
  return `
    ${head('Баланс карты')}
    <input class="input amount" inputmode="decimal" placeholder="0 ₽" value="${esc(s.amount)}" data-input="b-amount" aria-label="Баланс" autocomplete="off">
    <p class="small muted">Введи сумму как в приложении банка, без отложенных денег. Дальше баланс считается от неё. Если разойдётся, просто сверь снова.</p>
    <button class="btn primary" data-act="balance-save">Сохранить</button>`;
}

const TYPE_LABELS = { expense: 'Расход', income: 'Доход', transferOut: 'Перевод себе: списание', transferIn: 'Перевод себе: зачисление' };

function txSheet(s) {
  const f = s.form;
  const cats = catsOf(f.type);
  return `
    ${head(s.id ? 'Операция' : 'Новая операция')}
    ${s.id ? '' : '<label class="btn">📷 Загрузить скриншоты<input type="file" accept="image/*" multiple data-change="shots"></label>'}
    <div class="seg two-rows">
      ${['expense', 'income', 'transferOut', 'transferIn'].map((t) => `<button data-act="tx-type" data-v="${t}" class="${f.type === t ? 'on' : ''}">${t === 'transferOut' ? 'Себе: списание' : t === 'transferIn' ? 'Себе: зачисление' : TYPE_LABELS[t]}</button>`).join('')}
    </div>
    <input class="input amount" id="f-amount" inputmode="decimal" placeholder="0 ₽" value="${esc(f.amount)}" data-input="tx-amount" aria-label="Сумма" autocomplete="off">
    <div class="chips" ${cats.length ? '' : 'hidden'}>
      ${cats.map((c) => `<button class="chip ${f.categoryId === c.id ? 'on' : ''}" data-act="tx-cat" data-id="${esc(c.id)}"><span class="e">${esc(c.emoji)}</span>${esc(c.name)}</button>`).join('')}
    </div>
    <div class="two">
      <label class="field">Название<input class="input" value="${esc(f.merchant)}" data-input="tx-merchant" placeholder="Необязательно"></label>
      <label class="field">Дата<input class="input" type="date" value="${esc(f.date)}" max="${today()}" data-input="tx-date"></label>
    </div>
    <button class="btn primary" data-act="tx-save">Сохранить</button>
    ${s.id ? '<button class="btn danger" data-act="tx-delete">Удалить</button>' : ''}`;
}

function goalSheet(s) {
  const f = s.form;
  return `
    ${head(s.id ? 'Цель' : 'Новая цель')}
    <label class="field">Название<input class="input" value="${esc(f.name)}" data-input="g-name" placeholder="Например, отпуск"></label>
    <div class="two">
      <label class="field">Сумма цели<input class="input" inputmode="decimal" value="${esc(f.target)}" data-input="g-target" placeholder="100 000"></label>
      <label class="field">Срок<input class="input" type="date" value="${esc(f.deadline)}" min="${today()}" data-input="g-deadline"></label>
    </div>
    <label class="field">Уже накоплено<input class="input" inputmode="decimal" value="${esc(f.initial)}" data-input="g-initial" placeholder="0"></label>
    <p class="small muted">Эта сумма не вычитается с карты. Для новых денег используй «Пополнить».</p>
    <button class="btn primary" data-act="goal-save">Сохранить</button>
    ${s.id ? '<button class="btn danger" data-act="goal-delete">Удалить цель</button>' : ''}`;
}

function goalAddSheet(s) {
  const g = S.goals.find((x) => x.id === s.id);
  return `
    ${head(`Пополнить: ${g.name}`)}
    <input class="input amount" id="f-amount" inputmode="decimal" placeholder="0 ₽" data-input="ga-amount" aria-label="Сумма" autocomplete="off">
    <p class="small muted">Сумма спишется с баланса карты и добавится к отложенному.</p>
    <button class="btn primary" data-act="goal-contribute">Отложить</button>`;
}

function catSheet(s) {
  const f = s.form;
  return `
    ${head(s.id ? 'Категория' : 'Новая категория')}
    ${s.id ? '' : `<div class="seg">
      <button data-act="cat-type" data-v="expense" class="${f.type === 'expense' ? 'on' : ''}">Расход</button>
      <button data-act="cat-type" data-v="income" class="${f.type === 'income' ? 'on' : ''}">Доход</button>
    </div>`}
    <div style="display:grid;grid-template-columns:72px 1fr;gap:10px">
      <label class="field">Значок<input class="input" style="text-align:center" value="${esc(f.emoji)}" data-input="c-emoji"></label>
      <label class="field">Название<input class="input" value="${esc(f.name)}" data-input="c-name"></label>
    </div>
    ${f.type === 'expense' ? `<label class="field">Лимит в месяц<input class="input" inputmode="decimal" value="${esc(f.limit)}" data-input="c-limit" placeholder="Без лимита"></label>` : ''}
    <button class="btn primary" data-act="cat-save">Сохранить</button>
    ${s.id && !catById(s.id)?.fallback ? '<button class="btn danger" data-act="cat-delete">Удалить категорию</button>' : ''}`;
}

function importSheet(s) {
  if (s.status === 'work') {
    return `
      ${head('Распознаю')}
      <p>${esc(s.step)}</p>
      <div class="progress"><i id="ocr-bar" style="width:${s.progress * 100}%"></i></div>
      <p class="small muted">Всё считается на телефоне. Первая загрузка требует интернет: нужно скачать модуль распознавания.</p>`;
  }
  const count = s.rows.filter((r) => r.selected).length;
  return `
    ${head('Проверь операции')}
    ${s.rows.length ? `<p class="small muted">Найдено: ${s.rows.length}. Выделенные рамкой стоит проверить внимательнее.</p>` : '<div class="empty">Операций не нашёл. Пришли этот скриншот, и я подстрою разбор под вёрстку банка.</div>'}
    <div id="review-sum">${reviewSummary(s.rows)}</div>
    ${s.rows.map(reviewRow).join('')}
    ${s.rawText ? `<details><summary>Распознанный текст</summary><pre>${esc(s.rawText)}</pre></details>` : ''}
    <div class="sticky-foot"><button class="btn primary" style="width:100%" data-act="import-save" id="import-save" ${count ? '' : 'disabled'}>Добавить: ${count}</button></div>`;
}

function reviewSummary(rows) {
  const parsed = rows.filter((r) => r.selected).map((r) => ({ ...r, amount: parseMoneyInput(r.amountText) }));
  const lines = monthTotals(parsed).map((m) => `<div>${monthTitle(m.ym)}: расходы ${formatRub(m.expense)}, доходы ${formatRub(m.income)}</div>`);
  return lines.length ? `<div class="card small"><b>Сверь с банком</b>${lines.join('')}</div>` : '';
}

const DUP_TEXT = {
  existing: 'Уже есть в бюджете',
  overlap: 'Повтор с другого скриншота',
  'same-shot': 'Две одинаковые: оставить обе?',
};

function reviewRow(r, i) {
  const cats = catsOf(r.type);
  return `
    <div class="review-row ${r.selected ? '' : 'off'} ${r.doubts.length ? 'doubt' : ''}" data-row="${i}">
      <div class="rr-top">
        <input type="checkbox" ${r.selected ? 'checked' : ''} data-change="row-selected" aria-label="Добавить операцию">
        <input class="input" value="${esc(r.merchant)}" placeholder="Название" data-rowfield="merchant" aria-label="Название">
      </div>
      <div class="rr-grid">
        <input class="input" inputmode="decimal" value="${esc(r.amountText)}" data-rowfield="amountText" aria-label="Сумма">
        <input class="input" type="date" value="${esc(r.date)}" data-rowfield="date" aria-label="Дата">
        <select class="input" data-rowfield="type" aria-label="Тип">${Object.entries(TYPE_LABELS).map(([v, l]) => `<option value="${v}" ${r.type === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        ${cats.length ? `<select class="input" data-rowfield="categoryId" aria-label="Категория">${cats.map((c) => `<option value="${esc(c.id)}" ${c.id === r.categoryId ? 'selected' : ''}>${esc(c.emoji)} ${esc(c.name)}</option>`).join('')}</select>` : ''}
      </div>
      ${r.dup ? `<span class="tag">${DUP_TEXT[r.dup]}</span>` : ''}
      ${r.doubts.length ? `<span class="tag">Проверь: ${esc(r.doubts.join(', '))}</span>` : ''}
    </div>`;
}

/* ---------- Импорт скриншотов ---------- */

async function importShots(files) {
  if (!files.length) return;
  const sheet = { kind: 'import', status: 'work', step: 'Готовлю распознавание…', progress: 0, rows: [], rawText: '' };
  openSheet(sheet);
  const found = [];
  const raw = [];
  let carryDate = null;
  try {
    for (let i = 0; i < files.length; i++) {
      sheet.step = `Скриншот ${i + 1} из ${files.length}`;
      sheet.progress = 0;
      if (S.sheet === sheet) renderSheet();
      const { lines, text } = await recognize(files[i], (p) => {
        const bar = $('#ocr-bar');
        if (bar) bar.style.width = `${p * 100}%`;
      });
      if (S.sheet !== sheet) return; // шторку закрыли
      raw.push(text);
      for (const op of parseStatement(lines, new Date(), carryDate)) {
        found.push({ ...op, shot: i });
        if (op.date) carryDate = op.date;
      }
    }
  } catch (e) {
    console.error(e);
    closeSheet();
    toast('Не удалось распознать. Нужен интернет для первого запуска.');
    return;
  }
  sheet.rows = markDuplicates(found, S.transactions).map((r) => {
    const guess = guessCategory(r, S.categories, S.rules);
    return { ...r, selected: r.selected && !!r.date, amountText: kopToInput(r.amount), categoryId: guess.id, autoCategory: guess.id };
  });
  sheet.rawText = raw.join('\n— — —\n');
  sheet.status = 'review';
  renderSheet();
}

async function saveImport() {
  const rows = S.sheet.rows.filter((r) => r.selected);
  const items = [];
  for (const r of rows) {
    const amount = parseMoneyInput(r.amountText);
    if (!amount || !r.date) return toast(`Проверь сумму и дату: ${r.merchant || 'без названия'}`);
    items.push({ id: uid(), type: r.type, amount, categoryId: r.categoryId, date: r.date, merchant: r.merchant.trim(), source: 'screenshot', createdAt: Date.now() });
    const key = merchantKey(r.merchant);
    if (key && r.categoryId) S.rules[key] = r.categoryId;
  }
  await db.putMany('transactions', items);
  await db.setMeta('rules', S.rules);
  S.transactions.push(...items);
  closeSheet();
  render();
  toast(`Добавлено: ${items.length}`);
}

/* ---------- Резервная копия ---------- */

async function exportBackup() {
  const data = { app: 'budget', version: 1, exportedAt: new Date().toISOString(), transactions: S.transactions, categories: S.categories, goals: S.goals, rules: S.rules, anchor: S.anchor };
  const name = `budget-${today()}.json`;
  const file = new File([JSON.stringify(data, null, 1)], name, { type: 'application/json' });
  let saved = true;
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      if (e.name === 'AbortError') saved = false;
      else throw e;
    }
  } else {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  if (saved) {
    S.lastBackup = Date.now();
    await db.setMeta('lastBackup', S.lastBackup);
    render();
    toast('Копия готова');
  }
}

async function restoreBackup(file) {
  try {
    const data = validateBackup(JSON.parse(await file.text()));
    if (!confirm(`Заменить текущие данные копией? Операций в копии: ${data.transactions.length}.`)) return;
    await db.replaceAll(data);
    await loadAll();
    render();
    toast('Данные восстановлены');
  } catch (e) {
    toast(e instanceof SyntaxError ? 'Файл повреждён' : e.message);
  }
}

/* ---------- Действия ---------- */

const actions = {
  tab(el) {
    S.tab = el.dataset.tab;
    if (S.tab !== 'history') S.historyCat = null;
    render();
    $('#view').scrollTop = 0;
  },
  month(el) {
    S.month = shiftMonth(S.month, +el.dataset.d);
    render();
  },
  close: closeSheet,
  'cat-history'(el) {
    S.historyCat = el.dataset.id;
    S.tab = 'history';
    render();
  },
  'clear-cat'() {
    S.historyCat = null;
    render();
  },
  export: exportBackup,

  'balance-edit'() {
    const balance = cardBalance(S.anchor, S.transactions, S.goals);
    openSheet({ kind: 'balance', amount: balance === null ? '' : kopToInput(Math.max(balance, 0)) });
  },
  async 'balance-save'() {
    const amount = S.sheet.amount.trim() === '0' ? 0 : parseMoneyInput(S.sheet.amount);
    if (amount === null) return toast('Введи сумму');
    S.anchor = { amount, date: today(), at: Date.now() };
    await db.setMeta('anchor', S.anchor);
    closeSheet();
    render();
    toast('Баланс сверен');
  },
  async 'wipe-tx'() {
    if (!confirm(`Удалить все операции (${S.transactions.length})? Категории, лимиты и цели останутся. Сначала лучше сохранить копию.`)) return;
    await db.clearTransactions();
    S.transactions = [];
    render();
    toast('Операции удалены');
  },

  add() {
    const type = 'expense';
    openSheet({ kind: 'tx', id: null, form: { type, amount: '', categoryId: catsOf(type)[0]?.id, merchant: '', date: today() } });
  },
  edit(el) {
    const t = S.transactions.find((x) => x.id === el.dataset.id);
    openSheet({ kind: 'tx', id: t.id, form: { type: t.type, amount: kopToInput(t.amount), categoryId: t.categoryId, merchant: t.merchant || '', date: t.date } });
  },
  'tx-type'(el) {
    const f = S.sheet.form;
    f.type = el.dataset.v;
    f.categoryId = catsOf(f.type)[0]?.id;
    renderSheet();
  },
  'tx-cat'(el) {
    S.sheet.form.categoryId = el.dataset.id;
    document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c === el));
  },
  async 'tx-save'() {
    const { id, form: f } = S.sheet;
    const amount = parseMoneyInput(f.amount);
    if (!amount) return toast('Введи сумму');
    if (!f.date) return toast('Укажи дату');
    const old = id && S.transactions.find((t) => t.id === id);
    const item = { ...(old || { id: uid(), source: 'manual', createdAt: Date.now() }), type: f.type, amount, categoryId: f.categoryId, merchant: f.merchant.trim(), date: f.date };
    await db.put('transactions', item);
    S.transactions = [...S.transactions.filter((t) => t.id !== item.id), item];
    const key = merchantKey(item.merchant);
    if (key && item.categoryId && S.rules[key] !== item.categoryId) {
      S.rules[key] = item.categoryId;
      await db.setMeta('rules', S.rules);
    }
    closeSheet();
    render();
    toast('Сохранено');
  },
  async 'tx-delete'() {
    if (!confirm('Удалить операцию?')) return;
    await db.remove('transactions', S.sheet.id);
    S.transactions = S.transactions.filter((t) => t.id !== S.sheet.id);
    closeSheet();
    render();
  },

  'goal-new'() {
    openSheet({ kind: 'goal', id: null, form: { name: '', target: '', deadline: '', initial: '' } });
  },
  'goal-edit'(el) {
    const g = S.goals.find((x) => x.id === el.dataset.id);
    openSheet({ kind: 'goal', id: g.id, form: { name: g.name, target: kopToInput(g.target), deadline: g.deadline || '', initial: goalSaved(g) ? kopToInput(goalSaved(g)) : '' } });
  },
  'goal-add'(el) {
    openSheet({ kind: 'goalAdd', id: el.dataset.id, amount: '' });
  },
  async 'goal-save'() {
    const { id, form: f } = S.sheet;
    const target = parseMoneyInput(f.target);
    if (!f.name.trim()) return toast('Назови цель');
    if (!target) return toast('Введи сумму цели');
    const initial = f.initial.trim() ? parseMoneyInput(f.initial) : 0;
    if (initial === null) return toast('Проверь сумму «Уже накоплено»');
    const old = id && S.goals.find((g) => g.id === id);
    // Правка накопленного заменяет взносы: это сверка, задним числом с карты ничего не списываем.
    const changed = !old || initial !== goalSaved(old);
    const goal = { ...(old || { id: uid(), emoji: '🎯', contributions: [] }), name: f.name.trim(), target, deadline: f.deadline || null };
    if (changed) {
      goal.initial = initial;
      goal.contributions = [];
    }
    await db.put('goals', goal);
    S.goals = [...S.goals.filter((g) => g.id !== goal.id), goal];
    closeSheet();
    render();
  },
  async 'goal-delete'() {
    if (!confirm('Удалить цель вместе с историей пополнений?')) return;
    await db.remove('goals', S.sheet.id);
    S.goals = S.goals.filter((g) => g.id !== S.sheet.id);
    closeSheet();
    render();
  },
  async 'goal-contribute'() {
    const amount = parseMoneyInput(S.sheet.amount);
    if (!amount) return toast('Введи сумму');
    const g = S.goals.find((x) => x.id === S.sheet.id);
    g.contributions = [...(g.contributions || []), { date: today(), amount, at: Date.now() }];
    await db.put('goals', g);
    closeSheet();
    render();
    toast(`Отложено ${formatRub(amount)}`);
  },

  'cat-new'() {
    openSheet({ kind: 'cat', id: null, form: { type: 'expense', emoji: '🏷️', name: '', limit: '' } });
  },
  'cat-edit'(el) {
    const c = catById(el.dataset.id);
    openSheet({ kind: 'cat', id: c.id, form: { type: c.type, emoji: c.emoji, name: c.name, limit: c.limit ? kopToInput(c.limit) : '' } });
  },
  'cat-type'(el) {
    S.sheet.form.type = el.dataset.v;
    renderSheet();
  },
  async 'cat-save'() {
    const { id, form: f } = S.sheet;
    if (!f.name.trim()) return toast('Назови категорию');
    const limit = f.limit.trim() ? parseMoneyInput(f.limit) : 0;
    if (limit === null) return toast('Проверь лимит');
    const old = id && catById(id);
    const cat = { ...(old || { id: uid(), keywords: [], archived: false }), type: f.type, emoji: f.emoji.trim() || '🏷️', name: f.name.trim(), limit: f.type === 'expense' ? limit : 0 };
    await db.put('categories', cat);
    S.categories = [...S.categories.filter((c) => c.id !== cat.id), cat];
    closeSheet();
    render();
  },
  async 'cat-delete'() {
    // Скрываем, а не стираем: старые операции должны сохранить категорию.
    if (!confirm('Убрать категорию? Старые операции останутся с ней.')) return;
    const cat = catById(S.sheet.id);
    cat.archived = true;
    await db.put('categories', cat);
    closeSheet();
    render();
  },
  'import-save': saveImport,
};

const inputs = {
  search(el) {
    S.query = el.value;
    $('#history-list').innerHTML = historyRows();
  },
  'tx-amount': (el) => { S.sheet.form.amount = el.value; },
  'tx-merchant'(el) {
    const f = S.sheet.form;
    f.merchant = el.value;
    if (S.sheet.id) return;
    const key = merchantKey(el.value);
    const rule = S.rules[key];
    if (rule && catById(rule)?.type === f.type) {
      f.categoryId = rule;
      document.querySelectorAll('.chip').forEach((c) => c.classList.toggle('on', c.dataset.id === rule));
    }
  },
  'tx-date': (el) => { S.sheet.form.date = el.value; },
  'g-name': (el) => { S.sheet.form.name = el.value; },
  'g-target': (el) => { S.sheet.form.target = el.value; },
  'g-deadline': (el) => { S.sheet.form.deadline = el.value; },
  'g-initial': (el) => { S.sheet.form.initial = el.value; },
  'b-amount': (el) => { S.sheet.amount = el.value; },
  'ga-amount': (el) => { S.sheet.amount = el.value; },
  'c-emoji': (el) => { S.sheet.form.emoji = el.value; },
  'c-name': (el) => { S.sheet.form.name = el.value; },
  'c-limit': (el) => { S.sheet.form.limit = el.value; },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el) {
    const fn = actions[el.dataset.act];
    Promise.resolve(fn?.(el)).catch((err) => {
      console.error(err);
      toast('Не получилось сохранить. Попробуй ещё раз.');
    });
    return;
  }
  if (e.target.matches('[data-overlay]') && S.sheet?.kind !== 'import') closeSheet();
});

document.addEventListener('input', (e) => {
  const key = e.target.dataset.input;
  if (key) inputs[key]?.(e.target);
  const field = e.target.dataset.rowfield;
  if (field) {
    const row = S.sheet.rows[+e.target.closest('[data-row]').dataset.row];
    row[field] = e.target.value;
    if (field === 'amountText' || field === 'date') $('#review-sum').innerHTML = reviewSummary(S.sheet.rows);
    if (field === 'type') {
      row.categoryId = guessCategory(row, S.categories, S.rules).id;
      const y = $('.sheet').scrollTop;
      renderSheet();
      $('.sheet').scrollTop = y;
    }
  }
});

document.addEventListener('change', (e) => {
  const kind = e.target.dataset.change;
  if (kind === 'shots') {
    const files = [...e.target.files];
    e.target.value = '';
    importShots(files);
  } else if (kind === 'restore') {
    const [file] = e.target.files;
    e.target.value = '';
    if (file) restoreBackup(file);
  } else if (kind === 'row-selected') {
    const box = e.target.closest('[data-row]');
    S.sheet.rows[+box.dataset.row].selected = e.target.checked;
    box.classList.toggle('off', !e.target.checked);
    const count = S.sheet.rows.filter((r) => r.selected).length;
    const btn = $('#import-save');
    btn.textContent = `Добавить: ${count}`;
    btn.disabled = !count;
    $('#review-sum').innerHTML = reviewSummary(S.sheet.rows);
  }
});

/* ---------- Старт ---------- */

async function loadAll() {
  [S.transactions, S.categories, S.goals, S.rules, S.lastBackup, S.anchor] = await Promise.all([
    db.getAll('transactions'), db.getAll('categories'), db.getAll('goals'), db.getMeta('rules').then((r) => r || {}), db.getMeta('lastBackup'), db.getMeta('anchor'),
  ]);
}

async function start() {
  await db.openDB();
  await loadAll();
  render();
  navigator.storage?.persist?.();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(console.error);
}

start().catch((e) => {
  console.error(e);
  $('#view').innerHTML = '<div class="empty">Не удалось открыть хранилище. Закрой приложение и открой снова.</div>';
});
