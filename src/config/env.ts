import { resolve } from "node:path";

export interface EnvConfig {
  host: string;
  port: number;
  publicUrl: string;
  dataDir: string;
  webhookToken: string;
  gatewayUrl: string;
  gatewayAccount: string;
  gatewayToken: string;
  oidcIssuer: string;
  oidcClientId: string;
  oidcClientSecret: string;
  devAuthBypass: boolean;
  devAuthSubject: string;
  devAuthName: string;
  keycloakAdminUrl: string;
  keycloakClientId: string;
  keycloakClientSecret: string;
  keycloakQqAttr: string;
  guildApiUrl: string;
  guildInternalToken: string;
  guildDatabaseUrl: string;
  guildPublicUrl: string;
  botQQ: string;
  mainBaseUrl: string;
  mainApiKey: string;
  mainModel: string;
  gateBaseUrl: string;
  gateApiKey: string;
  gateModel: string;
}

const readEnv = (
  env: Record<string, string | undefined>,
  key: string,
  fallback = "",
): string => (env[key] ?? fallback).trim();

function readBool(
  env: Record<string, string | undefined>,
  key: string,
  fallback = false,
): boolean {
  const value = readEnv(env, key).toLowerCase();

  if (!value) {
    return fallback;
  }

  return ["1", "on", "true", "yes"].includes(value);
}

function readPort(
  env: Record<string, string | undefined>,
  key: string,
  fallback: number,
): number {
  const raw = readEnv(env, key);

  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new Error(`Invalid port in ${key}: ${raw}`);
  }

  return parsed;
}

export function loadEnvConfig(
  env: Record<string, string | undefined> = process.env,
): EnvConfig {
  const publicUrl = readEnv(
    env,
    "BERRY_PUBLIC_URL",
    "http://127.0.0.1:3220",
  ).replace(/\/+$/, "");

  if (
    !URL.canParse(publicUrl) ||
    !["http:", "https:"].includes(new URL(publicUrl).protocol)
  ) {
    throw new Error(`BERRY_PUBLIC_URL must be an http(s) URL: ${publicUrl}`);
  }

  return {
    host: readEnv(env, "BERRY_HOST", "127.0.0.1"),
    port: readPort(env, "BERRY_PORT", 3220),
    publicUrl,
    dataDir: resolve(readEnv(env, "BERRY_DATA_DIR", "./data")),
    webhookToken: readEnv(env, "BERRY_WEBHOOK_TOKEN"),
    gatewayUrl: readEnv(env, "BERRY_GATEWAY_URL").replace(/\/+$/, ""),
    gatewayAccount: readEnv(env, "BERRY_GATEWAY_ACCOUNT", "qq"),
    gatewayToken: readEnv(env, "BERRY_GATEWAY_TOKEN"),
    oidcIssuer: readEnv(env, "BERRY_OIDC_ISSUER").replace(/\/+$/, ""),
    oidcClientId: readEnv(env, "BERRY_OIDC_CLIENT_ID"),
    oidcClientSecret: readEnv(env, "BERRY_OIDC_CLIENT_SECRET"),
    devAuthBypass: readBool(env, "BERRY_DEV_AUTH_BYPASS", false),
    devAuthSubject: readEnv(env, "BERRY_DEV_AUTH_SUBJECT", "dev-admin"),
    devAuthName: readEnv(env, "BERRY_DEV_AUTH_NAME", "Dev Admin"),
    keycloakAdminUrl: readEnv(env, "BERRY_KEYCLOAK_ADMIN_URL").replace(
      /\/+$/,
      "",
    ),
    keycloakClientId: readEnv(env, "BERRY_KEYCLOAK_CLIENT_ID"),
    keycloakClientSecret: readEnv(env, "BERRY_KEYCLOAK_CLIENT_SECRET"),
    keycloakQqAttr: readEnv(env, "BERRY_KEYCLOAK_QQ_ATTR", "qq_number"),
    guildApiUrl: readEnv(env, "BERRY_GUILD_API_URL").replace(/\/+$/, ""),
    guildInternalToken: readEnv(env, "BERRY_GUILD_INTERNAL_TOKEN"),
    guildDatabaseUrl: readEnv(env, "BERRY_GUILD_DATABASE_URL"),
    guildPublicUrl: readEnv(env, "BERRY_GUILD_PUBLIC_URL").replace(/\/+$/, ""),
    botQQ: readEnv(env, "BERRY_BOT_QQ"),
    mainBaseUrl: readEnv(
      env,
      "BERRY_MAIN_BASE_URL",
      "https://api.openai.com/v1",
    ),
    mainApiKey: readEnv(env, "BERRY_MAIN_API_KEY"),
    mainModel: readEnv(env, "BERRY_MAIN_MODEL", "gpt-4.1-mini"),
    gateBaseUrl: readEnv(
      env,
      "BERRY_GATE_BASE_URL",
      "https://api.openai.com/v1",
    ),
    gateApiKey: readEnv(env, "BERRY_GATE_API_KEY"),
    gateModel: readEnv(env, "BERRY_GATE_MODEL", "gpt-4.1-nano"),
  };
}
