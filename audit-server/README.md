# Приём заявок с формы «Бесплатный аудит»

Мини-сервис на Node (без внешних зависимостей). Принимает POST от формы на лендинге
и дописывает строку в CSV. CSV хранится в Docker-томе, доступном **только** контейнеру
приложения — Caddy его не отдаёт, скачать по прямой ссылке нельзя.

```
Браузер ──POST /api/audit──► Caddy ──► audit (Node) ──► /data/leads.csv (том)
                              └── / ──► статика geo.html
```

## Что где лежит

| Файл | Назначение |
|------|-----------|
| `audit-server/server.js` | сам эндпоинт |
| `audit-server/Dockerfile` | образ приложения |
| `docker-compose.yml` (в корне) | Caddy + приложение + тома |
| `Caddyfile` (в корне) | HTTPS, роутинг `/api/*` → приложение, статика |
| `.env` (создать из `.env.example`) | домен и секреты |
| `site/` | сюда положить `geo.html` и картинки лендинга |

## Развёртывание на сервере

```bash
# 1. код на сервер (git clone / rsync)
cd project

# 2. секреты
cp .env.example .env
nano .env                       # DOMAIN, ALLOWED_ORIGIN, ADMIN_TOKEN
openssl rand -hex 32            # <- подставить в ADMIN_TOKEN

# 3. статику лендинга — в ./site
mkdir -p site
cp geo.html site/
cp woman_stars.png site/        # и остальные картинки/ассеты, что использует geo.html

# 4. запуск
docker compose up -d --build
docker compose logs -f
```

Caddy сам получит TLS-сертификат Let's Encrypt для `DOMAIN` (нужны открытые порты 80/443
и A-запись домена на сервер).

## Как забрать заявки (CSV)

CSV наружу не отдаётся напрямую. Скачивание — только с `ADMIN_TOKEN`:

```bash
curl -H "Authorization: Bearer ВАШ_ADMIN_TOKEN" \
     https://ВАШ_ДОМЕН/api/admin/leads.csv -o leads.csv
```

Без токена / с чужим токеном — `401`. Токен длинный и случайный, в исходниках сайта
его нет (лежит только в `.env` на сервере). При утечке — сгенерировать новый и
`docker compose up -d`.

Альтернатива — читать файл прямо на сервере, не открывая наружу:

```bash
docker compose exec audit cat /data/leads.csv
```

## Формат CSV

```
timestamp,website,method,name,contact,ip,user_agent
"2026-07-23T10:00:00.000Z","example.com","Telegram","Иван","@ivan","1.2.3.4","Mozilla/5.0 ..."
```

## Что уже защищено

- **CSV вне веб-корня** — Caddy физически не имеет доступа к тому `leads_data`.
- **Токен на выгрузку** — `GET /api/admin/leads.csv` только с `Bearer ADMIN_TOKEN`.
- **Honeypot** — скрытое поле `hp_field`; заполнено ботом → заявка тихо отбрасывается.
- **Rate-limit** — по умолчанию 5 заявок/мин с одного IP (`RATE_MAX`, `RATE_WINDOW_MS`).
- **Лимит тела** — 4 КБ, длина полей ограничена.
- **CSV-инъекции** — поля, начинающиеся с `= + - @`, экранируются; переводы строк вырезаются.
- **Проверка Origin** — `ALLOWED_ORIGIN` отсекает POST с чужих доменов.
- **Непривилегированный пользователь** в контейнере, порт приложения наружу не проброшен.

## Бэкап CSV

Заявки — единственные ценные данные, том стоит бэкапить (например, по cron):

```bash
docker compose exec -T audit cat /data/leads.csv > "backup-leads-$(date +%F).csv"
```

## Переменные окружения

| Переменная | По умолчанию | Смысл |
|-----------|--------------|-------|
| `ADMIN_TOKEN` | — | токен для выгрузки CSV (обязателен) |
| `ALLOWED_ORIGIN` | пусто | разрешённый Origin формы; пусто = не проверять |
| `RATE_MAX` | `5` | заявок с одного IP за окно |
| `RATE_WINDOW_MS` | `60000` | окно rate-limit, мс |
| `PORT` | `8080` | порт приложения (внутри сети) |
| `DATA_DIR` | `/data` | каталог с CSV |
