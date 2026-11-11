import crypto from 'node:crypto';
import { localPhone } from '../../contracts/accounts.js';
import { ApiError } from '../../contracts/api/index.js';
import { SELLER_ROLES } from '../../contracts/api/access.js';
import { log } from '../../platform/log.js';
import { withTenant } from '../../tenancy.js';
import { writeAudit } from '../audit/index.js';
import { acceptInvites, linkMemberships } from '../team/invites.js';
import { NO_PASSWORD, accountPhone, platformOf } from './shared.js';

const UNIQUE_VIOLATION = /unique|duplicate/i;

/**
 * People (PRD 5.11, 10.3): one row per human, and the identities that prove who they are. A verified identity
 * (kind, subject) is exactly one person. What ties a person to seller accounts is only ever proof: a verified phone
 * equal to the account's phone, or an invitation taken up with a verified identity (src/modules/team). A Google or
 * Apple identity reaches accounts only through a person already tied to them, or an invitation to its verified email.
 * Everything here is about no single business, so it runs on the platform path.
 */
export function peopleService(ctx) {
  const db = () => platformOf(ctx.db);

  /** The person for this verified identity, made with it when there is none. `email` is the provider's verified email, or ''. */
  async function findOrMake({ kind, subject, email = '', name = '' }) {
    const found = await identityOwner(kind, subject);
    if (found) {
      if (kind !== 'phone' && email !== found.email) await db().query('UPDATE person_identities SET email = $3 WHERE kind = $1 AND subject = $2', [kind, subject, email]);
      if (name && !found.name) await db().query(`UPDATE people SET name = $2 WHERE id = $1 AND name = ''`, [found.personId, String(name).slice(0, 80)]);
      return { personId: found.personId, created: false };
    }
    return db().tx(async (t) => {
      const [person] = await t.query('INSERT INTO people (name) VALUES ($1) RETURNING id', [String(name ?? '').slice(0, 80)]);
      const [identity] = await t.query(
        `INSERT INTO person_identities (person_id, kind, subject, email, verified_at) VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (kind, subject) DO NOTHING RETURNING person_id`,
        [person.id, kind, subject, kind === 'phone' ? '' : email],
      );
      if (identity) return { personId: Number(person.id), created: true };
      // Someone signed in with the same identity at the same moment: theirs is the person.
      await t.query('DELETE FROM people WHERE id = $1', [person.id]);
      const [other] = await t.query('SELECT person_id FROM person_identities WHERE kind = $1 AND subject = $2', [kind, subject]);
      return { personId: Number(other.person_id), created: false };
    });
  }

  async function identityOwner(kind, subject) {
    const [row] = await db().query(
      `SELECT i.person_id, i.email, p.name FROM person_identities i JOIN people p ON p.id = i.person_id
       WHERE i.kind = $1 AND i.subject = $2 AND p.deleted_at IS NULL`,
      [kind, subject],
    );
    return row ? { personId: Number(row.person_id), email: row.email, name: row.name } : null;
  }

  async function person(personId) {
    const [row] = await db().query('SELECT id, name FROM people WHERE id = $1 AND deleted_at IS NULL', [personId]);
    return row ? { id: Number(row.id), name: row.name } : null;
  }

  async function identities(personId) {
    return db().query('SELECT kind, subject, email, verified_at FROM person_identities WHERE person_id = $1 ORDER BY verified_at, id', [personId]);
  }

  async function phonesOf(personId) {
    return (await identities(personId)).filter((i) => i.kind === 'phone').map((i) => i.subject);
  }

  /**
   * Brings the person's accounts up to date with what they have proved: every seller account whose phone equals one of
   * their verified numbers and that nobody has proved yet becomes theirs; every open invitation to one of their verified
   * numbers or emails is taken up; and the switcher pairs are written between every two of their accounts.
   */
  async function reconcile(personId) {
    const all = await identities(personId);
    const phones = all.filter((i) => i.kind === 'phone').map((i) => i.subject);
    const emails = [...new Set(all.filter((i) => i.kind !== 'phone' && i.email).map((i) => i.email.toLowerCase()))];
    const numbers = phones.flatMap((p) => [localPhone(p), p]).filter(Boolean);
    if (numbers.length) {
      const tied = await db().query(
        `UPDATE users u SET person_id = $1
         WHERE u.person_id IS NULL AND u.removed_at IS NULL AND u.role = ANY($2) AND u.phone = ANY($3)
           AND NOT EXISTS (SELECT 1 FROM users o WHERE o.tenant_id = u.tenant_id AND o.person_id = $1)
         RETURNING u.tenant_id, u.id`,
        [personId, SELLER_ROLES, numbers],
      );
      for (const row of tied) log.info('accounts.account_tied', { personId, tenantId: row.tenant_id, userId: row.id });
      // An account made before the person had a verified number now carries it, where nobody else there has it.
      const number = accountPhone(phones[0], personId);
      await db().query(
        `UPDATE users u SET phone = $2 WHERE u.person_id = $1 AND u.phone = $3
           AND NOT EXISTS (SELECT 1 FROM users o WHERE o.tenant_id = u.tenant_id AND o.phone = $2)`,
        [personId, number, `person:${personId}`],
      );
    }
    const me = await person(personId);
    await acceptInvites(ctx, { personId, name: me?.name ?? '', phones, emails });
    await linkMemberships(ctx.db, personId);
  }

  /** The person's live seller accounts, the one used last first. */
  async function accounts(personId) {
    return db().query(
      `SELECT u.tenant_id, u.id AS user_id, u.role, last.at AS last_used
       FROM users u
       JOIN tenants t ON t.id = u.tenant_id
       LEFT JOIN LATERAL (SELECT max(s.created_at) AS at FROM sessions s WHERE s.tenant_id = u.tenant_id AND s.user_id = u.id) last ON true
       WHERE u.person_id = $1 AND u.role = ANY($2) AND u.removed_at IS NULL AND t.status <> 'killed'
       ORDER BY last.at DESC NULLS LAST, u.created_at, u.id`,
      [personId, SELLER_ROLES],
    );
  }

  async function accountIn(personId, tenantId) {
    return (await accounts(personId)).find((a) => a.tenant_id === Number(tenantId)) ?? null;
  }

  /**
   * The first business of someone who has no seller account anywhere (F-109): a creator account on the Free plan, with
   * them as its owner. Its address is made up and can be changed in onboarding; nothing about it is special in code.
   */
  async function makeFirstBusiness(personId) {
    const me = await person(personId);
    const phones = await phonesOf(personId);
    const name = me?.name ? `${me.name.split(/\s+/)[0]}'s page` : 'My creator page';
    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = `c-${crypto.randomBytes(5).toString('hex')}`;
      try {
        const made = await db().tx(async (t) => {
          const [tenant] = await t.query(`INSERT INTO tenants (slug, name, plan, account_type) VALUES ($1, $2, 'free', 'creator') RETURNING id`, [slug, name.slice(0, 80)]);
          const [user] = await t.query(
            `INSERT INTO users (tenant_id, name, phone, email, password_hash, role, person_id) VALUES ($1, $2, $3, '', $4, 'owner', $5) RETURNING id`,
            [tenant.id, (me?.name || 'Owner').slice(0, 80), accountPhone(phones[0], personId), NO_PASSWORD, personId],
          );
          return { tenantId: tenant.id, userId: user.id };
        });
        await withTenant(made.tenantId, () => ctx.db.tx((t) => writeAudit(t, { actor: `user:${made.userId}`, action: 'business.created', target: `tenant:${made.tenantId}`, details: { accountType: 'creator', plan: 'free' } })));
        log.info('accounts.first_business', { personId, tenantId: made.tenantId, userId: made.userId });
        return { tenant_id: made.tenantId, user_id: made.userId, role: 'owner' };
      } catch (err) {
        if (!UNIQUE_VIOLATION.test(String(err?.message))) throw err;
      }
    }
    throw new Error('Could not choose an address for a new business');
  }

  /**
   * Adds a verified identity to `personId`. The same identity on the same person is nothing new. On another person it
   * is refused with conflict, unless that other person is only the identity itself, made by a browser sign-in started
   * to link it (no account, no other identity): then it moves. Accounts are never merged here.
   */
  async function attach(personId, { kind, subject, email = '' }) {
    await db().tx(async (t) => {
      const [owner] = await t.query('SELECT person_id FROM person_identities WHERE kind = $1 AND subject = $2 FOR UPDATE', [kind, subject]);
      if (!owner) {
        await t.query('INSERT INTO person_identities (person_id, kind, subject, email, verified_at) VALUES ($1, $2, $3, $4, now())', [personId, kind, subject, kind === 'phone' ? '' : email]);
        return;
      }
      const other = Number(owner.person_id);
      if (other === personId) return;
      const [bare] = await t.query(
        `SELECT (SELECT count(*) FROM users WHERE person_id = $1)::int AS accounts, (SELECT count(*) FROM person_identities WHERE person_id = $1)::int AS identities`,
        [other],
      );
      if (bare.accounts !== 0 || bare.identities !== 1) throw new ApiError('conflict', 'That sign-in already belongs to another account.');
      await t.query('UPDATE person_identities SET person_id = $3, email = $4, verified_at = now() WHERE kind = $1 AND subject = $2', [kind, subject, personId, kind === 'phone' ? '' : email]);
      await t.query('DELETE FROM people WHERE id = $1', [other]);
    });
  }

  return { findOrMake, identityOwner, person, identities, phonesOf, reconcile, accounts, accountIn, makeFirstBusiness, attach };
}
