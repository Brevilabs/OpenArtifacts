// These operation names are the contract checked against Copilot's coverage file.

/** @typedef {import("./access.d.cts").LinkAccess} LinkAccess */
/** @typedef {import("./access.d.cts").Role} Role */
/** @typedef {import("./access.d.cts").AccessRequest} AccessRequest */

/**
 * @param {string} docId
 * @param {AccessRequest["method"]} method
 * @param {string} [suffix]
 * @param {{linkAccess: LinkAccess} | {role: Role}} [body]
 * @returns {AccessRequest}
 */
function request(docId, method, suffix = "", body) {
  return {
    path: `/api/v1/docs/${encodeURIComponent(docId)}/access${suffix}`,
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  };
}

/** @type {import("./access.d.cts").AccessOperations} */
const documentAccess = {
  getAccess: (docId) => request(docId, "GET"),
  setLinkAccess: (docId, linkAccess) => request(docId, "PUT", "", { linkAccess }),
  addPerson: (docId, email, role) =>
    request(docId, "PUT", `/people/${encodeURIComponent(email)}`, role === undefined ? undefined : { role }),
  removePerson: (docId, email) => request(docId, "DELETE", `/people/${encodeURIComponent(email)}`),
  declineRequest: (docId, email) => request(docId, "DELETE", `/requests/${encodeURIComponent(email)}`),
};

exports.documentAccess = documentAccess;
