# Webhook Autofill

Приём POST `/webhook` от внешней системы (AICalls и т.п.) и запись лидов в существующую БД.

## Развёртывание на сервере

```bash
# 1. Скопировать autofill/ на сервер
scp -r autofill/ user@server:~/autofill/

# 2. Создать .env
cd ~/autofill
cp .env.example .env
# Указать DATABASE_URL от вашей существующей БД
```

```bash
# 3. Запустить
docker compose up -d --build

# 4. Проверить
curl http://localhost:3002/health
```

Если БД на том же сервере (`localhost`), в `docker-compose.yml` раскомментируйте `network_mode: host` и уберите `ports`.

## Эндпоинты

| Метод | URL | Описание |
|-------|-----|----------|
| POST | `/webhook` | Приём лида (JSON) |
| GET | `/health` | Проверка работы |

## Переменные окружения (.env)

| Переменная | Обязательная | Описание |
|------------|:---:|----------|
| `DATABASE_URL` | да | PostgreSQL URL существующей БД |
| `PORT` | нет | Порт сервиса (по умолчанию 3002) |
| `WEBHOOK_AUTO_CREATE_PROJECT` | нет | `1` — создавать проект при первом вебхуке от новой организации |
| `WEBHOOK_PROJECT_ID` | нет | UUID проекта по умолчанию (если не найден по организации) |

## Логика выбора проекта

1. Ищет `projects.external_organization_id` = `organizationId` из вебхука
2. Ищет в `webhook_project_mapping`
3. Использует `WEBHOOK_PROJECT_ID`
4. Создаёт новый проект (если `WEBHOOK_AUTO_CREATE_PROJECT=1`)

## Миграции

При старте контейнера автоматически применяются к существующей БД (только `ALTER TABLE` и `CREATE TABLE IF NOT EXISTS`):

- **001** — `record_url`, `payload` в `calls`
- **002** — таблица `webhook_project_mapping`
- **003** — `external_organization_id` в `projects`

Существующие таблицы и данные не затрагиваются.

## Производительность

- Кэш `organizationId → projectId` в памяти
- Батчинг: записи вставляются пачками (до 50 шт / 200мс)
- Пул до 20 соединений к Postgres
- Ответ клиенту мгновенный (до записи в БД)
