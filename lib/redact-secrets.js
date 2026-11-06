/**
 * Mask credential-looking values in free text (error messages, sync logs)
 * before it is shown in the UI. Defense in depth: errors are not expected to
 * carry secrets, but upstream messages are outside our control.
 */

const MASK = "[hidden]";

const PATTERNS = [
    // Cookie pairs used by Acumatica / ASP.NET sessions
    [/(?<!\w)(ASP\.NET_SessionId|\.ASPXAUTH|\.ASPXFORMSAUTH|requeststat|UserBranch|Locale|CompanyID)=([^;\s,"']+)/gi, `$1=${MASK}`],
    // Authorization headers and bearer tokens
    [/\b(Authorization\s*[:=]\s*)(Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, `$1$2 ${MASK}`],
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, `Bearer ${MASK}`],
    // key=value / "key": "value" for secret-like keys
    [/\b(password|passwd|pwd|secret|client_secret|api[_-]?key|access_token|refresh_token|id_token|token|cookie|set-cookie)(["']?\s*[:=]\s*["']?)([^"'\s,;&}]+)/gi, `$1$2${MASK}`],
    // JSON Web Tokens
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, MASK],
    // Credentials embedded in URLs (https://user:pass@host)
    [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, `$1${MASK}@`],
];

export function redactSecrets(text) {
    if (text === null || text === undefined) return text;
    let out = String(text);
    for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
    return out;
}
