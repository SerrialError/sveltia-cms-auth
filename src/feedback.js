/**
 * Anonymous question feedback for the study site this worker signs editors into.
 *
 * The practice page posts `{ questionId, kind, comment, page, picked }` to `POST /feedback`, and
 * this files a GitHub issue on `FEEDBACK_REPO` with the `GITHUB_FEEDBACK_TOKEN` secret, so students
 * can report a problem without a GitHub account. The endpoint is open to anyone, so it only accepts
 * requests from the `ALLOWED_DOMAINS` sites, checks every field, and is rate-limited per IP address
 * when the `FEEDBACK_RATE_LIMITER` binding is configured.
 */

/** What a student can say is wrong with a question, and the label each gets in the issue title. */
export const feedbackKinds = {
  'wrong-answer': 'Wrong answer',
  unclear: 'Confusing or unclear',
  typo: 'Typo or formatting',
  difficulty: 'Difficulty label is off',
  other: 'Other',
};

const MAX_COMMENT = 2000;

/**
 * Build the CORS headers for a response to the given origin.
 * @param {string} origin - The request's `Origin` header, already checked against the allowed
 * domains.
 * @returns {Record<string, string>} Headers.
 */
const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

/**
 * Whether a URL's hostname matches one of the allowed domain patterns.
 * @param {string | null} url - Origin or page URL.
 * @param {string[]} patterns - Regular expression sources from `getDomainPatterns`.
 * @returns {boolean} True if allowed.
 */
const isAllowedURL = (url, patterns) => {
  try {
    const { hostname, protocol } = new URL(url ?? '');

    return (
      ['https:', 'http:'].includes(protocol) &&
      patterns.some((pattern) => new RegExp(pattern).test(hostname))
    );
  } catch {
    return false;
  }
};

/**
 * Turn a student's comment into a Markdown blockquote that can't mention anyone.
 * @param {string} comment - Comment text, already trimmed and length-checked.
 * @returns {string} Markdown.
 */
export const quoteComment = (comment) =>
  comment
    // Drop control characters other than newlines and tabs.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    // A zero-width space after @ keeps "@someone" from notifying a real GitHub user.
    .replaceAll('@', '@​')
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n');

/**
 * Check a feedback request body.
 * @param {unknown} body - Parsed JSON.
 * @param {string[]} patterns - Allowed domain patterns, for the page URL.
 * @returns {{ error: string } | { questionId: string, kind: string, comment: string, page:
 * string, picked?: string }} The cleaned fields, or what was wrong.
 */
export const parseFeedback = (body, patterns) => {
  if (!body || typeof body !== 'object') {
    return { error: 'Expected a JSON object.' };
  }

  const { questionId, kind, comment, page, picked, website } =
    /** @type {Record<string, unknown>} */ (body);

  // A hidden field people never see; bots that fill in every field get dropped.
  if (website) {
    return { error: 'Rejected.' };
  }

  if (typeof questionId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(questionId)) {
    return { error: 'Unknown question.' };
  }

  if (typeof kind !== 'string' || !Object.hasOwn(feedbackKinds, kind)) {
    return { error: 'Unknown feedback type.' };
  }

  const text = typeof comment === 'string' ? comment.trim() : '';

  if (text.length > MAX_COMMENT) {
    return { error: `Keep the comment under ${MAX_COMMENT} characters.` };
  }

  if (!text && kind === 'other') {
    return { error: 'Say what the problem is.' };
  }

  if (typeof page !== 'string' || page.length > 500 || !isAllowedURL(page, patterns)) {
    return { error: 'Unknown page.' };
  }

  if (picked !== undefined && (typeof picked !== 'string' || !/^[a-z]$/.test(picked))) {
    return { error: 'Unknown choice.' };
  }

  return { questionId, kind, comment: text, page, ...(picked ? { picked } : {}) };
};

/**
 * Write the GitHub issue for a piece of feedback.
 * @param {{ questionId: string, kind: string, comment: string, page: string, picked?: string }}
 * feedback - Cleaned fields from {@link parseFeedback}.
 * @returns {{ title: string, body: string }} Issue title and Markdown body.
 */
export const feedbackIssue = ({ questionId, kind, comment, page, picked }) => ({
  title: `Question feedback: ${questionId} (${feedbackKinds[kind]})`,
  body: [
    `- **Question:** \`${questionId}\``,
    `- **Problem:** ${feedbackKinds[kind]}`,
    ...(picked ? [`- **Student picked:** ${picked.toUpperCase()}`] : []),
    `- **Page:** ${page}`,
    '',
    comment ? quoteComment(comment) : '_No comment._',
    '',
    '<sub>Sent anonymously from the practice page.</sub>',
  ].join('\n'),
});

/**
 * Handle `OPTIONS` and `POST` requests to `/feedback`.
 * @param {Request} request - HTTP request.
 * @param {{ [key: string]: string | undefined } & { FEEDBACK_RATE_LIMITER?: { limit: (options:
 * { key: string }) => Promise<{ success: boolean }> } }} env - Environment variables and bindings.
 * @param {string[]} patterns - Allowed domain patterns.
 * @returns {Promise<Response>} HTTP response.
 */
export const handleFeedback = async (request, env, patterns) => {
  const origin = request.headers.get('Origin');

  if (!isAllowedURL(origin, patterns)) {
    return new Response('', { status: 403 });
  }

  const headers = corsHeaders(/** @type {string} */ (origin));

  /**
   * Send a JSON response with the CORS headers.
   * @param {number} status - HTTP status.
   * @param {object} data - Response body.
   * @returns {Response} HTTP response.
   */
  const reply = (status, data) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { ...headers, 'Content-Type': 'application/json' },
    });

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers });
  }

  if (!env.GITHUB_FEEDBACK_TOKEN || !env.FEEDBACK_REPO) {
    return reply(503, { error: 'Feedback isn’t set up yet.' });
  }

  if (env.FEEDBACK_RATE_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await env.FEEDBACK_RATE_LIMITER.limit({ key: ip });

    if (!success) {
      return reply(429, { error: 'Too much feedback at once. Try again in a minute.' });
    }
  }

  let body;

  try {
    body = await request.json();
  } catch {
    return reply(400, { error: 'Expected a JSON object.' });
  }

  const feedback = parseFeedback(body, patterns);

  if ('error' in feedback) {
    return reply(400, { error: feedback.error });
  }

  const response = await fetch(`https://api.github.com/repos/${env.FEEDBACK_REPO}/issues`, {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_FEEDBACK_TOKEN}`,
      'Content-Type': 'application/json',
      'User-Agent': 'sveltia-cms-auth-feedback',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify({ ...feedbackIssue(feedback), labels: ['question feedback'] }),
  });

  if (!response.ok) {
    // eslint-disable-next-line no-console
    console.error(`GitHub refused the feedback issue: ${response.status} ${await response.text()}`);

    return reply(502, { error: 'Couldn’t save the feedback. Try again later.' });
  }

  return reply(201, { ok: true });
};
