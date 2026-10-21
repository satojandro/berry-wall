// Shared wallet instance bridge so sign.ts and wallet.ts use the same session.
import { NearConnector } from "@hot-labs/near-connect";

let connector: NearConnector | null = null;
let wallet: { signAndSendTransactions(t: unknown): Promise<unknown> } | null = null;

export function initConnector(network: "mainnet" | "testnet") {
  connector = new NearConnector({ network });
}

export async function signIn(): Promise<string> {
  if (!connector) throw new Error("connector not initialized");
  const w = (await connector.wallet()) as unknown as {
    signIn(o: unknown): Promise<{ accountId: string }>;
  };
  const res = await w.signIn({ contractId: undefined });
  wallet = (await connector.wallet()) as unknown as {
    signAndSendTransactions(t: unknown): Promise<unknown>;
  };
  return res.accountId;
}

export async function signOut(): Promise<void> {
  if (!wallet) return;
  const w = wallet as unknown as { signOut(): Promise<void> };
  await w.signOut();
  wallet = null;
}

export async function getWallet() {
  if (!wallet) throw new Error("not signed in");
  return wallet;
}
