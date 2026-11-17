/** Domain error with a machine-readable `code` (screens show `message`). */
export class ServiceError extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) { super(message); this.name = 'ServiceError'; this.code = code; }
}
