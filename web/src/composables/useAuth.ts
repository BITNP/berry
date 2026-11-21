import { reactive } from "vue";

import { apiFetch, setCsrfToken } from "../api/client.ts";

export interface AuthUser {
  subject: string;
  name: string;
  email: string;
  avatar: string | null;
  permissions: {
    systemAdmin: boolean;
    managementAccess?: boolean;
    manager: boolean;
    accessDepartments: string[];
    managedDepartments: string[];
    positions: { code: string; label: string }[];
  };
}

interface AuthStatusResponse {
  state: "active" | "anonymous";
  user: AuthUser | null;
  csrfToken?: string;
  oidcConfigured: boolean;
  devAuthBypass: boolean;
}

const state = reactive<{
  loaded: boolean;
  authenticated: boolean;
  user: AuthUser | null;
  oidcConfigured: boolean;
  devAuthBypass: boolean;
}>({
  loaded: false,
  authenticated: false,
  user: null,
  oidcConfigured: false,
  devAuthBypass: false,
});

export async function refreshAuthStatus(force = false): Promise<boolean> {
  if (state.loaded && !force) {
    return state.authenticated;
  }

  const res = await apiFetch<AuthStatusResponse>("/api/auth/status");

  state.loaded = true;
  state.authenticated = res.state === "active" && res.user !== null;
  state.user = res.user;
  state.oidcConfigured = res.oidcConfigured;
  state.devAuthBypass = res.devAuthBypass;
  setCsrfToken(res.csrfToken ?? "");

  return state.authenticated;
}

export async function logout(): Promise<void> {
  await apiFetch("/api/auth/logout", { method: "POST" });
  state.authenticated = false;
  state.user = null;
  setCsrfToken("");
}

export const useAuth = () => state;
