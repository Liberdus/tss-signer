const SENSITIVE_ARG_FLAGS = new Set([
  "--channel_password",
  "--channel-password",
  "--password",
]);

/** Redact API keys and credentials from RPC URLs before logging. */
export function redactRpcUrlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    if (parsed.username) parsed.username = "***";
    if (parsed.search) {
      parsed.search = "?***";
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      segments[segments.length - 1] = "***";
      parsed.pathname = `/${segments.join("/")}`;
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return url.replace(
      /([?&](?:apikey|api_key|key|secret|token|password|auth|access_token)=)[^&]+/gi,
      "$1***",
    );
  }
}

/** Redact password flags from CLI arg lists before logging. */
export function redactCommandArgsForLog(args: string[]): string {
  const redacted: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const flag = arg.split("=")[0]?.toLowerCase();
    if (flag && SENSITIVE_ARG_FLAGS.has(flag) && arg.includes("=")) {
      redacted.push(`${flag}=***`);
      continue;
    }
    redacted.push(arg);
    if (flag && SENSITIVE_ARG_FLAGS.has(flag)) {
      const next = args[i + 1];
      if (next && !next.startsWith("--")) {
        redacted.push("***");
        i += 1;
      }
    }
  }
  return redacted.join(" ");
}
