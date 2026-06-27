/**
 * The session cookie name, in a dependency-free module so it can be imported by
 * Edge middleware (which must not pull in `pg`/`server-only`) as well as the
 * server-side session service.
 */
export const SESSION_COOKIE = "itf_session";
