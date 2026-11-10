import { checkKey } from '../../platform/storage.js';
import { tenantId } from '../../tenancy.js';

/**
 * Where report files live. Downloads, monthly PDFs and scheduled attachments are written by the worker and opened through the web app, so both must
 * see one store. The local and S3 drivers are shared already. The memory driver is one Map per createPlatform(), so a worker and a web app in the same
 * process (tests, a local run) would each have their own: for that driver only, report files share one Map in this process.
 */
const sharedMemory = new Map();

const memoryStore = Object.freeze({
  driver: 'memory-shared',
  async put(key, buffer) {
    sharedMemory.set(checkKey(key), Buffer.from(buffer));
  },
  async get(key) {
    return sharedMemory.get(checkKey(key)) ?? null;
  },
  async remove(key) {
    sharedMemory.delete(checkKey(key));
  },
});

export function fileStore(platform) {
  const storage = platform?.storage;
  if (!storage || storage.driver === 'memory') return memoryStore;
  return storage;
}

/** Keys are under the business's own folder, so one business's file can never be named by another's row. */
export const downloadKey = (id, ext) => `t/${tenantId()}/reports/downloads/${id}.${ext}`;
export const monthlyKey = (periodStart) => `t/${tenantId()}/reports/monthly/${periodStart}.pdf`;
export const scheduledKey = (scheduleId, periodStart, audience, ext) => `t/${tenantId()}/reports/scheduled/${scheduleId}-${periodStart}-${audience}.${ext}`;

/** The address a file opens at. REPORT_FILE_PATH is /report-files/:id; the id says which kind of file: d for a download, m for a monthly report. */
export const downloadFileUrl = (id) => `/report-files/d${id}`;
export const monthlyFileUrl = (id) => `/report-files/m${id}`;

export function parseFileRef(ref) {
  const match = /^([dm])([1-9]\d{0,17})$/.exec(String(ref ?? ''));
  return match ? { kind: match[1] === 'd' ? 'download' : 'monthly', id: match[2] } : null;
}
