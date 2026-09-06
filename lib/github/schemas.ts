import {
  AUTH_FAULT_NAME, AUTH_ISSUE, AUTH_MESSAGE, AUTH_MESSAGES, AUTH_MESSAGE_PREFIX, AUTH_STATUS,
  GITHUB_APP_SCOPE, GITHUB_TOKEN_TYPE, OAUTH_ERROR, VERIFICATION_URL,
} from '../constants/github';
import { z } from '../schema';

export const issueSchema = z.enum(AUTH_ISSUE);
export type AuthIssue = z.infer<typeof issueSchema>;

export const issueMessages = AUTH_MESSAGES;

export class AuthFault extends Error {
  constructor(readonly issue: AuthIssue) {
    super(issueMessages[issue]);
    this.name = AUTH_FAULT_NAME;
  }
}

export const clientIdSchema = z.string().regex(/^[A-Za-z0-9._-]{1,128}$/);
export const appConfigSchema = z.strictObject({ clientId: clientIdSchema.nullable() });
const tokenSchema = z.string().min(1).max(4096);
export const credentialsSchema = z.strictObject({ token: tokenSchema, expiresAt: z.iso.datetime() });
export type Credentials = z.infer<typeof credentialsSchema>;
export const githubUserSchema = z.strictObject({
  id: z.int().positive(),
  login: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/),
});
export const githubUserResponseSchema = githubUserSchema.strip();
export const verificationSchema = z.object({
  device_code: z.string().min(1).max(512),
  user_code: z.string().regex(/^[A-Z0-9-]{4,32}$/),
  verification_uri: z.literal(VERIFICATION_URL),
  expires_in: z.int().positive().max(900),
  interval: z.int().positive().max(900),
});
export const authenticationSchema = z.object({
  token: tokenSchema,
  expiresAt: z.iso.datetime().optional(),
});
export const grantResponseSchema = z.object({
  access_token: tokenSchema,
  token_type: z.literal(GITHUB_TOKEN_TYPE),
  scope: z.literal(GITHUB_APP_SCOPE),
  expires_in: z.int().positive().optional(),
  refresh_token: tokenSchema.optional(),
  refresh_token_expires_in: z.int().positive().optional(),
});

const disconnectedSchema = z.strictObject({ status: z.literal(AUTH_STATUS.disconnected), issue: issueSchema });
export const pendingSessionSchema = z.strictObject({
  status: z.literal(AUTH_STATUS.authorizing), attemptId: z.uuid(), clientId: clientIdSchema,
  ownerTabId: z.int().nonnegative(), ownerDocumentId: z.string().min(1),
});
export const connectedSessionSchema = z.strictObject({
  status: z.literal(AUTH_STATUS.connected), connectionId: z.uuid(), clientId: clientIdSchema,
  token: tokenSchema, expiresAt: z.iso.datetime(), verifiedAt: z.iso.datetime(),
  user: githubUserSchema,
});
export type ConnectedSession = z.infer<typeof connectedSessionSchema>;
export const sessionSchema = z.discriminatedUnion('status', [
  disconnectedSchema, pendingSessionSchema, connectedSessionSchema,
]);
export type AuthSession = z.infer<typeof sessionSchema>;

export const authStateSchema = z.discriminatedUnion('status', [
  disconnectedSchema,
  z.strictObject({ status: z.literal(AUTH_STATUS.unavailable), issue: issueSchema }),
  z.strictObject({ status: z.literal(AUTH_STATUS.authorizing), attemptId: z.uuid(), clientId: clientIdSchema }),
  z.strictObject({
    status: z.literal(AUTH_STATUS.connected), expiresAt: z.iso.datetime(), verifiedAt: z.iso.datetime(),
    user: githubUserSchema,
  }),
]);
export type AuthState = z.infer<typeof authStateSchema>;
export const authEnvelopeSchema = z.object({ type: z.string().startsWith(AUTH_MESSAGE_PREFIX) });
export const authRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal(AUTH_MESSAGE.state) }),
  z.strictObject({ type: z.literal(AUTH_MESSAGE.begin), attemptId: z.uuid() }),
  z.strictObject({ type: z.literal(AUTH_MESSAGE.permit), attemptId: z.uuid() }),
  z.strictObject({ type: z.literal(AUTH_MESSAGE.complete), attemptId: z.uuid(), credentials: credentialsSchema }),
  z.strictObject({ type: z.literal(AUTH_MESSAGE.cancel), attemptId: z.uuid(), issue: issueSchema }),
  z.strictObject({ type: z.literal(AUTH_MESSAGE.disconnect) }),
  z.strictObject({ type: z.literal(AUTH_MESSAGE.check) }),
]);
export type AuthRequest = z.infer<typeof authRequestSchema>;
export const authReplySchema = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true), state: authStateSchema }),
  z.strictObject({ ok: z.literal(false), error: issueSchema }),
]);
export type AuthReply = z.infer<typeof authReplySchema>;

const oauthErrorSchema = z.object({
  response: z.object({ data: z.object({ error: z.string() }) }),
});
const httpErrorSchema = z.object({ status: z.number() });

export function oauthErrorCode(error: unknown): string | null {
  const parsed = oauthErrorSchema.safeParse(error);
  return parsed.success ? parsed.data.response.data.error : null;
}

export function authIssue(error: unknown): AuthIssue {
  if (error instanceof AuthFault) return error.issue;
  switch (oauthErrorCode(error)) {
    case OAUTH_ERROR.accessDenied: return AUTH_ISSUE.denied;
    case OAUTH_ERROR.expiredToken: return AUTH_ISSUE.flowExpired;
    case OAUTH_ERROR.incorrectClientCredentials:
    case OAUTH_ERROR.deviceFlowDisabled: return AUTH_ISSUE.configurationInvalid;
  }
  const http = httpErrorSchema.safeParse(error);
  return http.success && http.data.status >= 500 ? AUTH_ISSUE.networkError : AUTH_ISSUE.providerError;
}
