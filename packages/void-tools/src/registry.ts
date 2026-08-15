import { Service, type Context } from "@deepseek-ai/cordis";
import type { ToolContract } from "./contract.js";

declare module "@deepseek-ai/cordis" {
  interface Context {
    voidToolContracts: VoidToolContracts;
  }
}

/**
 * Service Definition: the void-tools contract registry. Star attaches
 * `ToolContract` to each Tool (`withToolContract`); here the contract lives in
 * a named registry so the governance seam can be consumed without importing
 * the tool's module (matching dsh's "consume by name" convention).
 */
export class VoidToolContracts extends Service {
  private readonly contracts = new Map<string, ToolContract>();

  constructor(ctx: Context) {
    super(ctx, "voidToolContracts");
  }

  register(contract: ToolContract): () => void {
    return this.ctx.effect(() => {
      this.contracts.set(contract.name, contract);
      return () => {
        this.contracts.delete(contract.name);
      };
    }, "voidToolContracts.register()");
  }

  get(name: string): ToolContract | undefined {
    return this.contracts.get(name);
  }
}

export default VoidToolContracts;
