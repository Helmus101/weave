export function isBlacklisted(
  input: { appName?: string; bundleId?: string; title?: string }, 
  appBlacklist: string[],
  websiteBlacklist: string[]
): boolean {
  const appHaystack = [input.appName, input.bundleId].filter(Boolean).join(" ").toLowerCase();
  const titleHaystack = (input.title || "").toLowerCase();

  const appBlocked = appBlacklist.some((matcher) => matcher && appHaystack.includes(matcher.toLowerCase()));
  if (appBlocked) return true;

  // Websites are usually identified by domain or name in the window title
  const websiteBlocked = websiteBlacklist.some((matcher) => matcher && titleHaystack.includes(matcher.toLowerCase()));
  if (websiteBlocked) return true;

  return false;
}
