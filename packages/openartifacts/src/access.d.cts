export type LinkAccess = "anyone" | "invited";
export type Role = "view" | "comment";
export interface AccessRequest {
  path: string;
  method: "GET" | "PUT" | "DELETE";
  body?: string;
}
export interface AccessOperations {
  getAccess(docId: string): AccessRequest;
  setLinkAccess(docId: string, linkAccess: LinkAccess): AccessRequest;
  addPerson(docId: string, email: string, role?: Role): AccessRequest;
  removePerson(docId: string, email: string): AccessRequest;
  declineRequest(docId: string, email: string): AccessRequest;
}
export const documentAccess: AccessOperations;
