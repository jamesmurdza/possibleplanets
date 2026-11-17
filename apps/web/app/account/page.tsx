"use client";

/**
 * Self-serve account page: sign in with GitHub, then create/revoke API
 * keys for calling the /v1/* gateway as yourself (see lib/apiKey.ts and
 * the REST example on every model page). Deliberately separate from
 * /dashboard -- that's the internal ops console (one shared password,
 * see lib/auth.ts); this is public, per-user, and anyone can use it.
 */
import { useEffect, useState } from "react";
import { PublicHeader, PublicFooter } from "../../components/PublicChrome";

interface ApiKeyRow {
  id: number;
  key_prefix: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface User {
  id: number;
  login: string;
  avatar_url: string | null;
}

export default function AccountPage() {
  const [user, setUser] = useState<User | null | undefined>(undefined); // undefined = still loading
  const [keys, setKeys] = useState<ApiKeyRow[]>([]);
  const [label, setLabel] = useState("");
  const [justCreated, setJustCreated] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function loadKeys() {
    const res = await fetch("/api/keys");
    if (res.ok) {
      const data = await res.json();
      setKeys(data.keys ?? []);
    }
  }

  useEffect(() => {
    fetch("/api/account/me")
      .then((r) => r.json())
      .then((data) => {
        setUser(data.user ?? null);
        if (data.user) loadKeys();
      })
      .catch(() => setUser(null));
  }, []);

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: label || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "failed to create key");
      setJustCreated(data.key);
      setLabel("");
      await loadKeys();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: number) {
    await fetch(`/api/keys/${id}`, { method: "DELETE" });
    await loadKeys();
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    setUser(null);
    setKeys([]);
  }

  return (
    <div className="public-page">
      <PublicHeader />
      <main className="public-main article">
        <h1 className="article-title">Account</h1>

        {user === undefined && <p>Loading...</p>}

        {user === null && (
          <section className="article-section">
            <h2>Sign in</h2>
            <p>
              Sign in with GitHub to create API keys for calling the <code>/v1/*</code> gateway directly (see any
              model page&apos;s &quot;How to run&quot; section for the request shape).
            </p>
            <a className="primary-button" href="/api/auth/github" style={{ display: "inline-block", textDecoration: "none" }}>
              Sign in with GitHub
            </a>
          </section>
        )}

        {user && (
          <>
            <section className="article-section">
              <h2>Signed in as {user.login}</h2>
              <button className="primary-button" onClick={logout}>
                Sign out
              </button>
            </section>

            <section className="article-section">
              <h2>API keys</h2>
              <p>
                Each key authenticates requests to <code>POST /v1/models/&#123;model&#125;/runs</code> and{" "}
                <code>GET /v1/runs/&#123;run_id&#125;</code> as you -- send it as{" "}
                <code>Authorization: Bearer &lt;key&gt;</code>. Already-cached results don&apos;t need a key at
                all (no new sandbox run happens, so there&apos;s nothing to authorize); a key is only checked when
                a request would actually start one.
              </p>

              {justCreated && (
                <p className="panel-error" style={{ color: "#1b7a3d", background: "#e9f7ee", borderColor: "#bfe6cc" }}>
                  New key (shown once, copy it now): <code>{justCreated}</code>
                </p>
              )}
              {error && <p className="panel-error">{error}</p>}

              <form onSubmit={createKey} style={{ display: "flex", gap: "0.5rem", alignItems: "flex-end", marginBottom: "1rem" }}>
                <label className="form-field">
                  <span className="form-field-label">Label (optional)</span>
                  <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. my laptop" />
                </label>
                <button type="submit" className="primary-button" disabled={busy}>
                  {busy ? "Creating..." : "Create new key"}
                </button>
              </form>

              {keys.length === 0 ? (
                <p>No API keys yet.</p>
              ) : (
                <table className="run-guide-code" style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left" }}>Key</th>
                      <th style={{ textAlign: "left" }}>Label</th>
                      <th style={{ textAlign: "left" }}>Created</th>
                      <th style={{ textAlign: "left" }}>Last used</th>
                      <th style={{ textAlign: "left" }}>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.id}>
                        <td>{k.key_prefix}...</td>
                        <td>{k.label || "--"}</td>
                        <td>{new Date(k.created_at).toLocaleDateString()}</td>
                        <td>{k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : "never"}</td>
                        <td>{k.revoked_at ? "revoked" : "active"}</td>
                        <td>
                          {!k.revoked_at && (
                            <button className="primary-button" onClick={() => revoke(k.id)}>
                              Revoke
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </>
        )}
      </main>
      <PublicFooter />
    </div>
  );
}
