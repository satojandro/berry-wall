// Shared wallet instance bridge so sign.ts and wallet.ts use the same session.
// near-connect: the correct entry point is connector.connect() — it opens the
// wallet-selection popup, persists the chosen wallet, and runs signIn internally.
// (Calling connector.wallet() before any wallet is selected throws
// "No accounts found" — that was the sign-in bug.)
import { NearConnector } from "@hot-labs/near-connect";

export type Network = "mainnet" | "testnet";

export interface WalletAccount {
  accountId: string;
  publicKey?: string;
}

interface WalletLike {
  getAccounts(): Promise<WalletAccount[]>;
  signAndSendTransactions(t: unknown): Promise<unknown>;
  signOut(): Promise<void>;
}

let connector: NearConnector | null = null;
let wallet: WalletLike | null = null;

export function initConnector(network: Network) {
  connector = new NearConnector({ network });
}

export async function signIn(): Promise<string> {
  if (!connector) throw new Error("connector not initialized");

  // connect() opens the wallet picker (if needed), signs in, and returns
  // the WALLET OBJECT — the accounts arrive via wallet.getAccounts()
  // (and the "wallet:signIn" event).
  const w = (await (connector as unknown as {
    connect(input?: object): Promise<unknown>;
  }).connect({})) as WalletLike;
  wallet = w;

  for (let i = 0; i < 30; i++) {
    try {
      const accs = await w.getAccounts();
      if (accs && accs.length > 0) return accs[0].accountId;
    } catch {
      // account list may not be populated immediately after the popup
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("signed in but no account was returned");
}

export async function signOut(): Promise<void> {
  if (!connector) return;
  try {
    await (connector as unknown as { disconnect(wallet?: unknown): Promise<void> }).disconnect();
  } finally {
    wallet = null;
  }
}

export async function getWallet(): Promise<WalletLike> {
  if (!wallet) {
    if (!connector) throw new Error("connector not initialized");
    wallet = (await connector.wallet()) as unknown as WalletLike;
  }
  return wallet;
}
