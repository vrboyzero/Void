/** Native MCP clients omit Origin; browser clients need an explicit exact-origin grant. */
import { ControlError } from "./protocol.js";

export function validateOrigins(origins: readonly string[]): void {
  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin || url.hostname.includes("*")) throw new Error();
    } catch {
      throw new ControlError("dsh-control/invalid-request", "allowedOrigins must contain exact HTTP(S) origins without paths or wildcards");
    }
  }
}

export function requireOrigin(header: string | string[] | undefined, allowedOrigins: readonly string[]): void {
  if (header === undefined) return;
  validateOrigins(allowedOrigins);
  if (typeof header !== "string" || !allowedOrigins.includes(header)) {
    throw new ControlError("dsh-control/forbidden-origin", "request Origin is not allowed");
  }
}
