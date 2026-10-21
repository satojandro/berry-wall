// Minimal signing helper. near-connect's wallet object exposes
// signAndSendTransactions; this wraps it. Kept separate so main.ts stays readable.
import type { Action } from "@near-js/transactions";

export async function signAndSendTransaction(opts: {
  receiverId: string;
  actions: Action[];
}): Promise<{ hash: string }> {
  const { getWallet } = await import("./wallet-bridge");
  const wallet = await getWallet();
  const outcomes = (await wallet.signAndSendTransactions({
    transactions: [{ receiverId: opts.receiverId, actions: opts.actions }],
  })) as Array<{ transaction?: { hash?: string } }>;
  return { hash: outcomes?.[0]?.transaction?.hash ?? "" };
}
