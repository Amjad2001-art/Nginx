const { useEffect, useMemo, useRef, useState } = React;
const { createRoot } = ReactDOM;

const CAPACITY = 8;
const REFILL_PER_SECOND = 0.45;
const WINDOW_MS = 3000;
const WINDOW_LIMIT = 15;

const clients = [
  {
    id: "internal",
    label: "Internal Checkout Service",
    ip: "10.0.0.42",
    subnet: "10.0.0.0/24",
    type: "Whitelisted",
    burst: 18,
    color: "#17a673",
  },
  {
    id: "shopper",
    label: "External Shopper",
    ip: "172.16.8.19",
    subnet: "172.16.8.0/24",
    type: "Token Limited",
    burst: 18,
    color: "#2454c6",
  },
  {
    id: "throttled",
    label: "Severely Throttled IP",
    ip: "192.168.1.5",
    subnet: "192.168.1.0/24",
    type: "Severe Throttle",
    burst: 16,
    color: "#e59c24",
  },
  {
    id: "rogue",
    label: "Rogue Scraper Network",
    ip: "203.0.113.77",
    subnet: "203.0.113.0/24",
    type: "Dynamic Block",
    burst: 22,
    color: "#dc2638",
  },
];

const routes = [
  { name: "/checkout", priority: "critical", policy: "Protected checkout assets" },
  { name: "/cart", priority: "high", policy: "Token bucket ingress" },
  { name: "/assets", priority: "high", policy: "Cached client resources" },
  { name: "/telemetry", priority: "low", policy: "Shed first during flood" },
];

const initialBuckets = clients.reduce((acc, client) => {
  acc[client.id] = CAPACITY;
  return acc;
}, {});

function isWhitelisted(client) {
  return client.subnet === "10.0.0.0/24";
}

function isSevereThrottle(client) {
  return client.ip === "192.168.1.5";
}

function tokenCost(client, route) {
  if (isWhitelisted(client)) return 0;
  if (route === "/telemetry") return 2;
  if (isSevereThrottle(client)) return 3;
  return 1;
}

function App() {
  const [activeTab, setActiveTab] = useState("sandbox");
  const [selectedClient, setSelectedClient] = useState("throttled");
  const [selectedRoute, setSelectedRoute] = useState("/checkout");
  const [buckets, setBuckets] = useState(initialBuckets);
  const [windowHits, setWindowHits] = useState({});
  const [logs, setLogs] = useState([]);
  const [metrics, setMetrics] = useState({ allowed: 0, denied: 0, shed: 0, alerts: 0 });
  const [lastDecision, setLastDecision] = useState(null);
  const [severityAlert, setSeverityAlert] = useState(null);
  const [rogueBlocked, setRogueBlocked] = useState({ rogue: true });
  const bucketRef = useRef(initialBuckets);
  const windowRef = useRef({});
  const blockedRef = useRef({ rogue: true });

  useEffect(() => {
    const timer = setInterval(() => {
      setBuckets((current) => {
        const next = { ...current };
        clients.forEach((client) => {
          next[client.id] = Math.min(CAPACITY, Number((next[client.id] + REFILL_PER_SECOND / 2).toFixed(2)));
        });
        bucketRef.current = next;
        return next;
      });
      setWindowHits((current) => {
        const cutoff = Date.now() - WINDOW_MS;
        const next = Object.fromEntries(
          Object.entries(current).map(([key, hits]) => [key, hits.filter((stamp) => stamp > cutoff)])
        );
        windowRef.current = next;
        return next;
      });
    }, 500);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    blockedRef.current = rogueBlocked;
  }, [rogueBlocked]);

  const selected = useMemo(
    () => clients.find((client) => client.id === selectedClient),
    [selectedClient]
  );

  const activeHits = windowHits[selectedClient]?.length ?? 0;
  const throughput = Math.max(0, metrics.allowed * 7 - metrics.denied * 2 - metrics.shed);

  useEffect(() => {
    if (!severityAlert) return undefined;
    const timer = setTimeout(() => setSeverityAlert(null), 9000);
    return () => clearTimeout(timer);
  }, [severityAlert]);

  function writeLog(level, client, route, message) {
    const entry = {
      id: crypto.randomUUID(),
      time: new Date().toLocaleTimeString(),
      level,
      ip: client.ip,
      route,
      message,
    };
    setLogs((current) => [entry, ...current].slice(0, 9));
  }

  function processRequest(clientId = selectedClient, route = selectedRoute) {
    const client = clients.find((item) => item.id === clientId);
    const cost = tokenCost(client, route);
    const now = Date.now();
    const currentWindows = windowRef.current;
    const hits = [...(currentWindows[client.id] ?? []), now].filter((stamp) => stamp > now - WINDOW_MS);
    const breachedWindow = hits.length > WINDOW_LIMIT;
    const nextWindows = { ...currentWindows, [client.id]: hits };

    windowRef.current = nextWindows;
    setWindowHits(nextWindows);

    if (blockedRef.current[client.id]) {
      const decision = { status: 403, title: "403 Dynamic Network Block", detail: "Rogue subnet denied before upstream routing." };
      setLastDecision(decision);
      setMetrics((m) => ({ ...m, denied: m.denied + 1 }));
      writeLog("deny", client, route, "Blocked rogue IP network at ingress boundary");
      return;
    }

    if (breachedWindow) {
      setMetrics((m) => ({ ...m, alerts: m.alerts + 1 }));
      setSeverityAlert({
        client: client.label,
        ip: client.ip,
        hits: hits.length,
        route,
      });
      writeLog("alert", client, route, "Sliding-window breach: more than 15 spikes in 3 seconds");
    }

    if (isWhitelisted(client)) {
      const decision = { status: 200, title: "200 Bypass Granted", detail: "10.0.0.0/24 internal subnet bypasses token throttling." };
      setLastDecision(decision);
      setMetrics((m) => ({ ...m, allowed: m.allowed + 1 }));
      writeLog("allow", client, route, "Internal whitelisted network bypassed limits");
      return;
    }

    const currentTokens = bucketRef.current[client.id];

    if (route === "/telemetry" && currentTokens < CAPACITY / 2) {
      const decision = { status: 202, title: "Telemetry Shed", detail: "Low-priority telemetry dropped to preserve checkout throughput." };
      setLastDecision(decision);
      setMetrics((m) => ({ ...m, shed: m.shed + 1 }));
      writeLog("shed", client, route, "Non-essential telemetry shed during pressure");
      return;
    }

    if (currentTokens >= cost) {
      const nextBuckets = { ...bucketRef.current, [client.id]: Number((currentTokens - cost).toFixed(2)) };
      bucketRef.current = nextBuckets;
      setBuckets(nextBuckets);
      const decision = { status: 200, title: "200 Routed Upstream", detail: `${cost} token${cost === 1 ? "" : "s"} consumed from the 8-capacity bucket.` };
      setLastDecision(decision);
      setMetrics((m) => ({ ...m, allowed: m.allowed + 1 }));
      writeLog("allow", client, route, "Request routed to active upstream pool");
      return;
    }

    const decision = { status: 429, title: "HTTP 429 Too Many Requests", detail: "Token bucket empty. Shopper receives the high-contrast rate-limit screen." };
    setLastDecision(decision);
    setMetrics((m) => ({ ...m, denied: m.denied + 1 }));
    writeLog("deny", client, route, "Rejected by active client rate limit");
  }

  function burstTraffic() {
    const client = clients.find((item) => item.id === selectedClient);
    for (let i = 0; i < client.burst; i += 1) {
      setTimeout(() => processRequest(client.id, selectedRoute), i * 80);
    }
  }

  function resetSandbox() {
    bucketRef.current = initialBuckets;
    windowRef.current = {};
    setBuckets(initialBuckets);
    setWindowHits({});
    setLogs([]);
    setMetrics({ allowed: 0, denied: 0, shed: 0, alerts: 0 });
    setLastDecision(null);
    setSeverityAlert(null);
  }

  return (
    <main>
      <header className="topbar">
        <div>
          <p className="eyebrow">Nginx Front-End Ingress Policy Router</p>
          <h1>Black Friday Sales Gateway</h1>
        </div>
        <div className="status-pill">
          <span aria-hidden="true">LIVE</span>
          <span>Live policy simulation</span>
        </div>
      </header>

      <nav className="tabs" aria-label="Gateway views">
        <button className={activeTab === "sandbox" ? "active" : ""} onClick={() => setActiveTab("sandbox")}>
          <span aria-hidden="true">BURST</span> Live Sandbox
        </button>
        <button className={activeTab === "blueprint" ? "active" : ""} onClick={() => setActiveTab("blueprint")}>
          <span aria-hidden="true">MAP</span> Cluster Blueprint
        </button>
        <button className={activeTab === "evidence" ? "active" : ""} onClick={() => setActiveTab("evidence")}>
          <span aria-hidden="true">OK</span> Criteria Evidence
        </button>
      </nav>

      {activeTab === "sandbox" && (
        <section className="workspace">
          <aside className="panel controls">
            <h2>Traffic Source</h2>
            <div className="client-list">
              {clients.map((client) => (
                <button
                  key={client.id}
                  className={selectedClient === client.id ? "client active" : "client"}
                  onClick={() => setSelectedClient(client.id)}
                >
                  <span className="dot" style={{ background: client.color }} />
                  <strong>{client.label}</strong>
                  <small>{client.ip} · {client.type}</small>
                </button>
              ))}
            </div>

            <label className="field">
              Upstream route
              <select value={selectedRoute} onChange={(event) => setSelectedRoute(event.target.value)}>
                {routes.map((route) => (
                  <option key={route.name}>{route.name}</option>
                ))}
              </select>
            </label>

            <div className="actions">
              <button className="primary" onClick={() => processRequest()}>
                <span aria-hidden="true">RUN</span> Send Request
              </button>
              <button onClick={burstTraffic}>
                <span aria-hidden="true">15+</span> Trigger Burst
              </button>
              <button onClick={resetSandbox}>
                <span aria-hidden="true">RESET</span> Reset
              </button>
            </div>
          </aside>

          <section className="main-grid">
            <div className="limit-strip">
              {clients.map((client) => {
                const tokens = buckets[client.id];
                const percent = (tokens / CAPACITY) * 100;
                return (
                  <article key={client.id} className="limit-card">
                    <div>
                      <span>{client.ip}</span>
                      <strong>{isWhitelisted(client) ? "BYPASS" : `${tokens.toFixed(1)} / ${CAPACITY} TOKENS`}</strong>
                    </div>
                    <div className="meter">
                      <i style={{ width: `${isWhitelisted(client) ? 100 : percent}%`, background: client.color }} />
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="gateway">
              <div className="node client-node">
                <span className="node-icon">IP</span>
                <b>{selected.label}</b>
                <span>{selected.subnet}</span>
              </div>
              <div className="route-line">
                <span>Ingress boundary</span>
              </div>
              <div className="node nginx-node">
                <span className="node-icon">ACL</span>
                <b>Nginx policy router</b>
                <span>token bucket + subnet ACL + sliding window</span>
              </div>
              <div className="route-line">
                <span>{selectedRoute}</span>
              </div>
              <div className="node upstream-node">
                <span className="node-icon">UP</span>
                <b>Checkout upstream pool</b>
                <span>{throughput} req/min simulated throughput</span>
              </div>
            </div>

            <div className={lastDecision?.status === 429 ? "decision reject" : "decision"}>
              {lastDecision ? (
                <>
                  <strong>{lastDecision.title}</strong>
                  <p>{lastDecision.detail}</p>
                </>
              ) : (
                <>
                  <strong>Waiting for traffic</strong>
                  <p>Send one request or trigger a burst to exercise the policy router.</p>
                </>
              )}
            </div>

            {severityAlert && (
              <div className="warning">
                <span aria-hidden="true">ALERT</span>
                <div>
                  <strong>HIGH SEVERITY: sliding-window breach detected</strong>
                  <p>
                    {severityAlert.client} ({severityAlert.ip}) sent {severityAlert.hits} query spikes to{" "}
                    {severityAlert.route} inside 3 seconds. The gateway marks this as brute-force flood
                    behavior and raises a high-priority ingress warning.
                  </p>
                </div>
              </div>
            )}
          </section>

          <aside className="panel monitor">
            <h2>High-Contrast Denial Monitor</h2>
            <div className="toggles">
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(rogueBlocked.rogue)}
                  onChange={(event) => setRogueBlocked((current) => ({ ...current, rogue: event.target.checked }))}
                />
                Block 203.0.113.0/24
              </label>
            </div>
            <div className="metrics">
              <b>{metrics.allowed}</b><span>Allowed</span>
              <b>{metrics.denied}</b><span>Denied</span>
              <b>{metrics.shed}</b><span>Shed</span>
              <b>{metrics.alerts}</b><span>Alerts</span>
            </div>
            <div className="log-frame">
              {logs.length === 0 && <p>No denials yet.</p>}
              {logs.map((log) => (
                <div key={log.id} className={`log ${log.level}`}>
                  <b>{log.time} · {log.level.toUpperCase()}</b>
                  <span>{log.ip} {log.route}</span>
                  <p>{log.message}</p>
                </div>
              ))}
            </div>
          </aside>
        </section>
      )}

      {activeTab === "blueprint" && (
        <section className="blueprint">
          {routes.map((route) => (
            <article key={route.name}>
              <h2>{route.name}</h2>
              <strong>{route.priority.toUpperCase()}</strong>
              <p>{route.policy}</p>
            </article>
          ))}
          <div className="nginx-map">
            <span>Client IP</span>
            <span>Subnet classifier</span>
            <span>8 token bucket</span>
            <span>3s sliding counter</span>
            <span>Upstream or 429</span>
          </div>
        </section>
      )}

      {activeTab === "evidence" && (
        <section className="evidence">
          {[
            "8-capacity token limit is rendered on every client meter and refills every 500ms.",
            "Bold, high-contrast token counters show active rate-limit state directly.",
            "Rogue IP subnet can be blocked dynamically and every denial appears in the monitor.",
            "10.0.0.0/24 bypasses limits while 192.168.1.5 spends 3 tokens per request.",
            "More than 15 spikes inside 3 seconds raises the high-severity warning banner.",
            "Telemetry requests are shed first when pressure rises to protect checkout assets.",
          ].map((item) => (
            <article key={item}>
              <span className="check">OK</span>
              <p>{item}</p>
            </article>
          ))}
        </section>
      )}
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
