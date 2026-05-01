import type { Context } from "hono";
import { currentAccessPrincipal, isAuthEnabled, type AuthVariables } from "./access-control.js";

export const LOCAL_DATA_OWNER_ID = "local";

export interface DataOwner {
  id: string;
  label: string;
  isLocal: boolean;
}

export function currentDataOwner(c: Context<{ Variables: AuthVariables }>): DataOwner {
  if (!isAuthEnabled()) {
    return {
      id: LOCAL_DATA_OWNER_ID,
      label: "Local",
      isLocal: true
    };
  }

  const principal = currentAccessPrincipal(c);
  if (!principal) {
    throw new Error("Missing access token owner.");
  }

  return {
    id: principal.id,
    label: principal.label,
    isLocal: false
  };
}
