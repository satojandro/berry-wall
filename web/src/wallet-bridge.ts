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

  // connect({}) opens the wallet picker popup if none is selected, then signs in.
  const accounts = (await (connector as unknown as {
    connect(input?: object): Promise<WalletAccount[]>;
  }).connect({})) as WalletAccount[];

  if (!accounts || accounts.length === 0) {
    throw new Error("wallet returned no accounts");
  }

  wallet = (await connector.wallet()) as unknown as WalletLike;
  return accounts[0].accountId;
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
