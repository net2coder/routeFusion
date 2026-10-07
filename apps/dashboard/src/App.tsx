import React, {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  Activity,
  AlertTriangle,
  Blocks,
  Command,
  Code2,
  Copy,
  Download,
  Gauge,
  Info,
  KeyRound,
  Layers3,
  Menu,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Search,
  Settings2,
  ShieldCheck,
  Trash2,
  Waypoints,
  X,
} from "lucide-react";
import { createClient } from "@supabase/supabase-js";

type Caps = {
  chat: boolean;
  streaming: boolean;
  tools: boolean;
  vision: boolean;
  reasoning: boolean;
};
type Provider = {
  id: string;
  name: string;
  baseUrl: string;
  status: string;
  priority: number;
  timeoutMs: number;
  latency: number | null;
  enabled: boolean;
  apiKeyConfigured: boolean;
  apiKeyHint: string | null;
  models: number;
};
type Model = {
  id: string;
  logicalModelId: string;
  providerId: string;
  providerName: string;
  providerModelId: string;
  displayName: string;
  capabilities: Caps;
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
  apiKeyId?: string | null;
  apiKeyName?: string;
};
type ClientKey = {
  id: string;
  name: string;
  prefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  requests: number;
};
type Usage = {
  retention: string;
  total: number;
  last24Hours: number;
  requests: number;
  failed: number;
  tokens: number;
  byModel: { model: string; requests: number; tokens: number }[];
  byProvider: { provider: string; requests: number }[];
  hourly: { hour: string; requests: number }[];
  logs: RequestLog[];
};
type InstanceSettings = {
  requestsPerMinute: number;
  requestRetention: number;
  allowedOrigins: string[];
};
type Overview = {
  totalRequests: number;
  success: number | null;
  failed: number;
  activeProviders: number;
  healthyModels: number;
  throughput: number | null;
  avgLatency: number | null;
  failovers: number;
  providers: Provider[];
  models: Model[];
  logs: RequestLog[];
};
const API = import.meta.env.VITE_API_URL ?? "";
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL ?? "";
const supabasePublishableKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? "";
const supabaseAuth =
  supabaseUrl && supabasePublishableKey
    ? createClient(supabaseUrl, supabasePublishableKey)
    : null;
const groups = [
  { title: "", items: [["Overview", Activity]] },
  {
    title: "Infrastructure",
    items: [
      ["Providers", Blocks],
      ["Models", Layers3],
      ["Routing", Waypoints],
    ],
  },
  {
    title: "Operations",
    items: [
      ["Requests", Command],
      ["Usage", Gauge],
      ["Health", ShieldCheck],
    ],
  },
  { title: "Access", items: [["API Keys", KeyRound], ["Connect", Code2]] },
  {
    title: "System",
    items: [
      ["Settings", Settings2],
      ["About", Info],
    ],
  },
] as const;
const routes: Record<string, string> = {
  "/": "Overview",
  "/overview": "Overview",
  "/providers": "Providers",
  "/models": "Models",
  "/routing": "Routing",
  "/requests": "Requests",
  "/usage": "Usage",
  "/health": "Health",
  "/api-keys": "API Keys",
  "/connect": "Connect",
  "/settings": "Settings",
  "/about": "About",
};
const pagePaths: Record<string, string> = Object.fromEntries(
  Object.entries(routes).map(([path, name]) => [name, path]),
);
class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type BoundaryState = { error: Error | null };
export class AppErrorBoundary extends React.Component<
  { children: ReactNode },
  BoundaryState
> {
  state: BoundaryState = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error)
      return (
        <main className="fatal-page">
          <img
            className="brand-icon large"
            src="/rf-app-icon.png"
            alt="RouteFusion"
          />
          <AlertTriangle size={22} />
          <h1>Something went wrong</h1>
          <p>
            The dashboard couldn't render this page. Your gateway configuration
            was not changed.
          </p>
          <details>
            <summary>Technical details</summary>
            <code>{this.state.error.message}</code>
          </details>
          <button
            className="btn primary"
            onClick={() => window.location.reload()}
          >
            Reload dashboard
          </button>
        </main>
      );
    return this.props.children;
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let authHeader: Record<string, string> = {};
  if (path.startsWith("/admin")) {
    if (supabaseAuth) {
      const { data } = await supabaseAuth.auth.getSession();
      if (data.session?.access_token)
        authHeader = { Authorization: `Bearer ${data.session.access_token}` };
    } else {
      const secret = sessionStorage.getItem("rf_admin_secret");
      if (secret) authHeader = { Authorization: `Bearer ${secret}` };
    }
  }
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...authHeader,
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const nested =
      typeof payload.error === "string"
        ? payload.error
        : payload.error?.message;
    throw new ApiError(
      nested ?? `Request failed (${response.status})`,
      response.status,
    );
  }
  return payload as T;
}

export default function App() {
  const [page, setPage] = useState(
    () => routes[window.location.pathname] ?? "NotFound",
  );
  const [overview, setOverview] = useState<Overview | null>(null);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [keys, setKeys] = useState<ClientKey[]>([]);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState("");
  const [checks, setChecks] = useState<Record<string, string>>({});
  const [mobileNav, setMobileNav] = useState(false);
  const [authReady, setAuthReady] = useState(
    supabaseAuth ? false : !!sessionStorage.getItem("rf_admin_secret"),
  );
  const [authError, setAuthError] = useState("");
  useEffect(() => {
    const onPop = () => setPage(routes[window.location.pathname] ?? "NotFound");
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => {
    document.title =
      page === "NotFound" ? "404 — RouteFusion" : `${page} — RouteFusion`;
  }, [page]);
  useEffect(() => {
    if (!supabaseAuth) return;
    void supabaseAuth.auth
      .getSession()
      .then(({ data }) => setAuthReady(!!data.session));
    const {
      data: { subscription },
    } = supabaseAuth.auth.onAuthStateChange((_event, session) =>
      setAuthReady(!!session),
    );
    return () => subscription.unsubscribe();
  }, []);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [o, k] = await Promise.all([
        api<Overview>("/admin/overview"),
        api<ClientKey[]>("/admin/api-keys"),
      ]);
      setOverview(o);
      setProviders(o.providers);
      setModels(o.models);
      setKeys(k);
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load gateway data");
      if (e instanceof ApiError && e.status === 401) {
        if (supabaseAuth) void supabaseAuth.auth.signOut();
        else sessionStorage.removeItem("rf_admin_secret");
        setAuthError("Your admin session expired. Sign in to continue.");
        setAuthReady(false);
      }
    } finally {
      setBusy(false);
    }
  }, []);
  useEffect(() => {
    if (!authReady) return;
    void refresh();
    const t = setInterval(() => void refresh(), 30000);
    return () => clearInterval(t);
  }, [refresh, authReady]);
  const navigate = (next: string) => {
    const path = pagePaths[next];
    if (!path) return;
    window.history.pushState({}, "", path);
    setPage(next);
    setQuery("");
    setMobileNav(false);
  };
  const testProvider = async (id: string) => {
    setTesting(id);
    try {
      const result = await api<{
        ok: boolean;
        status: string;
        latency?: number;
        reason?: string;
      }>(`/admin/providers/${id}/test`, { method: "POST" });
      setChecks((c) => ({
        ...c,
        [id]: result.ok
          ? `Connection OK · ${result.latency}ms`
          : (result.reason ?? result.status),
      }));
      await refresh();
    } catch (e) {
      setChecks((c) => ({
        ...c,
        [id]: e instanceof Error ? e.message : "Connection check failed",
      }));
    } finally {
      setTesting("");
    }
  };
  const logs = overview?.logs ?? [];
  if (!authReady)
    return (
      <AdminLogin
        error={authError}
        onSubmit={async (email, password) => {
          try {
            if (!supabaseAuth) {
              sessionStorage.setItem("rf_admin_secret", password);
              await api("/admin/overview");
            } else {
              const { error } = await supabaseAuth.auth.signInWithPassword({
                email,
                password,
              });
              if (error) throw error;
            }
            setAuthError("");
            setAuthReady(true);
          } catch (e) {
            sessionStorage.removeItem("rf_admin_secret");
            setAuthError(
              e instanceof Error ? e.message : "Admin sign-in failed",
            );
          }
        }}
      />
    );
  return (
    <div className="app">
      <aside className={`sidebar ${mobileNav ? "mobile-open" : ""}`}>
        <button
          className="logo"
          onClick={() => navigate("Overview")}
          aria-label="RouteFusion home"
        >
          <span className="logo-crop">
            <img src="/routefusion-logo.png" alt="RouteFusion" />
          </span>
        </button>
        <button
          className="mobile-close"
          onClick={() => setMobileNav(false)}
          aria-label="Close navigation"
        >
          <X size={17} />
        </button>
        <nav>
          {groups.map((group) => (
            <div className="group" key={group.title || "overview"}>
              {group.title && <div className="group-label">{group.title}</div>}
              {group.items.map(([name, Icon]) => (
                <button
                  key={name}
                  className={`nav ${page === name ? "on" : ""}`}
                  onClick={() => navigate(name)}
                >
                  <Icon size={15} />
                  <span>{name}</span>
                  {name === "Providers" && (
                    <span className="count">{providers.length}</span>
                  )}
                  {name === "Models" && (
                    <span className="count">{models.length}</span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="side-health">
            <div className="side-health-title">
              Provider pool{" "}
              <span
                className={`dot ${(overview?.activeProviders ?? 0) > 0 ? "" : "a"}`}
              />
              <b>
                {providers.length === 0
                  ? "Empty"
                  : (overview?.activeProviders ?? 0) > 0
                    ? "Operational"
                    : "Offline"}
              </b>
            </div>
            <div className="side-health-line">
              <span>Healthy providers</span>
              <strong>
                {overview ? overview.activeProviders : "—"} /{" "}
                {providers.length || "—"}
              </strong>
            </div>
            <div className="bar">
              <i
                style={{
                  width: `${providers.length ? ((overview?.activeProviders ?? 0) / providers.length) * 100 : 0}%`,
                }}
              />
            </div>
          </div>
          <div className="account">
            <img className="avatar-img" src="/rf-app-icon.png" alt="" />
            <div>
              <b>RouteFusion</b>
              <small>Gateway administrator</small>
            </div>
          </div>
        </div>
      </aside>
      {mobileNav && (
        <button
          className="nav-backdrop"
          onClick={() => setMobileNav(false)}
          aria-label="Close navigation overlay"
        />
      )}
      <main>
        <header className="top">
          <button
            className="btn small mobile-menu"
            onClick={() => setMobileNav(true)}
            aria-label="Open navigation"
          >
            <Menu size={15} />
          </button>
          <div className="breadcrumb">
            <span>RouteFusion</span>
            <span className="slash">/</span>
            <strong>{page}</strong>
          </div>
          <span className="spacer" />
          <span className="stat">
            <i
              className={`dot ${(overview?.activeProviders ?? 0) > 0 ? "" : "a"}`}
            />
            {providers.length
              ? `${overview?.activeProviders ?? 0} / ${providers.length} providers healthy`
              : "No providers configured"}
          </span>
          <button
            className="btn small"
            onClick={() => void refresh()}
            aria-label="Refresh"
          >
            <RefreshCw size={14} className={busy ? "rotate" : ""} />
          </button>
          <button
            className="avatar top-avatar"
            aria-label="Sign out"
            title="Sign out"
            onClick={() => {
              void supabaseAuth?.auth.signOut();
              if (!supabaseAuth) sessionStorage.removeItem("rf_admin_secret");
              setAuthReady(false);
            }}
          >
            <img src="/rf-app-icon.png" alt="" />
          </button>
        </header>
        <div className="page">
          {error && (
            <div className="alert">
              <span>{error}</span>
              <button onClick={() => void refresh()}>Retry</button>
            </div>
          )}
          {page === "Overview" && (
            <OverviewPage
              data={overview}
              providers={providers}
              models={models}
              logs={logs}
              go={navigate}
            />
          )}
          {page === "Providers" && (
            <ProvidersPage
              providers={providers}
              query={query}
              setQuery={setQuery}
              checks={checks}
              testing={testing}
              onTest={testProvider}
              onChanged={refresh}
            />
          )}
          {page === "Models" && (
            <ModelsPage
              providers={providers}
              models={models}
              onChanged={refresh}
            />
          )}
          {page === "Routing" && (
            <RoutingPage providers={providers} models={models} />
          )}
          {page === "Requests" && <RequestsPage keys={keys} />}
          {page === "Usage" && <UsagePage />}
          {page === "Health" && <HealthPage providers={providers} />}
          {page === "API Keys" && (
            <APIKeysPage keys={keys} onChanged={refresh} />
          )}
          {page === "Connect" && (
            <ConnectPage apiUrl={API} keys={keys} models={models} />
          )}
          {page === "Settings" && (
            <SettingsPage
              apiUrl={API}
              authEnabled={!!supabaseAuth}
              connected={!error && !!overview}
              overview={overview}
              providers={providers}
              models={models}
            />
          )}
          {page === "About" && <AboutPage go={navigate} />}
          {page === "NotFound" && <NotFoundPage go={navigate} />}
          <footer>
            <span>
              RouteFusion <b>·</b> Gateway control plane
            </span>
            <span>
              <i
                className={`dot ${error ? "r" : (overview?.activeProviders ?? 0) > 0 ? "" : "a"}`}
              />
              {error
                ? "API unreachable"
                : overview
                  ? "Gateway API connected"
                  : "Waiting for gateway response"}
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}

function Heading({
  title,
  sub,
  action,
}: {
  title: string;
  sub: string;
  action?: ReactNode;
}) {
  return (
    <div className="heading">
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      {action}
    </div>
  );
}
function SettingsPage({
  apiUrl,
  authEnabled,
  connected,
  overview,
  providers,
  models,
}: {
  apiUrl: string;
  authEnabled: boolean;
  connected: boolean;
  overview: Overview | null;
  providers: Provider[];
  models: Model[];
}) {
  const [settings, setSettings] = useState<InstanceSettings | null>(null);
  const [settingsError, setSettingsError] = useState("");
  useEffect(() => {
    let live = true;
    api<InstanceSettings>("/admin/settings")
      .then((value) => {
        if (live) setSettings(value);
      })
      .catch((e) => {
        if (live)
          setSettingsError(
            e instanceof Error ? e.message : "Could not load instance settings",
          );
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <>
      <Heading
        title="Settings"
        sub="Deployment and instance status for this RouteFusion control plane."
      />
      <div className="settings-grid">
        <section className="card settings-card">
          <div className="settings-heading">
            <Settings2 size={16} />
            <h2>Connection</h2>
          </div>
          <dl>
            <div>
              <dt>Gateway API</dt>
              <dd className="mono">{apiUrl || "Same origin"}</dd>
            </div>
            <div>
              <dt>API status</dt>
              <dd>
                <Status
                  status={
                    connected
                      ? "Connected"
                      : overview
                        ? "Unavailable"
                        : "Waiting"
                  }
                />
              </dd>
            </div>
            <div>
              <dt>Admin sign-in</dt>
              <dd>{authEnabled ? "Supabase Auth" : "Local admin secret"}</dd>
            </div>
            <div>
              <dt>Dashboard origin</dt>
              <dd className="mono">{window.location.origin}</dd>
            </div>
          </dl>
        </section>
        <section className="card settings-card">
          <div className="settings-heading">
            <Activity size={16} />
            <h2>Live inventory</h2>
          </div>
          <dl>
            <div>
              <dt>Providers</dt>
              <dd>{providers.length}</dd>
            </div>
            <div>
              <dt>Enabled providers</dt>
              <dd>{providers.filter((p) => p.enabled).length}</dd>
            </div>
            <div>
              <dt>Model mappings</dt>
              <dd>{models.length}</dd>
            </div>
            <div>
              <dt>Enabled mappings</dt>
              <dd>{models.filter((m) => m.enabled).length}</dd>
            </div>
            <div>
              <dt>Recorded requests</dt>
              <dd>
                {overview?.totalRequests.toLocaleString() ?? "Waiting for API"}
              </dd>
            </div>
          </dl>
        </section>
      </div>
      {settingsError && (
        <div className="form-error settings-error">{settingsError}</div>
      )}
      <section className="card settings-card settings-note">
        <h2>Gateway policy</h2>
        <dl>
          <div>
            <dt>Rate limit</dt>
            <dd>
              {settings
                ? `${settings.requestsPerMinute.toLocaleString()} requests / minute / API key`
                : "Loading"}
            </dd>
          </div>
          <div>
            <dt>Request metadata retention</dt>
            <dd>
              {settings
                ? `${settings.requestRetention.toLocaleString()} newest requests`
                : "Loading"}
            </dd>
          </div>
          <div>
            <dt>Allowed dashboard origins</dt>
            <dd className="mono">
              {settings?.allowedOrigins.join(", ") ?? "Loading"}
            </dd>
          </div>
        </dl>
        <p>
          Set <code>REQUESTS_PER_MINUTE</code> and <code>CORS_ORIGIN</code> in
          the API project’s Vercel environment variables. Provider credentials
          are encrypted before storage in Supabase. Redeploy the API after
          changing environment variables.
        </p>
      </section>
    </>
  );
}
function AboutPage({ go }: { go: (s: string) => void }) {
  return (
    <>
      <Heading
        title="About RouteFusion"
        sub="One control plane for model providers, routing, and API access."
      />
      <section className="card about-hero">
        <img src="/routefusion-logo.png" alt="RouteFusion" />
        <p>
          RouteFusion is a self-hosted gateway dashboard for managing provider
          connections, model mappings, request routing, and client API keys.
        </p>
      </section>
      <div className="grid2 about-grid">
        <section className="card settings-card">
          <h2>Control plane</h2>
          <p>
            Manage providers and model mappings, inspect gateway health, review
            request usage, and rotate or revoke client credentials.
          </p>
          <button className="btn" onClick={() => go("Providers")}>
            Open providers
          </button>
        </section>
        <section className="card settings-card">
          <h2>Data and security</h2>
          <p>
            Provider credentials are encrypted with AES-256-GCM before being
            stored in Supabase. Request history contains usage metadata, not
            prompts or completions.
          </p>
          <button className="btn" onClick={() => go("Settings")}>
            View instance settings
          </button>
        </section>
      </div>
      <p className="info-line">
        Build: RouteFusion dashboard · {import.meta.env.MODE} mode
      </p>
    </>
  );
}
function NotFoundPage({ go }: { go: (s: string) => void }) {
  return (
    <section className="card not-found">
      <span className="not-found-code">404</span>
      <div className="not-found-rule" />
      <h1>This route is off the map.</h1>
      <p>
        The address may have changed, or the page may not exist in this control
        plane.
      </p>
      <div className="not-found-actions">
        <button className="btn primary" onClick={() => go("Overview")}>
          Return to overview
        </button>
        <button
          className="btn"
          onClick={() =>
            window.history.length > 1 ? window.history.back() : go("Overview")
          }
        >
          Go back
        </button>
      </div>
    </section>
  );
}
function AdminLogin({
  error,
  onSubmit,
}: {
  error: string;
  onSubmit: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <main className="login-page">
      <section className="card login-card">
        <img
          className="brand-icon large"
          src="/rf-app-icon.png"
          alt="RouteFusion"
        />
        <h1>RouteFusion</h1>
        <p>
          {supabaseAuth
            ? "Sign in with your Supabase owner account."
            : "Enter the local admin secret to open the control plane."}
        </p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            await onSubmit(email, password);
            setBusy(false);
          }}
        >
          {supabaseAuth && (
            <Field label="Owner email">
              <input
                autoFocus
                required
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </Field>
          )}
          <Field label={supabaseAuth ? "Password" : "Admin secret"}>
            <input
              autoFocus={!supabaseAuth}
              required
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          {error && <div className="form-error">{error}</div>}
          <button className="btn primary" disabled={busy}>
            {busy ? "Signing in…" : "Continue"}
          </button>
        </form>
        <small>Use HTTPS when signing in on a hosted dashboard.</small>
      </section>
    </main>
  );
}
function Kpi({
  label,
  value,
  detail,
}: {
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <section className="card kpi">
      <small>{label}</small>
      <b>{value}</b>
      <span>{detail}</span>
    </section>
  );
}
function OverviewPage({
  data,
  providers,
  models,
  logs,
  go,
}: {
  data: Overview | null;
  providers: Provider[];
  models: Model[];
  logs: RequestLog[];
  go: (s: string) => void;
}) {
  return (
    <>
      <Heading
        title="Overview"
        sub="Your gateway at a glance."
        action={<span className="badge muted">Persistent request history</span>}
      />
      <div className="grid4">
        <Kpi
          label="Requests"
          value={data ? data.totalRequests.toLocaleString() : "—"}
          detail="Latest 10,000 retained"
        />
        <Kpi
          label="Success Rate"
          value={data?.success == null ? "—" : `${data.success}%`}
          detail={
            data?.totalRequests ? "Successful requests" : "No requests recorded"
          }
        />
        <Kpi
          label="Avg Latency"
          value={data?.avgLatency == null ? "—" : `${data.avgLatency}ms`}
          detail={
            data?.totalRequests
              ? "Across retained requests"
              : "No latency samples"
          }
        />
        <Kpi
          label="Failovers"
          value={data ? String(data.failovers) : "—"}
          detail="Recorded multi-attempt requests"
        />
      </div>
      <section className="card chart-card">
        <h3>
          Request Volume <span className="spacer" />
          <button className="link" onClick={() => go("Usage")}>
            View usage →
          </button>
        </h3>
        <div className="empty compact">
          <b>See hourly traffic in Usage</b>
          <span>
            Usage includes requests, reported tokens, provider and model
            breakdowns.
          </span>
        </div>
      </section>
      <div className="grid2">
        <section className="card">
          <h3>
            Provider Health <span className="spacer" />
            <button className="link" onClick={() => go("Providers")}>
              View all →
            </button>
          </h3>
          {providers.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Status</th>
                    <th>Models</th>
                    <th>Latency</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <b>{p.name}</b>
                      </td>
                      <td>
                        <Status status={p.status} />
                      </td>
                      <td>{p.models}</td>
                      <td>{p.latency == null ? "—" : `${p.latency}ms`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No providers configured"
              text="Add a provider to begin routing requests."
            />
          )}
        </section>
        <section className="card">
          <h3>
            Routing Activity <span className="spacer" />
            <span className="badge muted">Live records</span>
          </h3>
          {logs.length ? (
            <div className="activity">
              {logs.slice(0, 5).map((r) => (
                <div className="activity-row" key={r.id}>
                  <i className={`dot ${r.status === 200 ? "" : "r"}`} />
                  <div>
                    <b className="mono">{r.virtualModel}</b>
                    <span>
                      {r.provider} · {r.status} · {r.latency}ms
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="No routing activity"
              text="Requests recorded by the gateway will appear here."
            />
          )}
        </section>
      </div>
      <div className="section-title">
        <div>
          <h3>Recent Requests</h3>
          <p>Latest requests recorded by this gateway process.</p>
        </div>
        <button className="link" onClick={() => go("Requests")}>
          View request log →
        </button>
      </div>
      <RequestTable logs={logs.slice(0, 5)} />
      <div className="small-summary">
        {models.length} model mapping{models.length === 1 ? "" : "s"} configured
      </div>
    </>
  );
}

function ProvidersPage({
  providers,
  query,
  setQuery,
  checks,
  testing,
  onTest,
  onChanged,
}: {
  providers: Provider[];
  query: string;
  setQuery: (s: string) => void;
  checks: Record<string, string>;
  testing: string;
  onTest: (id: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Provider | null | false>(false);
  const [removing, setRemoving] = useState<Provider | null>(null);
  const [error, setError] = useState("");
  const filtered = providers.filter((p) =>
    `${p.name} ${p.baseUrl}`.toLowerCase().includes(query.toLowerCase()),
  );
  const remove = async () => {
    if (!removing) return;
    try {
      await api(`/admin/providers/${removing.id}`, { method: "DELETE" });
      setRemoving(null);
      setError("");
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete provider");
    }
  };
  return (
    <>
      <Heading
        title="Providers"
        sub="Manage provider endpoints and encrypted credentials."
        action={
          <button className="btn primary" onClick={() => setEditing(null)}>
            <Plus size={14} /> Add Provider
          </button>
        }
      />
      <div className="toolbar">
        <div className="search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search providers..."
          />
        </div>
        <span className="badge muted">{providers.length} configured</span>
      </div>
      {error && <div className="form-error">{error}</div>}
      {filtered.length ? (
        <div className="provider-grid">
          {filtered.map((p) => (
            <section className="card provider" key={p.id}>
              <div className="provider-top">
                <div className="provider-icon">
                  <Blocks size={16} />
                </div>
                <div className="provider-title">
                  <b>{p.name}</b>
                  <small>{p.baseUrl}</small>
                </div>
                <Status status={p.enabled ? p.status : "disabled"} />
              </div>
              <div className="provider-model mono">
                {p.apiKeyConfigured ? "API key configured" : "API key missing"}
                {p.apiKeyHint && <span>{p.apiKeyHint}</span>}
              </div>
              <div className="provider-stats">
                <span>
                  Models <b>{p.models}</b>
                </span>
                <span>
                  Priority <b>{p.priority}</b>
                </span>
                <span>
                  Latency{" "}
                  <b>{p.latency == null ? "Unknown" : `${p.latency}ms`}</b>
                </span>
              </div>
              <div className="provider-actions">
                <button
                  className="btn"
                  onClick={() => onTest(p.id)}
                  disabled={testing === p.id}
                >
                  {testing === p.id ? "Checking…" : "Test connection"}
                </button>
                <button
                  className="btn"
                  onClick={() => setEditing(p)}
                  aria-label={`Edit ${p.name}`}
                >
                  <Pencil size={13} /> Edit
                </button>
                <button
                  className="btn danger"
                  onClick={() => setRemoving(p)}
                  aria-label={`Delete ${p.name}`}
                >
                  <Trash2 size={13} />
                </button>
              </div>
              {checks[p.id] && (
                <div className="check-result">{checks[p.id]}</div>
              )}
            </section>
          ))}
        </div>
      ) : (
        <Empty
          title={query ? "No matching providers" : "No providers configured"}
          text={
            query
              ? "Try a different search."
              : "Add a provider. Credentials are encrypted before they are saved locally."
          }
        />
      )}
      <div className="info-line">
        Provider credentials are never returned to the UI. Provider settings are
        stored in the local data directory.
      </div>
      {editing !== false && (
        <ProviderDialog
          provider={editing}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onChanged();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.name}?`}
          text="This also deletes its model mappings. This action cannot be undone."
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}

function ProviderDialog({
  provider,
  onClose,
  onSaved,
}: {
  provider: Provider | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(provider?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(
    provider?.baseUrl ?? "https://api.openai.com/v1",
  );
  const [apiKey, setApiKey] = useState("");
  const [priority, setPriority] = useState(String(provider?.priority ?? 100));
  const [timeoutMs, setTimeoutMs] = useState(
    String(provider?.timeoutMs ?? 30000),
  );
  const [enabled, setEnabled] = useState(provider?.enabled ?? true);
  const [clearKey, setClearKey] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    setSaving(true);
    try {
      const payload = {
        name,
        baseUrl,
        priority: Number(priority),
        timeoutMs: Number(timeoutMs),
        enabled,
        ...(provider ? {} : { apiKey }),
        ...(provider && apiKey ? { apiKey } : {}),
        ...(provider && clearKey ? { clearApiKey: true } : {}),
      };
      await api(
        provider ? `/admin/providers/${provider.id}` : "/admin/providers",
        { method: provider ? "PATCH" : "POST", body: JSON.stringify(payload) },
      );
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save provider");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={provider ? "Edit Provider" : "Add Provider"}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <Field label="Provider name">
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="OpenAI"
          />
        </Field>
        <Field label="OpenAI-compatible base URL">
          <input
            required
            type="url"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="https://api.openai.com/v1"
          />
        </Field>
        <Field label={provider ? "Replace API key (optional)" : "API key"}>
          <input
            type="password"
            autoComplete="new-password"
            required={!provider}
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              provider
                ? "Leave blank to keep current key"
                : "Paste provider API key"
            }
          />
        </Field>
        <div className="form-grid">
          <Field label="Priority">
            <input
              type="number"
              min="0"
              max="10000"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </Field>
          <Field label="Timeout (ms)">
            <input
              type="number"
              min="1000"
              max="120000"
              step="1000"
              value={timeoutMs}
              onChange={(e) => setTimeoutMs(e.target.value)}
            />
          </Field>
        </div>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />{" "}
          Provider enabled
        </label>
        {provider && (
          <label className="toggle-row destructive">
            <input
              type="checkbox"
              checked={clearKey}
              onChange={(e) => setClearKey(e.target.checked)}
            />{" "}
            Remove saved API key
          </label>
        )}
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving}>
            {saving ? "Saving…" : provider ? "Save changes" : "Create provider"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ModelsPage({
  providers,
  models,
  onChanged,
}: {
  providers: Provider[];
  models: Model[];
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState<Model | null | false>(false);
  const [removing, setRemoving] = useState<Model | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const filtered = models.filter((m) =>
    `${m.logicalModelId} ${m.providerName} ${m.providerModelId}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const remove = async () => {
    if (!removing) return;
    try {
      await api(`/admin/models/${removing.id}`, { method: "DELETE" });
      setRemoving(null);
      setError("");
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete model");
    }
  };
  return (
    <>
      <Heading
        title="Models"
        sub="Map virtual model IDs to provider model endpoints."
        action={
          <button
            className="btn primary"
            disabled={!providers.length}
            onClick={() => setEditing(null)}
          >
            <Plus size={14} /> Add Model
          </button>
        }
      />
      <div className="toolbar">
        <div className="search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search model mappings..."
          />
        </div>
        <span className="badge muted">{models.length} mappings</span>
      </div>
      {error && <div className="form-error">{error}</div>}
      {providers.length === 0 ? (
        <Empty
          title="Add a provider first"
          text="Models need a provider endpoint. Create a provider before adding model mappings."
        />
      ) : filtered.length ? (
        <section className="card table-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Virtual Model</th>
                  <th>Provider</th>
                  <th>Provider Model</th>
                  <th>Context</th>
                  <th>Capabilities</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((m) => (
                  <tr key={m.id}>
                    <td className="mono">
                      {m.logicalModelId}
                      <small className="subcell">{m.displayName}</small>
                    </td>
                    <td>{m.providerName}</td>
                    <td className="mono">{m.providerModelId}</td>
                    <td>
                      {m.contextWindow
                        ? `${m.contextWindow.toLocaleString()} tokens`
                        : "Unknown"}
                    </td>
                    <td>
                      <div className="caps">
                        {m.capabilities.chat && <span>Chat</span>}
                        {m.capabilities.streaming && <span>Stream</span>}
                        {m.capabilities.tools && <span>Tools</span>}
                        {m.capabilities.vision && <span>Vision</span>}
                        {m.capabilities.reasoning && <span>Reasoning</span>}
                      </div>
                    </td>
                    <td>
                      <Status
                        status={
                          !m.enabled
                            ? "disabled"
                            : (providers.find((p) => p.id === m.providerId)
                                ?.status ?? "offline")
                        }
                      />
                    </td>
                    <td>{m.priority}</td>
                    <td>
                      <div className="table-actions">
                        <button
                          className="icon-action"
                          onClick={() => setEditing(m)}
                          aria-label="Edit model"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          className="icon-action danger"
                          onClick={() => setRemoving(m)}
                          aria-label="Delete model"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <Empty
          title={query ? "No matching models" : "No model mappings"}
          text={
            query
              ? "Try a different search."
              : "Create a mapping from a virtual model ID to one of your provider models."
          }
        />
      )}
      <div className="info-line">
        Routing selects enabled compatible mappings by model priority, provider
        priority, health, and recent latency.
      </div>
      {editing !== false && (
        <ModelDialog
          model={editing}
          providers={providers}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            setEditing(false);
            await onChanged();
          }}
        />
      )}
      {removing && (
        <ConfirmDialog
          title={`Delete ${removing.displayName}?`}
          text={`This removes the ${removing.logicalModelId} mapping to ${removing.providerModelId}.`}
          onCancel={() => setRemoving(null)}
          onConfirm={() => void remove()}
        />
      )}
    </>
  );
}

function ModelDialog({
  model,
  providers,
  onClose,
  onSaved,
}: {
  model: Model | null;
  providers: Provider[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [logicalModelId, setLogical] = useState(
    model?.logicalModelId ?? "rf-auto",
  );
  const [providerId, setProvider] = useState(
    model?.providerId ?? providers[0]?.id ?? "",
  );
  const [providerModelId, setProviderModel] = useState(
    model?.providerModelId ?? "",
  );
  const [displayName, setDisplayName] = useState(model?.displayName ?? "");
  const [contextWindow, setContext] = useState(
    model?.contextWindow ? String(model.contextWindow) : "",
  );
  const [priority, setPriority] = useState(String(model?.priority ?? 100));
  const [enabled, setEnabled] = useState(model?.enabled ?? true);
  const [capabilities, setCaps] = useState<Caps>(
    model?.capabilities ?? {
      chat: true,
      streaming: true,
      tools: false,
      vision: false,
      reasoning: false,
    },
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [fetchingCatalog, setFetchingCatalog] = useState(false);
  const toggle = (key: keyof Caps) =>
    setCaps((c) => ({ ...c, [key]: !c[key] }));
  const fetchCatalog = async () => {
    if (!providerId) return;
    setFetchingCatalog(true);
    setError("");
    try {
      const result = await api<{ models: { id: string }[] }>(
        `/admin/providers/${encodeURIComponent(providerId)}/models`,
      );
      setCatalog(result.models.map((item) => item.id));
      if (!result.models.length)
        setError(
          "The provider returned no model IDs. You can still enter the model ID manually.",
        );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not fetch provider models",
      );
    } finally {
      setFetchingCatalog(false);
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    const payload = {
      logicalModelId,
      providerId,
      providerModelId,
      displayName: displayName || providerModelId,
      contextWindow: contextWindow ? Number(contextWindow) : null,
      priority: Number(priority),
      enabled,
      capabilities,
    };
    try {
      await api(model ? `/admin/models/${model.id}` : "/admin/models", {
        method: model ? "PATCH" : "POST",
        body: JSON.stringify(payload),
      });
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save model");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={model ? "Edit Model Mapping" : "Add Model Mapping"}
      onClose={onClose}
    >
      <form onSubmit={submit}>
        <Field label="Virtual model ID">
          <input
            required
            value={logicalModelId}
            onChange={(e) => setLogical(e.target.value)}
            placeholder="rf-auto"
          />
        </Field>
        <Field label="Provider">
          <select
            required
            value={providerId}
            onChange={(e) => {
              setProvider(e.target.value);
              setCatalog([]);
            }}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="field">
          <span>Provider model ID</span>
          <div className="model-select-row">
            <input
              required
              value={providerModelId}
              onChange={(e) => setProviderModel(e.target.value)}
              placeholder="gpt-4o-mini"
            />
            <button
              type="button"
              className="btn"
              onClick={() => void fetchCatalog()}
              disabled={fetchingCatalog || !providerId}
            >
              {fetchingCatalog ? "Fetching…" : "Fetch models"}
            </button>
          </div>
          {catalog.length > 0 && (
            <select
              className="model-catalog"
              aria-label="Choose a discovered provider model"
              value={catalog.includes(providerModelId) ? providerModelId : ""}
              onChange={(e) => {
                if (e.target.value) setProviderModel(e.target.value);
              }}
            >
              <option value="">
                Choose from {catalog.length} discovered models
              </option>
              {catalog.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          )}
        </div>
        <Field label="Display name">
          <input
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Defaults to provider model ID"
          />
        </Field>
        <div className="form-grid">
          <Field label="Context window (tokens)">
            <input
              type="number"
              min="1"
              value={contextWindow}
              onChange={(e) => setContext(e.target.value)}
              placeholder="Unknown"
            />
          </Field>
          <Field label="Routing priority">
            <input
              type="number"
              min="0"
              max="10000"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
            />
          </Field>
        </div>
        <div className="field">
          <span>Capabilities</span>
          <div className="checks">
            {(
              ["chat", "streaming", "tools", "vision", "reasoning"] as const
            ).map((k) => (
              <label key={k}>
                <input
                  type="checkbox"
                  checked={capabilities[k]}
                  onChange={() => toggle(k)}
                />
                {k === "streaming"
                  ? "Streaming"
                  : k[0].toUpperCase() + k.slice(1)}
              </label>
            ))}
          </div>
        </div>
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />{" "}
          Mapping enabled
        </label>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving}>
            {saving ? "Saving…" : model ? "Save changes" : "Create mapping"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RoutingPage({
  providers,
  models,
}: {
  providers: Provider[];
  models: Model[];
}) {
  const enabled = models.filter((m) => m.enabled);
  return (
    <>
      <Heading
        title="Routing"
        sub="Capability-aware provider model fallback order."
      />
      {enabled.length ? (
        <section className="card">
          <h3>rf-auto provider pool</h3>
          <div className="route-list">
            {enabled
              .sort((a, b) => a.priority - b.priority)
              .map((m, i) => (
                <div className="route-row" key={m.id}>
                  <span className="route-index">{i + 1}</span>
                  <div>
                    <b>
                      {m.providerName} / {m.providerModelId}
                    </b>
                    <small>
                      {m.logicalModelId} · model priority {m.priority} ·
                      provider priority{" "}
                      {providers.find((p) => p.id === m.providerId)?.priority}
                    </small>
                  </div>
                  <Status
                    status={
                      providers.find((p) => p.id === m.providerId)?.status ??
                      "offline"
                    }
                  />
                </div>
              ))}
          </div>
          <p className="note">
            Requests are routed across mappings matching the requested virtual
            model. Failover is limited to three providers per request.
          </p>
        </section>
      ) : (
        <Empty
          title="Routing pool is empty"
          text="Create enabled model mappings to add real backends to the routing pool."
        />
      )}
    </>
  );
}

function RequestsPage({ keys }: { keys: ClientKey[] }) {
  const [logs, setLogs] = useState<RequestLog[]>([]);
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [keyId, setKeyId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(true);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setBusy(true);
    api<RequestLog[]>("/admin/requests?limit=5000")
      .then((rows) => {
        if (active) {
          setLogs(rows);
          setError("");
        }
      })
      .catch((e) => {
        if (active)
          setError(
            e instanceof Error ? e.message : "Could not load request history",
          );
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [reload]);
  const filtered = logs.filter((r) => {
    const time = Date.parse(r.time);
    const end = to ? new Date(`${to}T00:00:00`) : null;
    if (end) end.setDate(end.getDate() + 1);
    return (
      `${r.id} ${r.provider} ${r.virtualModel} ${r.actualModel} ${r.apiKeyName ?? ""}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (!from || time >= new Date(`${from}T00:00:00`).getTime()) &&
      (!end || time < end.getTime()) &&
      (!keyId || r.apiKeyId === keyId)
    );
  });
  const exportCsv = () => {
    const fields = [
      "time",
      "id",
      "apiKeyName",
      "virtualModel",
      "provider",
      "actualModel",
      "latency",
      "tokens",
      "status",
      "attempts",
    ];
    const safe = (value: unknown) => {
      const input = String(value ?? "");
      return /^[=+@\-\t\r]/.test(input) ? `'${input}` : input;
    };
    const quote = (value: unknown) => `"${safe(value).replaceAll('"', '""')}"`;
    const csv = [
      fields.join(","),
      ...filtered.map((r) =>
        [
          r.time,
          r.id,
          r.apiKeyName,
          r.virtualModel,
          r.provider,
          r.actualModel,
          r.latency,
          r.tokens,
          r.status,
          r.attempts.join(" | "),
        ]
          .map(quote)
          .join(","),
      ),
    ].join("\r\n");
    const url = URL.createObjectURL(
      new Blob([csv], { type: "text/csv;charset=utf-8" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "routefusion-requests.csv";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <>
      <Heading
        title="Requests"
        sub="Search, filter, and export recent gateway request metadata."
        action={
          <>
            <button
              className="btn small"
              onClick={() => setReload((r) => r + 1)}
              aria-label="Refresh requests"
            >
              <RefreshCw size={14} className={busy ? "rotate" : ""} />
            </button>
            <button
              className="btn"
              onClick={exportCsv}
              disabled={!filtered.length}
            >
              <Download size={14} /> Export CSV
            </button>
          </>
        }
      />
      <div className="toolbar requests-toolbar">
        <div className="search">
          <Search size={14} />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search request, model, provider, key..."
          />
        </div>
        <label>
          From{" "}
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </label>
        <label>
          To{" "}
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <label>
          Client key{" "}
          <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
            <option value="">All keys</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </label>
        <span className="badge muted">
          {filtered.length} / {logs.length} loaded
        </span>
      </div>
      {error && <div className="form-error">{error}</div>}
      {busy ? (
        <Empty
          title="Loading requests"
          text="Fetching recent request metadata."
        />
      ) : (
        <RequestTable logs={filtered} />
      )}
      <p className="info-line">
        Request metadata is retained in Supabase for hosted deployments and
        locally for development, up to the latest 10,000 records. Filters and
        export apply to the latest 5,000 loaded records.
      </p>
    </>
  );
}
function UsagePage() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api<Usage>("/admin/usage")
      .then((data) => {
        if (live) setUsage(data);
      })
      .catch((e) => {
        if (live)
          setError(e instanceof Error ? e.message : "Could not load usage");
      });
    return () => {
      live = false;
    };
  }, []);
  const peak = Math.max(1, ...(usage?.hourly.map((h) => h.requests) ?? []));
  return (
    <>
      <Heading
        title="Usage"
        sub="Request and token totals from recorded gateway traffic."
        action={
          <span className="badge muted">
            Last 24 hours · {usage?.retention ?? "Loading"}
          </span>
        }
      />
      {error && <div className="form-error">{error}</div>}
      <div className="grid4">
        <Kpi
          label="Requests (24h)"
          value={usage ? usage.last24Hours.toLocaleString() : "—"}
          detail="Recorded API requests"
        />
        <Kpi
          label="Failed (24h)"
          value={usage ? usage.failed.toLocaleString() : "—"}
          detail="HTTP failures"
        />
        <Kpi
          label="Tokens (24h)"
          value={usage ? usage.tokens.toLocaleString() : "—"}
          detail="Reported by upstream responses"
        />
        <Kpi
          label="Retained"
          value={usage ? usage.total.toLocaleString() : "—"}
          detail="Most recent records"
        />
      </div>
      <section className="card usage-chart">
        <h3>
          Request volume <span className="spacer" />
          <span className="badge muted">Hourly · 24h</span>
        </h3>
        <div className="hour-bars">
          {usage?.hourly.map((h) => (
            <div
              className="hour-col"
              key={h.hour}
              title={`${new Date(h.hour).toLocaleString()} · ${h.requests} requests`}
            >
              <i
                style={{ height: `${Math.max(3, (h.requests / peak) * 100)}%` }}
              />
              <small>
                {new Date(h.hour).getHours().toString().padStart(2, "0")}
              </small>
            </div>
          ))}
        </div>
      </section>
      <div className="grid2">
        <section className="card">
          <h3>Usage by Model</h3>
          {usage?.byModel.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Requests</th>
                    <th>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byModel.map((row) => (
                    <tr key={row.model}>
                      <td className="mono">{row.model}</td>
                      <td>{row.requests}</td>
                      <td>{row.tokens.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No model usage"
              text="Model totals appear after requests are routed."
            />
          )}
        </section>
        <section className="card">
          <h3>Usage by Provider</h3>
          {usage?.byProvider.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Provider</th>
                    <th>Requests</th>
                  </tr>
                </thead>
                <tbody>
                  {usage.byProvider.map((row) => (
                    <tr key={row.provider}>
                      <td>{row.provider}</td>
                      <td>{row.requests}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty
              title="No provider usage"
              text="Provider totals appear after requests are routed."
            />
          )}
        </section>
      </div>
      <p className="info-line">
        Only request metadata is stored. Prompts and completions are not
        retained. Streaming token totals are unavailable because the stream is
        forwarded without buffering.
      </p>
    </>
  );
}
function ConnectPage({
  apiUrl,
  keys,
  models,
}: {
  apiUrl: string;
  keys: ClientKey[];
  models: Model[];
}) {
  const [client, setClient] = useState<"anthropic" | "openai">("anthropic");
  const [model, setModel] = useState(
    models.find((item) => item.enabled)?.logicalModelId ?? "rf-auto",
  );
  const [keyId, setKeyId] = useState(keys.find((item) => !item.revokedAt)?.id ?? "");
  const [key, setKey] = useState("");
  const [copied, setCopied] = useState(false);
  const base = (apiUrl || window.location.origin).replace(/\/$/, "");
  const enabledModels = [...new Set(models.filter((item) => item.enabled).map((item) => item.logicalModelId))];
  const chosenModel = enabledModels.includes(model) ? model : enabledModels[0] ?? "rf-auto";
  const credential = key || "rf_live_paste-your-key-here";
  const snippet = client === "anthropic"
    ? `# Claude Code\n$env:ANTHROPIC_BASE_URL="${base}"\n$env:ANTHROPIC_AUTH_TOKEN="${credential}"\n$env:ANTHROPIC_MODEL="${chosenModel}"\nclaude`
    : `# OpenAI-compatible clients\nfrom openai import OpenAI\n\nclient = OpenAI(\n    base_url="${base}/v1",\n    api_key="${credential}",\n)\n\nresponse = client.chat.completions.create(\n    model="${chosenModel}",\n    messages=[{"role": "user", "content": "Hello"}],\n)\nprint(response.choices[0].message.content)`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };
  return (
    <>
      <Heading title="Connect a client" sub="One gateway, two API adaptors. Choose a ready model and copy the matching client setup." />
      <div className="connect-grid">
        <section className="card connect-setup">
          <div className="connect-kicker"><Code2 size={15} /> Client setup</div>
          <Field label="Client protocol">
            <select value={client} onChange={(e) => setClient(e.target.value as "anthropic" | "openai")}>
              <option value="anthropic">Anthropic Messages · Claude Code</option>
              <option value="openai">OpenAI Chat Completions</option>
            </select>
          </Field>
          <Field label="Model">
            <select value={chosenModel} onChange={(e) => setModel(e.target.value)}>
              {enabledModels.length ? enabledModels.map((id) => <option key={id} value={id}>{id}</option>) : <option value="rf-auto">rf-auto · automatic routing</option>}
            </select>
          </Field>
          <Field label="Client API key">
            <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
              <option value="">Paste key below</option>
              {keys.filter((item) => !item.revokedAt).map((item) => <option key={item.id} value={item.id}>{item.name} · {item.prefix}…</option>)}
            </select>
          </Field>
          <Field label="Paste key for this snippet (optional)">
            <input type="password" autoComplete="off" placeholder="rf_live_…" value={key} onChange={(e) => setKey(e.target.value)} />
          </Field>
          <p className="connect-note">Keys are never saved here. Select a key as a reminder, then paste its full value below. RouteFusion only shows the secret when it is created or rotated.</p>
        </section>
        <section className="card connect-output">
          <div className="connect-output-head">
            <div><div className="connect-kicker">{client === "anthropic" ? "Anthropic Messages" : "OpenAI-compatible"}</div><span className="mono">{client === "anthropic" ? `${base}/v1/messages` : `${base}/v1/chat/completions`}</span></div>
            <button className="btn small" onClick={() => void copy()}><Copy size={13} /> {copied ? "Copied" : "Copy setup"}</button>
          </div>
          <pre className="connect-code"><code>{snippet}</code></pre>
          <div className="connect-foot"><span><i className={`dot ${enabledModels.length ? "" : "a"}`} /> {enabledModels.length ? `${enabledModels.length} enabled model${enabledModels.length === 1 ? "" : "s"}` : "No enabled models yet"}</span><button className="link" onClick={() => { window.history.pushState({}, "", "/models"); window.dispatchEvent(new PopStateEvent("popstate")); }}>Manage models →</button></div>
        </section>
      </div>
      <section className="card protocol-card">
        <div><b>Anthropic adaptor</b><span>POST /v1/messages · x-api-key or Bearer · streaming and tool calls translated to provider chat format.</span></div>
        <div><b>OpenAI adaptor</b><span>POST /v1/chat/completions · Bearer authentication · standard Chat Completions request and response shape.</span></div>
        <div><b>Models discovery</b><span>GET /v1/models · lists enabled logical model IDs available to this API key.</span></div>
      </section>
    </>
  );
}

function APIKeysPage({
  keys,
  onChanged,
}: {
  keys: ClientKey[];
  onChanged: () => Promise<void>;
}) {
  const [create, setCreate] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(
    null,
  );
  const [pending, setPending] = useState<ClientKey | null>(null);
  const [error, setError] = useState("");
  const mutate = async (key: ClientKey, action: "rotate" | "revoke") => {
    try {
      if (action === "rotate") {
        const issued = await api<{ name: string; secret: string }>(
          `/admin/api-keys/${key.id}/rotate`,
          { method: "POST" },
        );
        setSecret({ name: issued.name, value: issued.secret });
      } else await api(`/admin/api-keys/${key.id}`, { method: "DELETE" });
      setError("");
      setPending(null);
      await onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update API key");
    }
  };
  return (
    <>
      <Heading
        title="API Keys"
        sub="Create client credentials and monitor their usage."
        action={
          <button className="btn primary" onClick={() => setCreate(true)}>
            <Plus size={14} /> Generate key
          </button>
        }
      />
      {error && <div className="form-error">{error}</div>}
      <section className="card table-card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Key prefix</th>
                <th>Created</th>
                <th>Last used</th>
                <th>Retained requests</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.id}>
                  <td>
                    <b>{k.name}</b>
                  </td>
                  <td className="mono">{k.prefix}…</td>
                  <td>{new Date(k.createdAt).toLocaleDateString()}</td>
                  <td>
                    {k.lastUsedAt
                      ? new Date(k.lastUsedAt).toLocaleString()
                      : "Never"}
                  </td>
                  <td>{k.requests}</td>
                  <td>
                    <Status status={k.revokedAt ? "revoked" : "active"} />
                  </td>
                  <td>
                    <div className="table-actions">
                      <button
                        className="icon-action"
                        disabled={!!k.revokedAt}
                        onClick={() => void mutate(k, "rotate")}
                        aria-label={`Rotate ${k.name}`}
                        title="Rotate key"
                      >
                        <RotateCw size={13} />
                      </button>
                      <button
                        className="icon-action danger"
                        disabled={!!k.revokedAt}
                        onClick={() => setPending(k)}
                        aria-label={`Revoke ${k.name}`}
                        title="Revoke key"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {keys.length === 0 && (
          <div className="empty">
            <b>No client API keys</b>
            <span>Generate a key to authenticate client requests.</span>
          </div>
        )}
      </section>
      <p className="info-line">
        Secrets are shown only when generated or rotated. Only SHA-256 hashes
        are stored. Retained request counts reflect up to the latest 10,000
        request records.
      </p>
      {create && (
        <CreateKeyDialog
          onClose={() => setCreate(false)}
          onCreated={async (value) => {
            setCreate(false);
            setSecret(value);
            await onChanged();
          }}
        />
      )}
      {secret && (
        <SecretDialog
          name={secret.name}
          secret={secret.value}
          onClose={() => setSecret(null)}
        />
      )}
      {pending && (
        <ConfirmDialog
          title={`Revoke ${pending.name}?`}
          text="Clients using this key will immediately receive authentication errors. Existing usage history will remain available."
          onCancel={() => setPending(null)}
          onConfirm={() => void mutate(pending, "revoke")}
        />
      )}
    </>
  );
}
function CreateKeyDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (key: { name: string; value: string }) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const result = await api<{ name: string; secret: string }>(
        "/admin/api-keys",
        { method: "POST", body: JSON.stringify({ name }) },
      );
      await onCreated({ name: result.name, value: result.secret });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not generate key");
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="Generate API key" onClose={onClose}>
      <form onSubmit={submit}>
        <Field label="Key name">
          <input
            required
            maxLength={80}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Production app"
          />
        </Field>
        <p className="confirm-text">
          A new secret will be shown once. Copy and store it securely before
          closing.
        </p>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={saving}>
            {saving ? "Generating…" : "Generate key"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
function SecretDialog({
  name,
  secret,
  onClose,
}: {
  name: string;
  secret: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Modal title="Copy your new API key" onClose={onClose}>
      <p className="confirm-text">
        {name} · This secret will not be shown again.
      </p>
      <div className="secret-box">
        <code>{secret}</code>
        <button
          className="btn"
          onClick={() => {
            void navigator.clipboard
              .writeText(secret)
              .then(() => setCopied(true))
              .catch(() => setCopied(false));
          }}
        >
          <Copy size={13} />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="modal-actions">
        <button className="btn primary" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
function HealthPage({ providers }: { providers: Provider[] }) {
  return (
    <>
      <Heading
        title="Health"
        sub="Current provider availability reported by the gateway."
      />
      {providers.length ? (
        <section className="card table-card">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Status</th>
                  <th>Latency</th>
                  <th>Health checks</th>
                </tr>
              </thead>
              <tbody>
                {providers.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>
                      <Status status={p.status} />
                    </td>
                    <td>{p.latency == null ? "Unknown" : `${p.latency}ms`}</td>
                    <td>On demand</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : (
        <Empty
          title="No health checks available"
          text="Provider health will appear when providers are configured."
        />
      )}
    </>
  );
}
function RequestTable({ logs }: { logs: RequestLog[] }) {
  return (
    <section className="card table-card">
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>Request ID</th>
              <th>Client key</th>
              <th>Virtual Model</th>
              <th>Provider</th>
              <th>Latency</th>
              <th>Tokens</th>
              <th>Status</th>
              <th>Attempts</th>
            </tr>
          </thead>
          <tbody>
            {logs.map((r) => (
              <tr key={r.id}>
                <td>{new Date(r.time).toLocaleString()}</td>
                <td className="mono">{r.id}</td>
                <td>{r.apiKeyName ?? "Unknown"}</td>
                <td className="mono">{r.virtualModel}</td>
                <td>{r.provider}</td>
                <td>{r.latency}ms</td>
                <td>{r.tokens?.toLocaleString() ?? "Unknown"}</td>
                <td>
                  <Status status={String(r.status)} />
                </td>
                <td>{r.attempts.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!logs.length && (
        <div className="empty">
          <b>No requests recorded</b>
          <span>
            Requests received by this gateway appear here. Request metadata is
            retained without prompts or completions.
          </span>
        </div>
      )}
    </section>
  );
}
function Status({ status }: { status: string }) {
  const s = status.toLowerCase();
  const type = [
    "healthy",
    "enabled",
    "active",
    "200",
    "connected",
    "ready",
  ].includes(s)
    ? "good"
    : ["degraded", "limited", "429", "unknown", "waiting"].includes(s)
      ? "warn"
      : "bad";
  return (
    <span className={`badge ${type}`}>
      <i /> {status}
    </span>
  );
}
function Empty({ title, text }: { title: string; text: string }) {
  return (
    <section className="card empty">
      <b>{title}</b>
      <span>{text}</span>
    </section>
  );
}
function Unavailable({ title, text }: { title: string; text: string }) {
  return (
    <>
      <Heading title={title} sub="Gateway controls." />
      <Empty title={`${title} are unavailable`} text={text} />
    </>
  );
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}
function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section className="modal">
        <header>
          <h2>{title}</h2>
          <button className="icon-action" onClick={onClose} aria-label="Close">
            <X size={15} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
function ConfirmDialog({
  title,
  text,
  onCancel,
  onConfirm,
}: {
  title: string;
  text: string;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Modal title={title} onClose={onCancel}>
      <p className="confirm-text">{text}</p>
      <div className="modal-actions">
        <button className="btn" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn delete" onClick={onConfirm}>
          <Trash2 size={13} /> Delete
        </button>
      </div>
    </Modal>
  );
}
