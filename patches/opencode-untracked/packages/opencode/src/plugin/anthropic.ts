import type { Hooks, PluginInput } from "@opencode-ai/plugin"
import * as Log from "@opencode-ai/core/util/log"
import { OAUTH_DUMMY_KEY } from "../auth"
import { ProviderID } from "../provider/schema"

const log = Log.create({ service: "plugin.anthropic" })

// Claude Code's public OAuth client. Lets a Claude Pro/Max subscription drive
// the Anthropic provider (api.anthropic.com/v1/messages) without an API key.
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize"
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token"
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback"
const SCOPE = "org:create_api_key user:profile user:inference"

// Sent when exchanging/refreshing tokens.
const OAUTH_BETA = "oauth-2025-04-20"
// Merged into every inference request's anthropic-beta header. oauth-2025-04-20
// authorizes the subscription token; the rest match Claude Code / opencode.
const REQUEST_BETAS = [
  "oauth-2025-04-20",
  "claude-code-20250219",
  "interleaved-thinking-2025-05-14",
  "fine-grained-tool-streaming-2025-05-14",
]
// Anthropic rejects a Pro/Max OAuth token unless the request presents as Claude
// Code. This must be the first system block.
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."

interface PkceCodes {
  verifier: string
  challenge: string
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43)
  const encoder = new TextEncoder()
  const data = encoder.encode(verifier)
  const hash = await crypto.subtle.digest("SHA-256", data)
  const challenge = base64UrlEncode(hash)
  return { verifier, challenge }
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"
  const bytes = crypto.getRandomValues(new Uint8Array(length))
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("")
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const binary = String.fromCharCode(...bytes)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function generateState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)).buffer)
}

function buildAuthorizeUrl(pkce: PkceCodes, state: string): string {
  const params = new URLSearchParams({
    code: "true",
    client_id: CLIENT_ID,
    response_type: "code",
    scope: SCOPE,
    redirect_uri: REDIRECT_URI,
    code_challenge: pkce.challenge,
    code_challenge_method: "S256",
    state,
  })
  return `${AUTHORIZE_URL}?${params.toString()}`
}

interface TokenResponse {
  access_token: string
  refresh_token: string
  expires_in?: number
}

async function exchangeCodeForTokens(pasted: string, pkce: PkceCodes, expectedState: string): Promise<TokenResponse> {
  // Anthropic's callback page shows the code as "code#state" to paste back.
  const [code, returnedState] = pasted.trim().split("#")
  if (!code || !returnedState) throw new Error("Invalid code format. Expected: code#state")
  if (returnedState !== expectedState) throw new Error("State mismatch - potential CSRF, aborting")

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-beta": OAUTH_BETA },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      state: returnedState,
      code_verifier: pkce.verifier,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status} ${await response.text()}`)
  return response.json()
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "anthropic-beta": OAUTH_BETA },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`)
  return response.json()
}

function mergeBetaHeader(existing: string | null): string {
  const present = new Set(
    (existing ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  )
  for (const beta of REQUEST_BETAS) present.add(beta)
  return Array.from(present).join(",")
}

// Prepend the Claude Code identity as the first system block, required for
// Pro/Max OAuth tokens. Accepts the @ai-sdk/anthropic body shape where `system`
// is a string or an array of text blocks.
function injectClaudeCodeSystem(body: any): void {
  const block = { type: "text", text: CLAUDE_CODE_SYSTEM }
  if (Array.isArray(body.system)) {
    if (body.system[0]?.text === CLAUDE_CODE_SYSTEM) return
    body.system = [block, ...body.system]
  } else if (typeof body.system === "string" && body.system.length > 0) {
    body.system = [block, { type: "text", text: body.system }]
  } else {
    body.system = [block]
  }
}

export async function AnthropicAuthPlugin(input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: ProviderID.anthropic,
      async loader(getAuth) {
        const auth = await getAuth()
        // API-key and unset users fall through to opencode's built-in path.
        if (auth.type !== "oauth") return {}

        let refreshPromise: Promise<string> | undefined

        return {
          apiKey: OAUTH_DUMMY_KEY,
          async fetch(requestInput: RequestInfo | URL, init?: RequestInit) {
            const currentAuth = await getAuth()
            if (currentAuth.type !== "oauth") return fetch(requestInput, init)

            // Refresh if expired (single-flight, mirrors codex plugin).
            if (!currentAuth.access || currentAuth.expires < Date.now()) {
              if (!refreshPromise) {
                log.info("refreshing anthropic oauth token")
                refreshPromise = refreshAccessToken(currentAuth.refresh)
                  .then(async (tokens) => {
                    await input.client.auth.set({
                      path: { id: ProviderID.anthropic },
                      body: {
                        type: "oauth",
                        refresh: tokens.refresh_token || currentAuth.refresh,
                        access: tokens.access_token,
                        expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                      },
                    })
                    return tokens.access_token
                  })
                  .finally(() => {
                    refreshPromise = undefined
                  })
              }
              currentAuth.access = await refreshPromise
            }

            const headers = new Headers(init?.headers as HeadersInit)
            // Swap the dummy x-api-key for the OAuth bearer token.
            headers.delete("x-api-key")
            headers.set("authorization", `Bearer ${currentAuth.access}`)
            headers.set("anthropic-beta", mergeBetaHeader(headers.get("anthropic-beta")))

            let body = init?.body
            if (typeof body === "string" && init?.method === "POST") {
              try {
                const parsed = JSON.parse(body)
                injectClaudeCodeSystem(parsed)
                body = JSON.stringify(parsed)
              } catch {
                // Non-JSON body: leave untouched.
              }
            }

            return fetch(requestInput, { ...init, headers, body })
          },
        }
      },
      methods: [
        {
          label: "Claude Pro/Max",
          type: "oauth",
          authorize: async () => {
            const pkce = await generatePKCE()
            const state = generateState()
            return {
              url: buildAuthorizeUrl(pkce, state),
              instructions: "Log in, then paste the code shown (format: code#state).",
              method: "code" as const,
              callback: async (code: string) => {
                const tokens = await exchangeCodeForTokens(code, pkce, state)
                return {
                  type: "success" as const,
                  refresh: tokens.refresh_token,
                  access: tokens.access_token,
                  expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
                }
              },
            }
          },
        },
      ],
    },
  }
}
