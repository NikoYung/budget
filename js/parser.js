// Разбор текста со скриншота списка операций. Без привязки к конкретному банку:
// строки дат задают день, строки с суммой дают операцию, название берётся рядом.
import { MONTHS_GEN, pad2, toISODate } from './logic.js';

const MONTH_STEMS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// Цифры с разделителем тысяч, копейки, валюта. ₽ OCR часто читает как Р/P/р/Е.
const CURRENCY = '(?:₽|руб\\.?|р\\.|[РPрpЕE](?![а-яa-z]))';
const AMOUNT_RE = new RegExp(`([+\\-−–—]\\s?)?(\\d{1,3}(?:[ \\u00a0]\\d{3})+|\\d+)(?:[.,](\\d{2}))?\\s?(${CURRENCY})?\\s*$`, 'i');

const SKIP_RE = /(баланс|остаток|доступно|всего|итого|траты за|расходы за|доходы за|потрачено|операции|история|кредитн[а-яё]* лимит|на счет|кешбэк за|показать|фильтр|поиск)/i;
// Счёт без знака — это баланс на главном экране банка, а не операция.
const ACCOUNT_RE = /(счет|счёт|счета|карта|карты|вклад|копилк|накопительн)/i;
const OWN_TRANSFER_RE = /(между сво|между счет|между счёт|своих счет|своих счёт|на накопительн|с накопительн|на вклад|со вклада|с вклада|копилк|на свой счет|на свой счёт)/i;
const INCOME_RE = /(пополнени|зачислени|перевод от|входящ|зарплат|кешб[эе]к|кэшб[эе]к|возврат|от\s+[А-ЯЁ][а-яё]+\s+[А-ЯЁ]\.)/i;
const BANK_HINT_RE = /^(супермаркеты?|рестораны?|кафе|фастфуд|транспорт|такси|топливо|азс|аптеки?|здоровье|одежда|маркетплейсы?|развлечения|кино|связь|жкх|переводы?|пополнения?|супермаркет|различные товары|красота|дом и ремонт|образование|путешествия|другое|остальное|прочее|снятие наличных)(?![а-яё])/i;

function monthIndex(word) {
  const w = word.toLowerCase();
  const full = MONTHS_GEN.findIndex((m) => m === w);
  if (full >= 0) return full;
  return MONTH_STEMS.findIndex((s) => w.startsWith(s));
}

/** Год берём текущий; если дата оказалась в будущем — это прошлый год. */
function isoFrom(day, month, year, now) {
  let y = year ?? now.getFullYear();
  if (year == null && new Date(y, month, day) > now) y -= 1;
  const d = new Date(y, month, day);
  if (d.getMonth() !== month || d.getDate() !== day) return null;
  return `${y}-${pad2(month + 1)}-${pad2(day)}`;
}

/** Если строка — заголовок дня, вернёт ISO-дату, иначе null. */
export function parseDateLine(line, now = new Date()) {
  const s = line.trim();
  // \b в JS не видит кириллицу, поэтому границу слова задаём явно.
  if (/^сегодня(?![а-яё])/i.test(s)) return toISODate(now);
  if (/^вчера(?![а-яё])/i.test(s)) return toISODate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s+\d{1,2}:\d{2})?$/);
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return isoFrom(+m[1], +m[2] - 1, y, now);
  }
  m = s.match(/^(?:[а-яё]+,?\s+)?(\d{1,2})\s+([а-яё]{3,9})\.?(?:\s+(\d{4}))?(?:\s*г\.?)?(?:[,\s]+[а-яё]+)?$/i);
  if (m) {
    const month = monthIndex(m[2]);
    if (month >= 0) return isoFrom(+m[1], month, m[3] ? +m[3] : null, now);
  }
  return null;
}

/** Выделяет сумму в конце строки. null, если суммы нет или это время, год и т. п. */
export function parseAmountTail(line) {
  const s = line.trim();
  const m = s.match(AMOUNT_RE);
  if (!m) return null;
  const [, signRaw, wholeRaw, kopRaw, cur] = m;
  // Голое число без валюты и копеек — не сумма (время, номер карты, количество).
  if (!cur && !kopRaw) return null;
  const whole = wholeRaw.replace(/[\s ]/g, '');
  const before = s.slice(0, m.index).trim();
  if (/\d$/.test(before) && !signRaw) return null; // хвост длинного номера
  if (/[:]$/.test(before)) return null;
  const amount = Number(whole) * 100 + Number(kopRaw || 0);
  if (!amount) return null;
  return { amount, sign: signRaw ? (signRaw.trim() === '+' ? 1 : -1) : 0, hasCurrency: !!cur, text: before };
}

const clean = (s) =>
  s
    .replace(/[|¦_©®*•·]+/g, ' ')
    .replace(/^[^0-9A-Za-zА-Яа-яЁё+\-−–—]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/^[^\s\d]\s(?=[А-ЯЁA-Z])/, '') // круглая иконка банка читается как «O» перед названием
    .trim();

const isNoise = (s) => s.length < 3 || !/[A-Za-zА-Яа-яЁё]{2}/.test(s) || /^\d{1,2}:\d{2}/.test(s);

/**
 * @param lines строки OCR: строка или { text, conf }
 * @param startDate день, которым закончился предыдущий скриншот: строки до первого заголовка относятся к нему
 * @returns операции { date, amount, type, merchant, bankHint, doubts: string[] }; date пустая, если дня не нашлось
 */
export function parseStatement(lines, now = new Date(), startDate = null) {
  const items = lines
    .map((l) => (typeof l === 'string' ? { text: clean(l), conf: 100 } : { text: clean(l.text), conf: l.conf ?? 100 }))
    .filter((l) => l.text);

  const ops = [];
  let date = startDate;
  let dateIsCarried = true; // дата ещё не подтверждена заголовком на этом скриншоте
  let pendingName = null; // последняя строка текста, ещё не ставшая названием

  items.forEach((item, i) => {
    const { text, conf } = item;

    const d = parseDateLine(text, now);
    if (d) {
      date = d;
      dateIsCarried = false;
      pendingName = null;
      return;
    }

    const parsed = parseAmountTail(text);
    if (!parsed) {
      if (!SKIP_RE.test(text) && !isNoise(text)) pendingName = text;
      else if (SKIP_RE.test(text)) pendingName = null;
      return;
    }
    if (SKIP_RE.test(text) || (!parsed.sign && ACCOUNT_RE.test(text))) {
      pendingName = null;
      return;
    }

    let merchant = parsed.text;
    let bankHint = '';
    const onlyHintOnLine = BANK_HINT_RE.test(merchant);
    if (onlyHintOnLine && pendingName) {
      bankHint = merchant; // «Пятёрочка» / «Супермаркеты  −500 ₽»
      merchant = pendingName;
    } else if (!merchant || isNoise(merchant)) {
      merchant = pendingName || '';
    }
    pendingName = null;

    const next = items[i + 1]?.text || '';
    if (!bankHint && BANK_HINT_RE.test(next) && !parseAmountTail(next)) bankHint = next;

    if (!merchant && !parsed.sign && !parsed.hasCurrency) return; // одинокое число — не операция

    const doubts = [];
    const lineConf = Math.min(conf, items[i - 1]?.conf ?? 100);
    if (conf < 75) doubts.push('сумма');
    else if (lineConf < 60) doubts.push('название');
    if (!date || dateIsCarried) doubts.push('дата');
    if (!merchant) doubts.push('название');

    const label = `${merchant} ${bankHint}`;
    const isIncome = parsed.sign > 0 || (parsed.sign === 0 && INCOME_RE.test(label));
    const isOwn = OWN_TRANSFER_RE.test(label);

    ops.push({
      date: date || '',
      amount: parsed.amount,
      type: isOwn ? (isIncome ? 'transferIn' : 'transferOut') : isIncome ? 'income' : 'expense',
      signed: parsed.sign !== 0,
      merchant,
      bankHint,
      doubts: [...new Set(doubts)],
    });
  });
  // Если почти все суммы со знаком, строка без знака подозрительна.
  const signed = ops.filter((o) => o.signed).length;
  if (signed * 2 > ops.length) {
    for (const o of ops) if (!o.signed) o.doubts.push('доход или расход');
  }
  return ops;
}
