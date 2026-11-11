import express from 'express';
import { isAllowed, staffWith } from '../../contracts/api/access.js';
import { STORE_ROUTES } from '../../contracts/store-routes.js';
import { log, reportError } from '../../platform/log.js';
import { sendStoreNotFound } from '../storefront/shell.js';
import { INVOICE_EVENTS, PDF_QUEUE, SWEEP_QUEUE, createInvoices, fileName } from './service.js';

/**
 * PRD 9.13: GST invoices, bills of supply and credit notes. This folder is the invoices track's.
 *
 * Tables (migration 408): invoice_settings, invoice_sequences, invoices. The database numbers every document per business,
 * kind and financial year with no gap, even for orders paid at the same moment (S-43), starts each April's series at 1
 * (S-44), and refuses a second document for one order or refund. An issued document never changes: a refund is corrected
 * by a credit note.
 *
 * Order events (one listener, so an order's events reach it in order): order.paid, order.advance_paid and order.delivered
 * issue the invoice when it is due (prepaid on payment, part-advance on the advance, cash on delivery on delivery);
 * refund.processed issues the credit note. It emits invoice.issued and credit_note.issued.
 * Money (money.js): prices include GST, GST is worked out on the discounted value, CGST and SGST in one state and IGST across
 * states, exact in paise (S-42).
 * Files: the PDF is drawn by the queue (invoices.pdf) and kept in platform.storage under t/<business>/invoices/; a sweep
 * queues any still missing. Until then, and if the stored file is lost, it is drawn again from the row.
 *
 * Console routes: invoiceSettings.get, invoiceSettings.update (owner), invoices.list, invoices.get.
 * Seller file: GET /invoices/:id/file (owner, manager, staff with orders). 'invoices' is a reserved first segment.
 * Buyer file: GET /order/:token/invoice/:number, by the order's unguessable link, in the seller's brand only.
 */
export const INVOICE_FILE_PATH = '/invoices/:id/file';
export { PDF_QUEUE, SWEEP_QUEUE };
const services = new WeakMap();

/** This process's invoices service. */
export function invoicesFor(ctx) {
  let found = services.get(ctx);
  if (!found) {
    found = createInvoices(ctx);
    services.set(ctx, found);
  }
  return found;
}

const sellerReads = staffWith('orders');

function sendPdf(res, buffer, number, disposition) {
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${disposition}; filename="${fileName(number)}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  return res.send(buffer);
}

/** The queue job: one document's PDF into storage. */
export const pdfJob = (ctx) => async (job) => {
  const id = Number(job.payload?.invoiceId);
  if (!Number.isSafeInteger(id) || id <= 0) return;
  if (await invoicesFor(ctx).storeFile(id)) log.info('invoices.file_stored', { invoiceId: id });
};

export const invoices = {
  name: 'invoices',

  setup(ctx) {
    const service = invoicesFor(ctx);
    ctx.invoices = service;
    ctx.orderEvents?.on(INVOICE_EVENTS, 'invoices.documents', (event) => service.onEvent(event));
  },

  routes(app, ctx) {
    const r = express.Router();

    r.get(STORE_ROUTES.invoiceFile.path, async (req, res) => {
      try {
        const invoice = await invoicesFor(ctx).forBuyer(req.params.token, req.params.number);
        if (!invoice) return sendStoreNotFound(ctx, req, res, 'We couldn’t find that document.');
        return sendPdf(res, await invoicesFor(ctx).file(invoice), invoice.number, 'inline');
      } catch (err) {
        reportError(err, { msg: 'invoices.buyer_file_failed' });
        return res.status(500).type('text').send('Something went wrong. Please try again.');
      }
    });

    r.get(INVOICE_FILE_PATH, async (req, res) => {
      try {
        res.set('Cache-Control', 'private, no-store');
        if (!req.user) return res.status(401).type('text').send('Sign in to your admin, then open this link again.');
        if (!isAllowed(req.user, sellerReads)) return res.status(403).type('text').send('You don’t have access to invoices.');
        const invoice = /^\d{1,18}$/.test(req.params.id) ? await invoicesFor(ctx).row(req.params.id) : null;
        if (!invoice) return res.status(404).type('text').send('We couldn’t find that invoice.');
        return sendPdf(res, await invoicesFor(ctx).file(invoice), invoice.number, 'attachment');
      } catch (err) {
        reportError(err, { msg: 'invoices.seller_file_failed' });
        return res.status(500).type('text').send('Something went wrong. Please try again.');
      }
    });

    app.use(r);
  },

  api: (ctx) => ({
    'invoiceSettings.get': () => invoicesFor(ctx).settings.get(),
    'invoiceSettings.update': ({ body, user }) => invoicesFor(ctx).settings.update(body, `user:${user.id}`),
    'invoices.list': ({ query }) => invoicesFor(ctx).list(query),
    'invoices.get': ({ params }) => invoicesFor(ctx).get(params.id),
  }),

  jobs(ctx) {
    const { queue } = ctx.platform;
    queue.work(PDF_QUEUE, pdfJob(ctx));
    queue.work(SWEEP_QUEUE, () => invoicesFor(ctx).sweep());
    return async function schedule() {
      await queue.every(SWEEP_QUEUE, 10 * 60_000);
    };
  },
};
