/**
 * Idempotent devnet Squads v4 multisig + vault + vault USDC ATA setup.
 *
 * Mirrors `backend/src/modules/chains/solana/squads-vault.constants.ts`'s PDA
 * derivation exactly (same seeds, same program id) — this is the script-side
 * proof that the backend's math matches what the Squads program actually
 * accepted on chain, not a second implementation trusted on its own.
 */
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  Transaction,
} from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { address, createNoopSigner } from '@solana/kit';
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from '@solana-program/token';

import { kitInstructionToWeb3 } from './kit-to-web3';
import { loadOrCreateKeypair, loadState, saveState } from './keystore';

const VAULT_INDEX = 0;

export interface SquadsSetupResult {
  readonly createKey: PublicKey;
  readonly multisigPda: PublicKey;
  readonly vaultPda: PublicKey;
  readonly vaultAta: PublicKey;
  readonly multisigCreated: boolean;
  readonly vaultAtaCreated: boolean;
  readonly multisigCreateSignature: string | null;
  readonly vaultAtaCreateSignature: string | null;
}

export async function setupSquadsVault(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
): Promise<SquadsSetupResult> {
  const createKeyKeypair = loadOrCreateKeypair('squads-create-key');
  const createKey = createKeyKeypair.publicKey;

  const [multisigPda] = multisig.getMultisigPda({ createKey });
  const [vaultPda] = multisig.getVaultPda({ multisigPda, index: VAULT_INDEX });

  const [vaultAtaAddress] = await findAssociatedTokenPda({
    owner: address(vaultPda.toBase58()),
    mint: address(mint.toBase58()),
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  const vaultAta = new PublicKey(vaultAtaAddress);

  let multisigCreated = false;
  let multisigCreateSignature: string | null = null;
  const existingMultisig = await connection.getAccountInfo(multisigPda);
  if (!existingMultisig) {
    // `treasury` is not a free choice: the program's `multisig_create`
    // instruction requires it to equal the address stored in the program's
    // own global `ProgramConfig` account (it collects the protocol's
    // multisig-creation fee), not an arbitrary key. Passing our own payer
    // here fails on-chain with `InvalidAccount` (confirmed by hand against
    // this program id on devnet) — read the real one first.
    const [programConfigPda] = multisig.getProgramConfigPda({});
    const programConfig = await multisig.accounts.ProgramConfig.fromAccountAddress(
      connection,
      programConfigPda,
    );

    multisigCreateSignature = await multisig.rpc.multisigCreateV2({
      connection,
      createKey: createKeyKeypair,
      creator: payer,
      multisigPda,
      configAuthority: null,
      threshold: 1,
      members: [
        {
          key: payer.publicKey,
          permissions: multisig.types.Permissions.all(),
        },
      ],
      timeLock: 0,
      rentCollector: null,
      treasury: programConfig.treasury,
      memo: 'assay platform devnet treasury vault',
      sendOptions: { skipPreflight: false },
    });
    multisigCreated = true;
  }

  let vaultAtaCreated = false;
  let vaultAtaCreateSignature: string | null = null;
  const existingAta = await connection.getAccountInfo(vaultAta);
  if (!existingAta) {
    const createAtaIx = getCreateAssociatedTokenIdempotentInstruction({
      // A noop signer: this instruction is only ever built here to be
      // converted and sent through web3.js (`sendAndConfirmTransaction`
      // below signs with the real web3.js `payer` Keypair) — kit never
      // signs anything in this script, so it only needs a value that
      // satisfies `TransactionSigner`'s shape, not one that can actually sign.
      payer: createNoopSigner(address(payer.publicKey.toBase58())),
      owner: address(vaultPda.toBase58()),
      mint: address(mint.toBase58()),
      ata: vaultAtaAddress,
    });
    const tx = new Transaction().add(kitInstructionToWeb3(createAtaIx));
    vaultAtaCreateSignature = await sendAndConfirmTransaction(connection, tx, [payer]);
    vaultAtaCreated = true;
  }

  // Record the create_key so `backend/.env`'s `SOLANA_VAULT_MULTISIG_CREATE_KEY`
  // can be set to it — printed by the caller, not written to `.env` here,
  // since `.env.example` and this deployment's own `.env` are outside this
  // script's ownership.
  saveState('squads-vault', {
    createKey: createKey.toBase58(),
    multisigPda: multisigPda.toBase58(),
    vaultPda: vaultPda.toBase58(),
    vaultAta: vaultAta.toBase58(),
    vaultIndex: VAULT_INDEX,
  });

  return {
    createKey,
    multisigPda,
    vaultPda,
    vaultAta,
    multisigCreated,
    vaultAtaCreated,
    multisigCreateSignature,
    vaultAtaCreateSignature,
  };
}

export function loadSquadsVaultState(): {
  createKey: string;
  multisigPda: string;
  vaultPda: string;
  vaultAta: string;
  vaultIndex: number;
} | null {
  return loadState('squads-vault');
}
