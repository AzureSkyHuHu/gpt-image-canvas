export interface AuthUser {
  id: string;
  label: string;
}

export interface AuthMeResponse {
  authEnabled: boolean;
  authenticated: boolean;
  user?: AuthUser;
}

export interface AuthLoginRequest {
  token: string;
}

export interface AdminMeResponse {
  authEnabled: boolean;
  authenticated: boolean;
}

export interface AdminLoginRequest {
  password: string;
}

export interface AccessTokenView {
  id: string;
  label: string;
  tokenPreview: string;
  upstreamApiKeyPreview: string;
  upstreamBaseURL?: string;
  upstreamModel?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AccessTokenListResponse {
  items: AccessTokenView[];
}

export interface CreateAccessTokenRequest {
  label: string;
  accessToken?: string;
  upstreamApiKey: string;
  upstreamBaseURL?: string;
  upstreamModel?: string;
  enabled?: boolean;
}

export interface CreateAccessTokenResponse {
  item: AccessTokenView;
  accessToken: string;
}

export interface UpdateAccessTokenRequest {
  label?: string;
  accessToken?: string;
  upstreamApiKey?: string;
  upstreamBaseURL?: string | null;
  upstreamModel?: string | null;
  enabled?: boolean;
}
