import type { ServiceDraft } from "./types.js";

export function BasicsStep({ draft, onChange }: { draft: ServiceDraft; onChange: (patch: Partial<ServiceDraft>) => void }) {
  return (
    <div className="form-group">
      <label>Name</label>
      <input aria-label="Name" className="input" value={draft.name} onChange={(e) => onChange({ name: e.target.value })} />
      <label>Slug</label>
      <input aria-label="Slug" className="input" value={draft.slug} onChange={(e) => onChange({ slug: e.target.value })} />
      <label>Description</label>
      <input aria-label="Description" className="input" value={draft.description} onChange={(e) => onChange({ description: e.target.value })} />
      <label>Base URL</label>
      <input aria-label="Base URL" className="input" value={draft.baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} />
    </div>
  );
}

export function TransportStep() {
  return <div className="card"><p>Transport</p><input className="input" value="HTTP" readOnly disabled /><p>Other transports land in follow-up tasks.</p></div>;
}

export function EndpointsStep({ draft, onChange }: { draft: ServiceDraft; onChange: (endpoints: ServiceDraft["endpoints"]) => void }) {
  return <div className="cli-press-endpoint-list">{draft.endpoints.map((endpoint) => <div className="card cli-press-endpoint-row" key={endpoint.id}><input className="input" value={endpoint.name} placeholder="Name" onChange={(e) => onChange(draft.endpoints.map((item) => item.id === endpoint.id ? { ...item, name: e.target.value } : item))} /><select className="input" value={endpoint.method} onChange={(e) => onChange(draft.endpoints.map((item) => item.id === endpoint.id ? { ...item, method: e.target.value as typeof endpoint.method } : item))}><option>GET</option><option>POST</option><option>PUT</option><option>PATCH</option><option>DELETE</option></select><input className="input" value={endpoint.path} placeholder="/path" onChange={(e) => onChange(draft.endpoints.map((item) => item.id === endpoint.id ? { ...item, path: e.target.value } : item))} /><button className="btn btn-danger" onClick={() => onChange(draft.endpoints.filter((item) => item.id !== endpoint.id))}>Remove</button></div>) }<button className="btn" onClick={() => onChange([...draft.endpoints, { id: crypto.randomUUID(), name: "", method: "GET", path: "" }])}>Add endpoint</button></div>;
}

export function CredentialsStep({ draft, onChange }: { draft: ServiceDraft; onChange: (credential: ServiceDraft["credential"]) => void }) {
  const credential = draft.credential;
  return (
    <div className="form-group">
      <p className="card">OAuth support is deferred to FN-3762 / FN-3766.</p>
      <label><input type="radio" checked={credential.kind === "none"} onChange={() => onChange({ kind: "none" })} />None</label>
      <label><input type="radio" checked={credential.kind === "apiKey"} onChange={() => onChange({ kind: "apiKey", header: "", envVar: "" })} />API Key</label>
      <label><input type="radio" checked={credential.kind === "bearerToken"} onChange={() => onChange({ kind: "bearerToken", envVar: "" })} />Bearer Token</label>
      <label><input type="radio" checked={credential.kind === "basicAuth"} onChange={() => onChange({ kind: "basicAuth", usernameEnvVar: "", passwordEnvVar: "" })} />Basic Auth</label>

      {credential.kind === "apiKey" ? (
        <>
          <input className="input" value={credential.header} placeholder="X-Api-Key" onChange={(e) => onChange({ kind: "apiKey", header: e.target.value, envVar: credential.envVar })} />
          <input className="input" value={credential.envVar} placeholder="SERVICE_API_KEY" onChange={(e) => onChange({ kind: "apiKey", header: credential.header, envVar: e.target.value })} />
        </>
      ) : null}
      {credential.kind === "bearerToken" ? <input className="input" value={credential.envVar} placeholder="SERVICE_TOKEN" onChange={(e) => onChange({ kind: "bearerToken", envVar: e.target.value })} /> : null}
      {credential.kind === "basicAuth" ? (
        <>
          <input className="input" value={credential.usernameEnvVar} placeholder="SERVICE_USER" onChange={(e) => onChange({ kind: "basicAuth", usernameEnvVar: e.target.value, passwordEnvVar: credential.passwordEnvVar })} />
          <input className="input" value={credential.passwordEnvVar} placeholder="SERVICE_PASS" onChange={(e) => onChange({ kind: "basicAuth", usernameEnvVar: credential.usernameEnvVar, passwordEnvVar: e.target.value })} />
        </>
      ) : null}
    </div>
  );
}

export function ReviewStep({ draft }: { draft: ServiceDraft }) {
  return <pre className="card">{JSON.stringify(draft, null, 2)}</pre>;
}
