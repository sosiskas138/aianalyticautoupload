import express from 'express';
import { query, pool } from '../config/database.js';

const router = express.Router();

// ─── Кэш organizationId → projectId (в памяти, сбрасывается при рестарте) ───
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
  let insert;
  try {
    insert = await query(
      `INSERT INTO projects (name, description, external_organization_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (external_organization_id) DO UPDATE SET name = EXCLUDED.name
       RETURNING id`,
      [name, `Авто: организация ${organizationId}`, organizationId]
    );
  } catch {
    insert = await query(
      'INSERT INTO projects (name, description) VALUES ($1, $2) RETURNING id',
      [name, `Авто: организация ${organizationId}`]
    );
  }
  if (!insert.rows.length) return null;
  const newId = (insert.rows[0] as { id: string }).id;
  try {
    await query(
      'INSERT INTO webhook_project_mapping (organization_id, project_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [organizationId, newId]
    );
  } catch { /* таблица может отсутствовать */ }
  return newId;
}

async function resolveProjectId(body: Record<string, unknown>): Promise<string | null> {
  const organizationId = body.organizationId as string | undefined;
  const defaultProjectId = process.env.WEBHOOK_PROJECT_ID?.trim() || null;
  const autoCreate = process.env.WEBHOOK_AUTO_CREATE_PROJECT === '1' || process.env.WEBHOOK_AUTO_CREATE_PROJECT === 'true';

  if (organizationId) {
    const cached = projectCache.get(organizationId);
    if (cached) return cached;

    const found = await findProjectByOrgId(organizationId);
    if (found) {
      projectCache.set(organizationId, found);
      return found;
    }
  }

  if (defaultProjectId) return defaultProjectId;

  if (autoCreate && organizationId) {
    // Защита от гонки: если уже создаём проект для этой организации — ждём тот же промис
    const pending = pendingCreates.get(organizationId);
    if (pending) return pending;

    const callList = body.callList as Record<string, unknown> | undefined;
    const org = (callList?.organization as Record<string, unknown>) || {};
    const orgName = (org.name as string) || '';

    const createPromise = createProjectForOrg(organizationId, orgName)
      .then((id) => {
        if (id) projectCache.set(organizationId, id);
        pendingCreates.delete(organizationId);
        return id;
      })
      .catch((e) => {
        console.error('Auto-create project failed:', e);
        pendingCreates.delete(organizationId);
        return null;
      });

    pendingCreates.set(organizationId, createPromise);
    return createPromise;
  }

  return null;
}

// ─── Очередь батчинга: собираем записи и вставляем пачкой ───
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

  const values = batch.map((_, idx) => {
    const b = idx * 13;
    return `($${b+1},$${b+2},$${b+3},$${b+4},$${b+5},$${b+6},$${b+7},$${b+8},$${b+9},$${b+10},$${b+11},$${b+12},$${b+13},1,true)`;
  }).join(',');

  const params: unknown[] = [];
  for (const r of batch) {
    params.push(
      r.projectId, r.callId, r.phoneRaw, r.phoneNormalized,
      r.callListName, r.skillBase, r.callAt, r.durationSeconds,
      r.status, r.hangupReason, r.isLead, r.recordUrl, r.payload
    );
  }

  try {
    await pool.query(
      `INSERT INTO calls (
        project_id, external_call_id, phone_raw, phone_normalized,
        call_list, skill_base, call_at, duration_seconds, status, end_reason,
        is_lead, record_url, payload, call_attempt_number, is_first_attempt
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
        record_url = COALESCE(EXCLUDED.record_url, calls.record_url),
        payload = COALESCE(EXCLUDED.payload, calls.payload)`,
      params
    );
  } catch (e) {
    console.error('Batch insert error, falling back to single inserts:', (e as Error).message);
    for (const r of batch) {
      try {
        await pool.query(
          `INSERT INTO calls (
            project_id, external_call_id, phone_raw, phone_normalized,
            call_list, skill_base, call_at, duration_seconds, status, end_reason,
            is_lead, record_url, payload, call_attempt_number, is_first_attempt
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,1,true)
          ON CONFLICT (project_id, external_call_id)
          DO UPDATE SET
            phone_raw = EXCLUDED.phone_raw, phone_normalized = EXCLUDED.phone_normalized,
            call_list = EXCLUDED.call_list, skill_base = EXCLUDED.skill_base,
            call_at = EXCLUDED.call_at, duration_seconds = EXCLUDED.duration_seconds,
            status = EXCLUDED.status, end_reason = EXCLUDED.end_reason,
            is_lead = EXCLUDED.is_lead,
            record_url = COALESCE(EXCLUDED.record_url, calls.record_url),
            payload = COALESCE(EXCLUDED.payload, calls.payload)`,
          [r.projectId, r.callId, r.phoneRaw, r.phoneNormalized,
           r.callListName, r.skillBase, r.callAt, r.durationSeconds,
           r.status, r.hangupReason, r.isLead, r.recordUrl, r.payload]
        );
      } catch (e2) {
        console.error('Single insert error:', r.callId, (e2 as Error).message);
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
      return res.status(400).json({ error: 'Invalid JSON body' });
    }

    const projectId = await resolveProjectId(body);
    if (!projectId) {
      return res.status(503).json({
        error: 'Webhook not configured: set WEBHOOK_PROJECT_ID or WEBHOOK_AUTO_CREATE_PROJECT=1',
      });
    }

    const type = body.type as string;
    const callList = body.callList as Record<string, unknown> | undefined;
    const contact = body.contact as Record<string, unknown> | undefined;
    const call = body.call as Record<string, unknown> | undefined;

    if (!call || !contact || !callList) {
      return res.status(400).json({ error: 'Missing required fields: call, contact, callList' });
    }

    const callId = call.id as string;
    if (!callId) {
      return res.status(400).json({ error: 'Missing call.id' });
    }

    const phoneRaw = String(contact.phone ?? '');
    const phoneNormalized = normalizePhone(phoneRaw) || phoneRaw || 'unknown';
    const startedAt = (call.startedAt as string) || (call.createdAt as string);
    const callAt = startedAt ? new Date(startedAt).toISOString() : new Date().toISOString();
    const durationSeconds = Math.round(Number(call.duration ?? 0) / 1000);
    const status = String(call.status ?? 'completed');
    const hangupReason = (call.hangupReason as string) || '';
    const recordUrl = (call.recordUrl as string) || null;
    const callListName = (callList.name as string) || '';
    const callDetails = (call.callDetails as Record<string, unknown>) || {};
    const skillBase = (callDetails.skillbaseName as string) || (callDetails.skillbase_id as string) || '';
    const isLead = type === 'lead_only';

    const payload = JSON.stringify({
      webhook_id: body.id,
      webhook_type: type,
      organization_id: body.organizationId,
      timestamp: body.timestamp,
      agreements: callDetails.agreements ?? null,
      chatHistory: callDetails.chatHistory ?? null,
      metrics: callDetails.metrics ?? null,
      leadTransfer: (callDetails.agreements as Record<string, unknown>)?.leadTransfer ?? null,
    });

    enqueueInsert({
      projectId, callId, phoneRaw, phoneNormalized, callListName,
      skillBase, callAt, durationSeconds, status, hangupReason,
      isLead, recordUrl, payload,
    });

    res.status(200).json({ ok: true, external_call_id: callId, project_id: projectId });
  } catch (error: unknown) {
    console.error('Webhook error:', error);
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal server error',
    });
  }
});

export default router;
