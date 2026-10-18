export const PROVIDER_REQUEST_SIGNING_KEYS_ENV = 'PROVIDER_REQUEST_SIGNING_KEYS';

/** `readonly EnvSigningKeySource[]`, read once at boot via `takeEnvSigningKeys`. */
export const REQUEST_SIGNING_KEYS = Symbol('REQUEST_SIGNING_KEYS');
