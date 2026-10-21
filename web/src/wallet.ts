// Wallet via @hot-labs/near-connect. Kept as the single sign-in/out surface;
// the wallet instance itself lives in wallet-bridge.ts so signing shares it.
import { signIn as bridgeSignIn, signOut as bridgeSignOut, initConnector, type Network } from "./wallet-bridge";

let initialized = false;

export async function connectWallet(network: Network): Promise<string> {
  if (!initialized) {
    initConnector(network);
    initialized = true;
  }
  return bridgeSignIn();
}

export async function disconnectWallet(): Promise<void> {
  await bridgeSignOut();
}
