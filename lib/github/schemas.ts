import { z } from '../schema';

export const AUTH_SESSION_KEY = 'github-connection-v1';
export const AUTH_EXPIRY_ALARM = 'github-connection-expiry';
export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const TOKEN_URL = 'https://github.com/login/oauth/access_token';
export const VERIFICATION_URL = 'https://github.com/login/device';

export const issueSchema = z.enum([
  'not-connected', 'configuration-required', 'configuration-invalid', 'configuration-unavailable',
  'cancelled', 'interrupted', 'expired', 'denied', 'flow-expired', 'network-error',
  'provider-error', 'identity-failed', 'expiring-tokens-required', 'invalid-session', 'not-allowed',
]);
export type AuthIssue = z.infer<typeof issueSchema>;

export const issueMessages: Record<AuthIssue, string> = {
  'not-connected': 'Not connected to GitHub.',
  'configuration-required': 'Configure the public GitHub App client ID, then rebuild and reload the extension.',
  'configuration-invalid': 'Check the public GitHub App client ID and enable device flow in the App settings.',
  'configuration-unavailable': 'GitHub App configuration could not be loaded. Reload the extension.',
  cancelled: 'GitHub authorization cancelled.',
  interrupted: 'GitHub authorization was interrupted. Start a new connection.',
  expired: 'The GitHub session expired. Connect again.',
  denied: 'GitHub authorization was denied. You can try again.',
  'flow-expired': 'The GitHub verification code expired. Start a new connection.',
  'network-error': 'GitHub could not be reached. Check your connection and try again.',
  'provider-error': 'GitHub returned an unsupported authorization response. Try connecting again.',
  'identity-failed': 'GitHub identity could not be verified. Connect again.',
  'expiring-tokens-required': 'Enable expiring user access tokens in the GitHub App settings, then reconnect.',
  'invalid-session': 'Stored GitHub connection data was invalid and has been cleared. Connect again.',
  'not-allowed': 'This GitHub connection request is no longer permitted.',
};

export class AuthFault extends Error {
  constructor(readonly issue: AuthIssue) {
    super(issueMessages[issue]);
    this.name = 'AuthFault';
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
  token_type: z.literal('bearer'),
  scope: z.literal(''),
  expires_in: z.int().positive().optional(),
  refresh_token: tokenSchema.optional(),
  refresh_token_expires_in: z.int().positive().optional(),
});

const disconnectedSchema = z.strictObject({ status: z.literal('disconnected'), issue: issueSchema });
export const pendingSessionSchema = z.strictObject({
  status: z.literal('authorizing'), attemptId: z.uuid(), clientId: clientIdSchema,
  ownerTabId: z.int().nonnegative(), ownerDocumentId: z.string().min(1),
});
export const connectedSessionSchema = z.strictObject({
  status: z.literal('connected'), connectionId: z.uuid(), clientId: clientIdSchema,
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
  z.strictObject({ status: z.literal('unavailable'), issue: issueSchema }),
  z.strictObject({ status: z.literal('authorizing'), attemptId: z.uuid(), clientId: clientIdSchema }),
  z.strictObject({
    status: z.literal('connected'), expiresAt: z.iso.datetime(), verifiedAt: z.iso.datetime(),
    user: githubUserSchema,
  }),
]);
export type AuthState = z.infer<typeof authStateSchema>;
export const authEnvelopeSchema = z.object({ type: z.string().startsWith('github:') });
export const authRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('github:state') }),
  z.strictObject({ type: z.literal('github:begin'), attemptId: z.uuid() }),
  z.strictObject({ type: z.literal('github:permit'), attemptId: z.uuid() }),
  z.strictObject({ type: z.literal('github:complete'), attemptId: z.uuid(), credentials: credentialsSchema }),
  z.strictObject({ type: z.literal('github:cancel'), attemptId: z.uuid(), issue: issueSchema }),
  z.strictObject({ type: z.literal('github:disconnect') }),
  z.strictObject({ type: z.literal('github:check') }),
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
    case 'access_denied': return 'denied';
    case 'expired_token': return 'flow-expired';
    case 'incorrect_client_credentials':
    case 'device_flow_disabled': return 'configuration-invalid';
  }
  const http = httpErrorSchema.safeParse(error);
  return http.success && http.data.status >= 500 ? 'network-error' : 'provider-error';
}
