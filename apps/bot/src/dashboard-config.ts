/** Worker-side dashboard connectivity; no gateway or music imports. */
export function resolveDashboardConnection(input: {
  NODE_ENV?: string;
  APP_URL?: string;
  DASHBOARD_INTERNAL_URL?: string;
  INTERNAL_API_TOKEN?: string;
}) {
  const production = input.NODE_ENV !== "development" && input.NODE_ENV !== "test";
  const normalize = (value: string, variable: string, publicUrl = false) => {
    try {
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        (production && publicUrl && url.protocol !== "https:")
      )
        throw new Error();
      return url.origin;
    } catch {
      throw new Error(
        `${variable} must be an absolute HTTP(S) origin; production APP_URL requires HTTPS.`,
      );
    }
  };
  const appUrl = normalize(
    input.APP_URL || (!production ? "http://localhost:3000" : ""),
    "APP_URL",
    true,
  );
  const dashboardInternalUrl = normalize(
    input.DASHBOARD_INTERNAL_URL || appUrl,
    "DASHBOARD_INTERNAL_URL",
  );
  const internalToken = input.INTERNAL_API_TOKEN;
  if (
    production &&
    internalToken &&
    (internalToken.length < 32 ||
      new Set(internalToken).size < 12 ||
      /change[-_]?me|placeholder|your[-_]secret/i.test(internalToken))
  )
    throw new Error(
      "INTERNAL_API_TOKEN must be an independently generated random secret of at least 32 characters.",
    );
  // An absent token deliberately disables internal clients (existing behavior).
  return { appUrl, dashboardInternalUrl, internalToken };
}
