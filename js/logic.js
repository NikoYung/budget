// Чистая логика без DOM и IndexedDB. Все суммы — целые копейки.

export const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
export const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const pad2 = (n) => String(n).padStart(2, '0');
export const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
export const monthKey = (iso) => iso.slice(0, 7);

export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

export function monthTitle(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_NOM[m - 1]} ${y}`;
}

export function dayTitle(iso, today = toISODate(new Date())) {
  const [y, m, d] = iso.split('-').map(Number);
  const yesterday = toISODate(new Date(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10) - 1));
  if (iso === today) return 'Сегодня';
  if (iso === yesterday) return 'Вчера';
  return `${d} ${MONTHS_GEN[m - 1]}${y === +today.slice(0, 4) ? '' : ' ' + y}`;
}

/** 123450 → "1 234,50 ₽"; круглые суммы без копеек. Минус — типографский. */
export function formatRub(kop, { sign = false } = {}) {
  const abs = Math.abs(Math.round(kop));
  const rub = Math.floor(abs / 100);
  const rest = abs % 100;
  const whole = String(rub).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const body = rest ? `${whole},${pad2(rest)}` : whole;
  const prefix = kop < 0 ? '−' : sign ? '+' : '';
  return `${prefix}${body} ₽`;
}

/** Строка из поля ввода → копейки; null, если это не положительная сумма. */
export function parseMoneyInput(str) {
  const s = String(str).replace(/[\s ₽]/g, '').replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const [r, k = ''] = s.split('.');
  const kop = Number(r) * 100 + Number(k.padEnd(2, '0') || 0);
  return kop > 0 ? kop : null;
}

export const kopToInput = (kop) => (kop % 100 ? (kop / 100).toFixed(2).replace('.', ',') : String(kop / 100));

/** Сводка месяца. Взносы в цели уменьшают «осталось»: эти деньги отложены. */
export function monthSummary(transactions, goals, ym) {
  let income = 0;
  let expense = 0;
  const byCategory = new Map();
  for (const t of transactions) {
    if (monthKey(t.date) !== ym) continue;
    if (t.type === 'income') income += t.amount;
    else {
      expense += t.amount;
      byCategory.set(t.categoryId, (byCategory.get(t.categoryId) || 0) + t.amount);
    }
  }
  let saved = 0;
  for (const g of goals) {
    for (const c of g.contributions || []) if (monthKey(c.date) === ym) saved += c.amount;
  }
  return { income, expense, saved, left: income - expense - saved, byCategory };
}

/** Состояние лимита: ok до 80 %, warn до 100 %, over — превышен. */
export function limitState(spent, limit) {
  const ratio = limit > 0 ? spent / limit : 0;
  return { ratio, state: ratio > 1 ? 'over' : ratio >= 0.8 ? 'warn' : 'ok', left: limit - spent };
}

export const goalSaved = (g) => (g.contributions || []).reduce((s, c) => s + c.amount, 0);

/** Сколько откладывать в месяц, чтобы успеть к сроку; null, если срока нет или цель закрыта. */
export function goalMonthly(goal, today = toISODate(new Date())) {
  const rest = goal.target - goalSaved(goal);
  if (!goal.deadline || rest <= 0) return null;
  const months = (+goal.deadline.slice(0, 4) - +today.slice(0, 4)) * 12 + (+goal.deadline.slice(5, 7) - +today.slice(5, 7));
  return Math.ceil(rest / Math.max(months, 1));
}

/** Нормализация названия магазина для правил и поиска дублей. */
export function merchantKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** Похожи ли названия с поправкой на ошибки распознавания. */
export function similarMerchant(a, b) {
  const x = merchantKey(a);
  const y = merchantKey(b);
  if (!x || !y) return true; // без названия решают дата и сумма
  if (x === y) return true;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length) >= 0.7;
}

const sameOp = (a, b) => a.date === b.date && a.amount === b.amount && a.type === b.type && similarMerchant(a.merchant, b.merchant);

/**
 * Разметка найденных операций перед проверкой.
 * - в базе уже есть такая → dup: 'existing', снята галочка
 * - такая же на ДРУГОМ скриншоте → dup: 'overlap', снята галочка (перекрытие)
 * - такая же на ЭТОМ ЖЕ скриншоте → dup: 'same-shot', галочка стоит: это, скорее всего, две покупки
 */
export function markDuplicates(found, existing) {
  const result = [];
  for (const op of found) {
    const row = { ...op, dup: null, selected: true };
    if (existing.some((e) => sameOp(e, op))) {
      row.dup = 'existing';
      row.selected = false;
    } else {
      const twin = result.find((r) => sameOp(r, op));
      if (twin && twin.shot !== op.shot) {
        row.dup = 'overlap';
        row.selected = false;
      } else if (twin) {
        row.dup = 'same-shot';
        if (!twin.dup) twin.dup = 'same-shot';
      }
    }
    result.push(row);
  }
  return result;
}

/** Категория для магазина: сначала выученные правила, затем подсказка банка, затем ключевые слова. */
export function guessCategory({ merchant, bankHint, type }, categories, rules) {
  const usable = categories.filter((c) => c.type === type && !c.archived);
  const key = merchantKey(merchant);
  if (key && rules[key] && usable.some((c) => c.id === rules[key])) return { id: rules[key], sure: true };
  const hay = `${key} ${merchantKey(bankHint)}`;
  for (const c of usable) {
    if ((c.keywords || []).some((w) => hay.includes(w))) return { id: c.id, sure: true };
  }
  const other = usable.find((c) => c.fallback) || usable[0];
  return { id: other?.id ?? null, sure: false };
}

export function defaultCategories() {
  const c = (id, name, emoji, type, keywords = [], extra = {}) => ({ id, name, emoji, type, keywords, limit: 0, archived: false, ...extra });
  return [
    c('food', 'Продукты', '🛒', 'expense', ['пятерочк', 'перекрест', 'магнит', 'лента', 'вкусвилл', 'ашан', 'дикси', 'окей', 'самокат', 'лавк', 'супермаркет', 'продукт']),
    c('cafe', 'Кафе и доставка', '🍔', 'expense', ['кафе', 'ресторан', 'кофе', 'coffee', 'бургер', 'вкусно и точка', 'kfc', 'rostics', 'ростикс', 'додо', 'доставка еды', 'фастфуд']),
    c('transport', 'Транспорт', '🚇', 'expense', ['метро', 'такси', 'yandex go', 'яндекс go', 'тройка', 'транспорт', 'ржд', 'азс', 'лукойл', 'газпромнефть', 'топливо']),
    c('home', 'Дом и связь', '🏠', 'expense', ['жкх', 'аренда', 'квартплата', 'мтс', 'билайн', 'мегафон', 'теле2', 'интернет', 'связь', 'коммунальн']),
    c('subs', 'Подписки', '📺', 'expense', ['подписк', 'plus', 'кинопоиск', 'ivi', 'okko', 'apple com', 'icloud', 'spotify']),
    c('shopping', 'Покупки', '🛍️', 'expense', ['wildberries', 'вайлдберриз', 'ozon', 'озон', 'одежд', 'маркетплейс', 'dns', 'мвидео', 'эльдорадо']),
    c('health', 'Здоровье', '💊', 'expense', ['аптек', 'клиник', 'стоматолог', 'медицин', 'здоровье']),
    c('fun', 'Развлечения', '🎉', 'expense', ['кино', 'театр', 'концерт', 'развлечен', 'игры', 'steam']),
    c('other', 'Другое', '📦', 'expense', [], { fallback: true }),
    c('salary', 'Зарплата', '💼', 'income', ['зарплат', 'аванс']),
    c('cashback', 'Кешбэк', '🎁', 'income', ['кешбэк', 'кэшбэк', 'cashback', 'бонус', 'процент']),
    c('otherinc', 'Другой доход', '💰', 'income', [], { fallback: true }),
  ];
}

/** Проверка резервной копии перед импортом. Бросает ошибку, если файл не наш. */
export function validateBackup(data) {
  if (!data || data.app !== 'budget' || !Array.isArray(data.transactions) || !Array.isArray(data.categories) || !Array.isArray(data.goals)) {
    throw new Error('Это не резервная копия бюджета');
  }
  const okTx = data.transactions.every((t) => t.id && Number.isInteger(t.amount) && t.amount > 0 && /^\d{4}-\d{2}-\d{2}$/.test(t.date) && (t.type === 'income' || t.type === 'expense'));
  if (!okTx) throw new Error('В файле есть повреждённые операции');
  return data;
}
