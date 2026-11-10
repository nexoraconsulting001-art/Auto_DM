import { normalizeHost } from '../../tenancy.js';

/** The platform host: PLATFORM_HOST, or admin.<PLATFORM_DOMAIN> ("admin" is a reserved business slug). */
export const platformHostOf = (config) => normalizeHost(config.platformHost || (config.platformDomain ? `admin.${config.platformDomain}` : ''));
