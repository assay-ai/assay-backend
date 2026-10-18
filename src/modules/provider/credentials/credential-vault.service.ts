import { Inject, Injectable, OnModuleInit, Optional } from '@nestjs/common';
import { timingSafeEqual } from 'node:crypto';
import { EntityManager } from 'typeorm';

import { BindingCredentialEntity } from '@database/postgres/entities/binding-credential.entity';
import { VaultKekCheckRepository } from '@database/postgres/repositories/vault-kek-check.repository';
import { BindingCredentialRepository } from '@database/postgres/repositories/binding-credential.repository';

import { ProviderErrors } from '../errors/provider.errors';
import {
  CredentialHeader,
  credentialAad,
  kekCheckValue,
  openCredentialSet,
  sealCredentialSet,
  valueHint,
} from './credential-vault.crypto';
import { CREDENTIAL_VAULT_KEKS, VaultKeks } from './credential-vault.keys';

export interface CredentialSetSummary {
  origin: string;
  headers: { name: string; hint: string | null }[];
  updatedAt: Date;
}

/**
 * Stores and serves provider credential headers. Values leave this class only
 * through `headersFor`, which the invoker calls at dial time; every other
 * method returns names and hints.
 */
@Injectable()
export class CredentialVaultService implements OnModuleInit {
  constructor(
    private readonly credentials: BindingCredentialRepository,
    @Inject(CREDENTIAL_VAULT_KEKS) private readonly keks: VaultKeks,
    // Optional only for hand-built harnesses; without it no key-check runs.
    @Optional() private readonly kekChecks?: VaultKekCheckRepository,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.verifyKeks();
  }

  /**
   * Compares every loaded KEK with the key-check value stored for its id,
   * writing the value on first sight. A mismatch means the id now holds
   * different bytes than the ones that sealed existing sets: the boot fails,
   * naming the id and never the key.
   */
  async verifyKeks(): Promise<void> {
    if (!this.kekChecks) return;
    for (const kek of this.keks.byId.values()) {
      const actual = kekCheckValue(kek);
      let stored = await this.kekChecks.findKcv(kek.keyId);
      if (!stored) {
        await this.kekChecks.insertIfAbsent(kek.keyId, actual);
        // A concurrent first boot (api and mcp together) may have won the insert.
        stored = await this.kekChecks.findKcv(kek.keyId);
      }
      if (!stored || stored.length !== actual.length || !timingSafeEqual(stored, actual)) {
        throw new Error(
          `Vault key "${kek.keyId}" does not match the key-check value stored for it; ` +
            `the key id was reused with different key material`,
        );
      }
    }
  }

  async put(
    organizationId: string,
    bindingId: string,
    origin: string,
    headers: CredentialHeader[],
    updatedBy: string,
  ): Promise<CredentialSetSummary> {
    const active = this.keks.active;
    if (!active) throw ProviderErrors.credentialVaultNotConfigured();

    const sealed = sealCredentialSet(
      headers,
      active,
      credentialAad(organizationId, bindingId, origin),
    );
    const row = await this.credentials.replace(organizationId, {
      bindingId,
      origin,
      kekId: sealed.kekId,
      wrappedDek: sealed.wrappedDek,
      dekIv: sealed.dekIv,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      headerNames: headers.map((h) => h.name),
      valueHints: headers.map((h) => valueHint(h.value)),
      updatedBy,
    });
    return summarise(row);
  }

  async remove(organizationId: string, bindingId: string, origin: string): Promise<void> {
    await this.credentials.removeOrigin(organizationId, bindingId, origin);
  }

  async list(organizationId: string, bindingId: string): Promise<CredentialSetSummary[]> {
    const rows = await this.credentials.findForBinding(organizationId, bindingId);
    return rows.map(summarise);
  }

  /**
   * Decrypted headers for exactly this origin, or `[]` when none. Throws
   * `credentialVaultUnavailable` when a row exists but cannot be opened (its KEK
   * is absent, or it fails authentication). Failing closed is deliberate:
   * calling the provider without its credentials would only produce a 401 that
   * is blamed on the provider.
   */
  async headersFor(
    organizationId: string,
    bindingId: string,
    origin: string,
  ): Promise<CredentialHeader[]> {
    const row = await this.credentials.findForOrigin(organizationId, bindingId, origin);
    if (!row) return [];
    if (!this.keks.byId.has(row.kekId)) {
      throw ProviderErrors.credentialVaultUnavailable({ reason: 'key not loaded' });
    }
    try {
      return openCredentialSet(
        {
          kekId: row.kekId,
          wrappedDek: row.wrappedDek,
          dekIv: row.dekIv,
          ciphertext: row.ciphertext,
          iv: row.iv,
        },
        this.keks.byId,
        credentialAad(organizationId, bindingId, origin),
      );
    } catch {
      throw ProviderErrors.credentialVaultUnavailable({ reason: 'authentication failed' });
    }
  }

  /**
   * Deletes the binding's sets for origins not in `keepOrigins`, inside the
   * caller's transaction. Returns what was removed (origin and header names,
   * never values) so the caller can audit it.
   */
  async pruneExcept(
    manager: EntityManager,
    organizationId: string,
    bindingId: string,
    keepOrigins: readonly string[],
  ): Promise<Array<{ origin: string; headerNames: string[] }>> {
    return this.credentials.pruneExcept(manager, organizationId, bindingId, keepOrigins);
  }
}

function summarise(row: BindingCredentialEntity): CredentialSetSummary {
  return {
    origin: row.origin,
    headers: row.headerNames.map((name, i) => ({ name, hint: row.valueHints[i] ?? null })),
    updatedAt: row.updatedAt,
  };
}
