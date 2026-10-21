// Shared wallet instance bridge so sign.ts and wallet.ts use the same session.
// near-connect SDK: signIn() resolves to Account[]; getAccounts() is the
// post-popup fallback for bridges that resolve before the popup completes.
import { NearConnector } from "@hot-labs/near-connect";

export type Network = "mainnet" | "testnet";

export interface WalletAccount {
  accountId: string;
  publicKey?: string;
}

interface WalletLike {
  signIn(data?: unknown): Promise<unknown>;
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
  if (!wallet) wallet = (await connector.wallet()) as unknown as WalletLike;

  const res = await wallet.signIn();
  const accounts = normalizeAccounts(res);
  if (accounts.length > 0) return accounts[0].accountId;

  // Popup flow may complete after signIn resolves; poll briefly.
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const accs = await wallet.getAccounts();
      if (accs && accs.length > 0) return accs[0].accountId;
    } catch {
      // keep polling until timeout
    }
  }
  throw new Error("no account returned by wallet (did you complete the popup?)");
}

export async function signOut(): Promise<void> {
  if (!wallet) return;
  await wallet.signOut();
  wallet = null;
}

export async function getWallet(): Promise<WalletLike> {
  if (!wallet) throw new Error("not signed in");
  return wallet;
}

function normalizeAccounts(res: unknown): WalletAccount[] {
  if (Array.isArray(res)) return res as WalletAccount[];
  if (res && typeof res === "object") {
    const r = res as { accounts?: WalletAccount[]; accountId?: string };
    if (Array.isArray(r.accounts)) return r.accounts;
    if (typeof r.accountId === "string") return [{ accountId: r.accountId }];
  }
  return [];
}
