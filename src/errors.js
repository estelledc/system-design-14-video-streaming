export class AppError extends Error {
  constructor(message, { code = 'internal_error', status = 500, cause } = {}) {
    super(message, { cause });
    this.name = new.target.name;
    this.code = code;
    this.status = status;
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Request validation failed') {
    super(message, { code: 'invalid_request', status: 400 });
  }
}

export class AuthenticationError extends AppError {
  constructor() {
    super('Authentication required', { code: 'unauthorized', status: 401 });
  }
}

export class NotFoundError extends AppError {
  constructor() {
    super('Resource was not found', { code: 'not_found', status: 404 });
  }
}

export class GoneError extends AppError {
  constructor() {
    super('Resource is no longer available', { code: 'gone', status: 410 });
  }
}

export class RequestConflictError extends AppError {
  constructor(message = 'Stable request identity is bound to different intent') {
    super(message, { code: 'idempotency_conflict', status: 409 });
  }
}

export class OffsetConflictError extends AppError {
  constructor() {
    super('Upload offset does not match the committed offset', { code: 'offset_conflict', status: 409 });
  }
}

export class StateConflictError extends AppError {
  constructor(message = 'Resource state does not allow this transition') {
    super(message, { code: 'state_conflict', status: 409 });
  }
}

export class LeaseConflictError extends AppError {
  constructor() {
    super('Worker lease is stale or expired', { code: 'lease_conflict', status: 409 });
  }
}

export class IntegrityError extends AppError {
  constructor(message = 'Object integrity verification failed') {
    super(message, { code: 'integrity_failed', status: 422 });
  }
}

export class RangeNotSatisfiableError extends AppError {
  constructor(totalBytes) {
    super('Requested range cannot be satisfied', { code: 'range_not_satisfiable', status: 416 });
    this.totalBytes = totalBytes;
  }
}

export class DependencyError extends AppError {
  constructor(message = 'Dependency operation failed', cause) {
    super(message, { code: 'dependency_unavailable', status: 503, cause });
  }
}
