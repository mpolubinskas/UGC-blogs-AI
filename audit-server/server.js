'use strict';

/*
 * Минимальный эндпоинт приёма заявок с формы «Бесплатный аудит».
 * Без внешних зависимостей — только встроенные модули Node.
 *
 *   POST /api/audit               — приём заявки, дописывает строку в CSV
 *   GET  /api/admin/leads.csv     — выгрузка CSV (только с Bearer-токеном)
 *   GET  /api/health              — проверка живости
 *
 * CSV лежит в /data (Docker-том, примонтирован ТОЛЬКО к этому контейнеру).
 * Caddy этот путь не отдаёт — файл нельзя скачать по прямой ссылке.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.DATA_DIR || '/data';
const CSV_PATH = path.join(DATA_DIR, 'leads.csv');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || ''; // напр. https://example.com (пусто = не проверять)
const MAX_BODY = 4 * 1024;                                // 4 КБ на запрос
const RATE_MAX = Number(process.env.RATE_MAX || 5);       // сколько заявок
const RATE_WINDOW_MS = Number(process.env.RATE_WINDOW_MS || 60000); // за окно (по умолчанию 1 мин) с одного IP

// человекочитаемые названия каналов; заодно — белый список допустимых значений
const METHODS = { telegram: 'Telegram', max: 'MAX', email: 'Email', phone: 'Телефон' };
const CSV_HEADER = 'timestamp,website,method,name,contact,ip,user_agent\n';

// --- инициализация хранилища ---
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(CSV_PATH)) fs.writeFileSync(CSV_PATH, CSV_HEADER, { mode: 0o600 });

// --- утилиты ---
// Чистим поле: убираем перевод строк/табы (защита от инъекции новых строк/колонок),
// режем по длине и экранируем формулы (=,+,-,@) — защита от CSV formula injection в Excel.
function sanitizeField(v, maxLen) {
  let s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim();
  if (s.length > maxLen) s = s.slice(0, maxLen);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}
// Оборачиваем в кавычки и экранируем внутренние кавычки — корректный CSV.
function csvCell(s) { return '"' + String(s).replace(/"/g, '""') + '"'; }

function send(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, headers || {}));
  res.end(JSON.stringify(obj));
}

// --- простой rate-limit в памяти ---
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > RATE_MAX;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, arr] of hits) {
    const keep = arr.filter(t => now - t < RATE_WINDOW_MS);
    if (keep.length) hits.set(ip, keep); else hits.delete(ip);
  }
}, RATE_WINDOW_MS).unref();

// Реальный IP клиента: за Caddy он в X-Forwarded-For (левый — исходный).
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // health
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return send(res, 200, { ok: true });
  }

  // защищённая выгрузка CSV
  if (req.method === 'GET' && url.pathname === '/api/admin/leads.csv') {
    const auth = req.headers['authorization'] || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) return send(res, 401, { error: 'unauthorized' });
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="leads.csv"'
    });
    return fs.createReadStream(CSV_PATH).pipe(res);
  }

  // приём заявки
  if (req.method === 'POST' && url.pathname === '/api/audit') {
    if (ALLOWED_ORIGIN) {
      const origin = req.headers['origin'];
      if (origin && origin !== ALLOWED_ORIGIN) return send(res, 403, { error: 'forbidden' });
    }
    const ip = clientIp(req);
    if (rateLimited(ip)) return send(res, 429, { error: 'too_many_requests' });

    let raw = '';
    let aborted = false;
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > MAX_BODY) { aborted = true; req.destroy(); }
    });
    req.on('end', () => {
      if (aborted) return;
      let data;
      try { data = JSON.parse(raw || '{}'); } catch (e) { return send(res, 400, { error: 'bad_json' }); }

      // honeypot: заполнено только ботами — тихо «успех», ничего не пишем
      if (data.hp_field) return send(res, 200, { ok: true });

      const website = sanitizeField(data.website, 200);
      const method = METHODS[data.method] || '';
      const name = sanitizeField(data.name, 100);
      const contact = sanitizeField(data.contact, 200);

      if (!method || !name || !contact) return send(res, 422, { error: 'invalid' });

      const row = [
        new Date().toISOString(),
        website, method, name, contact,
        ip, sanitizeField(req.headers['user-agent'] || '', 300)
      ].map(csvCell).join(',') + '\n';

      // O_APPEND — атомарная дозапись, безопасно при параллельных заявках
      fs.appendFile(CSV_PATH, row, err => {
        if (err) { console.error('append failed:', err.message); return send(res, 500, { error: 'server' }); }
        send(res, 200, { ok: true });
      });
    });
    return;
  }

  send(res, 404, { error: 'not_found' });
});

server.listen(PORT, () => console.log('audit server listening on :' + PORT));
