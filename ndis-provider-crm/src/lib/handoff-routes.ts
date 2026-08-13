export type HandoffRouteWindow = {
  status?: unknown;
  route_type?: unknown;
  effective_from?: unknown;
  effective_until?: unknown;
  created_at?: unknown;
};

export function isCurrentHandoffRoute(
  route: HandoffRouteWindow,
  now: Date = new Date(),
): boolean {
  if (String(route.status ?? "") !== "active") return false;
  const effectiveFrom = Date.parse(String(route.effective_from ?? ""));
  if (!Number.isFinite(effectiveFrom) || effectiveFrom > now.getTime()) return false;
  const effectiveUntilRaw = route.effective_until;
  if (effectiveUntilRaw !== null && effectiveUntilRaw !== undefined && String(effectiveUntilRaw) !== "") {
    const effectiveUntil = Date.parse(String(effectiveUntilRaw));
    if (!Number.isFinite(effectiveUntil) || effectiveUntil <= now.getTime()) return false;
  }
  return true;
}

export function selectCurrentHandoffRoutes<T extends HandoffRouteWindow>(
  routes: T[],
  now: Date = new Date(),
): T[] {
  return routes
    .filter((route) => isCurrentHandoffRoute(route, now))
    .sort((a, b) => Date.parse(String(b.effective_from ?? "")) - Date.parse(String(a.effective_from ?? "")))
    .filter(
      (route, index, current) =>
        current.findIndex(
          (candidate) => String(candidate.route_type ?? "") === String(route.route_type ?? ""),
        ) === index,
    );
}
