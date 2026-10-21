// NEAR RPC client for the board contract. View calls only here;
// signing goes through the wallet adapter in wallet.ts.
import type {
  AccountView, BoardMeta, ChunkData, DrawInput, PixelsPage,
} from "./protocol";

export interface ViewCaller {
  view(args: { methodName: string; args: Record<string, unknown> }): Promise<unknown>;
}

export class BoardClient {
  constructor(
    public contractId: string,
    public caller: ViewCaller,
  ) {}

  async getBoard(): Promise<BoardMeta> {
    return (await this.caller.view({ methodName: "get_board", args: {} })) as BoardMeta;
  }

  async getChunkVersions(): Promise<number[]> {
    return (await this.caller.view({
      methodName: "get_chunk_versions", args: {},
    })) as number[];
  }

  async getChunk(chunkIndex: number, sinceVersion: number): Promise<ChunkData> {
    return (await this.caller.view({
      methodName: "get_chunk",
      args: { chunk_index: chunkIndex, since_version: sinceVersion },
    })) as ChunkData;
  }

  async getPixels(fromIndex: number, limit: number): Promise<PixelsPage> {
    return (await this.caller.view({
      methodName: "get_pixels",
      args: { from_index: fromIndex, limit },
    })) as PixelsPage;
  }

  async getAccount(accountId: string): Promise<AccountView> {
    return (await this.caller.view({
      methodName: "get_account",
      args: { account_id: accountId },
    })) as AccountView;
  }

  drawArgs(pixels: DrawInput[]): Record<string, unknown> {
    return { pixels };
  }
}
