import { config as loadEnv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";
import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
loadEnv({ path: resolve(root, ".env") });
const dataDir = resolve(root, "data");
const storePath = resolve(dataDir, "gateway-config.json");
const keyStorePath = resolve(dataDir, "client-keys.json");
const requestStorePath = resolve(dataDir, "requests.json");
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecret =
  process.env.SUPABASE_SECRET_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
const ownerUserId = process.env.ROUTEFUSION_OWNER_ID;
const databaseEnabled = !!(supabaseUrl && supabaseSecret && ownerUserId);
const anySupabaseConfig = !!(supabaseUrl || supabaseSecret || ownerUserId);
if (anySupabaseConfig && !databaseEnabled)
  throw new Error(
    "Configure SUPABASE_URL, SUPABASE_SECRET_KEY, and ROUTEFUSION_OWNER_ID together, or leave all three empty for local development.",
  );
if (
  ownerUserId &&
  !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    ownerUserId,
  )
)
  throw new Error(
    "ROUTEFUSION_OWNER_ID must be the UUID of the Supabase owner account.",
  );
if (process.env.NODE_ENV === "production" && !databaseEnabled)
  throw new Error(
    "Set SUPABASE_URL, SUPABASE_SECRET_KEY, and ROUTEFUSION_OWNER_ID for production.",
  );
if (
  process.env.NODE_ENV === "production" &&
  (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 24)
)
  throw new Error(
    "Set a stable ENCRYPTION_KEY of at least 24 characters for production.",
  );
if (process.env.NODE_ENV === "production" && !process.env.CORS_ORIGIN)
  throw new Error(
    "Set CORS_ORIGIN to the dashboard HTTPS origin in production.",
  );
const supabase: SupabaseClient | null = databaseEnabled
  ? createClient(supabaseUrl!, supabaseSecret!, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;
const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    redact: ["req.headers.authorization", "req.body.apiKey"],
  },
  bodyLimit: 1_048_576,
});
const allowedOrigins = process.env.CORS_ORIGIN?.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean) ?? ["http://localhost:5173"];
if (!allowedOrigins.length)
  throw new Error("CORS_ORIGIN must include at least one dashboard origin.");
if (
  process.env.NODE_ENV === "production" &&
  allowedOrigins.some((origin) => {
    try {
      return (
        new URL(origin).protocol !== "https:" ||
        new URL(origin).origin !== origin
      );
    } catch {
      return true;
    }
  })
)
  throw new Error(
    "Production CORS_ORIGIN entries must be exact HTTPS origins without paths.",
  );
await app.register(cors, { origin: allowedOrigins });
const requestsPerMinute = Math.max(
  1,
  Math.min(
    10000,
    Math.floor(Number(process.env.REQUESTS_PER_MINUTE ?? 120) || 120),
  ),
);
await app.register(rateLimit, {
  max: supabase ? 300 : requestsPerMinute,
  timeWindow: "1 minute",
  keyGenerator: (req) => {
    const token = req.headers.authorization?.replace(/^Bearer\s+/, "");
    return token ? createHash("sha256").update(token).digest("hex") : req.ip;
  },
});
app.setErrorHandler((error, req, reply) => {
  req.log.error({ err: error }, "Request failed");
  const candidate =
    error && typeof error === "object" && "statusCode" in error
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  const status =
    typeof candidate === "number" && candidate >= 400 ? candidate : 500;
  return reply
    .code(status)
    .send({
      error: {
        message:
          status >= 500
            ? "The gateway could not complete the request."
            : "The request could not be processed.",
        type: status >= 500 ? "server_error" : "request_error",
        request_id: req.id,
      },
    });
});
app.setNotFoundHandler((req, reply) =>
  reply
    .code(404)
    .send({
      error: {
        message: "Route not found",
        type: "not_found",
        request_id: req.id,
      },
    }),
);

const capabilitySchema = z
  .object({
    chat: z.boolean().default(true),
    streaming: z.boolean().default(true),
    tools: z.boolean().default(false),
    vision: z.boolean().default(false),
    reasoning: z.boolean().default(false),
  })
  .default({});
type Capabilities = z.infer<typeof capabilitySchema>;
const baseUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    },
    { message: "Use an http(s) URL without embedded credentials" },
  );
type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  apiKeyEnv?: string;
  apiKeyCiphertext?: string;
  keyHint?: string;
  priority: number;
  timeoutMs: number;
  enabled: boolean;
  status: "unknown" | "healthy" | "degraded" | "limited" | "offline";
  latency: number | null;
  cooldownUntil: number;
  failures: number;
};
type ModelEndpoint = {
  id: string;
  logicalModelId: string;
  providerId: string;
  providerModelId: string;
  displayName: string;
  capabilities: Capabilities;
  contextWindow: number | null;
  enabled: boolean;
  priority: number;
};
type RequestLog = {
  id: string;
  time: string;
  virtualModel: string;
  provider: string;
  actualModel: string;
  latency: number;
  tokens: number | null;
  status: number;
  attempts: string[];
  apiKeyId: string | null;
  apiKeyName: string;
};
type ClientKey = {
  id: string;
  name: string;
  prefix: string;
  hash: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
};
const envProviderSchema = z.array(
  z.object({
    id: z.string().regex(/^[a-z0-9_-]+$/),
    name: z.string().min(1),
    baseUrl: baseUrlSchema,
    model: z.string().min(1),
    logicalModelId: z.string().default("rf-auto"),
    apiKeyEnv: z.string().min(1),
    priority: z.number().int().default(100),
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().min(1000).max(120000).default(30000),
    contextWindow: z.number().int().positive().nullable().default(null),
    capabilities: capabilitySchema,
  }),
);
const storedSchema = z.object({
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      baseUrl: baseUrlSchema,
      apiKeyEnv: z.string().optional(),
      apiKeyCiphertext: z.string().optional(),
      keyHint: z.string().optional(),
      priority: z.number().int(),
      timeoutMs: z.number().int(),
      enabled: z.boolean(),
    }),
  ),
  models: z.array(
    z.object({
      id: z.string(),
      logicalModelId: z.string(),
      providerId: z.string(),
      providerModelId: z.string(),
      displayName: z.string(),
      capabilities: capabilitySchema,
      contextWindow: z.number().int().positive().nullable(),
      enabled: z.boolean(),
      priority: z.number().int(),
    }),
  ),
});
const envProviders = envProviderSchema.parse(
  process.env.PROVIDERS_JSON ? JSON.parse(process.env.PROVIDERS_JSON) : [],
);
let providers: Provider[] = [];
let models: ModelEndpoint[] = [];
let configLoadedAt = 0;
let configLoadPromise: Promise<void> | null = null;
const requests: RequestLog[] = [];
const clientKeys: ClientKey[] = [];

function encryptionKey() {
  const secret = process.env.ENCRYPTION_KEY;
  if (!secret || secret.length < 24)
    throw new Error(
      "Set ENCRYPTION_KEY to at least 24 characters before saving provider API keys.",
    );
  return createHash("sha256").update(secret).digest();
}
function encryptSecret(secret: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(secret, "utf8"),
    cipher.final(),
  ]);
  return `${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${encrypted.toString("base64")}`;
}
function decryptSecret(value: string) {
  const [iv, tag, ciphertext] = value.split(".");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
function providerKey(p: Provider) {
  if (p.apiKeyEnv) return process.env[p.apiKeyEnv] || null;
  if (p.apiKeyCiphertext) {
    try {
      return decryptSecret(p.apiKeyCiphertext);
    } catch {
      return null;
    }
  }
  return null;
}
function publicProvider(p: Provider) {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    status: p.status,
    priority: p.priority,
    timeoutMs: p.timeoutMs,
    latency: p.latency,
    enabled: p.enabled,
    apiKeyConfigured: !!providerKey(p),
    apiKeyHint: p.keyHint ?? null,
    models: models.filter((m) => m.providerId === p.id).length,
  };
}
function publicModel(m: ModelEndpoint) {
  return {
    ...m,
    providerName:
      providers.find((p) => p.id === m.providerId)?.name ?? "Unknown",
  };
}
function makeEnvProvider(
  p: z.infer<typeof envProviderSchema>[number],
): Provider {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl.replace(/\/$/, ""),
    apiKeyEnv: p.apiKeyEnv,
    priority: p.priority,
    timeoutMs: p.timeoutMs,
    enabled: p.enabled,
    status: process.env[p.apiKeyEnv] ? "unknown" : "offline",
    latency: null,
    cooldownUntil: 0,
    failures: 0,
  };
}
function makeEnvModel(
  p: z.infer<typeof envProviderSchema>[number],
): ModelEndpoint {
  return {
    id: `env_${p.id}_${p.model}`.replace(/[^a-zA-Z0-9_-]/g, "_"),
    logicalModelId: p.logicalModelId,
    providerId: p.id,
    providerModelId: p.model,
    displayName: p.model,
    capabilities: p.capabilities,
    contextWindow: p.contextWindow,
    enabled: p.enabled,
    priority: p.priority,
  };
}
async function loadConfigFromStore() {
  if (supabase) {
    const [pResult, mResult] = await Promise.all([
      supabase.from("rf_providers").select("*").eq("owner_id", ownerUserId),
      supabase.from("rf_models").select("*").eq("owner_id", ownerUserId),
    ]);
    if (pResult.error || mResult.error)
      throw new Error(
        `Could not load Supabase configuration: ${pResult.error?.message ?? mResult.error?.message}`,
      );
    providers = (pResult.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      baseUrl: p.base_url,
      apiKeyEnv: p.api_key_env ?? undefined,
      apiKeyCiphertext: p.api_key_ciphertext ?? undefined,
      keyHint: p.key_hint ?? undefined,
      priority: p.priority,
      timeoutMs: p.timeout_ms,
      enabled: p.enabled,
      status: p.status,
      latency: p.latency,
      cooldownUntil: Number(p.cooldown_until ?? 0),
      failures: p.failures ?? 0,
    }));
    models = (mResult.data ?? []).map((m) => ({
      id: m.id,
      logicalModelId: m.logical_model_id,
      providerId: m.provider_id,
      providerModelId: m.provider_model_id,
      displayName: m.display_name,
      capabilities: capabilitySchema.parse(m.capabilities),
      contextWindow: m.context_window,
      enabled: m.enabled,
      priority: m.priority,
    }));
    return;
  }
  try {
    const raw = JSON.parse(await readFile(storePath, "utf8"));
    const parsed = storedSchema.parse(raw);
    providers = parsed.providers.map((p) => ({
      ...p,
      status: providerKey({
        ...p,
        status: "unknown",
        latency: null,
        cooldownUntil: 0,
        failures: 0,
      })
        ? "unknown"
        : "offline",
      latency: null,
      cooldownUntil: 0,
      failures: 0,
    }));
    models = parsed.models;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error(
        `Could not read provider/model configuration: ${error instanceof Error ? error.message : "invalid configuration"}`,
      );
    providers = envProviders.map(makeEnvProvider);
    models = envProviders.map(makeEnvModel);
  }
}
async function loadConfig(force = false) {
  if (!force && Date.now() - configLoadedAt < 3000) return;
  if (!configLoadPromise) {
    configLoadPromise = loadConfigFromStore()
      .then(() => {
        configLoadedAt = Date.now();
      })
      .finally(() => {
        configLoadPromise = null;
      });
  }
  await configLoadPromise;
}
let saveQueue = Promise.resolve();
function saveConfig() {
  if (supabase)
    throw new Error(
      "Use row-level Supabase persistence for hosted configuration.",
    );
  const write = async () => {
    await mkdir(dataDir, { recursive: true });
    const payload = {
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl,
        ...(p.apiKeyEnv ? { apiKeyEnv: p.apiKeyEnv } : {}),
        ...(p.apiKeyCiphertext ? { apiKeyCiphertext: p.apiKeyCiphertext } : {}),
        ...(p.keyHint ? { keyHint: p.keyHint } : {}),
        priority: p.priority,
        timeoutMs: p.timeoutMs,
        enabled: p.enabled,
      })),
      models,
    };
    const temp = `${storePath}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(payload, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temp, storePath);
  };
  saveQueue = saveQueue.then(write, write);
  return saveQueue;
}
async function persistProvider(p: Provider) {
  if (!supabase) return saveConfig();
  const { error } = await supabase
    .from("rf_providers")
    .upsert(
      {
        id: p.id,
        owner_id: ownerUserId,
        name: p.name,
        base_url: p.baseUrl,
        api_key_env: p.apiKeyEnv ?? null,
        api_key_ciphertext: p.apiKeyCiphertext ?? null,
        key_hint: p.keyHint ?? null,
        priority: p.priority,
        timeout_ms: p.timeoutMs,
        enabled: p.enabled,
        status: p.status,
        latency: p.latency,
        cooldown_until: p.cooldownUntil,
        failures: p.failures,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "owner_id,id" },
    );
  if (error) throw new Error(`Could not save provider: ${error.message}`);
}
async function persistModel(m: ModelEndpoint) {
  if (!supabase) return saveConfig();
  const { error } = await supabase
    .from("rf_models")
    .upsert({
      id: m.id,
      owner_id: ownerUserId,
      logical_model_id: m.logicalModelId,
      provider_id: m.providerId,
      provider_model_id: m.providerModelId,
      display_name: m.displayName,
      capabilities: m.capabilities,
      context_window: m.contextWindow,
      enabled: m.enabled,
      priority: m.priority,
    });
  if (error) throw new Error(`Could not save model: ${error.message}`);
}
async function removeProvider(id: string) {
  if (!supabase) return saveConfig();
  const { error } = await supabase
    .from("rf_providers")
    .delete()
    .eq("owner_id", ownerUserId)
    .eq("id", id);
  if (error) throw new Error(`Could not delete provider: ${error.message}`);
}
async function removeModel(id: string) {
  if (!supabase) return saveConfig();
  const { error } = await supabase
    .from("rf_models")
    .delete()
    .eq("owner_id", ownerUserId)
    .eq("id", id);
  if (error) throw new Error(`Could not delete model: ${error.message}`);
}
await loadConfig();
async function loadTelemetry() {
  if (supabase) {
    await loadClientKeys();
    return;
  }
  try {
    clientKeys.push(
      ...(JSON.parse(await readFile(keyStorePath, "utf8")) as ClientKey[]),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Could not read client API key store");
  }
  try {
    requests.push(
      ...(
        JSON.parse(await readFile(requestStorePath, "utf8")) as RequestLog[]
      ).slice(0, 10000),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new Error("Could not read request history");
  }
}
async function loadClientKeys() {
  if (!supabase) return;
  const { data, error } = await supabase
    .from("rf_client_keys")
    .select("*")
    .eq("owner_id", ownerUserId);
  if (error)
    throw new Error(`Could not load Supabase API keys: ${error.message}`);
  clientKeys.splice(
    0,
    clientKeys.length,
    ...(data ?? []).map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      hash: k.key_hash,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      revokedAt: k.revoked_at,
    })),
  );
}
async function touchClientKey(id: string) {
  const time = new Date().toISOString();
  if (supabase) {
    await supabase
      .from("rf_client_keys")
      .update({ last_used_at: time })
      .eq("owner_id", ownerUserId)
      .eq("id", id);
    return;
  }
  const key = clientKeys.find((k) => k.id === id);
  if (key) {
    key.lastUsedAt = time;
    await persistTelemetry();
  }
}
await loadTelemetry();
app.addHook("onRequest", async (req, reply) => {
  if (!supabase || req.url === "/health") return;
  try {
    await loadConfig();
  } catch (error) {
    return reply
      .code(503)
      .send({
        error:
          error instanceof Error ? error.message : "Supabase is unavailable",
      });
  }
});
async function consumeSharedRateLimit(token: string) {
  if (!supabase) return true;
  const { data, error } = await supabase.rpc("rf_consume_rate_limit", {
    p_subject_hash: hashClientKey(token),
    p_limit: requestsPerMinute,
  });
  if (error) throw new Error(`Rate limit store unavailable: ${error.message}`);
  return data === true;
}
let telemetryQueue = Promise.resolve();
function persistTelemetry() {
  if (supabase)
    return supabase
      .from("rf_client_keys")
      .upsert(
        clientKeys.map((k) => ({
          id: k.id,
          owner_id: ownerUserId,
          name: k.name,
          prefix: k.prefix,
          key_hash: k.hash,
          created_at: k.createdAt,
          last_used_at: k.lastUsedAt,
          revoked_at: k.revokedAt,
        })),
      )
      .then(({ error }) => {
        if (error)
          throw new Error(`Could not save Supabase API keys: ${error.message}`);
      });
  const write = async () => {
    await mkdir(dataDir, { recursive: true });
    for (const [path, payload] of [
      [keyStorePath, clientKeys],
      [requestStorePath, requests.slice(0, 10000)],
    ] as const) {
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(payload, null, 2), {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temp, path);
    }
  };
  telemetryQueue = telemetryQueue.then(write, write);
  return telemetryQueue;
}

const providerCreateSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9_-]+$/)
    .optional(),
  name: z.string().trim().min(1).max(80),
  baseUrl: baseUrlSchema,
  apiKey: z.string().min(1),
  priority: z.coerce.number().int().min(0).max(10000).default(100),
  timeoutMs: z.coerce.number().int().min(1000).max(120000).default(30000),
  enabled: z.boolean().default(true),
});
const providerPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    baseUrl: baseUrlSchema.optional(),
    apiKey: z.string().optional(),
    clearApiKey: z.boolean().optional(),
    priority: z.coerce.number().int().min(0).max(10000).optional(),
    timeoutMs: z.coerce.number().int().min(1000).max(120000).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });
const contextWindowSchema = z.preprocess(
  (value) =>
    value === null || value === "" || value === undefined
      ? null
      : Number(value),
  z.number().int().positive().nullable(),
);
const modelSchema = z.object({
  logicalModelId: z.string().trim().min(1).max(100),
  providerId: z.string().min(1),
  providerModelId: z.string().trim().min(1).max(160),
  displayName: z.string().trim().min(1).max(120),
  capabilities: capabilitySchema,
  contextWindow: contextWindowSchema.default(null),
  enabled: z.boolean().default(true),
  priority: z.coerce.number().int().min(0).max(10000).default(100),
});
const modelPatchSchema = modelSchema
  .partial()
  .refine((v) => Object.keys(v).length > 0, {
    message: "Provide at least one field to update",
  });
const chatSchema = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(z.object({ role: z.string(), content: z.any() }).passthrough())
      .min(1),
    stream: z.boolean().optional().default(false),
    tools: z.array(z.any()).optional(),
    max_tokens: z.number().optional(),
    temperature: z.number().optional(),
  })
  .passthrough();
async function admin(auth?: string) {
  const token = auth?.replace(/^Bearer\s+/, "");
  if (supabase) {
    if (!token) return false;
    const { data, error } = await supabase.auth.getUser(token);
    return !error && data.user?.id === ownerUserId;
  }
  const configured = process.env.ADMIN_SECRET;
  return (
    process.env.NODE_ENV !== "production" &&
    auth === `Bearer ${configured ?? "routefusion-local-admin"}`
  );
}
function hashClientKey(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
async function clientAuth(auth?: string) {
  const token = auth?.replace(/^Bearer\s+/, "");
  if (!token) return null;
  if (supabase) {
    const { data, error } = await supabase
      .from("rf_client_keys")
      .select("id,name,owner_id")
      .eq("owner_id", ownerUserId)
      .eq("key_hash", hashClientKey(token))
      .is("revoked_at", null)
      .maybeSingle();
    if (error)
      throw new Error("Client key verification storage is unavailable.");
    if (data) return { id: data.id, name: data.name, ownerId: data.owner_id };
    return null;
  }
  const key = clientKeys.find(
    (k) => !k.revokedAt && k.hash === hashClientKey(token),
  );
  if (key) return { id: key.id, name: key.name, ownerId: ownerUserId ?? "" };
  if (
    token === process.env.ROUTEFUSION_API_KEY ||
    (!process.env.ROUTEFUSION_API_KEY &&
      process.env.NODE_ENV !== "production" &&
      token === "rf_live_local_dev_key")
  )
    return {
      id: "environment",
      name: "Environment key",
      ownerId: ownerUserId ?? "",
    };
  return null;
}
async function record(log: RequestLog) {
  requests.unshift(log);
  requests.splice(10000);
  if (supabase) {
    const { error } = await supabase.rpc("rf_record_request", {
      p_owner_id: ownerUserId,
      p_row: {
        id: log.id,
        api_key_id: log.apiKeyId,
        api_key_name: log.apiKeyName,
        time: log.time,
        virtual_model: log.virtualModel,
        provider: log.provider,
        actual_model: log.actualModel,
        latency: log.latency,
        tokens: log.tokens,
        status: log.status,
        attempts: log.attempts,
      },
    });
    if (error)
      throw new Error(`Could not record Supabase usage: ${error.message}`);
    return;
  }
  await persistTelemetry();
}
async function recordSafely(log: RequestLog) {
  try {
    await record(log);
  } catch (error) {
    app.log.error(
      { err: error, requestId: log.id },
      "Request telemetry could not be persisted",
    );
  }
}
async function requireAdmin(
  req: { headers: { authorization?: string } },
  reply: import("fastify").FastifyReply,
) {
  if (await admin(req.headers.authorization)) return true;
  void reply.code(401).send({ error: "Admin authentication required" });
  return false;
}
function setKey(p: Provider, key: string) {
  const ciphertext = encryptSecret(key);
  p.apiKeyEnv = undefined;
  p.apiKeyCiphertext = ciphertext;
  p.keyHint = `••••••••${key.slice(-4)}`;
}
function routeCandidates(body: z.infer<typeof chatSchema>) {
  const tools = !!body.tools?.length;
  const vision = body.messages.some(
    (m) =>
      typeof m.content !== "string" &&
      JSON.stringify(m.content).toLowerCase().includes("image"),
  );
  const candidates = models
    .filter(
      (m) =>
        m.enabled &&
        (body.model === "rf-auto"
          ? true
          : m.logicalModelId === body.model ||
            m.providerModelId === body.model) &&
        m.capabilities.chat &&
        (!body.stream || m.capabilities.streaming) &&
        (!tools || m.capabilities.tools) &&
        (!vision || m.capabilities.vision),
    )
    .map((m) => ({
      model: m,
      provider: providers.find((p) => p.id === m.providerId),
    }))
    .filter(
      (x): x is { model: ModelEndpoint; provider: Provider } =>
        !!x.provider &&
        x.provider.enabled &&
        !!providerKey(x.provider) &&
        x.provider.status !== "offline" &&
        x.provider.cooldownUntil <= Date.now(),
    )
    .sort(
      (a, b) =>
        a.model.priority - b.model.priority ||
        a.provider.priority - b.provider.priority ||
        (a.provider.latency ?? Number.MAX_SAFE_INTEGER) -
          (b.provider.latency ?? Number.MAX_SAFE_INTEGER),
    );
  const used = new Set<string>();
  return candidates.filter((candidate) => {
    if (used.has(candidate.provider.id)) return false;
    used.add(candidate.provider.id);
    return true;
  });
}
function providerUrl(p: Provider, path: string) {
  return `${p.baseUrl.replace(/\/$/, "")}${path}`;
}
function privateIPv4(address: string) {
  const [a, b] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51) ||
    (a === 203 && b === 0)
  );
}
function privateAddress(address: string) {
  const family = isIP(address);
  if (family === 4) return privateIPv4(address);
  if (family === 6) {
    const ip = address.toLowerCase().split("%")[0];
    if (
      ip === "::" ||
      ip === "::1" ||
      ip.startsWith("::ffff:") ||
      ip.startsWith("fc") ||
      ip.startsWith("fd") ||
      /^fe[89ab]/.test(ip) ||
      ip.startsWith("ff")
    )
      return true;
    const mapped = ip.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return !!mapped && privateIPv4(mapped[1]);
  }
  return true;
}
async function assertSafeProviderUrl(raw: string) {
  if (
    process.env.NODE_ENV !== "production" &&
    process.env.ALLOW_PRIVATE_PROVIDER_URLS === "true"
  )
    return;
  const url = new URL(raw);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  )
    throw new Error("Private and local provider addresses are blocked.");
  const addresses = isIP(host)
    ? [{ address: host }]
    : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (
    !addresses.length ||
    addresses.some((result) => privateAddress(result.address))
  )
    throw new Error("Provider host must resolve only to public IP addresses.");
}
async function readLimitedText(response: Response, maxBytes: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Provider response exceeded the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString(
    "utf8",
  );
}
async function testProvider(p: Provider) {
  const key = providerKey(p);
  if (!key)
    return {
      ok: false,
      status: "offline",
      reason: "Provider API key is not configured",
    };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs);
  const started = Date.now();
  try {
    await assertSafeProviderUrl(p.baseUrl);
    const res = await fetch(providerUrl(p, "/models"), {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
      redirect: "manual",
    });
    p.latency = Date.now() - started;
    if (!res.ok) {
      p.status = res.status === 429 ? "limited" : "degraded";
      await res.body?.cancel();
      return {
        ok: false,
        status: p.status,
        latency: p.latency,
        reason: `Provider returned HTTP ${res.status}`,
      };
    }
    await res.body?.cancel();
    p.status = "healthy";
    p.failures = 0;
    p.cooldownUntil = 0;
    return { ok: true, status: p.status, latency: p.latency };
  } catch (error) {
    p.status = "offline";
    p.failures++;
    return {
      ok: false,
      status: p.status,
      reason:
        (error instanceof Error && error.message.includes("Private")) ||
        (error instanceof Error && error.message.includes("public IP"))
          ? error.message
          : "Provider connection failed or timed out",
    };
  } finally {
    clearTimeout(timer);
  }
}
async function persistProviderHealth(p: Provider) {
  if (!supabase) return;
  const { error } = await supabase
    .from("rf_providers")
    .update({
      status: p.status,
      latency: p.latency,
      cooldown_until: p.cooldownUntil,
      failures: p.failures,
      updated_at: new Date().toISOString(),
    })
    .eq("owner_id", ownerUserId)
    .eq("id", p.id);
  if (error)
    throw new Error(`Could not update provider health: ${error.message}`);
}
async function persistProviderHealthSafely(p: Provider) {
  try {
    await persistProviderHealth(p);
  } catch (error) {
    app.log.error(
      { err: error, providerId: p.id },
      "Provider health could not be persisted",
    );
  }
}

app.get("/", async () => ({
  service: "routefusion-api",
  status: "ok",
  health: "/health",
  ready: "/health/ready",
}));
app.get("/health", async () => ({ status: "ok", service: "routefusion-api" }));
app.get("/health/ready", async (_req, reply) => {
  if (!supabase) return { status: "ready", storage: "local" };
  const { error } = await supabase
    .from("rf_providers")
    .select("id", { head: true, count: "exact" })
    .eq("owner_id", ownerUserId);
  if (error)
    return reply.code(503).send({ status: "not_ready", storage: "supabase" });
  return { status: "ready", storage: "supabase" };
});
app.get("/health/providers", async () =>
  providers.map((p) => ({
    id: p.id,
    name: p.name,
    status: p.status,
    latency: p.latency,
  })),
);
app.get("/v1/models", async (req, reply) => {
  const authenticated = await clientAuth(req.headers.authorization);
  if (!authenticated)
    return reply
      .code(401)
      .send({
        error: { message: "Invalid API key", type: "authentication_error" },
      });
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/, "") ?? "";
  if (!(await consumeSharedRateLimit(bearer)))
    return reply
      .code(429)
      .send({
        error: { message: "Rate limit exceeded", type: "rate_limit_error" },
      });
  if (authenticated.id !== "environment")
    await touchClientKey(authenticated.id);
  await recordSafely({
    id: `req_${randomUUID().slice(0, 8)}`,
    time: new Date().toISOString(),
    virtualModel: "models.list",
    provider: "—",
    actualModel: "—",
    latency: 0,
    tokens: null,
    status: 200,
    attempts: [],
    apiKeyId: authenticated.id === "environment" ? null : authenticated.id,
    apiKeyName: authenticated.name,
  });
  return {
    object: "list",
    data: [
      ...new Set(models.filter((m) => m.enabled).map((m) => m.logicalModelId)),
    ].map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "routefusion",
    })),
  };
});
app.get("/admin/overview", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  if (supabase) {
    const { data, error } = await supabase.rpc("rf_overview_summary", {
      p_owner_id: ownerUserId,
    });
    if (error) throw error;
    return {
      ...data,
      activeProviders: providers.filter(
        (p) => p.enabled && p.status === "healthy",
      ).length,
      healthyModels: models.filter(
        (m) =>
          m.enabled &&
          providers.find((p) => p.id === m.providerId)?.status === "healthy",
      ).length,
      throughput: null,
      providers: providers.map(publicProvider),
      models: models.map(publicModel),
    };
  }
  const total = requests.length;
  return {
    totalRequests: total,
    success: total
      ? Math.round(
          (requests.filter((r) => r.status === 200).length / total) * 1000,
        ) / 10
      : null,
    failed: requests.filter((r) => r.status !== 200).length,
    activeProviders: providers.filter(
      (p) => p.enabled && p.status === "healthy",
    ).length,
    healthyModels: models.filter(
      (m) =>
        m.enabled &&
        providers.find((p) => p.id === m.providerId)?.status === "healthy",
    ).length,
    throughput: null,
    avgLatency: total
      ? Math.round(requests.reduce((a, r) => a + r.latency, 0) / total)
      : null,
    failovers: requests.filter((r) => r.attempts.length > 1).length,
    providers: providers.map(publicProvider),
    models: models.map(publicModel),
    logs: requests.slice(0, 50),
  };
});
app.get("/admin/api-keys", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  if (supabase) {
    const [{ data, error }, { data: counts, countError }] = await Promise.all([
      supabase
        .from("rf_client_keys")
        .select("*")
        .eq("owner_id", ownerUserId)
        .order("created_at", { ascending: false }),
      supabase
        .rpc("rf_key_request_counts", { p_owner_id: ownerUserId })
        .then((result) => ({ data: result.data, countError: result.error })),
    ]);
    if (error || countError) throw error ?? countError;
    return (data ?? []).map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.created_at,
      lastUsedAt: k.last_used_at,
      revokedAt: k.revoked_at,
      requests:
        (counts ?? []).find(
          (c: { api_key_id: string }) => c.api_key_id === k.id,
        )?.request_count ?? 0,
    }));
  }
  return [...clientKeys]
    .reverse()
    .map((k) => ({
      id: k.id,
      name: k.name,
      prefix: k.prefix,
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt,
      revokedAt: k.revokedAt,
      requests: requests.filter((r) => r.apiKeyId === k.id).length,
    }));
});
const keyNameSchema = z.object({ name: z.string().trim().min(1).max(80) });
function issueClientKey(name: string, previous?: ClientKey) {
  const secret = `rf_live_${randomBytes(32).toString("base64url")}`;
  const now = new Date().toISOString();
  const key: ClientKey = {
    id: previous?.id ?? randomUUID(),
    name,
    prefix: secret.slice(0, 15),
    hash: hashClientKey(secret),
    createdAt: previous?.createdAt ?? now,
    lastUsedAt: null,
    revokedAt: null,
  };
  if (previous) Object.assign(previous, key);
  else clientKeys.push(key);
  return { key, secret };
}
app.post("/admin/api-keys", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  if (supabase) await loadClientKeys();
  const parsed = keyNameSchema.safeParse(req.body);
  if (!parsed.success)
    return reply.code(400).send({ error: "API key name is required" });
  const issued = issueClientKey(parsed.data.name);
  try {
    await persistTelemetry();
    return reply
      .code(201)
      .send({
        id: issued.key.id,
        name: issued.key.name,
        prefix: issued.key.prefix,
        createdAt: issued.key.createdAt,
        secret: issued.secret,
      });
  } catch (error) {
    clientKeys.splice(clientKeys.indexOf(issued.key), 1);
    return reply
      .code(500)
      .send({
        error:
          error instanceof Error ? error.message : "Could not save API key",
      });
  }
});
app.post("/admin/api-keys/:id/rotate", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  if (supabase) await loadClientKeys();
  const key = clientKeys.find(
    (k) => k.id === (req.params as { id: string }).id && !k.revokedAt,
  );
  if (!key) return reply.code(404).send({ error: "Active API key not found" });
  const previous = { ...key };
  const issued = issueClientKey(key.name, key);
  try {
    await persistTelemetry();
    return {
      id: key.id,
      name: key.name,
      prefix: key.prefix,
      createdAt: key.createdAt,
      secret: issued.secret,
    };
  } catch (error) {
    Object.assign(key, previous);
    return reply
      .code(500)
      .send({
        error:
          error instanceof Error ? error.message : "Could not rotate API key",
      });
  }
});
app.delete("/admin/api-keys/:id", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  if (supabase) await loadClientKeys();
  const key = clientKeys.find(
    (k) => k.id === (req.params as { id: string }).id,
  );
  if (!key) return reply.code(404).send({ error: "API key not found" });
  const previous = key.revokedAt;
  key.revokedAt = new Date().toISOString();
  try {
    await persistTelemetry();
    return { ok: true };
  } catch (error) {
    key.revokedAt = previous;
    return reply
      .code(500)
      .send({
        error:
          error instanceof Error ? error.message : "Could not revoke API key",
      });
  }
});
app.get("/admin/usage", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  if (supabase) {
    const { data, error } = await supabase.rpc("rf_usage_summary", {
      p_owner_id: ownerUserId,
    });
    if (error) throw error;
    return data;
  }
  const day = Date.now() - 24 * 60 * 60 * 1000;
  const recent = requests.filter((r) => Date.parse(r.time) >= day);
  const byModel = Object.entries(
    recent.reduce(
      (a, r) => ({ ...a, [r.virtualModel]: [...(a[r.virtualModel] ?? []), r] }),
      {} as Record<string, RequestLog[]>,
    ),
  )
    .map(([model, rows]) => ({
      model,
      requests: rows?.length ?? 0,
      tokens: rows?.reduce((n, r) => n + (r.tokens ?? 0), 0) ?? 0,
    }))
    .sort((a, b) => b.requests - a.requests);
  const hourly = Array.from({ length: 24 }, (_, i) => {
    const start = Date.now() - (23 - i) * 3600000;
    const bucket = new Date(start);
    bucket.setMinutes(0, 0, 0);
    const hour = bucket.getTime();
    return {
      hour: bucket.toISOString(),
      requests: recent.filter(
        (r) =>
          Date.parse(r.time) >= hour && Date.parse(r.time) < hour + 3600000,
      ).length,
    };
  });
  return {
    retention: "Up to 10,000 requests",
    total: requests.length,
    last24Hours: recent.length,
    requests: recent.length,
    failed: recent.filter((r) => r.status < 200 || r.status >= 400).length,
    tokens: recent.reduce((n, r) => n + (r.tokens ?? 0), 0),
    byModel,
    byProvider: Object.entries(
      recent.reduce(
        (a, r) => ({ ...a, [r.provider]: (a[r.provider] ?? 0) + 1 }),
        {} as Record<string, number>,
      ),
    ).map(([provider, count]) => ({ provider, requests: count })),
    hourly,
    logs: requests.slice(0, 500),
  };
});
app.get("/admin/settings", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return { requestsPerMinute, requestRetention: 10000, allowedOrigins };
});
app.get("/admin/requests", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const raw = Number((req.query as { limit?: string }).limit ?? 1000);
  const limit = Number.isFinite(raw)
    ? Math.max(1, Math.min(5000, Math.floor(raw)))
    : 1000;
  if (supabase) {
    const { data, error } = await supabase
      .from("rf_request_logs")
      .select("*")
      .eq("owner_id", ownerUserId)
      .order("time", { ascending: false })
      .limit(limit);
    if (error) throw error;
    return (data ?? []).map((r) => ({
      id: r.id,
      time: r.time,
      virtualModel: r.virtual_model,
      provider: r.provider,
      actualModel: r.actual_model,
      latency: r.latency,
      tokens: r.tokens,
      status: r.status,
      attempts: r.attempts,
      apiKeyId: r.api_key_id,
      apiKeyName: r.api_key_name,
    }));
  }
  return requests.slice(0, limit);
});
app.get("/admin/providers", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return providers.map(publicProvider);
});
app.post("/admin/providers", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const parsed = providerCreateSchema.safeParse(req.body);
  if (!parsed.success)
    return reply
      .code(400)
      .send({ error: "Invalid provider", details: parsed.error.flatten() });
  try {
    const input = parsed.data;
    const id =
      input.id ??
      input.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    if (!id)
      return reply
        .code(400)
        .send({ error: "Provider name must include letters or numbers" });
    if (providers.some((p) => p.id === id))
      return reply
        .code(409)
        .send({ error: "A provider with this ID already exists" });
    const p: Provider = {
      id,
      name: input.name,
      baseUrl: input.baseUrl.replace(/\/$/, ""),
      priority: input.priority,
      timeoutMs: input.timeoutMs,
      enabled: input.enabled,
      status: "unknown",
      latency: null,
      cooldownUntil: 0,
      failures: 0,
    };
    setKey(p, input.apiKey);
    providers.push(p);
    try {
      await persistProvider(p);
    } catch (error) {
      providers.splice(providers.indexOf(p), 1);
      throw error;
    }
    return reply.code(201).send(publicProvider(p));
  } catch (error) {
    return reply
      .code(400)
      .send({
        error:
          error instanceof Error ? error.message : "Could not save provider",
      });
  }
});
app.patch("/admin/providers/:id", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const parsed = providerPatchSchema.safeParse(req.body);
  if (!parsed.success)
    return reply
      .code(400)
      .send({
        error: "Invalid provider update",
        details: parsed.error.flatten(),
      });
  const p = providers.find((x) => x.id === (req.params as { id: string }).id);
  if (!p) return reply.code(404).send({ error: "Provider not found" });
  const previous = { ...p };
  try {
    const update = parsed.data;
    if (update.name !== undefined) p.name = update.name;
    if (update.baseUrl !== undefined)
      p.baseUrl = update.baseUrl.replace(/\/$/, "");
    if (update.priority !== undefined) p.priority = update.priority;
    if (update.timeoutMs !== undefined) p.timeoutMs = update.timeoutMs;
    if (update.enabled !== undefined) p.enabled = update.enabled;
    if (update.clearApiKey) {
      p.apiKeyEnv = undefined;
      p.apiKeyCiphertext = undefined;
      p.keyHint = undefined;
      p.status = "offline";
    } else if (update.apiKey) {
      setKey(p, update.apiKey);
      p.status = "unknown";
    }
    await persistProvider(p);
    return publicProvider(p);
  } catch (error) {
    Object.assign(p, previous);
    return reply
      .code(400)
      .send({
        error:
          error instanceof Error ? error.message : "Could not save provider",
      });
  }
});
app.delete("/admin/providers/:id", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const id = (req.params as { id: string }).id;
  const index = providers.findIndex((p) => p.id === id);
  if (index < 0) return reply.code(404).send({ error: "Provider not found" });
  const [provider] = providers.splice(index, 1);
  const removed = models.filter((m) => m.providerId === id);
  models = models.filter((m) => m.providerId !== id);
  try {
    await removeProvider(id);
    return { ok: true };
  } catch (error) {
    providers.splice(index, 0, provider);
    models.push(...removed);
    return reply
      .code(500)
      .send({
        error:
          error instanceof Error ? error.message : "Could not delete provider",
      });
  }
});
app.post("/admin/providers/:id/test", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const p = providers.find((x) => x.id === (req.params as { id: string }).id);
  if (!p) return reply.code(404).send({ error: "Provider not found" });
  const result = await testProvider(p);
  if (supabase) await persistProvider(p);
  return result;
});
app.get("/admin/providers/:id/models", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const p = providers.find((x) => x.id === (req.params as { id: string }).id);
  if (!p) return reply.code(404).send({ error: "Provider not found" });
  const key = providerKey(p);
  if (!key)
    return reply
      .code(409)
      .send({
        error: "Configure a provider API key before fetching its model list.",
      });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), p.timeoutMs);
  try {
    await assertSafeProviderUrl(p.baseUrl);
    const response = await fetch(providerUrl(p, "/models"), {
      headers: { Authorization: `Bearer ${key}` },
      signal: controller.signal,
      redirect: "manual",
    });
    if (!response.ok) {
      await response.body?.cancel();
      return reply
        .code(response.status === 429 ? 429 : 502)
        .send({
          error: `Provider model list returned HTTP ${response.status}.`,
        });
    }
    const payload = JSON.parse(
      await readLimitedText(response, 5 * 1024 * 1024),
    ) as { data?: unknown };
    const data = Array.isArray(payload.data) ? payload.data : [];
    return {
      models: data
        .flatMap((item) => {
          if (
            !item ||
            typeof item !== "object" ||
            !("id" in item) ||
            typeof item.id !== "string"
          )
            return [];
          return [{ id: item.id }];
        })
        .slice(0, 1000),
    };
  } catch (error) {
    return reply
      .code(controller.signal.aborted ? 504 : 502)
      .send({
        error: controller.signal.aborted
          ? "Provider model list request timed out."
          : error instanceof Error
            ? error.message
            : "Could not fetch provider models.",
      });
  } finally {
    clearTimeout(timer);
  }
});
app.get("/admin/models", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  return models.map(publicModel);
});
app.post("/admin/models", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const parsed = modelSchema.safeParse(req.body);
  if (!parsed.success)
    return reply
      .code(400)
      .send({ error: "Invalid model", details: parsed.error.flatten() });
  if (!providers.some((p) => p.id === parsed.data.providerId))
    return reply.code(400).send({ error: "Select an existing provider" });
  if (
    models.some(
      (m) =>
        m.logicalModelId === parsed.data.logicalModelId &&
        m.providerId === parsed.data.providerId &&
        m.providerModelId === parsed.data.providerModelId,
    )
  )
    return reply
      .code(409)
      .send({
        error: "This virtual model is already mapped to that provider model",
      });
  const model: ModelEndpoint = { id: randomUUID(), ...parsed.data };
  models.push(model);
  try {
    await persistModel(model);
    return reply.code(201).send(publicModel(model));
  } catch (error) {
    models = models.filter((m) => m.id !== model.id);
    return reply
      .code(500)
      .send({
        error: error instanceof Error ? error.message : "Could not save model",
      });
  }
});
app.patch("/admin/models/:id", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const parsed = modelPatchSchema.safeParse(req.body);
  if (!parsed.success)
    return reply
      .code(400)
      .send({ error: "Invalid model update", details: parsed.error.flatten() });
  const model = models.find((m) => m.id === (req.params as { id: string }).id);
  if (!model) return reply.code(404).send({ error: "Model not found" });
  if (
    parsed.data.providerId &&
    !providers.some((p) => p.id === parsed.data.providerId)
  )
    return reply.code(400).send({ error: "Select an existing provider" });
  const previous = { ...model };
  Object.assign(model, parsed.data);
  if (
    models.some(
      (m) =>
        m.id !== model.id &&
        m.logicalModelId === model.logicalModelId &&
        m.providerId === model.providerId &&
        m.providerModelId === model.providerModelId,
    )
  ) {
    Object.assign(model, previous);
    return reply
      .code(409)
      .send({
        error: "This virtual model is already mapped to that provider model",
      });
  }
  try {
    await persistModel(model);
    return publicModel(model);
  } catch (error) {
    Object.assign(model, previous);
    return reply
      .code(500)
      .send({
        error: error instanceof Error ? error.message : "Could not save model",
      });
  }
});
app.delete("/admin/models/:id", async (req, reply) => {
  if (!(await requireAdmin(req, reply))) return;
  const id = (req.params as { id: string }).id;
  const index = models.findIndex((m) => m.id === id);
  if (index < 0) return reply.code(404).send({ error: "Model not found" });
  const [model] = models.splice(index, 1);
  try {
    await removeModel(id);
    return { ok: true };
  } catch (error) {
    models.splice(index, 0, model);
    return reply
      .code(500)
      .send({
        error:
          error instanceof Error ? error.message : "Could not delete model",
      });
  }
});

app.post("/v1/chat/completions", async (req, reply) => {
  const authenticated = await clientAuth(req.headers.authorization);
  if (!authenticated)
    return reply
      .code(401)
      .send({
        error: { message: "Invalid API key", type: "authentication_error" },
      });
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/, "") ?? "";
  if (!(await consumeSharedRateLimit(bearer)))
    return reply
      .code(429)
      .send({
        error: { message: "Rate limit exceeded", type: "rate_limit_error" },
      });
  if (authenticated.id !== "environment")
    await touchClientKey(authenticated.id);
  const parsed = chatSchema.safeParse(req.body);
  if (!parsed.success)
    return reply
      .code(400)
      .send({
        error: {
          message: "Invalid request",
          type: "invalid_request_error",
          details: parsed.error.flatten(),
        },
      });
  const body = parsed.data;
  const id = `req_${randomUUID().slice(0, 8)}`;
  const started = Date.now();
  const attempts: string[] = [];
  const pool = routeCandidates(body);
  const baseLog = {
    apiKeyId: authenticated.id === "environment" ? null : authenticated.id,
    apiKeyName: authenticated.name,
  };
  if (!pool.length) {
    await recordSafely({
      ...baseLog,
      id,
      time: new Date().toISOString(),
      virtualModel: body.model,
      provider: "—",
      actualModel: "—",
      latency: 0,
      tokens: null,
      status: 503,
      attempts,
    });
    return reply
      .code(503)
      .send({
        error: {
          message: "No enabled healthy compatible model backend is available",
          type: "service_unavailable",
          request_id: id,
        },
      });
  }
  for (const { provider, model } of pool.slice(0, 3)) {
    if (Date.now() - started >= 240000) break;
    const key = providerKey(provider);
    if (!key) continue;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(
        provider.timeoutMs,
        Math.max(1, 240000 - (Date.now() - started)),
      ),
    );
    const attemptStarted = Date.now();
    let upstream: Response;
    try {
      await assertSafeProviderUrl(provider.baseUrl);
      upstream = await fetch(providerUrl(provider, "/chat/completions"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ ...body, model: model.providerModelId }),
        signal: controller.signal,
        redirect: "manual",
      });
    } catch {
      clearTimeout(timer);
      const latency = Date.now() - attemptStarted;
      provider.failures++;
      provider.status = "degraded";
      provider.latency = latency;
      provider.cooldownUntil =
        Date.now() +
        Math.min(60000, 5000 * 2 ** Math.min(provider.failures - 1, 3));
      await persistProviderHealthSafely(provider);
      attempts.push(
        `${provider.name} / ${model.providerModelId} → connection or timeout`,
      );
      continue;
    }
    provider.latency = Date.now() - attemptStarted;
    if (!upstream.ok) {
      clearTimeout(timer);
      attempts.push(
        `${provider.name} / ${model.providerModelId} → ${upstream.status}`,
      );
      if (upstream.status === 429) {
        provider.status = "limited";
        provider.cooldownUntil = Date.now() + 30000;
      } else if (upstream.status >= 500) {
        provider.status = "degraded";
        provider.failures++;
        provider.cooldownUntil =
          Date.now() +
          Math.min(60000, 5000 * 2 ** Math.min(provider.failures - 1, 3));
      }
      await persistProviderHealthSafely(provider);
      if (upstream.status !== 429 && upstream.status < 500) {
        await upstream.body?.cancel();
        await recordSafely({
          ...baseLog,
          id,
          time: new Date().toISOString(),
          virtualModel: body.model,
          provider: provider.name,
          actualModel: model.providerModelId,
          latency: Date.now() - started,
          tokens: null,
          status: upstream.status,
          attempts: [...attempts],
        });
        return reply
          .code(upstream.status)
          .send({
            error: {
              message: "Provider rejected the request",
              type: "provider_error",
              request_id: id,
            },
          });
      }
      await upstream.body?.cancel();
      continue;
    }
    provider.status = "healthy";
    provider.failures = 0;
    provider.cooldownUntil = 0;
    await persistProviderHealthSafely(provider);
    attempts.push(`${provider.name} / ${model.providerModelId} → 200`);
    if (body.stream) {
      if (!upstream.body) {
        clearTimeout(timer);
        return reply
          .code(502)
          .send({
            error: {
              message: "Provider returned an empty stream",
              type: "provider_error",
              request_id: id,
            },
          });
      }
      const stream = Readable.fromWeb(
        upstream.body as import("node:stream/web").ReadableStream<Uint8Array>,
      );
      let completed = false;
      const settle = (status: number) => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        void record({
          ...baseLog,
          id,
          time: new Date().toISOString(),
          virtualModel: body.model,
          provider: provider.name,
          actualModel: model.providerModelId,
          latency: Date.now() - started,
          tokens: null,
          status,
          attempts: [...attempts],
        }).catch((error) =>
          app.log.error(
            { err: error, requestId: id },
            "Could not persist streamed request",
          ),
        );
      };
      stream.once("end", () => settle(200));
      stream.once("error", () => settle(502));
      stream.once("close", () => {
        if (!completed) settle(499);
      });
      reply
        .header(
          "content-type",
          upstream.headers.get("content-type") ?? "text/event-stream",
        )
        .header("cache-control", "no-cache, no-transform")
        .header("x-request-id", id);
      return reply.send(stream);
    }
    try {
      const text = await readLimitedText(upstream, 20 * 1024 * 1024);
      clearTimeout(timer);
      let response: { usage?: { total_tokens?: number }; model?: string };
      try {
        response = JSON.parse(text) as typeof response;
      } catch {
        throw new Error("Provider returned an invalid JSON response");
      }
      const latency = Date.now() - started;
      await recordSafely({
        ...baseLog,
        id,
        time: new Date().toISOString(),
        virtualModel: body.model,
        provider: provider.name,
        actualModel: model.providerModelId,
        latency,
        tokens: response.usage?.total_tokens ?? null,
        status: 200,
        attempts: [...attempts],
      });
      response.model = body.model;
      return response;
    } catch (error) {
      clearTimeout(timer);
      if (controller.signal.aborted) {
        provider.failures++;
        provider.status = "degraded";
        provider.cooldownUntil =
          Date.now() +
          Math.min(60000, 5000 * 2 ** Math.min(provider.failures - 1, 3));
        await persistProviderHealthSafely(provider);
        attempts.push(
          `${provider.name} / ${model.providerModelId} → response timeout`,
        );
        continue;
      }
      await recordSafely({
        ...baseLog,
        id,
        time: new Date().toISOString(),
        virtualModel: body.model,
        provider: provider.name,
        actualModel: model.providerModelId,
        latency: Date.now() - started,
        tokens: null,
        status: 502,
        attempts: [...attempts],
      });
      return reply
        .code(502)
        .send({
          error: {
            message:
              error instanceof Error
                ? error.message
                : "Provider returned an invalid response",
            type: "provider_error",
            request_id: id,
          },
        });
    }
  }
  const status = attempts.at(-1)?.includes("429") ? 429 : 503;
  await recordSafely({
    ...baseLog,
    id,
    time: new Date().toISOString(),
    virtualModel: body.model,
    provider: "—",
    actualModel: "—",
    latency: Date.now() - started,
    tokens: null,
    status,
    attempts,
  });
  return reply
    .code(status)
    .send({
      error: {
        message: "All compatible backends failed",
        type: "service_unavailable",
        request_id: id,
      },
    });
});

const port = Number(process.env.PORT ?? 3000);
await app.listen({ port, host: "0.0.0.0" });
