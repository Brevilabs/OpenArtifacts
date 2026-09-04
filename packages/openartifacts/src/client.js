/** An error returned by the OpenArtifacts JSON API. */
export class APIError extends Error {
  /** @param {number} status @param {Record<string, any>} body */
  constructor(status, body) {
    const detail = body.error ?? {};
    super(detail.message ?? `OpenArtifacts returned HTTP ${status}.`);
    this.name = "APIError";
    this.status = status;
    this.code = detail.code;
    this.detail = detail;
  }
}

/**
 * The fetch-only OpenArtifacts client. Keeping it free of Node APIs lets the
 * same calls be tested directly against the local Worker.
 * @param {{host: string, token?: string, fetcher?: typeof fetch}} options
 */
export function createClient({ host, token, fetcher = fetch }) {
  const base = host.replace(/\/$/, "");

  /** @param {string} path @param {RequestInit} [init] @param {number[]} [allowed] @param {boolean} [authenticated] */
  async function request(path, init = {}, allowed = [], authenticated = true) {
    const headers = new Headers(init.headers);
    if (token && authenticated) headers.set("authorization", `Bearer ${token}`);
    if (init.body !== undefined) headers.set("content-type", "application/json");
    const response = await fetcher(path.startsWith("http") ? path : `${base}${path}`, {
      ...init,
      headers,
    });
    if (!response.ok && allowed.includes(response.status)) return null;
    if (!response.ok) {
      let body = {};
      try {
        body = await response.json();
      } catch {}
      throw new APIError(response.status, body);
    }
    if (response.status === 204) return null;
    const type = response.headers.get("content-type") ?? "";
    return type.includes("application/json") ? response.json() : response.text();
  }

  return {
    /** @param {string} label */
    deviceCode: (label) =>
      request("/device/code", { method: "POST", body: JSON.stringify({ label }) }),
    /** @param {string} deviceCode */
    deviceToken: (deviceCode) =>
      request("/device/token", {
        method: "POST",
        body: JSON.stringify({ device_code: deviceCode }),
      }),
    /** @param {{title?: string, html: string}} body */
    createDoc: (body) =>
      request("/api/v1/docs", { method: "POST", body: JSON.stringify(body) }),
    /** @param {string} docId @param {{title?: string, html: string}} body */
    updateDoc: (docId, body) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    listDocs: async () => {
      const docs = [];
      let cursor;
      do {
        const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
        const page = await request(`/api/v1/docs${query}`);
        docs.push(...page.docs);
        cursor = page.cursor;
      } while (cursor);
      return docs;
    },
    /** @param {string} url */
    readDocument: (url) => request(url, {}, [], false),
    /** @param {string} docId */
    unshare: (docId) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}`, { method: "DELETE" }, [404]),
    listTokens: () => request("/api/v1/tokens"),
    /** @param {string} tokenId */
    revoke: (tokenId) =>
      request(`/api/v1/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" }, [404]),
  };
}
