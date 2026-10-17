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

  const listDocs = async () => {
    const docs = [];
    let cursor;
    do {
      const query = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
      const page = await request(`/api/v1/docs${query}`);
      docs.push(...page.docs);
      cursor = page.cursor;
    } while (cursor);
    return docs;
  };

  return {
    account: () => request("/api/v1/account"),
    createHandoff: () => request("/api/v1/account/handoffs", { method: "POST" }),
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
    /**
     * Create a document that is private from its first request. A server without
     * private sharing answers 404, which reaches the caller as an APIError.
     * @param {{title?: string, html: string}} body
     */
    createPrivateDoc: (body) =>
      request("/api/v1/private-docs", { method: "POST", body: JSON.stringify(body) }),
    /** @param {string} docId @param {{title?: string, html: string}} body */
    updateDoc: (docId, body) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      }),
    listDocs,
    /**
     * A url that opens the owner's own page with no sign-in step: for a private
     * page, a grant that lasts 60 seconds. It is for the browser, never for output.
     * @param {string} docId
     */
    openDoc: (docId) => request(`/api/v1/docs/${encodeURIComponent(docId)}/open`, { method: "POST" }),
    /**
     * The owner's latest HTML. A Worker that predates private sharing has no …/html and serves every document publicly, so there `get` reads the public url, as it always did, without the token.
     * @param {string} docId
     */
    getHtml: async (docId) => {
      const html = await request(`/api/v1/docs/${encodeURIComponent(docId)}/html`, {}, [404]);
      if (html !== null) return html;
      const doc = (await listDocs()).find((item) => item.docId === docId);
      // A server that lists linkAccess has …/html, so its 404 is the answer.
      if (!doc || doc.linkAccess !== undefined) {
        throw new APIError(404, { error: { code: "not_found", message: `No document with id ${docId} is in this account.` } });
      }
      return request(doc.url, {}, [], false);
    },
    /** @param {string} docId */
    getAccess: (docId) => request(`/api/v1/docs/${encodeURIComponent(docId)}/access`),
    /** @param {string} docId @param {"anyone" | "invited"} linkAccess */
    setLinkAccess: (docId, linkAccess) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}/access`, {
        method: "PUT",
        body: JSON.stringify({ linkAccess }),
      }),
    /** The body is sent only for an explicit role, so a plain add stays the request older servers expect. @param {string} docId @param {string} email @param {string} [role] */
    addPerson: (docId, email, role) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}/access/people/${encodeURIComponent(email)}`, {
        method: "PUT",
        ...(role === undefined ? {} : { body: JSON.stringify({ role }) }),
      }),
    /** @param {string} docId @param {string} email */
    removePerson: (docId, email) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}/access/people/${encodeURIComponent(email)}`, {
        method: "DELETE",
      }),
    /** Decline a pending request. It is idempotent and tells the requester nothing. @param {string} docId @param {string} email */
    declineRequest: (docId, email) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}/access/requests/${encodeURIComponent(email)}`, {
        method: "DELETE",
      }),
    /**
     * The document's comment threads. `since` is an ISO time; the server answers
     * 404 for a reader who cannot see the document and for a server without comments.
     * @param {string} docId @param {{state?: "open" | "resolved" | "all", since?: string}} [options]
     */
    listThreads: (docId, { state, since } = {}) => {
      const query = new URLSearchParams();
      if (state) query.set("state", state);
      if (since) query.set("since", since);
      const suffix = query.toString() ? `?${query}` : "";
      return request(`/api/v1/docs/${encodeURIComponent(docId)}/threads${suffix}`);
    },
    /** Start a thread on quoted text. @param {string} docId @param {{anchor: {exact: string, prefix?: string, suffix?: string, section?: string}, body: string, version?: number}} body */
    addThread: (docId, body) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}/threads`, { method: "POST", body: JSON.stringify(body) }),
    /** @param {string} docId @param {string} threadId @param {string} body */
    replyToThread: (docId, threadId, body) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/comments`, {
        method: "POST",
        body: JSON.stringify({ body }),
      }),
    /** @param {string} docId @param {string} threadId @param {number} [version] the version that addressed it */
    resolveThread: (docId, threadId, version) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/resolve`, {
        method: "POST",
        body: JSON.stringify(version === undefined ? {} : { version }),
      }),
    /** @param {string} docId @param {string} threadId */
    reopenThread: (docId, threadId) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}/threads/${encodeURIComponent(threadId)}/reopen`, { method: "POST" }),
    /** Delete the caller's own comment; a thread's first comment takes the thread with it. @param {string} docId @param {string} commentId */
    deleteComment: (docId, commentId) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}/comments/${encodeURIComponent(commentId)}`, { method: "DELETE" }),
    /** The name the caller's comments carry. @param {string} displayName */
    setDisplayName: (displayName) =>
      request("/api/v1/account", { method: "PUT", body: JSON.stringify({ displayName }) }),
    /** @param {string} docId */
    unshare: (docId) =>
      request(`/api/v1/docs/${encodeURIComponent(docId)}`, { method: "DELETE" }, [404]),
    listTokens: () => request("/api/v1/tokens"),
    /** @param {string} tokenId */
    revoke: (tokenId) =>
      request(`/api/v1/tokens/${encodeURIComponent(tokenId)}`, { method: "DELETE" }, [404]),
  };
}
