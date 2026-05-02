import type { Context } from "hono";
import { currentAccessPrincipal, isAuthEnabled, type AuthVariables } from "./access-control.js";

export const LOCAL_DATA_OWNER_ID = "local";

export interface DataOwner {
  id: string;
  label: string;
  isLocal: boolean;
}

export function currentDataOwner(c: Context<{ Variables: AuthVariables }>): DataOwner {
  const auth = c.get("auth");
  if (!isAuthEnabled() || auth?.isAdmin) {
    return {
      id: LOCAL_DATA_OWNER_ID,
      label: auth?.isAdmin ? "Admin local" : "Local",
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
