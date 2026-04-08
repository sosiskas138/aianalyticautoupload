import express from 'express';
import { query, pool } from '../config/database.js';
import { log } from '../utils/logger.js';

const router = express.Router();

// --- Empty status alert ---
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '8233600919:AAEu3g47ozU5d0tPach8FcexbptGn04mNd8';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '-1003809075389';

let emptyStatusCount = 0;
let emptyStatusProjects = new Map<string, number>();
let lastAlertTime = 0;
const ALERT_INTERVAL_MS = 5 * 60 * 1000;
const ALERT_THRESHOLD = 10;

async function sendTelegramAlert(text: string) {
  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
  } catch (e) {
    log.error('Telegram alert error:', e);
  }
}

function trackEmptyStatus(projectName: string) {
  emptyStatusCount++;
  emptyStatusProjects.set(projectName, (emptyStatusProjects.get(projectName) || 0) + 1);

  const now = Date.now();
  if (emptyStatusCount >= ALERT_THRESHOLD && (now - lastAlertTime) > ALERT_INTERVAL_MS) {
    const lines = Array.from(emptyStatusProjects.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, cnt]) => `  ${name}: ${cnt}`);

    sendTelegramAlert(
      `\u26a0\ufe0f <b>Webhook: пустой status у ${emptyStatusCount} звонков</b>\n` +
      `Вебхуки приходят без call.status и call.duration.\n\n` +
      `Проекты:\n${lines.join('\n')}\n\n` +
      `Возможен сбой на стороне платформы trySasha.`
    );

    lastAlertTime = now;
    emptyStatusCount = 0;
    emptyStatusProjects.clear();
  }
}



const projectCache = new Map<string, string>();
const pendingCreates = new Map<string, Promise<string | null>>();

function normalizePhone(raw: string): string {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('8')) return '7' + digits.slice(1);
  if (digits.length === 10) return '7' + digits;
  return digits || raw || '';
}

async function findProjectByOrgId(organizationId: string): Promise<string | null> {
  try {
    const r = await query(
      'SELECT id FROM projects WHERE external_organization_id = $1',
      [organizationId]
    );
    if (r.rows.length > 0) return (r.rows[0] as { id: string }).id;
  } catch { /* колонка может отсутствовать */ }

  try {
    const r = await query(
      'SELECT project_id FROM webhook_project_mapping WHERE organization_id = $1',
      [organizationId]
    );
    if (r.rows.length > 0) return (r.rows[0] as { project_id: string }).project_id;
  } catch { /* таблица может отсутствовать */ }

  return null;
}

async function createProjectForOrg(
  organizationId: string,
  orgName: string
): Promise<string | null> {
  const name = orgName || `Вебхук ${organizationId.slice(0, 8)}`;
  const needsMapping = !orgName;
  let insert;
  try {
    insert = await query(
      `INSERT INTO projects (name, description, external_organization_id, needs_mapping)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (external_organization_id) DO UPDATE
         SET name = CASE WHEN projects.needs_mapping THEN EXCLUDED.name ELSE projects.name END,
             needs_mapping = CASE WHEN projects.needs_mapping AND $4 = FALSE THEN FALSE ELSE projects.needs_mapping END
       RETURNING id`,
      [name, `Авто: организация ${organizationId}`, organizationId, needsMapping]
    );
  } catch {
    insert = await query(
      'INSERT INTO projects (name, description, needs_mapping) VALUES ($1, $2, $3) RETURNING id',
      [name, `Авто: организация ${organizationId}`, needsMapping]
    );
  }
  if (!insert.rows.length) return null;
  const newId = (insert.rows[0] as { id: string }).id;
  log.info(`Project created: ${newId} for org ${organizationId} (${name})`);
  // Default pricing 12 rub/min
  try {
    await query(
      "INSERT INTO project_pricing (project_id, price_per_number, price_per_call, price_per_minute) VALUES ($1, 0, 0, 12) ON CONFLICT DO NOTHING",
      [newId]
    );
  } catch { /* ignore */ }
  try {
    await query(
      'INSERT INTO webhook_project_mapping (organization_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [organizationId, newId]
    );
  } catch { /* таблица может отсутствовать */ }
  return newId;
}

async function tryRenameIfNeeded(projectId: string, orgName: string): Promise<void> {
  if (!orgName) return;
  try {
    const r = await query(
      `UPDATE projects SET name = $1, needs_mapping = FALSE
       WHERE id = $2 AND needs_mapping = TRUE
       RETURNING name`,
      [orgName, projectId]
    );
    if (r.rows.length > 0) {
      log.info(`Project auto-renamed: ${projectId} → "${orgName}"`);
    }
  } catch { /* ignore */ }
}

async function resolveProjectId(body: Record<string, unknown>): Promise<string | null> {
  const organizationId = body.organizationId as string | undefined;
  const defaultProjectId = process.env.WEBHOOK_PROJECT_ID?.trim() || null;
  const autoCreate = process.env.WEBHOOK_AUTO_CREATE_PROJECT === '1' || process.env.WEBHOOK_AUTO_CREATE_PROJECT === 'true';

  // Извлекаем имя орга из callList.organization.name (если пришёл объект)
  const callList = body.callList as Record<string, unknown> | undefined;
  const rawOrg = callList?.organization;
  const orgObj = (typeof rawOrg === 'object' && rawOrg !== null) ? (rawOrg as Record<string, unknown>) : null;
  const orgName = (orgObj?.name as string) || '';

  if (organizationId) {
    const cached = projectCache.get(organizationId);
    if (cached) {
      log.debug(`Project resolved from cache: ${cached} for org ${organizationId}`);
      if (orgName) tryRenameIfNeeded(cached, orgName);
      return cached;
    }

    const found = await findProjectByOrgId(organizationId);
    if (found) {
      projectCache.set(organizationId, found);
      log.debug(`Project resolved from DB: ${found} for org ${organizationId}`);
      if (orgName) tryRenameIfNeeded(found, orgName);
      return found;
    }
  }

  if (defaultProjectId) return defaultProjectId;

  if (autoCreate && organizationId) {
    const pending = pendingCreates.get(organizationId);
    if (pending) return pending;

    const createPromise = createProjectForOrg(organizationId, orgName)
      .then((id) => {
        if (id) projectCache.set(organizationId, id);
        pendingCreates.delete(organizationId);
        return id;
      })
      .catch((e) => {
        log.error('Auto-create project failed:', e);
        pendingCreates.delete(organizationId);
        return null;
      });

    pendingCreates.set(organizationId, createPromise);
    return createPromise;
  }

  return null;
}

// ─── Очередь батчинга ───
interface CallRecord {
  projectId: string;
  callId: string;
  phoneRaw: string;
  phoneNormalized: string;
  callListName: string;
  skillBase: string;
  callAt: string;
  durationSeconds: number;
  status: string;
  hangupReason: string;
  isLead: boolean;
  needsReview: boolean;
  recordUrl: string | null;
  payload: string;
}

const insertQueue: CallRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 200;

async function flushQueue(): Promise<void> {
  if (insertQueue.length === 0) return;
  const batch = insertQueue.splice(0, BATCH_SIZE);

  log.debug(`Flushing batch: ${batch.length} records`);

  const values = batch.map((_, idx) => {
    const b = idx * 14;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},$${b+14},1,true)`;
  }).join(',');

  const params: unknown[] = [];
  for (const r of batch) {
    params.push(
      r.projectId, r.callId, r.phoneRaw, r.phoneNormalized,
      r.callListName, r.skillBase, r.callAt, r.durationSeconds,
      r.status, r.hangupReason, r.isLead, r.needsReview, r.recordUrl, r.payload
    );
  }

  try {
    await pool.query(
      `INSERT INTO calls (
        project_id, external_call_id, phone_raw, phone_normalized,
        call_list, skill_base, call_at, duration_seconds, status, end_reason,
        is_lead, needs_review, record_url, payload, call_attempt_number, is_first_attempt
      ) VALUES ${values}
      ON CONFLICT (project_id, external_call_id)
      DO UPDATE SET
        phone_raw = EXCLUDED.phone_raw,
        phone_normalized = EXCLUDED.phone_normalized,
        call_list = EXCLUDED.call_list,
        skill_base = EXCLUDED.skill_base,
        call_at = EXCLUDED.call_at,
        duration_seconds = EXCLUDED.duration_seconds,
        status = EXCLUDED.status,
        end_reason = EXCLUDED.end_reason,
        is_lead = EXCLUDED.is_lead,
        needs_review = EXCLUDED.needs_review,
        record_url = COALESCE(EXCLUDED.record_url, calls.record_url),
        payload = COALESCE(EXCLUDED.payload, calls.payload)`,
      params
    );
    log.info(`Batch inserted: ${batch.length} calls`);
  } catch (e) {
    log.error('Batch insert error, falling back to single inserts:', (e as Error).message);
    for (const r of batch) {
      try {
        await pool.query(
          `INSERT INTO calls (
            project_id, external_call_id, phone_raw, phone_normalized,
            call_list, skill_base, call_at, duration_seconds, status, end_reason,
            is_lead, needs_review, record_url, payload, call_attempt_number, is_first_attempt
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,true)
          ON CONFLICT (project_id, external_call_id)
          DO UPDATE SET
            phone_raw = EXCLUDED.phone_raw, phone_normalized = EXCLUDED.phone_normalized,
            call_list = EXCLUDED.call_list, skill_base = EXCLUDED.skill_base,
            call_at = EXCLUDED.call_at, duration_seconds = EXCLUDED.duration_seconds,
            status = EXCLUDED.status, end_reason = EXCLUDED.end_reason,
            is_lead = EXCLUDED.is_lead,
            needs_review = EXCLUDED.needs_review,
            record_url = COALESCE(EXCLUDED.record_url, calls.record_url),
            payload = COALESCE(EXCLUDED.payload, calls.payload)`,
          [r.projectId, r.callId, r.phoneRaw, r.phoneNormalized,
           r.callListName, r.skillBase, r.callAt, r.durationSeconds,
           r.status, r.hangupReason, r.isLead, r.needsReview, r.recordUrl, r.payload]
        );
        log.debug(`Single insert OK: ${r.callId}`);
      } catch (e2) {
        log.error('Single insert error:', r.callId, (e2 as Error).message);
      }
    }
  }

  if (insertQueue.length > 0) {
    setImmediate(flushQueue);
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    flushQueue();
  }, FLUSH_INTERVAL_MS);
}

function enqueueInsert(record: CallRecord): void {
  insertQueue.push(record);
  if (insertQueue.length >= BATCH_SIZE) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushQueue();
  } else {
    scheduleFlush();
  }
}

// ─── POST /webhook ───
router.post('/', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object') {
      log.warn('Invalid JSON body received');
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const projectId = await resolveProjectId(body);
    if (!projectId) {
      log.warn('No project found for webhook, orgId:', body.organizationId);
      return res.status(503).json({
        error: 'Webhook not configured: set WEBHOOK_PROJECT_ID or WEBHOOK_AUTO_CREATE_PROJECT=1',
      });
    }

    const type = body.type as string;
    const callList = (body.callList || body.call_list || {}) as Record<string, unknown>;
    const contact = (body.contact || {}) as Record<string, unknown>;
    const call = (body.call || {}) as Record<string, unknown>;

    // Fallback: try to extract from nested structures
    if (!contact.phone && call.callSession) {
      const session = call.callSession as Record<string, unknown>;
      const sessionContact = session.contact as Record<string, unknown> | undefined;
      if (sessionContact?.phone) contact.phone = sessionContact.phone;
      if (!callList.name && sessionContact?.callList) {
        const cl = sessionContact.callList as Record<string, unknown>;
        if (cl.name) callList.name = cl.name;
      }
    }

    // Try phone from body directly
    if (!contact.phone && body.phone) contact.phone = body.phone;

    const callId = (call.id || body.id || `auto_${Date.now()}_${Math.random().toString(36).slice(2,8)}`) as string;

    if (!contact.phone) {
      log.warn('No phone found in webhook body');
      return res.status(400).json({ error: 'Missing phone number' });
    }

    const phoneRaw = String(contact.phone ?? '');
    const phoneNormalized = normalizePhone(phoneRaw) || phoneRaw || 'unknown';
    const startedAt = (call.startedAt as string) || (call.createdAt as string);
    const callAt = startedAt ? new Date(startedAt).toISOString() : new Date().toISOString();
    const durationSeconds = Math.round(Number(call.duration ?? 0) / 1000);
    const rawStatus = String(call.status ?? '');
    const rawHangup = (call.hangupReason as string) || '';
    const recordUrl = (call.recordUrl as string) || null;
    const callListName = (callList.name as string) || '';
    const callDetails = (call.callDetails as Record<string, unknown>) || {};
    const skillBase = (callDetails.skillbaseName as string) || (callDetails.skillbase_id as string) || '';

    // Map API status → Russian DB values (matching existing data format)
    const STATUS_MAP: Record<string, string> = {
      failed:    'Недозвон',
      completed: 'Успешный',
      initiated: 'Инициирован',
    };
    const HANGUP_MAP: Record<string, string> = {
      hangup:               'Сброс',
      busy:                 'Занято',
      voicemail_busy:       'Занято',
      voicemail_smart_spam: 'Умный автоответчик',
      voicemail_smart_ivr:  'IVR',
      voicemail_smart_echo: 'Умный автоответчик',
    };
    const status = STATUS_MAP[rawStatus] ?? rawStatus;
    const hangupReason = HANGUP_MAP[rawHangup] ?? rawHangup;

    // Lead: transfer + lead_quality > 0 + destination=sales + isCommit=true
    const agreements = (call.agreements as Record<string, unknown>)
      || (callDetails.agreements as Record<string, unknown>)
      || {};
    const agrStatus = agreements.status as string;
    const leadQuality = Number(agreements.lead_quality ?? 0);
    const leadDestination = agreements.lead_destination as string;
    const isCommit = agreements.isCommit === true;
    const isLead = agrStatus === 'transfer' && leadQuality > 0 && leadDestination === 'sales' && isCommit;

    // needs_review: успешный звонок без agreements, но с историей разговора
    const chatHistory = callDetails.chatHistory as unknown[] | null;
    const needsReview = !isLead && rawStatus === 'completed' && !agrStatus && Array.isArray(chatHistory) && chatHistory.length > 0;

    const payload = JSON.stringify({
      webhook_id: body.id,
      webhook_type: type,
      organization_id: body.organizationId,
      timestamp: body.timestamp,
      agreements: agreements ?? null,
      chatHistory: callDetails.chatHistory ?? null,
      metrics: callDetails.metrics ?? null,
      leadTransfer: agreements?.leadTransfer ?? null,
    });

    enqueueInsert({
      projectId, callId, phoneRaw, phoneNormalized, callListName,
      skillBase, callAt, durationSeconds, status, hangupReason,
      isLead, needsReview, recordUrl, payload,
    });


    // Track empty status for alerting
    if (!rawStatus && !durationSeconds) {
      const projName = callListName || projectId;
      trackEmptyStatus(projName);
    }

    log.info(`Webhook received: call=${callId} phone=${phoneNormalized} project=${projectId} lead=${isLead} list=${callListName}`);

    res.status(200).json({ ok: true, external_call_id: callId, project_id: projectId });
  } catch (error: unknown) {
    log.error('Webhook error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

export default router;
