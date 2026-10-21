// Development-status keys are copied here instead of importing the incubating entry point, which
// the semconv package says not to use at runtime.

/** `http.request.body.size`: semantic-conventions v1.43.0, development. */
export const ATTR_HTTP_REQUEST_BODY_SIZE = "http.request.body.size";

/** `http.response.body.size`: semantic-conventions v1.43.0, development. */
export const ATTR_HTTP_RESPONSE_BODY_SIZE = "http.response.body.size";

/**
 * `http.request.body.content`: development. Added on semantic-conventions `main`
 * by PR #3521 (commit bcd7e291081f, 2026-08-14); not in a release as of v1.44.0.
 */
export const ATTR_HTTP_REQUEST_BODY_CONTENT = "http.request.body.content";

/** `http.response.body.content`: same source as {@link ATTR_HTTP_REQUEST_BODY_CONTENT}. */
export const ATTR_HTTP_RESPONSE_BODY_CONTENT = "http.response.body.content";
